import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  SAVED_CUSTOM_LIST_MAX_COUNT,
  SAVED_LIST_MAX_ITEMS,
  savedCatalogReferenceIdSchema,
  savedCatalogItemSchema,
  savedListCreateRequestSchema,
  savedListDeleteResponseSchema,
  savedListMembershipRequestSchema,
  savedListMembershipDeleteResponseSchema,
  savedListMembershipResponseSchema,
  savedListItemsQuerySchema,
  savedListItemsResponseSchema,
  savedListMutationResponseSchema,
  savedListReorderRequestSchema,
  savedListReorderResponseSchema,
  savedListRestoreRequestSchema,
  savedListsQuerySchema,
  savedListsResponseSchema,
  savedListUpdateRequestSchema,
  type SavedListCreateRequest,
  type SavedListDeleteResponse,
  type SavedListMembershipResponse,
  type SavedListMembershipDeleteResponse,
  type SavedListItemsQuery,
  type SavedListItemsResponse,
  type SavedListMutationResponse,
  type SavedListReorderResponse,
  type SavedListSummary,
  type SavedListsQuery,
  type SavedListsResponse,
} from "@omnifin/contracts/saved";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";
import {
  SavedTargetService,
  SavedTargetServiceError,
  storedSavedCatalogSnapshotSchema,
  type ResolvedSavedTarget,
  type SavedTargetServiceDependencies,
} from "./target-service.js";

const LIST_ID_PATTERN = /^saved_list_[A-Za-z0-9_-]{22}$/u;
const LIST_ITEM_ID_PATTERN = /^saved_item_[A-Za-z0-9_-]{22}$/u;
const CATALOG_ID_PATTERN = /^catalog_[A-Za-z0-9_-]{22}$/u;
const MEDIA_REFERENCE_ID_PATTERN = /^media_[A-Za-z0-9_-]{22}$/u;
const OPERATION_ID_PATTERN = /^saved_operation_[A-Za-z0-9_-]{22}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UNDO_WINDOW_MS = 30_000;
const MAX_ID_CREATION_ATTEMPTS = 8;

const cursorPayloadSchema = z.strictObject({
  createdAt: z.int().nonnegative(),
  id: z.string().regex(LIST_ID_PATTERN),
  schemaVersion: z.literal(1),
});

const itemCursorPayloadSchema = z.strictObject({
  fingerprint: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  listId: z.string().regex(LIST_ID_PATTERN),
  offset: z.int().nonnegative().max(SAVED_LIST_MAX_ITEMS),
  revision: z.int().nonnegative().max(2_147_483_647),
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

interface SavedCatalogRow {
  encryptedIdentity: string;
  encryptedSnapshot: string;
  id: string;
  libraryReferenceId: string | null;
}

interface SavedMembershipRow {
  createdAt: number;
  id: string;
  position: number;
}

interface MutableSavedMembershipRow extends SavedMembershipRow {
  catalogItemId: string;
}

interface SavedListItemRow extends SavedMembershipRow {
  catalogId: string;
  encryptedSnapshot: string;
  libraryReferenceId: string | null;
}

interface PendingOperation {
  fingerprintHash: string;
  id: string;
  idempotencyKeyHash: string;
  kind: "add_item" | "create_list" | "reorder_items" | "restore_list";
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
  createCatalogToken?: () => string;
  createItemToken?: () => string;
  createListToken?: () => string;
  createOperationToken?: () => string;
  targetDependencies?: SavedTargetServiceDependencies;
}

export type SavedListErrorReason =
  | "cursor_invalid"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "integrity_failure"
  | "list_immutable"
  | "list_item_quota_reached"
  | "list_not_found"
  | "list_not_deleted"
  | "list_quota_reached"
  | "principal_unavailable"
  | "reorder_window_changed"
  | "revision_stale"
  | "storage_failure"
  | "target_not_found"
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
  readonly #createCatalogToken: () => string;
  readonly #createItemToken: () => string;
  readonly #createListToken: () => string;
  readonly #createOperationToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #targets: SavedTargetService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: SavedListServiceDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAuditId = dependencies.createAuditId ?? (() => `saved-audit-${randomToken(16)}`);
    this.#createCatalogToken = dependencies.createCatalogToken ?? (() => randomToken(16));
    this.#createItemToken = dependencies.createItemToken ?? (() => randomToken(16));
    this.#createListToken = dependencies.createListToken ?? (() => randomToken(16));
    this.#createOperationToken = dependencies.createOperationToken ?? (() => randomToken(16));
    this.#targets = new SavedTargetService(database, config, {
      clock: this.#clock,
      ...dependencies.targetDependencies,
    });
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

  public resolveOwnedArtworkReference(
    rawCatalogReferenceId: string,
    context: SavedListContext,
  ): string {
    const principal = this.#activePrincipal(context);
    const catalogReferenceId = savedCatalogReferenceIdSchema.parse(rawCatalogReferenceId);
    const row = this.#database.sqlite
      .prepare(
        `select saved_catalog_items.library_reference_id as libraryReferenceId
         from saved_catalog_items
         where saved_catalog_items.id = ?
           and saved_catalog_items.user_id = ?
           and saved_catalog_items.library_reference_id is not null
           and exists (
             select 1
             from saved_list_items
             join saved_lists on saved_lists.id = saved_list_items.list_id
             where saved_list_items.catalog_item_id = saved_catalog_items.id
               and saved_list_items.user_id = saved_catalog_items.user_id
               and saved_lists.user_id = saved_catalog_items.user_id
               and saved_lists.deleted_at is null
           )`,
      )
      .get(catalogReferenceId, principal.userId) as { libraryReferenceId: string } | undefined;
    if (!row || !MEDIA_REFERENCE_ID_PATTERN.test(row.libraryReferenceId)) {
      throw new SavedListServiceError("target_not_found");
    }
    return row.libraryReferenceId;
  }

  public items(
    listId: string,
    rawQuery: unknown,
    context: SavedListContext,
  ): SavedListItemsResponse {
    return this.readItems(listId, rawQuery, context).body;
  }

  public readItems(
    listId: string,
    rawQuery: unknown,
    context: SavedListContext,
  ): { body: SavedListItemsResponse; etag: string } {
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    const query = savedListItemsQuerySchema.parse(rawQuery);
    const now = this.#now();
    try {
      const list = this.#row(id, principal.userId, false);
      if (!list) throw new SavedListServiceError("list_not_found");
      const fingerprint = privacyHash(
        "saved_list_items_query",
        JSON.stringify({
          availability: query.availability,
          query: query.query ?? null,
          sort: query.sort,
        }),
        this.#config.encryptionKey,
      );
      const cursor = query.cursor
        ? this.#decodeItemCursor(query.cursor, principal.userId, id)
        : null;
      if (
        cursor &&
        (cursor.listId !== id ||
          cursor.revision !== list.revision ||
          cursor.fingerprint !== fingerprint)
      ) {
        throw new SavedListServiceError("cursor_invalid");
      }
      const normalizedQuery = query.query?.toLowerCase();
      const allItems = this.#listItemRows(id, principal.userId).map((row) =>
        this.#listItem(row, principal.userId),
      );
      const filtered = allItems.filter(
        ({ catalog }) =>
          (query.availability === "all" || catalog.availability === query.availability) &&
          (normalizedQuery === undefined || catalog.title.toLowerCase().includes(normalizedQuery)),
      );
      filtered.sort((left, right) => this.#compareListItems(left, right, query));
      const offset = cursor?.offset ?? 0;
      if (offset > filtered.length) throw new SavedListServiceError("cursor_invalid");
      const page = filtered.slice(offset, offset + query.limit);
      const nextOffset = offset + page.length;
      const degraded = filtered.some(
        ({ catalog }) => catalog.resolutionState === "connector_unavailable",
      );
      const body = savedListItemsResponseSchema.parse({
        generatedAt: new Date(now).toISOString(),
        items: page,
        list: this.#summary(list),
        nextCursor:
          nextOffset < filtered.length
            ? this.#encodeItemCursor(
                {
                  fingerprint,
                  listId: id,
                  offset: nextOffset,
                  revision: list.revision,
                  schemaVersion: 1,
                },
                principal.userId,
                id,
              )
            : null,
        reconciliation: degraded
          ? {
              failures: [
                {
                  code: "unreachable",
                  message: "Some saved titles could not be refreshed from Jellyfin.",
                  occurredAt: new Date(now).toISOString(),
                  operation: "saved.list.items.resolve",
                  retryable: true,
                  service: "jellyfin",
                },
              ],
              state: "degraded",
            }
          : { failures: [], state: "current" },
      });
      return { body, etag: this.#etag(principal.userId, id, list.revision) };
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

  public addItem(
    listId: string,
    rawInput: unknown,
    idempotencyKey: string,
    ifMatch: string,
    context: SavedListContext,
  ): { body: SavedListMembershipResponse; etag: string; replayed: boolean } {
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    const input = savedListMembershipRequestSchema.parse(rawInput);
    const now = this.#now();
    const operation = this.#operation(
      principal.userId,
      "add_item",
      idempotencyKey,
      { ifMatch, listId: id, targetReferenceId: input.targetReferenceId },
      id,
    );
    try {
      return this.#database.sqlite
        .transaction(() => {
          const replay = this.#reserveOperation(operation, now);
          if (replay) {
            const body = savedListMembershipResponseSchema.parse(replay);
            return {
              body,
              etag: this.#etag(principal.userId, body.listId, body.revision),
              replayed: true,
            };
          }
          const list = this.#row(id, principal.userId, false);
          if (!list) throw new SavedListServiceError("list_not_found");
          this.#matchRevision(list, ifMatch);
          const target = this.#resolveTarget(input.targetReferenceId, principal);
          const catalog = this.#upsertCatalog(principal.userId, target, now);
          if (catalog.changed) {
            this.#refreshCatalogListRevisions(principal.userId, catalog.id, now);
          }
          const existing = this.#membership(id, principal.userId, catalog.id);
          if (existing) {
            const currentList = this.#row(id, principal.userId, false);
            if (!currentList) throw new SavedListServiceError("storage_failure");
            const body = this.#membershipResponse(
              false,
              id,
              currentList.revision,
              existing,
              catalog.id,
              target,
            );
            this.#completeOperation(operation.id, principal.userId, body, now);
            return {
              body,
              etag: this.#etag(principal.userId, id, currentList.revision),
              replayed: false,
            };
          }
          if (list.itemCount >= SAVED_LIST_MAX_ITEMS) {
            throw new SavedListServiceError("list_item_quota_reached");
          }
          const membership = this.#insertMembership(
            id,
            principal.userId,
            catalog.id,
            list.itemCount,
            now,
          );
          const revision = this.#nextRevision(list.revision);
          const updated = this.#database.sqlite
            .prepare(
              `update saved_lists set revision = ?, updated_at = ?
               where id = ? and user_id = ? and revision = ? and deleted_at is null`,
            )
            .run(revision, now, id, principal.userId, list.revision);
          if (updated.changes !== 1) throw new SavedListServiceError("revision_stale");
          const body = this.#membershipResponse(true, id, revision, membership, catalog.id, target);
          this.#completeOperation(operation.id, principal.userId, body, now);
          this.#audit(
            "saved.list.item.added",
            id,
            { catalogReferenceId: catalog.id, revision },
            context,
            now,
          );
          return {
            body,
            etag: this.#etag(principal.userId, id, revision),
            replayed: false,
          };
        })
        .immediate();
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  public removeItem(
    listId: string,
    catalogReferenceId: string,
    ifMatch: string,
    context: SavedListContext,
  ): { body: SavedListMembershipDeleteResponse; etag: string } {
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    const catalogId = savedCatalogReferenceIdSchema.parse(catalogReferenceId);
    const now = this.#now();
    try {
      return this.#database.sqlite
        .transaction(() => {
          const list = this.#row(id, principal.userId, false);
          if (!list) throw new SavedListServiceError("list_not_found");
          const membership = this.#mutableMembership(id, principal.userId, catalogId);
          if (!membership) {
            return {
              body: savedListMembershipDeleteResponseSchema.parse({
                catalogReferenceId: catalogId,
                listId: id,
                removed: false,
                revision: list.revision,
              }),
              etag: this.#etag(principal.userId, id, list.revision),
            };
          }
          this.#matchRevision(list, ifMatch);
          const revision = this.#nextRevision(list.revision);
          const tail = this.#database.sqlite
            .prepare(
              `select id, catalog_item_id as catalogItemId, position,
                      created_at as createdAt
               from saved_list_items
               where list_id = ? and user_id = ? and position > ?
               order by position`,
            )
            .all(id, principal.userId, membership.position) as MutableSavedMembershipRow[];
          const removed = this.#database.sqlite
            .prepare(
              `delete from saved_list_items
               where list_id = ? and user_id = ? and position >= ?`,
            )
            .run(id, principal.userId, membership.position);
          if (removed.changes !== tail.length + 1) {
            throw new SavedListServiceError("storage_failure");
          }
          for (const row of tail) {
            this.#insertExistingMembership(id, principal.userId, row, row.position - 1, now);
          }
          const updated = this.#database.sqlite
            .prepare(
              `update saved_lists set revision = ?, updated_at = ?
               where id = ? and user_id = ? and revision = ? and deleted_at is null`,
            )
            .run(revision, now, id, principal.userId, list.revision);
          if (updated.changes !== 1) throw new SavedListServiceError("revision_stale");
          this.#database.sqlite
            .prepare(
              `delete from saved_catalog_items
               where id = ? and user_id = ?
                 and not exists (
                   select 1 from saved_list_items
                   where catalog_item_id = ? and user_id = ?
                 )`,
            )
            .run(catalogId, principal.userId, catalogId, principal.userId);
          const body = savedListMembershipDeleteResponseSchema.parse({
            catalogReferenceId: catalogId,
            listId: id,
            removed: true,
            revision,
          });
          this.#audit(
            "saved.list.item.removed",
            id,
            { catalogReferenceId: catalogId, revision },
            context,
            now,
          );
          return { body, etag: this.#etag(principal.userId, id, revision) };
        })
        .immediate();
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  public reorderItems(
    listId: string,
    rawInput: unknown,
    idempotencyKey: string,
    ifMatch: string,
    context: SavedListContext,
  ): { body: SavedListReorderResponse; etag: string; replayed: boolean } {
    const principal = this.#activePrincipal(context);
    const id = this.#listId(listId);
    const input = savedListReorderRequestSchema.parse(rawInput);
    const now = this.#now();
    const operation = this.#operation(
      principal.userId,
      "reorder_items",
      idempotencyKey,
      { ifMatch, input, listId: id },
      id,
    );
    try {
      return this.#database.sqlite
        .transaction(() => {
          const replay = this.#reserveOperation(operation, now);
          if (replay) {
            const body = savedListReorderResponseSchema.parse(replay);
            return {
              body,
              etag: this.#etag(principal.userId, id, body.revision),
              replayed: true,
            };
          }
          const list = this.#row(id, principal.userId, false);
          if (!list) throw new SavedListServiceError("list_not_found");
          this.#matchRevision(list, ifMatch);
          const rows = this.#reorderWindow(
            id,
            principal.userId,
            input.startPosition,
            input.orderedItemIds.length,
          );
          const requested = new Set(input.orderedItemIds);
          if (
            rows.length !== input.orderedItemIds.length ||
            rows.some((row) => !requested.has(row.id))
          ) {
            throw new SavedListServiceError("reorder_window_changed");
          }
          const bodyInput = {
            orderedItemIds: input.orderedItemIds,
            revision: list.revision,
            startPosition: input.startPosition,
          };
          if (rows.every((row, index) => row.id === input.orderedItemIds[index])) {
            const body = savedListReorderResponseSchema.parse(bodyInput);
            this.#completeOperation(operation.id, principal.userId, body, now);
            return {
              body,
              etag: this.#etag(principal.userId, id, list.revision),
              replayed: false,
            };
          }
          const byId = new Map(rows.map((row) => [row.id, row]));
          const removed = this.#database.sqlite
            .prepare(
              `delete from saved_list_items
               where list_id = ? and user_id = ? and position >= ? and position < ?`,
            )
            .run(
              id,
              principal.userId,
              input.startPosition,
              input.startPosition + input.orderedItemIds.length,
            );
          if (removed.changes !== rows.length) throw new SavedListServiceError("storage_failure");
          for (const [index, itemId] of input.orderedItemIds.entries()) {
            const row = byId.get(itemId);
            if (!row) throw new SavedListServiceError("reorder_window_changed");
            this.#insertExistingMembership(
              id,
              principal.userId,
              row,
              input.startPosition + index,
              now,
            );
          }
          const revision = this.#nextRevision(list.revision);
          const updated = this.#database.sqlite
            .prepare(
              `update saved_lists set revision = ?, updated_at = ?
               where id = ? and user_id = ? and revision = ? and deleted_at is null`,
            )
            .run(revision, now, id, principal.userId, list.revision);
          if (updated.changes !== 1) throw new SavedListServiceError("revision_stale");
          const body = savedListReorderResponseSchema.parse({ ...bodyInput, revision });
          this.#completeOperation(operation.id, principal.userId, body, now);
          this.#audit(
            "saved.list.items.reordered",
            id,
            { count: rows.length, revision, startPosition: input.startPosition },
            context,
            now,
          );
          return {
            body,
            etag: this.#etag(principal.userId, id, revision),
            replayed: false,
          };
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

  #resolveTarget(targetReferenceId: string, principal: ActivePrincipal) {
    try {
      return this.#targets.resolve(targetReferenceId, { principal });
    } catch (error) {
      if (error instanceof SavedTargetServiceError) {
        if (error.reason === "not_found") {
          throw new SavedListServiceError("target_not_found", { cause: error });
        }
        if (error.reason === "principal_unavailable") {
          throw new SavedListServiceError("principal_unavailable", { cause: error });
        }
        throw new SavedListServiceError("storage_failure", { cause: error });
      }
      throw error;
    }
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

  #upsertCatalog(userId: string, target: ResolvedSavedTarget, now: number) {
    const existing = this.#database.sqlite
      .prepare(
        `select id, encrypted_identity as encryptedIdentity,
                encrypted_snapshot as encryptedSnapshot,
                library_reference_id as libraryReferenceId
         from saved_catalog_items where user_id = ? and identity_digest = ?`,
      )
      .get(userId, target.payload.catalogIdentityDigest) as SavedCatalogRow | undefined;
    if (existing && !CATALOG_ID_PATTERN.test(existing.id)) {
      throw new SavedListServiceError("storage_failure");
    }
    const id = existing?.id ?? this.#newCatalogId();
    const identity =
      target.payload.source === "jellyfin"
        ? {
            itemId: target.payload.itemId,
            kind: target.payload.kind,
            linkId: target.linkId,
            linkRevision: target.linkRevision,
            schemaVersion: 1,
            source: "jellyfin",
          }
        : {
            kind: target.payload.kind,
            schemaVersion: 1,
            source: "tmdb",
            tmdbId: target.payload.tmdbId,
          };
    const snapshot = {
      availability: target.payload.source === "jellyfin" ? "owned" : target.payload.availability,
      artwork: target.payload.artwork,
      favorite: target.payload.favorite,
      kind: target.payload.kind,
      overview: target.payload.overview,
      resolutionState: target.payload.resolutionState,
      schemaVersion: 1,
      title: target.payload.title,
      year: target.payload.year,
    };
    const identityJson = JSON.stringify(identity);
    const snapshotJson = JSON.stringify(snapshot);
    if (existing) {
      let unchanged: boolean;
      try {
        unchanged =
          this.#cipher.decrypt(
            existing.encryptedIdentity,
            this.#catalogIdentityContext(userId, id),
          ) === identityJson &&
          this.#cipher.decrypt(
            existing.encryptedSnapshot,
            this.#catalogSnapshotContext(userId, id),
          ) === snapshotJson &&
          existing.libraryReferenceId === target.payload.libraryReferenceId;
      } catch (error) {
        throw new SavedListServiceError("storage_failure", { cause: error });
      }
      if (unchanged) {
        this.#database.sqlite
          .prepare(
            `update saved_catalog_items set last_resolved_at = ?, updated_at = ?
             where id = ? and user_id = ?`,
          )
          .run(now, now, id, userId);
        return { changed: false, id };
      }
      const updated = this.#database.sqlite
        .prepare(
          `update saved_catalog_items
           set encrypted_identity = ?, encrypted_snapshot = ?, library_reference_id = ?,
               library_reference_user_id = ?, last_resolved_at = ?, updated_at = ?
           where id = ? and user_id = ? and identity_digest = ?`,
        )
        .run(
          this.#cipher.encrypt(identityJson, this.#catalogIdentityContext(userId, id)),
          this.#cipher.encrypt(snapshotJson, this.#catalogSnapshotContext(userId, id)),
          target.payload.libraryReferenceId,
          target.payload.libraryReferenceId === null ? null : userId,
          now,
          now,
          id,
          userId,
          target.payload.catalogIdentityDigest,
        );
      if (updated.changes !== 1) throw new SavedListServiceError("storage_failure");
      return { changed: true, id };
    }
    try {
      this.#database.sqlite
        .prepare(
          `insert into saved_catalog_items (
             id, user_id, identity_digest, encrypted_identity, encrypted_snapshot,
             library_reference_id, library_reference_user_id, last_resolved_at,
             created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          userId,
          target.payload.catalogIdentityDigest,
          this.#cipher.encrypt(identityJson, this.#catalogIdentityContext(userId, id)),
          this.#cipher.encrypt(snapshotJson, this.#catalogSnapshotContext(userId, id)),
          target.payload.libraryReferenceId,
          target.payload.libraryReferenceId === null ? null : userId,
          now,
          now,
          now,
        );
      return { changed: true, id };
    } catch (error) {
      throw new SavedListServiceError("storage_failure", { cause: error });
    }
  }

  #refreshCatalogListRevisions(userId: string, catalogId: string, now: number) {
    const exhausted = this.#database.sqlite
      .prepare(
        `select 1
         from saved_lists
         join saved_list_items on saved_list_items.list_id = saved_lists.id
         where saved_lists.user_id = ? and saved_lists.deleted_at is null
           and saved_list_items.catalog_item_id = ? and saved_lists.revision >= 2147483647
         limit 1`,
      )
      .get(userId, catalogId);
    if (exhausted) throw new SavedListServiceError("integrity_failure");
    this.#database.sqlite
      .prepare(
        `update saved_lists set revision = revision + 1, updated_at = ?
         where user_id = ? and deleted_at is null and id in (
           select list_id from saved_list_items where user_id = ? and catalog_item_id = ?
         )`,
      )
      .run(now, userId, userId, catalogId);
  }

  #newCatalogId() {
    for (let attempt = 0; attempt < MAX_ID_CREATION_ATTEMPTS; attempt += 1) {
      const id = `catalog_${this.#createCatalogToken()}`;
      if (!CATALOG_ID_PATTERN.test(id)) {
        throw new SavedListServiceError("integrity_failure");
      }
      const collision = this.#database.sqlite
        .prepare("select 1 from saved_catalog_items where id = ?")
        .get(id);
      if (!collision) return id;
    }
    throw new SavedListServiceError("integrity_failure");
  }

  #membership(listId: string, userId: string, catalogId: string) {
    return this.#database.sqlite
      .prepare(
        `select id, position, created_at as createdAt
         from saved_list_items
         where list_id = ? and user_id = ? and catalog_item_id = ?`,
      )
      .get(listId, userId, catalogId) as SavedMembershipRow | undefined;
  }

  #insertMembership(
    listId: string,
    userId: string,
    catalogId: string,
    itemCount: number,
    now: number,
  ) {
    if (itemCount >= SAVED_LIST_MAX_ITEMS) {
      throw new SavedListServiceError("list_item_quota_reached");
    }
    const positionRow = this.#database.sqlite
      .prepare(
        "select coalesce(max(position), -1) + 1 as position from saved_list_items where list_id = ?",
      )
      .get(listId) as { position: number };
    if (
      !Number.isSafeInteger(positionRow.position) ||
      positionRow.position < 0 ||
      positionRow.position >= SAVED_LIST_MAX_ITEMS
    ) {
      throw new SavedListServiceError("list_item_quota_reached");
    }
    for (let attempt = 0; attempt < MAX_ID_CREATION_ATTEMPTS; attempt += 1) {
      const id = `saved_item_${this.#createItemToken()}`;
      if (!LIST_ITEM_ID_PATTERN.test(id)) {
        throw new SavedListServiceError("integrity_failure");
      }
      try {
        this.#database.sqlite
          .prepare(
            `insert into saved_list_items (
               id, user_id, list_id, catalog_item_id, position, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, userId, listId, catalogId, positionRow.position, now, now);
        return { createdAt: now, id, position: positionRow.position };
      } catch (error) {
        const collision = this.#database.sqlite
          .prepare("select 1 from saved_list_items where id = ?")
          .get(id);
        if (!collision) throw error;
      }
    }
    throw new SavedListServiceError("integrity_failure");
  }

  #membershipResponse(
    created: boolean,
    listId: string,
    revision: number,
    membership: SavedMembershipRow,
    catalogId: string,
    target: ResolvedSavedTarget,
  ) {
    if (!LIST_ITEM_ID_PATTERN.test(membership.id)) {
      throw new SavedListServiceError("storage_failure");
    }
    const artworkPrefix = `/v1/saved/catalog/${catalogId}/images/`;
    return savedListMembershipResponseSchema.parse({
      created,
      item: {
        addedAt: new Date(membership.createdAt).toISOString(),
        catalog: savedCatalogItemSchema.parse({
          artwork: {
            accentColor: null,
            backdropPath: target.payload.artwork.backdrop ? `${artworkPrefix}backdrop` : null,
            blurHash: null,
            posterPath: target.payload.artwork.poster ? `${artworkPrefix}poster` : null,
          },
          availability:
            target.payload.source === "jellyfin" ? "owned" : target.payload.availability,
          favorite: target.payload.favorite,
          id: catalogId,
          kind: target.payload.kind,
          libraryReferenceId: target.payload.libraryReferenceId,
          overview: target.payload.overview,
          resolutionState: target.payload.resolutionState,
          title: target.payload.title,
          year: target.payload.year,
        }),
        id: membership.id,
        position: membership.position,
      },
      listId,
      revision,
    });
  }

  #listItemRows(listId: string, userId: string) {
    return this.#database.sqlite
      .prepare(
        `select saved_list_items.id as id, saved_list_items.position as position,
                saved_list_items.created_at as createdAt,
                saved_catalog_items.id as catalogId,
                saved_catalog_items.encrypted_snapshot as encryptedSnapshot,
                saved_catalog_items.library_reference_id as libraryReferenceId
         from saved_list_items
         join saved_catalog_items
           on saved_catalog_items.id = saved_list_items.catalog_item_id
          and saved_catalog_items.user_id = saved_list_items.user_id
         where saved_list_items.list_id = ? and saved_list_items.user_id = ?`,
      )
      .all(listId, userId) as SavedListItemRow[];
  }

  #mutableMembership(listId: string, userId: string, catalogId: string) {
    return this.#database.sqlite
      .prepare(
        `select id, catalog_item_id as catalogItemId, position, created_at as createdAt
         from saved_list_items
         where list_id = ? and user_id = ? and catalog_item_id = ?`,
      )
      .get(listId, userId, catalogId) as MutableSavedMembershipRow | undefined;
  }

  #reorderWindow(listId: string, userId: string, startPosition: number, length: number) {
    return this.#database.sqlite
      .prepare(
        `select id, catalog_item_id as catalogItemId, position, created_at as createdAt
         from saved_list_items
         where list_id = ? and user_id = ? and position >= ? and position < ?
         order by position`,
      )
      .all(listId, userId, startPosition, startPosition + length) as MutableSavedMembershipRow[];
  }

  #insertExistingMembership(
    listId: string,
    userId: string,
    row: MutableSavedMembershipRow,
    position: number,
    now: number,
  ) {
    const inserted = this.#database.sqlite
      .prepare(
        `insert into saved_list_items (
           id, user_id, list_id, catalog_item_id, position, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, userId, listId, row.catalogItemId, position, row.createdAt, now);
    if (inserted.changes !== 1) throw new SavedListServiceError("storage_failure");
  }

  #listItem(row: SavedListItemRow, userId: string) {
    if (
      !LIST_ITEM_ID_PATTERN.test(row.id) ||
      !CATALOG_ID_PATTERN.test(row.catalogId) ||
      (row.libraryReferenceId !== null && !MEDIA_REFERENCE_ID_PATTERN.test(row.libraryReferenceId))
    ) {
      throw new SavedListServiceError("storage_failure");
    }
    const snapshot = storedSavedCatalogSnapshotSchema.parse(
      JSON.parse(
        this.#cipher.decrypt(
          row.encryptedSnapshot,
          this.#catalogSnapshotContext(userId, row.catalogId),
        ),
      ),
    );
    const owned = row.libraryReferenceId !== null;
    const removedOwnedTitle = !owned && snapshot.availability === "owned";
    const artworkPrefix = `/v1/saved/catalog/${row.catalogId}/images/`;
    return {
      addedAt: new Date(row.createdAt).toISOString(),
      catalog: savedCatalogItemSchema.parse({
        artwork: {
          accentColor: null,
          backdropPath: owned && snapshot.artwork.backdrop ? `${artworkPrefix}backdrop` : null,
          blurHash: null,
          posterPath: owned && snapshot.artwork.poster ? `${artworkPrefix}poster` : null,
        },
        availability: owned ? "owned" : removedOwnedTitle ? "unavailable" : snapshot.availability,
        favorite: owned ? snapshot.favorite : { state: "not_applicable", value: null },
        id: row.catalogId,
        kind: snapshot.kind,
        libraryReferenceId: row.libraryReferenceId,
        overview: snapshot.overview,
        resolutionState: removedOwnedTitle ? "missing" : snapshot.resolutionState,
        title: snapshot.title,
        year: snapshot.year,
      }),
      id: row.id,
      position: row.position,
    };
  }

  #compareListItems(
    left: SavedListItemsResponse["items"][number],
    right: SavedListItemsResponse["items"][number],
    query: SavedListItemsQuery,
  ) {
    if (query.sort === "added_desc") {
      return (
        Date.parse(right.addedAt) - Date.parse(left.addedAt) || right.id.localeCompare(left.id)
      );
    }
    if (query.sort === "title") {
      const leftTitle = left.catalog.title.toLowerCase();
      const rightTitle = right.catalog.title.toLowerCase();
      return leftTitle < rightTitle
        ? -1
        : leftTitle > rightTitle
          ? 1
          : left.id.localeCompare(right.id);
    }
    return left.position - right.position || left.id.localeCompare(right.id);
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

  #catalogIdentityContext(userId: string, catalogId: string) {
    return `saved_catalog_identity_payload:${userId}:${catalogId}`;
  }

  #catalogSnapshotContext(userId: string, catalogId: string) {
    return `saved_catalog_snapshot:${userId}:${catalogId}`;
  }

  #operationContext(userId: string, operationId: string) {
    return `saved_list_operation:${userId}:${operationId}`;
  }

  #cursorContext(userId: string) {
    return `saved_list_cursor:${userId}`;
  }

  #itemCursorContext(userId: string, listId: string) {
    return `saved_list_item_cursor:${userId}:${listId}`;
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

  #encodeItemCursor(
    payload: z.infer<typeof itemCursorPayloadSchema>,
    userId: string,
    listId: string,
  ) {
    return this.#cipher.encrypt(JSON.stringify(payload), this.#itemCursorContext(userId, listId));
  }

  #decodeItemCursor(value: string, userId: string, listId: string) {
    try {
      return itemCursorPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(value, this.#itemCursorContext(userId, listId))),
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
    kind: "add_item" | "create_list" | "reorder_items" | "restore_list",
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
