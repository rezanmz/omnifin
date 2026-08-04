import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  SAVED_CUSTOM_LIST_MAX_COUNT,
  savedListCreateRequestSchema,
  savedListDeleteResponseSchema,
  savedListMutationResponseSchema,
  savedListRestoreRequestSchema,
  savedListsQuerySchema,
  savedListsResponseSchema,
  savedListUpdateRequestSchema,
  type SavedListCreateRequest,
  type SavedListDeleteResponse,
  type SavedListMutationResponse,
  type SavedListSummary,
  type SavedListsQuery,
  type SavedListsResponse,
} from "@omnifin/contracts/saved";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";

const LIST_ID_PATTERN = /^saved_list_[A-Za-z0-9_-]{22}$/u;
const OPERATION_ID_PATTERN = /^saved_operation_[A-Za-z0-9_-]{22}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UNDO_WINDOW_MS = 30_000;
const MAX_ID_CREATION_ATTEMPTS = 8;

const cursorPayloadSchema = z.strictObject({
  createdAt: z.int().nonnegative(),
  id: z.string().regex(LIST_ID_PATTERN),
  schemaVersion: z.literal(1),
});

type ActivePrincipal = SessionPrincipal & { userId: string };

interface SavedListRow {
  createdAt: number;
  deletedAt: number | null;
  encryptedDescription: string | null;
  encryptedName: string;
  id: string;
  itemCount: number;
  kind: "watch_later" | "custom";
  revision: number;
  undoExpiresAt: number | null;
  updatedAt: number;
  userId: string;
}

interface OperationRow {
  encryptedResponse: string | null;
  fingerprintHash: string;
  id: string;
  kind: "create_list" | "restore_list" | "add_item" | "reorder_items";
  state: "pending" | "succeeded" | "failed";
}

interface PendingOperation {
  fingerprintHash: string;
  id: string;
  idempotencyKeyHash: string;
  kind: "create_list" | "restore_list";
  resourceId: string | null;
  userId: string;
}

export interface SavedListContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface SavedListServiceDependencies {
  clock?: () => Date;
  createAuditId?: () => string;
  createListToken?: () => string;
  createOperationToken?: () => string;
}

export type SavedListErrorReason =
  | "cursor_invalid"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "integrity_failure"
  | "list_immutable"
  | "list_not_found"
  | "list_not_deleted"
  | "list_quota_reached"
  | "principal_unavailable"
  | "revision_stale"
  | "storage_failure"
  | "undo_expired";

export class SavedListServiceError extends Error {
  public readonly currentEtag: string | undefined;
  public readonly reason: SavedListErrorReason;

  public constructor(
    reason: SavedListErrorReason,
    options: { cause?: unknown; currentEtag?: string } = {},
  ) {
    super(
      "The saved-list operation could not be completed.",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SavedListServiceError";
    this.reason = reason;
    this.currentEtag = options.currentEtag;
  }
}

export class SavedListService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: Pick<AppConfig, "encryptionKey">;
  readonly #createAuditId: () => string;
  readonly #createListToken: () => string;
  readonly #createOperationToken: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: SavedListServiceDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAuditId = dependencies.createAuditId ?? (() => `saved-audit-${randomToken(16)}`);
    this.#createListToken = dependencies.createListToken ?? (() => randomToken(16));
    this.#createOperationToken = dependencies.createOperationToken ?? (() => randomToken(16));
  }

  public list(rawQuery: unknown, context: SavedListContext): SavedListsResponse {
    const principal = this.#activePrincipal(context);
    const query = savedListsQuerySchema.parse(rawQuery);
    const now = this.#now();
    try {
      return this.#database.sqlite.transaction(() => {
        this.#pruneExpired(now);
        const watchLater = this.#ensureWatchLater(principal.userId, now);
        const cursor = query.cursor ? this.#decodeCursor(query.cursor, principal.userId) : null;
        const rows = this.#listCustomRows(principal.userId, query, cursor);
        const page = rows.slice(0, query.limit);
        const tail = page.at(-1);
        return savedListsResponseSchema.parse({
          generatedAt: new Date(now).toISOString(),
          lists: page.map((row) => this.#summary(row)),
          nextCursor:
            rows.length > query.limit && tail
              ? this.#encodeCursor(
                  { createdAt: tail.createdAt, id: tail.id, schemaVersion: 1 },
                  principal.userId,
                )
              : null,
          watchLater: this.#summary(watchLater),
        });
      })();
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  public read(listId: string, context: SavedListContext) {
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    try {
      const row = this.#row(id, principal.userId, false);
      if (!row) throw new SavedListServiceError("list_not_found");
      const body = savedListMutationResponseSchema.parse({ list: this.#summary(row) });
      return { body, etag: this.#etag(principal.userId, id, row.revision) };
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  public create(
    rawInput: unknown,
    idempotencyKey: string,
    context: SavedListContext,
  ): { body: SavedListMutationResponse; etag: string; replayed: boolean } {
    const principal = this.#activePrincipal(context);
    const input = savedListCreateRequestSchema.parse(rawInput);
    const now = this.#now();
    const operation = this.#operation(principal.userId, "create_list", idempotencyKey, input);
    try {
      return this.#database.sqlite
        .transaction(() => {
          const replay = this.#reserveOperation(operation, now);
          if (replay) {
            const body = savedListMutationResponseSchema.parse(replay);
            return {
              body,
              etag: this.#etag(principal.userId, body.list.id, body.list.revision),
              replayed: true,
            };
          }
          this.#pruneExpired(now);
          this.#ensureWatchLater(principal.userId, now);
          const count = this.#database.sqlite
            .prepare(
              "select count(*) as count from saved_lists where user_id = ? and kind = 'custom'",
            )
            .get(principal.userId) as { count: number };
          if (count.count >= SAVED_CUSTOM_LIST_MAX_COUNT) {
            throw new SavedListServiceError("list_quota_reached");
          }
          const row = this.#insertList(principal.userId, "custom", input, now);
          const body = savedListMutationResponseSchema.parse({ list: this.#summary(row) });
          this.#completeOperation(operation.id, principal.userId, body, now);
          this.#audit(
            "saved.list.created",
            row.id,
            { kind: row.kind, revision: row.revision },
            context,
            now,
          );
          return {
            body,
            etag: this.#etag(principal.userId, row.id, row.revision),
            replayed: false,
          };
        })
        .immediate();
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  public update(listId: string, rawInput: unknown, ifMatch: string, context: SavedListContext) {
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    const input = savedListUpdateRequestSchema.parse(rawInput);
    const now = this.#now();
    try {
      return this.#database.sqlite
        .transaction(() => {
          const row = this.#row(id, principal.userId, false);
          if (!row) throw new SavedListServiceError("list_not_found");
          this.#editable(row);
          this.#matchRevision(row, ifMatch);
          const revision = this.#nextRevision(row.revision);
          const name = input.name ?? this.#decryptName(row);
          const description =
            input.description === undefined ? this.#decryptDescription(row) : input.description;
          const updated = this.#database.sqlite
            .prepare(
              `update saved_lists
             set encrypted_name = ?, encrypted_description = ?, revision = ?, updated_at = ?
             where id = ? and user_id = ? and revision = ? and deleted_at is null`,
            )
            .run(
              this.#cipher.encrypt(name, this.#nameContext(principal.userId, id)),
              description === null
                ? null
                : this.#cipher.encrypt(description, this.#descriptionContext(principal.userId, id)),
              revision,
              now,
              id,
              principal.userId,
              row.revision,
            );
          if (updated.changes !== 1) throw new SavedListServiceError("revision_stale");
          const current = this.#row(id, principal.userId, false);
          if (!current) throw new SavedListServiceError("storage_failure");
          const body = savedListMutationResponseSchema.parse({ list: this.#summary(current) });
          this.#audit("saved.list.updated", id, { revision }, context, now);
          return { body, etag: this.#etag(principal.userId, id, revision) };
        })
        .immediate();
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  public delete(
    listId: string,
    ifMatch: string,
    context: SavedListContext,
  ): { body: SavedListDeleteResponse; etag: string } {
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    const now = this.#now();
    try {
      return this.#database.sqlite
        .transaction(() => {
          const row = this.#row(id, principal.userId, false);
          if (!row) throw new SavedListServiceError("list_not_found");
          this.#editable(row);
          this.#matchRevision(row, ifMatch);
          const revision = this.#nextRevision(row.revision);
          const undoExpiresAt = now + UNDO_WINDOW_MS;
          const deleted = this.#database.sqlite
            .prepare(
              `update saved_lists
             set deleted_at = ?, undo_expires_at = ?, revision = ?, updated_at = ?
             where id = ? and user_id = ? and revision = ? and deleted_at is null`,
            )
            .run(now, undoExpiresAt, revision, now, id, principal.userId, row.revision);
          if (deleted.changes !== 1) throw new SavedListServiceError("revision_stale");
          const body = savedListDeleteResponseSchema.parse({
            deletedAt: new Date(now).toISOString(),
            listId: id,
            revision,
            undoExpiresAt: new Date(undoExpiresAt).toISOString(),
          });
          this.#audit("saved.list.deleted", id, { revision }, context, now);
          return { body, etag: this.#etag(principal.userId, id, revision) };
        })
        .immediate();
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  public restore(
    listId: string,
    rawInput: unknown,
    idempotencyKey: string,
    ifMatch: string,
    context: SavedListContext,
  ): { body: SavedListMutationResponse; etag: string; replayed: boolean } {
    savedListRestoreRequestSchema.parse(rawInput);
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    const now = this.#now();
    const operation = this.#operation(
      principal.userId,
      "restore_list",
      idempotencyKey,
      { ifMatch, listId: id },
      id,
    );
    try {
      return this.#database.sqlite
        .transaction(() => {
          const replay = this.#reserveOperation(operation, now);
          if (replay) {
            const body = savedListMutationResponseSchema.parse(replay);
            return {
              body,
              etag: this.#etag(principal.userId, body.list.id, body.list.revision),
              replayed: true,
            };
          }
          const row = this.#row(id, principal.userId, true);
          if (!row) throw new SavedListServiceError("list_not_found");
          this.#editable(row);
          if (row.deletedAt === null || row.undoExpiresAt === null) {
            throw new SavedListServiceError("list_not_deleted");
          }
          this.#matchRevision(row, ifMatch);
          if (row.undoExpiresAt <= now) throw new SavedListServiceError("undo_expired");
          const revision = this.#nextRevision(row.revision);
          const restored = this.#database.sqlite
            .prepare(
              `update saved_lists
             set deleted_at = null, undo_expires_at = null, revision = ?, updated_at = ?
             where id = ? and user_id = ? and revision = ? and deleted_at is not null`,
            )
            .run(revision, now, id, principal.userId, row.revision);
          if (restored.changes !== 1) throw new SavedListServiceError("revision_stale");
          const current = this.#row(id, principal.userId, false);
          if (!current) throw new SavedListServiceError("storage_failure");
          const body = savedListMutationResponseSchema.parse({ list: this.#summary(current) });
          this.#completeOperation(operation.id, principal.userId, body, now);
          this.#audit("saved.list.restored", id, { revision }, context, now);
          return { body, etag: this.#etag(principal.userId, id, revision), replayed: false };
        })
        .immediate();
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  #activePrincipal(context: SavedListContext): ActivePrincipal {
    const principal = requirePermission(context.principal, "saved.lists.self.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new SavedListServiceError("principal_unavailable");
    }
    return principal as ActivePrincipal;
  }

  #listCustomRows(
    userId: string,
    query: SavedListsQuery,
    cursor: z.infer<typeof cursorPayloadSchema> | null,
  ) {
    const cursorClause = cursor
      ? "and (saved_lists.created_at < ? or (saved_lists.created_at = ? and saved_lists.id < ?))"
      : "";
    const statement = this.#database.sqlite.prepare(
      `select
         saved_lists.id as id, saved_lists.user_id as userId, saved_lists.kind as kind,
         saved_lists.encrypted_name as encryptedName,
         saved_lists.encrypted_description as encryptedDescription,
         saved_lists.revision as revision, saved_lists.deleted_at as deletedAt,
         saved_lists.undo_expires_at as undoExpiresAt,
         saved_lists.created_at as createdAt, saved_lists.updated_at as updatedAt,
         count(saved_list_items.id) as itemCount
       from saved_lists
       left join saved_list_items on saved_list_items.list_id = saved_lists.id
       where saved_lists.user_id = ? and saved_lists.kind = 'custom'
         and saved_lists.deleted_at is null ${cursorClause}
       group by saved_lists.id
       order by saved_lists.created_at desc, saved_lists.id desc
       limit ?`,
    );
    return (
      cursor
        ? statement.all(userId, cursor.createdAt, cursor.createdAt, cursor.id, query.limit + 1)
        : statement.all(userId, query.limit + 1)
    ) as SavedListRow[];
  }

  #row(id: string, userId: string, includeDeleted: boolean): SavedListRow | undefined {
    return this.#database.sqlite
      .prepare(
        `select
           saved_lists.id as id, saved_lists.user_id as userId, saved_lists.kind as kind,
           saved_lists.encrypted_name as encryptedName,
           saved_lists.encrypted_description as encryptedDescription,
           saved_lists.revision as revision, saved_lists.deleted_at as deletedAt,
           saved_lists.undo_expires_at as undoExpiresAt,
           saved_lists.created_at as createdAt, saved_lists.updated_at as updatedAt,
           count(saved_list_items.id) as itemCount
         from saved_lists
         left join saved_list_items on saved_list_items.list_id = saved_lists.id
         where saved_lists.id = ? and saved_lists.user_id = ?
           ${includeDeleted ? "" : "and saved_lists.deleted_at is null"}
         group by saved_lists.id`,
      )
      .get(id, userId) as SavedListRow | undefined;
  }

  #ensureWatchLater(userId: string, now: number) {
    const existing = this.#database.sqlite
      .prepare(
        `select id from saved_lists
         where user_id = ? and kind = 'watch_later' and deleted_at is null`,
      )
      .get(userId) as { id: string } | undefined;
    if (existing) {
      const row = this.#row(existing.id, userId, false);
      if (!row) throw new SavedListServiceError("storage_failure");
      return row;
    }
    return this.#insertList(userId, "watch_later", { description: null, name: "Watch Later" }, now);
  }

  #insertList(
    userId: string,
    kind: "watch_later" | "custom",
    input: SavedListCreateRequest,
    now: number,
  ) {
    for (let attempt = 0; attempt < MAX_ID_CREATION_ATTEMPTS; attempt += 1) {
      const id = `saved_list_${this.#createListToken()}`;
      if (!LIST_ID_PATTERN.test(id)) throw new SavedListServiceError("integrity_failure");
      try {
        this.#database.sqlite
          .prepare(
            `insert into saved_lists (
               id, user_id, kind, encrypted_name, encrypted_description,
               revision, deleted_at, undo_expires_at, created_at, updated_at
             ) values (?, ?, ?, ?, ?, 0, null, null, ?, ?)`,
          )
          .run(
            id,
            userId,
            kind,
            this.#cipher.encrypt(input.name, this.#nameContext(userId, id)),
            input.description === null
              ? null
              : this.#cipher.encrypt(input.description, this.#descriptionContext(userId, id)),
            now,
            now,
          );
        const row = this.#row(id, userId, false);
        if (!row) throw new SavedListServiceError("storage_failure");
        return row;
      } catch (error) {
        if (error instanceof SavedListServiceError) throw error;
        const collision = this.#database.sqlite
          .prepare("select 1 from saved_lists where id = ?")
          .get(id);
        if (!collision) throw error;
      }
    }
    throw new SavedListServiceError("integrity_failure");
  }

  #summary(row: SavedListRow): SavedListSummary {
    if (!LIST_ID_PATTERN.test(row.id) || row.userId.length === 0) {
      throw new SavedListServiceError("storage_failure");
    }
    return {
      capabilities: {
        delete: row.kind === "custom",
        rename: row.kind === "custom",
        reorder: true,
      },
      createdAt: new Date(row.createdAt).toISOString(),
      description: this.#decryptDescription(row),
      id: row.id,
      itemCount: row.itemCount,
      kind: row.kind,
      name: this.#decryptName(row),
      revision: row.revision,
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  #decryptName(row: SavedListRow) {
    return this.#cipher.decrypt(row.encryptedName, this.#nameContext(row.userId, row.id));
  }

  #decryptDescription(row: SavedListRow) {
    return row.encryptedDescription === null
      ? null
      : this.#cipher.decrypt(
          row.encryptedDescription,
          this.#descriptionContext(row.userId, row.id),
        );
  }

  #nameContext(userId: string, listId: string) {
    return `saved_list_name:${userId}:${listId}`;
  }

  #descriptionContext(userId: string, listId: string) {
    return `saved_list_description:${userId}:${listId}`;
  }

  #operationContext(userId: string, operationId: string) {
    return `saved_list_operation:${userId}:${operationId}`;
  }

  #cursorContext(userId: string) {
    return `saved_list_cursor:${userId}`;
  }

  #encodeCursor(payload: z.infer<typeof cursorPayloadSchema>, userId: string) {
    return this.#cipher.encrypt(JSON.stringify(payload), this.#cursorContext(userId));
  }

  #decodeCursor(value: string, userId: string) {
    try {
      return cursorPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(value, this.#cursorContext(userId))),
      );
    } catch (error) {
      throw new SavedListServiceError("cursor_invalid", { cause: error });
    }
  }

  #etag(userId: string, listId: string, revision: number) {
    return `"saved_${privacyHash(
      "saved_list_etag",
      `${userId}\0${listId}\0${revision}`,
      this.#config.encryptionKey,
    )}"`;
  }

  #matchRevision(row: SavedListRow, ifMatch: string) {
    const currentEtag = this.#etag(row.userId, row.id, row.revision);
    if (ifMatch !== currentEtag) {
      throw new SavedListServiceError("revision_stale", { currentEtag });
    }
  }

  #nextRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2_147_483_647) {
      throw new SavedListServiceError("integrity_failure");
    }
    return revision + 1;
  }

  #editable(row: SavedListRow) {
    if (row.kind !== "custom") throw new SavedListServiceError("list_immutable");
  }

  #listId(value: string) {
    if (!LIST_ID_PATTERN.test(value)) throw new SavedListServiceError("list_not_found");
    return value;
  }

  #operation(
    userId: string,
    kind: "create_list" | "restore_list",
    idempotencyKey: string,
    fingerprint: unknown,
    resourceId: string | null = null,
  ) {
    const id = `saved_operation_${this.#createOperationToken()}`;
    if (!OPERATION_ID_PATTERN.test(id)) throw new SavedListServiceError("integrity_failure");
    return {
      fingerprintHash: privacyHash(
        "saved_operation",
        JSON.stringify({ fingerprint, kind }),
        this.#config.encryptionKey,
      ),
      id,
      idempotencyKeyHash: hashToken(`${userId}\0saved_list\0${idempotencyKey}`),
      kind,
      resourceId,
      userId,
    };
  }

  #reserveOperation(operation: PendingOperation, now: number): unknown | null {
    const existing = this.#database.sqlite
      .prepare(
        `select id, kind, fingerprint_hash as fingerprintHash, state,
                encrypted_response as encryptedResponse
         from saved_list_operations
         where user_id = ? and idempotency_key_hash = ?`,
      )
      .get(operation.userId, operation.idempotencyKeyHash) as OperationRow | undefined;
    if (existing) {
      if (
        existing.kind !== operation.kind ||
        existing.fingerprintHash !== operation.fingerprintHash
      ) {
        throw new SavedListServiceError("idempotency_conflict");
      }
      if (existing.state !== "succeeded" || existing.encryptedResponse === null) {
        throw new SavedListServiceError("idempotency_in_progress");
      }
      return JSON.parse(
        this.#cipher.decrypt(
          existing.encryptedResponse,
          this.#operationContext(operation.userId, existing.id),
        ),
      );
    }
    this.#database.sqlite
      .prepare(
        `insert into saved_list_operations (
           id, user_id, kind, resource_id, idempotency_key_hash, fingerprint_hash,
           state, encrypted_response, failure_code, completed_at, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, 'pending', null, null, null, ?, ?)`,
      )
      .run(
        operation.id,
        operation.userId,
        operation.kind,
        operation.resourceId,
        operation.idempotencyKeyHash,
        operation.fingerprintHash,
        now,
        now,
      );
    return null;
  }

  #completeOperation(operationId: string, userId: string, response: unknown, now: number) {
    const updated = this.#database.sqlite
      .prepare(
        `update saved_list_operations
         set state = 'succeeded', encrypted_response = ?, completed_at = ?, updated_at = ?
         where id = ? and user_id = ? and state = 'pending'`,
      )
      .run(
        this.#cipher.encrypt(JSON.stringify(response), this.#operationContext(userId, operationId)),
        now,
        now,
        operationId,
        userId,
      );
    if (updated.changes !== 1) throw new SavedListServiceError("storage_failure");
  }

  #pruneExpired(now: number) {
    this.#database.sqlite
      .prepare(
        `delete from saved_lists
         where kind = 'custom' and deleted_at is not null and undo_expires_at <= ?`,
      )
      .run(now);
    this.#database.sqlite
      .prepare(
        `delete from saved_list_operations
         where updated_at < ? and state <> 'pending'`,
      )
      .run(now - 7 * 24 * 60 * 60 * 1_000);
  }

  #audit(
    eventType: string,
    targetId: string,
    metadata: Record<string, unknown>,
    context: SavedListContext,
    createdAt: number,
  ) {
    const id = this.#createAuditId();
    if (!IDENTIFIER_PATTERN.test(id)) throw new SavedListServiceError("integrity_failure");
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method,
           event_type, outcome, target_type, target_id, request_id,
           metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, ?, 'success', 'saved_list', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        targetId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #now() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new SavedListServiceError("integrity_failure");
    }
    return value;
  }

  #normalizeError(error: unknown) {
    if (error instanceof SavedListServiceError) return error;
    return new SavedListServiceError("storage_failure", { cause: error });
  }
}
