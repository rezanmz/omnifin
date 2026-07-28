import {
  SeerrIssueClient,
  SeerrIssueError,
  type SeerrIssueListInput,
  type SeerrIssuePage,
  type SeerrIssueRecord,
} from "@omnifin/connectors/issues/seerr-issue-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { OptionalApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
  type ConnectorCapability,
} from "@omnifin/contracts/connectors";
import {
  mediaIssueStatusUpdateSchema,
  mediaIssueWorkbenchItemSchema,
  mediaIssueWorkbenchPageSchema,
  mediaIssueWorkbenchQuerySchema,
  playbackIssueIdSchema,
  type MediaIssueSource,
  type MediaIssueStatusUpdate,
  type MediaIssueWorkbenchItem,
  type MediaIssueWorkbenchPage,
  type MediaIssueWorkbenchQuery,
} from "@omnifin/contracts/issues";
import { idempotencyKeySchema } from "@omnifin/contracts/requests";
import { X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";

const EXTERNAL_REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_EXTERNAL_REFERENCES = 4_096;
const MAX_ID_ATTEMPTS = 8;
const OPERATION_ID_PATTERN = /^issue_operation_[A-Za-z0-9_-]{22}$/u;

const storedMediaReferenceSchema = z.union([
  z.strictObject({
    artwork: z.unknown(),
    itemId: z.string(),
    schemaVersion: z.literal(1),
  }),
  z.strictObject({
    artwork: z.unknown(),
    episodeNumber: z.int().nonnegative().max(100_000).nullable(),
    itemId: z.string(),
    kind: z.enum(["movie", "episode", "other"]),
    schemaVersion: z.literal(2),
    seasonNumber: z.int().nonnegative().max(100_000).nullable(),
    title: z.string().trim().min(1).max(300),
    year: z.int().min(1870).max(2200).nullable(),
  }),
]);
const storedExternalReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  upstreamId: z.int().positive().max(2_147_483_647),
});

interface SeerrConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  displayName: string;
  encryptedCredentials: string;
  healthState: string;
  id: string;
  insecureHttpApproved: number;
  tlsPolicy: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

interface LocalIssueRow {
  category: string;
  createdAt: number;
  displayName: string;
  encryptedDescription: string | null;
  encryptedMediaReference: string;
  id: string;
  mediaReferenceId: string;
  positionSeconds: number;
  state: string;
  updatedAt: number;
}

interface ExternalReferenceRow {
  connectorId: string;
  encryptedUpstreamId: string;
  id: string;
}

interface IdempotencyRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  responseJson: string | null;
  state: string;
}

export interface IssueWorkbenchConnector {
  listIssues(input: SeerrIssueListInput, signal?: AbortSignal): Promise<SeerrIssuePage>;
  updateIssueStatus(
    upstreamId: number,
    input: MediaIssueStatusUpdate,
    signal?: AbortSignal,
  ): Promise<SeerrIssueRecord>;
}

export interface IssueWorkbenchDependencies {
  clock?: () => Date;
  createClient?: (config: OptionalApiKeyConnectorConfig) => IssueWorkbenchConnector;
  createToken?: () => string;
}

export interface IssueWorkbenchContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface IssueWorkbenchUpdateResult {
  issue: MediaIssueWorkbenchItem;
  replayed: boolean;
}

export type IssueWorkbenchFailureCode =
  | "configuration_unavailable"
  | "issue_conflict"
  | "issue_not_found"
  | "response_invalid"
  | "temporarily_unavailable";

const PERSISTED_FAILURE_CODES = new Set<IssueWorkbenchFailureCode>([
  "configuration_unavailable",
  "issue_conflict",
  "issue_not_found",
  "response_invalid",
  "temporarily_unavailable",
]);

export type IssueWorkbenchServiceErrorReason =
  | IssueWorkbenchFailureCode
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "integrity_failure"
  | "principal_unavailable"
  | "storage_failure";

export class IssueWorkbenchServiceError extends Error {
  public readonly reason: IssueWorkbenchServiceErrorReason;

  public constructor(reason: IssueWorkbenchServiceErrorReason, options?: ErrorOptions) {
    super("The issue workbench operation could not be completed.", options);
    this.name = "IssueWorkbenchServiceError";
    this.reason = reason;
  }
}

function connectorCredentialContext(connectorId: string) {
  return `connector_credentials:seerr:${connectorId}`;
}

function descriptionContext(issueId: string) {
  return `media_issue_description:${issueId}`;
}

function resolutionContext(issueId: string) {
  return `media_issue_resolution:${issueId}`;
}

function mediaReferenceContext(referenceId: string) {
  return `media_reference:jellyfin:${referenceId}`;
}

function externalReferenceContext(referenceId: string) {
  return `external_issue_reference:seerr:${referenceId}`;
}

function connectorSecrets(
  row: SeerrConnectorRow,
  cipher: EnvelopeCipher,
): { apiKey: string; tlsCaCertificatePem?: string } {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, connectorCredentialContext(row.id)),
    ) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("invalid");
    }
    const record = decoded as Record<string, unknown>;
    const versioned = record.schemaVersion === 1;
    if (
      versioned &&
      Object.keys(record).some(
        (key) => !["credentials", "schemaVersion", "tlsCaCertificatePem"].includes(key),
      )
    ) {
      throw new Error("invalid");
    }
    const stored = versioned
      ? (record as unknown as StoredConnectorSecrets)
      : ({ credentials: decoded, schemaVersion: 1 } satisfies StoredConnectorSecrets);
    const credentials = connectorCredentialInputSchema.parse(stored.credentials);
    if (credentials.kind !== "api_key") throw new Error("invalid");
    const tlsCaCertificatePem = stored.tlsCaCertificatePem;
    if (tlsCaCertificatePem !== undefined) {
      if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
        throw new Error("invalid");
      }
      const certificate = new X509Certificate(tlsCaCertificatePem);
      if (!certificate.ca) throw new Error("invalid");
    }
    return {
      apiKey: credentials.apiKey,
      ...(typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {}),
    };
  } catch (error) {
    throw new IssueWorkbenchServiceError("integrity_failure", { cause: error });
  }
}

function hasCapability(row: SeerrConnectorRow, capability: ConnectorCapability) {
  try {
    const decoded = JSON.parse(row.capabilitySnapshotJson) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const record = decoded as Record<string, unknown>;
    if (record.schemaVersion !== 1) return false;
    const health = connectorHealthSchema.safeParse(record.health);
    return (
      health.success &&
      health.data.connectorId === row.id &&
      health.data.service === "seerr" &&
      health.data.status === "healthy" &&
      row.healthState === "healthy" &&
      health.data.capabilities.includes(capability)
    );
  } catch {
    return false;
  }
}

function knownFailure(error: unknown): IssueWorkbenchFailureCode {
  if (error instanceof IssueWorkbenchServiceError) {
    if (error.reason === "issue_not_found" || error.reason === "issue_conflict") {
      return error.reason;
    }
    if (
      error.reason === "configuration_unavailable" ||
      error.reason === "integrity_failure" ||
      error.reason === "storage_failure"
    ) {
      return "configuration_unavailable";
    }
  }
  if (error instanceof SeerrIssueError) return error.reason;
  if (error instanceof SafeConnectorError) {
    if (error.code === "response_invalid" || error.code === "unsupported_version") {
      return "response_invalid";
    }
    if (
      error.code === "configuration_invalid" ||
      error.code === "destination_blocked" ||
      error.code === "invalid_credentials"
    ) {
      return "configuration_unavailable";
    }
  }
  return "temporarily_unavailable";
}

function toIso(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new IssueWorkbenchServiceError("integrity_failure");
  }
  return new Date(value).toISOString();
}

export class IssueWorkbenchService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createClient: (config: OptionalApiKeyConnectorConfig) => IssueWorkbenchConnector;
  readonly #createToken: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: IssueWorkbenchDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createToken = dependencies.createToken ?? (() => randomToken(16));
    this.#createClient = dependencies.createClient ?? ((input) => new SeerrIssueClient(input));
  }

  public async list(
    rawQuery: MediaIssueWorkbenchQuery,
    context: IssueWorkbenchContext,
    signal?: AbortSignal,
  ): Promise<MediaIssueWorkbenchPage> {
    this.#principal(context.principal);
    const query = mediaIssueWorkbenchQuerySchema.parse(rawQuery);
    let localItems: MediaIssueWorkbenchItem[] = [];
    let localTruncated = false;
    let omnifinState: "available" | "unavailable" = "available";
    if (query.source !== "seerr") {
      try {
        const local = this.#listLocal(query);
        localItems = local.items;
        localTruncated = local.truncated;
      } catch {
        omnifinState = "unavailable";
      }
    }

    let seerrItems: MediaIssueWorkbenchItem[] = [];
    let seerrTruncated = false;
    const seerrSource = this.#seerrSource("issue.read");
    let seerrState: "available" | "unavailable" | "unconfigured" = seerrSource.state;
    if (query.source !== "omnifin" && seerrSource.state === "available") {
      try {
        const response = await this.#client(seerrSource.row).listIssues(
          { limit: query.limit, status: query.status },
          signal,
        );
        seerrItems = this.#referenceExternalIssues(seerrSource.row.id, response.items);
        seerrTruncated = response.truncated;
      } catch {
        seerrState = "unavailable";
      }
    }

    const merged = [...localItems, ...seerrItems].sort((left, right) => {
      const byTime = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    });
    const truncated = localTruncated || seerrTruncated || merged.length > query.limit;
    return mediaIssueWorkbenchPageSchema.parse({
      generatedAt: this.#clock().toISOString(),
      items: merged.slice(0, query.limit),
      limit: query.limit,
      source: query.source,
      sourceStates: { omnifin: omnifinState, seerr: seerrState },
      status: query.status,
      truncated,
    });
  }

  public async updateStatus(
    rawIssueId: string,
    rawInput: MediaIssueStatusUpdate,
    rawIdempotencyKey: string,
    context: IssueWorkbenchContext,
    signal?: AbortSignal,
  ): Promise<IssueWorkbenchUpdateResult> {
    const principal = this.#principal(context.principal);
    const issueId = playbackIssueIdSchema.parse(rawIssueId);
    const input = mediaIssueStatusUpdateSchema.parse(rawInput);
    const source = this.#sourceForIssue(issueId);
    const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(JSON.stringify({ input, issueId, source }));
    const keyHash = hashToken(`${principal.userId}\u0000issue_status\u0000${idempotencyKey}`);
    const reservation = this.#reserve(
      principal.userId,
      issueId,
      source,
      input.status,
      keyHash,
      fingerprintHash,
    );
    if (reservation.kind === "replay") return { issue: reservation.response, replayed: true };
    if (reservation.kind === "failure") {
      throw new IssueWorkbenchServiceError(reservation.failureCode);
    }
    if (reservation.kind === "conflict") {
      throw new IssueWorkbenchServiceError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new IssueWorkbenchServiceError("idempotency_in_progress");
    }

    let response: MediaIssueWorkbenchItem;
    try {
      response =
        source === "omnifin"
          ? this.#updateLocal(issueId, input.status, principal.userId)
          : await this.#updateExternal(issueId, input, signal);
      if (response.id !== issueId || response.status !== input.status) {
        throw new IssueWorkbenchServiceError("integrity_failure");
      }
    } catch (error) {
      const failureCode = knownFailure(error);
      this.#completeFailure(reservation.operationId, issueId, source, input, failureCode, context);
      throw new IssueWorkbenchServiceError(failureCode, { cause: error });
    }
    this.#completeSuccess(reservation.operationId, response, input, context);
    return { issue: response, replayed: false };
  }

  #principal(principal: SessionPrincipal) {
    const authorized = requirePermission(principal, "issue.manage");
    if (authorized.accountState !== "active" || !authorized.userId) {
      throw new IssueWorkbenchServiceError("principal_unavailable");
    }
    return authorized as typeof authorized & { userId: string };
  }

  #listLocal(query: MediaIssueWorkbenchQuery) {
    try {
      const statusClause = query.status === "all" ? "" : "and media_issues.state = ?";
      const parameters =
        query.status === "all" ? [query.limit + 1] : [query.status, query.limit + 1];
      const rows = this.#database.sqlite
        .prepare(
          `select
             media_issues.id,
             media_issues.media_reference_id as mediaReferenceId,
             media_issues.category,
             media_issues.encrypted_description as encryptedDescription,
             media_issues.position_seconds as positionSeconds,
             media_issues.state,
             media_issues.created_at as createdAt,
             media_issues.updated_at as updatedAt,
             users.display_name as displayName,
             media_references.encrypted_payload as encryptedMediaReference
           from media_issues
           join users on users.id = media_issues.user_id
           join media_references on media_references.id = media_issues.media_reference_id
           where 1 = 1 ${statusClause}
           order by media_issues.updated_at desc, media_issues.id asc
           limit ?`,
        )
        .all(...parameters) as LocalIssueRow[];
      return {
        items: rows.slice(0, query.limit).map((row) => this.#localItem(row)),
        truncated: rows.length > query.limit,
      };
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #localItem(row: LocalIssueRow, stateOverride?: "open" | "resolved", updatedAt?: number) {
    try {
      const id = playbackIssueIdSchema.parse(row.id);
      const reference = storedMediaReferenceSchema.parse(
        JSON.parse(
          this.#cipher.decrypt(
            row.encryptedMediaReference,
            mediaReferenceContext(row.mediaReferenceId),
          ),
        ),
      );
      const summary = row.encryptedDescription
        ? this.#cipher.decrypt(row.encryptedDescription, descriptionContext(id))
        : null;
      const v2 = reference.schemaVersion === 2 ? reference : null;
      return mediaIssueWorkbenchItemSchema.parse({
        category: row.category,
        createdAt: toIso(row.createdAt),
        episodeNumber: v2?.kind === "episode" ? v2.episodeNumber : null,
        id,
        kind: v2?.kind === "episode" ? "episode" : v2?.kind === "movie" ? "movie" : "unknown",
        positionSeconds: row.positionSeconds,
        reportedBy: row.displayName,
        seasonNumber: v2?.kind === "episode" ? v2.seasonNumber : null,
        source: "omnifin",
        status: stateOverride ?? row.state,
        summary,
        title: v2?.title ?? "Unavailable title",
        updatedAt: toIso(updatedAt ?? row.updatedAt),
        year: v2?.year ?? null,
      });
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("integrity_failure", { cause: error });
    }
  }

  #seerrRows(connectorId?: string) {
    try {
      const where = connectorId
        ? "type = 'seerr' and enabled = 1 and id = ?"
        : "type = 'seerr' and enabled = 1";
      return this.#database.sqlite
        .prepare(
          `select
             id,
             display_name as displayName,
             base_url as baseUrl,
             encrypted_credentials as encryptedCredentials,
             capability_snapshot_json as capabilitySnapshotJson,
             health_state as healthState,
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where ${where}
           order by id asc
           limit 2`,
        )
        .all(...(connectorId ? [connectorId] : [])) as SeerrConnectorRow[];
    } catch (error) {
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #seerrSource(
    capability: ConnectorCapability,
  ): { state: "available"; row: SeerrConnectorRow } | { state: "unavailable" | "unconfigured" } {
    const rows = this.#seerrRows();
    if (rows.length === 0) return { state: "unconfigured" };
    if (rows.length !== 1 || !hasCapability(rows[0]!, capability)) {
      return { state: "unavailable" };
    }
    return { row: rows[0]!, state: "available" };
  }

  #client(row: SeerrConnectorRow) {
    const secrets = connectorSecrets(row, this.#cipher);
    try {
      return this.#createClient({
        apiKey: secrets.apiKey,
        baseUrl: row.baseUrl,
        connectorId: row.id,
        displayName: row.displayName,
        insecureHttpApproved: row.insecureHttpApproved === 1,
        tlsPolicy: row.tlsPolicy === "allow_self_signed" ? "allow_self_signed" : "strict",
        ...(secrets.tlsCaCertificatePem
          ? { tlsCaCertificatePem: secrets.tlsCaCertificatePem }
          : {}),
        clock: { monotonicNow: () => performance.now(), now: this.#clock },
      });
    } catch (error) {
      throw new IssueWorkbenchServiceError("integrity_failure", { cause: error });
    }
  }

  #referenceExternalIssues(connectorId: string, issues: readonly SeerrIssueRecord[]) {
    try {
      return this.#database.sqlite.transaction(() => {
        const now = this.#now();
        const expiresAt = now + EXTERNAL_REFERENCE_TTL_MS;
        if (!Number.isSafeInteger(expiresAt)) {
          throw new IssueWorkbenchServiceError("integrity_failure");
        }
        this.#database.sqlite
          .prepare("delete from external_issue_references where expires_at <= ?")
          .run(now);
        const referenced = issues.map((issue) => {
          const id = this.#upsertExternalReference(connectorId, issue.upstreamId, now, expiresAt);
          return this.#externalItem(id, issue);
        });
        this.#enforceExternalReferenceLimit(
          connectorId,
          referenced.map(({ id }) => id),
        );
        return referenced;
      })();
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #upsertExternalReference(
    connectorId: string,
    upstreamId: number,
    now: number,
    expiresAt: number,
  ) {
    const digest = privacyHash(
      "external_issue_reference",
      `${connectorId}\u0000${upstreamId}`,
      this.#config.encryptionKey,
    );
    const existing = this.#database.sqlite
      .prepare(
        `select id, connector_id as connectorId, encrypted_upstream_id as encryptedUpstreamId
         from external_issue_references
         where connector_id = ? and upstream_id_digest = ?
         limit 1`,
      )
      .get(connectorId, digest) as ExternalReferenceRow | undefined;
    if (existing) {
      if (this.#decodeExternalReference(existing) !== upstreamId) {
        throw new IssueWorkbenchServiceError("integrity_failure");
      }
      const updated = this.#database.sqlite
        .prepare(
          `update external_issue_references
           set last_used_at = ?, expires_at = ?, updated_at = ?
           where id = ? and connector_id = ?`,
        )
        .run(now, expiresAt, now, existing.id, connectorId);
      if (updated.changes !== 1) throw new IssueWorkbenchServiceError("integrity_failure");
      return playbackIssueIdSchema.parse(existing.id);
    }

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = playbackIssueIdSchema.parse(`issue_${this.#token()}`);
      const collision =
        this.#database.sqlite.prepare("select 1 from media_issues where id = ?").get(id) ??
        this.#database.sqlite
          .prepare("select 1 from external_issue_references where id = ?")
          .get(id);
      if (collision) continue;
      const encrypted = this.#cipher.encrypt(
        JSON.stringify({ schemaVersion: 1, upstreamId }),
        externalReferenceContext(id),
      );
      this.#database.sqlite
        .prepare(
          `insert into external_issue_references (
             id, connector_id, upstream_id_digest, encrypted_upstream_id,
             last_used_at, expires_at, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, connectorId, digest, encrypted, now, expiresAt, now, now);
      return id;
    }
    throw new IssueWorkbenchServiceError("integrity_failure");
  }

  #enforceExternalReferenceLimit(connectorId: string, protectedIds: readonly string[]) {
    const count = this.#database.sqlite
      .prepare("select count(*) as count from external_issue_references where connector_id = ?")
      .get(connectorId) as { count: number };
    if (count.count <= MAX_EXTERNAL_REFERENCES) return;
    const placeholders = protectedIds.map(() => "?").join(", ") || "''";
    this.#database.sqlite
      .prepare(
        `delete from external_issue_references
         where id in (
           select id from external_issue_references
           where connector_id = ? and id not in (${placeholders})
           order by last_used_at asc, id asc
           limit ?
         )`,
      )
      .run(connectorId, ...protectedIds, count.count - MAX_EXTERNAL_REFERENCES);
    const remaining = this.#database.sqlite
      .prepare("select count(*) as count from external_issue_references where connector_id = ?")
      .get(connectorId) as { count: number };
    if (remaining.count > MAX_EXTERNAL_REFERENCES) {
      throw new IssueWorkbenchServiceError("integrity_failure");
    }
  }

  #externalItem(id: string, issue: SeerrIssueRecord) {
    return mediaIssueWorkbenchItemSchema.parse({
      category: issue.category,
      createdAt: issue.createdAt,
      episodeNumber: issue.episodeNumber,
      id,
      kind: issue.kind,
      positionSeconds: issue.positionSeconds,
      reportedBy: issue.reportedBy,
      seasonNumber: issue.seasonNumber,
      source: "seerr",
      status: issue.status,
      summary: issue.summary,
      title: issue.title,
      updatedAt: issue.updatedAt,
      year: issue.year,
    });
  }

  #sourceForIssue(issueId: string): MediaIssueSource {
    try {
      if (this.#database.sqlite.prepare("select 1 from media_issues where id = ?").get(issueId)) {
        return "omnifin";
      }
      if (
        this.#database.sqlite
          .prepare(
            "select 1 from external_issue_references where id = ? and expires_at > ? limit 1",
          )
          .get(issueId, this.#now())
      ) {
        return "seerr";
      }
      throw new IssueWorkbenchServiceError("issue_not_found");
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #updateLocal(issueId: string, status: "open" | "resolved", userId: string) {
    try {
      return this.#database.sqlite.transaction(() => {
        const row = this.#localRow(issueId);
        if (!row) throw new IssueWorkbenchServiceError("issue_not_found");
        if (row.state !== status) {
          const now = this.#now();
          const update =
            status === "resolved"
              ? this.#database.sqlite
                  .prepare(
                    `update media_issues
                     set state = 'resolved', encrypted_resolution = ?, resolved_by_user_id = ?,
                         resolved_at = ?, updated_at = ?
                     where id = ? and state = 'open'`,
                  )
                  .run(
                    this.#cipher.encrypt(
                      "Resolved through the issue workbench.",
                      resolutionContext(issueId),
                    ),
                    userId,
                    now,
                    now,
                    issueId,
                  )
              : this.#database.sqlite
                  .prepare(
                    `update media_issues
                     set state = 'open', encrypted_resolution = null, resolved_by_user_id = null,
                         resolved_at = null, updated_at = ?
                     where id = ? and state = 'resolved'`,
                  )
                  .run(now, issueId);
          if (update.changes !== 1) throw new IssueWorkbenchServiceError("issue_conflict");
          return this.#localItem(row, status, now);
        }
        return this.#localItem(row);
      })();
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #localRow(issueId: string) {
    return this.#database.sqlite
      .prepare(
        `select
           media_issues.id,
           media_issues.media_reference_id as mediaReferenceId,
           media_issues.category,
           media_issues.encrypted_description as encryptedDescription,
           media_issues.position_seconds as positionSeconds,
           media_issues.state,
           media_issues.created_at as createdAt,
           media_issues.updated_at as updatedAt,
           users.display_name as displayName,
           media_references.encrypted_payload as encryptedMediaReference
         from media_issues
         join users on users.id = media_issues.user_id
         join media_references on media_references.id = media_issues.media_reference_id
         where media_issues.id = ?
         limit 1`,
      )
      .get(issueId) as LocalIssueRow | undefined;
  }

  async #updateExternal(issueId: string, input: MediaIssueStatusUpdate, signal?: AbortSignal) {
    const reference = this.#externalReference(issueId);
    const rows = this.#seerrRows(reference.connectorId);
    if (rows.length !== 1 || !hasCapability(rows[0]!, "issue.manage")) {
      throw new IssueWorkbenchServiceError("configuration_unavailable");
    }
    const response = await this.#client(rows[0]!).updateIssueStatus(
      this.#decodeExternalReference(reference),
      input,
      signal,
    );
    return this.#externalItem(issueId, response);
  }

  #externalReference(issueId: string) {
    try {
      const row = this.#database.sqlite
        .prepare(
          `select id, connector_id as connectorId, encrypted_upstream_id as encryptedUpstreamId
           from external_issue_references
           where id = ? and expires_at > ?
           limit 1`,
        )
        .get(issueId, this.#now()) as ExternalReferenceRow | undefined;
      if (!row) throw new IssueWorkbenchServiceError("issue_not_found");
      return row;
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #decodeExternalReference(row: ExternalReferenceRow) {
    try {
      if (playbackIssueIdSchema.parse(row.id) !== row.id) throw new Error("invalid");
      return storedExternalReferenceSchema.parse(
        JSON.parse(this.#cipher.decrypt(row.encryptedUpstreamId, externalReferenceContext(row.id))),
      ).upstreamId;
    } catch (error) {
      throw new IssueWorkbenchServiceError("integrity_failure", { cause: error });
    }
  }

  #reserve(
    userId: string,
    issueId: string,
    source: MediaIssueSource,
    desiredStatus: "open" | "resolved",
    keyHash: string,
    fingerprintHash: string,
  ) {
    try {
      return this.#database.sqlite.transaction(() => {
        const existing = this.#database.sqlite
          .prepare(
            `select id, fingerprint_hash as fingerprintHash, state,
                    response_json as responseJson, failure_code as failureCode
             from media_issue_operations
             where user_id = ? and idempotency_key_hash = ?
             limit 1`,
          )
          .get(userId, keyHash) as IdempotencyRow | undefined;
        if (existing) {
          if (existing.fingerprintHash !== fingerprintHash) return { kind: "conflict" as const };
          if (existing.state === "pending") return { kind: "pending" as const };
          if (existing.state === "failed") {
            if (
              !existing.failureCode ||
              !PERSISTED_FAILURE_CODES.has(existing.failureCode as IssueWorkbenchFailureCode)
            ) {
              throw new IssueWorkbenchServiceError("integrity_failure");
            }
            return {
              failureCode: existing.failureCode as IssueWorkbenchFailureCode,
              kind: "failure" as const,
            };
          }
          if (existing.state === "succeeded" && existing.responseJson) {
            try {
              return {
                kind: "replay" as const,
                response: mediaIssueWorkbenchItemSchema.parse(JSON.parse(existing.responseJson)),
              };
            } catch (error) {
              throw new IssueWorkbenchServiceError("integrity_failure", { cause: error });
            }
          }
          throw new IssueWorkbenchServiceError("integrity_failure");
        }
        const operationId = `issue_operation_${this.#token()}`;
        if (!OPERATION_ID_PATTERN.test(operationId)) {
          throw new IssueWorkbenchServiceError("integrity_failure");
        }
        const now = this.#now();
        this.#database.sqlite
          .prepare(
            `insert into media_issue_operations (
               id, user_id, issue_id, source, desired_status,
               idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            operationId,
            userId,
            issueId,
            source,
            desiredStatus,
            keyHash,
            fingerprintHash,
            now,
            now,
          );
        return { kind: "reserved" as const, operationId };
      })();
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #completeSuccess(
    operationId: string,
    response: MediaIssueWorkbenchItem,
    input: MediaIssueStatusUpdate,
    context: IssueWorkbenchContext,
  ) {
    this.#complete(
      operationId,
      response.id,
      response.source,
      "success",
      response,
      null,
      input,
      context,
    );
  }

  #completeFailure(
    operationId: string,
    issueId: string,
    source: MediaIssueSource,
    input: MediaIssueStatusUpdate,
    failureCode: IssueWorkbenchFailureCode,
    context: IssueWorkbenchContext,
  ) {
    this.#complete(operationId, issueId, source, "failure", null, failureCode, input, context);
  }

  #complete(
    operationId: string,
    issueId: string,
    source: MediaIssueSource,
    outcome: "success" | "failure",
    response: MediaIssueWorkbenchItem | null,
    failureCode: IssueWorkbenchFailureCode | null,
    input: MediaIssueStatusUpdate,
    context: IssueWorkbenchContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite.transaction(() => {
        const update = this.#database.sqlite
          .prepare(
            `update media_issue_operations
             set state = ?, response_json = ?, failure_code = ?, completed_at = ?, updated_at = ?
             where id = ? and state = 'pending'`,
          )
          .run(
            outcome === "success" ? "succeeded" : "failed",
            response ? JSON.stringify(response) : null,
            failureCode,
            now,
            now,
            operationId,
          );
        if (update.changes !== 1) throw new IssueWorkbenchServiceError("integrity_failure");
        this.#database.sqlite
          .prepare(
            `insert into audit_events (
               id, actor_user_id, actor_session_id, actor_auth_method,
               event_type, outcome, target_type, target_id, request_id,
               metadata_json, ip_hash, created_at
             ) values (?, ?, ?, ?, ?, ?, 'media_issue', ?, ?, ?, ?, ?)`,
          )
          .run(
            this.#auditId(),
            context.principal.userId,
            context.principal.sessionId,
            context.principal.authenticationMethod.kind,
            outcome === "success" ? `media.issue.${input.status}` : "media.issue.update_failed",
            outcome,
            issueId,
            context.requestId ?? null,
            JSON.stringify({
              source,
              status: input.status,
              ...(failureCode ? { failureCode } : {}),
            }),
            context.ipAddress
              ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
              : null,
            now,
          );
      })();
    } catch (error) {
      if (error instanceof IssueWorkbenchServiceError) throw error;
      throw new IssueWorkbenchServiceError("storage_failure", { cause: error });
    }
  }

  #token() {
    const value = this.#createToken();
    if (!/^[A-Za-z0-9_-]{22}$/u.test(value)) {
      throw new IssueWorkbenchServiceError("integrity_failure");
    }
    return value;
  }

  #auditId() {
    const value = this.#createToken();
    if (!/^[A-Za-z0-9_-]{22}$/u.test(value)) {
      throw new IssueWorkbenchServiceError("integrity_failure");
    }
    return `audit_${value}`;
  }

  #now() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new IssueWorkbenchServiceError("integrity_failure");
    }
    return value;
  }
}
