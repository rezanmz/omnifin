import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  auditEventListQuerySchema,
  auditEventListResponseSchema,
  type AuditEvent,
  type AuditEventActor,
  type AuditEventCategory,
  type AuditEventListResponse,
} from "@omnifin/contracts/audit";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";

const CURSOR_PREFIX = "audit_cursor_";
const CURSOR_CONTEXT = "audit_trail_cursor:v1";

const auditRowSchema = z.strictObject({
  actorAuthMethod: z.enum(["oidc", "jellyfin", "recovery"]).nullable(),
  actorUserId: z.string().min(1).max(128).nullable(),
  actorDisplayName: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  eventType: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-z][a-z0-9_.:-]+$/u),
  id: z.string().min(1).max(128),
  outcome: z.enum(["success", "denied", "failure"]),
});
type AuditRow = z.infer<typeof auditRowSchema>;

const cursorPayloadSchema = z.strictObject({
  beforeCreatedAt: z.number().int().nonnegative(),
  beforeId: z.string().min(1).max(128),
  category: z
    .enum([
      "access",
      "acquisition",
      "authentication",
      "configuration",
      "downloads",
      "indexers",
      "issues",
      "library",
      "requests",
      "system",
    ])
    .nullable(),
  limit: z.number().int().min(1).max(50),
  outcome: z.enum(["success", "denied", "failure"]).nullable(),
  snapshotAt: z.number().int().nonnegative(),
  snapshotRowId: z.number().int().nonnegative(),
  version: z.literal(1),
});
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

const CATEGORY_SQL: Record<AuditEventCategory, string> = {
  access:
    "(event_type like 'auth.user.%' or event_type like 'auth.oidc.provider.%' or event_type like 'auth.oidc.role%')",
  acquisition: "event_type like 'acquisition.%'",
  authentication:
    "(event_type like 'auth.%' and not (event_type like 'auth.user.%' or event_type like 'auth.oidc.provider.%' or event_type like 'auth.oidc.role%'))",
  configuration: "event_type like 'connector.%'",
  downloads: "event_type like 'download.%'",
  indexers: "event_type like 'indexer.%'",
  issues: "event_type like 'media.issue.%'",
  library: "(event_type like 'library.%' or event_type like 'subtitle.%')",
  requests: "event_type like 'media.request.%'",
  system:
    "not (event_type like 'auth.%' or event_type like 'acquisition.%' or event_type like 'connector.%' or event_type like 'download.%' or event_type like 'indexer.%' or event_type like 'media.issue.%' or event_type like 'library.%' or event_type like 'subtitle.%' or event_type like 'media.request.%')",
};

export type AuditTrailErrorReason = "cursor_invalid" | "permission_denied" | "storage_failure";

export class AuditTrailError extends Error {
  public readonly reason: AuditTrailErrorReason;

  public constructor(reason: AuditTrailErrorReason, options?: ErrorOptions) {
    super("The audit trail could not be retrieved.", options);
    this.name = "AuditTrailError";
    this.reason = reason;
  }
}

export interface AuditTrailDependencies {
  clock?: () => Date;
}

function categoryFor(eventType: string): AuditEventCategory {
  if (
    eventType.startsWith("auth.user.") ||
    eventType.startsWith("auth.oidc.provider.") ||
    eventType.startsWith("auth.oidc.role")
  ) {
    return "access";
  }
  if (eventType.startsWith("auth.")) return "authentication";
  if (eventType.startsWith("connector.")) return "configuration";
  if (eventType.startsWith("media.request.")) return "requests";
  if (eventType.startsWith("acquisition.")) return "acquisition";
  if (eventType.startsWith("download.")) return "downloads";
  if (eventType.startsWith("library.") || eventType.startsWith("subtitle.")) return "library";
  if (eventType.startsWith("media.issue.")) return "issues";
  if (eventType.startsWith("indexer.")) return "indexers";
  return "system";
}

function safeDisplayName(value: string | null) {
  const cleaned = value?.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return cleaned ? cleaned.slice(0, 160) : null;
}

function actorFor(row: AuditRow): AuditEventActor {
  const displayName = safeDisplayName(row.actorDisplayName);
  if (row.actorUserId && displayName) {
    return {
      authenticationMethod: row.actorAuthMethod,
      displayName,
      kind: "user",
    };
  }
  if (row.actorAuthMethod === "recovery") {
    return {
      authenticationMethod: "recovery",
      displayName: "Recovery access",
      kind: "recovery",
    };
  }
  if (row.actorAuthMethod === "oidc" || row.actorAuthMethod === "jellyfin") {
    return {
      authenticationMethod: row.actorAuthMethod,
      displayName: "Former account",
      kind: "removed_user",
    };
  }
  return { authenticationMethod: null, displayName: "Omnifin", kind: "system" };
}

export class AuditTrailService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: AuditTrailDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  public list(rawQuery: unknown, principal: SessionPrincipal): AuditEventListResponse {
    if (
      principal.accountState !== "active" ||
      principal.authenticationMethod.kind === "recovery" ||
      !principal.permissions.includes("audit.view")
    ) {
      throw new AuditTrailError("permission_denied");
    }

    const query = auditEventListQuerySchema.parse(rawQuery);
    const cursor = query.cursor ? this.#decodeCursor(query.cursor, query) : null;
    try {
      const snapshotAt = cursor?.snapshotAt ?? this.#clock().getTime();
      if (!Number.isSafeInteger(snapshotAt) || snapshotAt < 0) {
        throw new Error("Invalid audit snapshot time.");
      }
      const snapshotRowId = cursor?.snapshotRowId ?? this.#snapshotRowId();
      const where = ["audit_events.rowid <= ?", "audit_events.created_at <= ?"];
      const parameters: Array<number | string> = [snapshotRowId, snapshotAt];
      if (query.category) where.push(CATEGORY_SQL[query.category]);
      if (query.outcome) {
        where.push("audit_events.outcome = ?");
        parameters.push(query.outcome);
      }
      if (cursor) {
        where.push(
          "(audit_events.created_at < ? or (audit_events.created_at = ? and audit_events.id < ?))",
        );
        parameters.push(cursor.beforeCreatedAt, cursor.beforeCreatedAt, cursor.beforeId);
      }
      parameters.push(query.limit + 1);
      const rawRows = this.#database.sqlite
        .prepare(
          `select
             audit_events.id as id,
             audit_events.actor_user_id as actorUserId,
             audit_events.actor_auth_method as actorAuthMethod,
             users.display_name as actorDisplayName,
             audit_events.event_type as eventType,
             audit_events.outcome as outcome,
             audit_events.created_at as createdAt
           from audit_events
           left join users on users.id = audit_events.actor_user_id
           where ${where.join(" and ")}
           order by audit_events.created_at desc, audit_events.id desc
           limit ?`,
        )
        .all(...parameters);
      const rows = z
        .array(auditRowSchema)
        .max(query.limit + 1)
        .parse(rawRows);
      const visibleRows = rows.slice(0, query.limit);
      const events: AuditEvent[] = visibleRows.map((row) => ({
        actor: actorFor(row),
        category: categoryFor(row.eventType),
        eventType: row.eventType,
        id: `audit_${privacyHash("audit_event", row.id, this.#config.encryptionKey)}`,
        occurredAt: new Date(row.createdAt).toISOString(),
        outcome: row.outcome,
      }));
      const last = visibleRows.at(-1);
      return auditEventListResponseSchema.parse({
        events,
        generatedAt: new Date(snapshotAt).toISOString(),
        nextCursor:
          rows.length > visibleRows.length && last
            ? this.#encodeCursor({
                beforeCreatedAt: last.createdAt,
                beforeId: last.id,
                category: query.category ?? null,
                limit: query.limit,
                outcome: query.outcome ?? null,
                snapshotAt,
                snapshotRowId,
                version: 1,
              })
            : null,
      });
    } catch (error) {
      if (error instanceof AuditTrailError) throw error;
      throw new AuditTrailError("storage_failure", { cause: error });
    }
  }

  #snapshotRowId() {
    const row = this.#database.sqlite
      .prepare("select coalesce(max(rowid), 0) as snapshotRowId from audit_events")
      .get() as { snapshotRowId?: unknown } | undefined;
    if (!row || typeof row.snapshotRowId !== "number" || !Number.isSafeInteger(row.snapshotRowId)) {
      throw new Error("Invalid audit snapshot boundary.");
    }
    return row.snapshotRowId;
  }

  #encodeCursor(payload: CursorPayload) {
    return `${CURSOR_PREFIX}${this.#cipher.encrypt(JSON.stringify(payload), CURSOR_CONTEXT)}`;
  }

  #decodeCursor(value: string, query: ReturnType<typeof auditEventListQuerySchema.parse>) {
    try {
      if (!value.startsWith(CURSOR_PREFIX)) throw new Error("invalid");
      const decoded = cursorPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(value.slice(CURSOR_PREFIX.length), CURSOR_CONTEXT)),
      );
      if (
        decoded.limit !== query.limit ||
        decoded.category !== (query.category ?? null) ||
        decoded.outcome !== (query.outcome ?? null)
      ) {
        throw new Error("invalid");
      }
      return decoded;
    } catch (error) {
      throw new AuditTrailError("cursor_invalid", { cause: error });
    }
  }
}
