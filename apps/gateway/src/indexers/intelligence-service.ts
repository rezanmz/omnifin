import { ProwlarrAdapter } from "@omnifin/connectors/adapters/prowlarr";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
  type ConnectorCapability,
} from "@omnifin/contracts/connectors";
import {
  indexerApplicationListResponseSchema,
  indexerFailureListResponseSchema,
  indexerIdentifierParameterSchema,
  indexerIntelligenceResponseSchema,
  indexerPageQuerySchema,
  indexerTestResponseSchema,
  type IndexerApplicationListResponse,
  type IndexerFailureListResponse,
  type IndexerIdentifierParameter,
  type IndexerIntelligenceResponse,
  type IndexerPageQuery,
  type IndexerTestResponse,
} from "@omnifin/contracts/indexers";
import { randomUUID, X509Certificate } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface IndexerConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  displayName: string;
  encryptedCredentials: string;
  healthState: string;
  id: string;
  insecureHttpApproved: number;
  tlsPolicy: string;
  type: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

export interface IndexerIntelligenceContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface IndexerIntelligenceAdapter {
  readApplicationPage: ProwlarrAdapter["readApplicationPage"];
  readFailurePage: ProwlarrAdapter["readFailurePage"];
  readIndexerIntelligencePage: ProwlarrAdapter["readIndexerIntelligencePage"];
  testIndexer: ProwlarrAdapter["testIndexer"];
}

export interface IndexerIntelligenceDependencies {
  clock?: () => Date;
  createAdapter?: (config: ApiKeyConnectorConfig) => IndexerIntelligenceAdapter;
  createId?: () => string;
}

export type IndexerIntelligenceErrorReason =
  | "connector_ambiguous"
  | "connector_integrity_failure"
  | "connector_unconfigured"
  | "cursor_invalid"
  | "identity_required"
  | "storage_failure";

export class IndexerIntelligenceError extends Error {
  public readonly reason: IndexerIntelligenceErrorReason;

  public constructor(reason: IndexerIntelligenceErrorReason, options?: ErrorOptions) {
    super("Indexer intelligence could not be retrieved.", options);
    this.name = "IndexerIntelligenceError";
    this.reason = reason;
  }
}

function credentialContext(connectorId: string) {
  return `connector_credentials:prowlarr:${connectorId}`;
}

function connectorSecrets(row: IndexerConnectorRow, cipher: EnvelopeCipher) {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, credentialContext(row.id)),
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
    throw new IndexerIntelligenceError("connector_integrity_failure", { cause: error });
  }
}

function hasCapability(row: IndexerConnectorRow, capability: ConnectorCapability) {
  try {
    const decoded = JSON.parse(row.capabilitySnapshotJson) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const record = decoded as Record<string, unknown>;
    if (record.schemaVersion !== 1) return false;
    const health = connectorHealthSchema.safeParse(record.health);
    return (
      health.success &&
      health.data.connectorId === row.id &&
      health.data.service === "prowlarr" &&
      health.data.status === "healthy" &&
      row.healthState === "healthy" &&
      health.data.capabilities.includes(capability)
    );
  } catch {
    return false;
  }
}

function encodeCursor(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (encodeCursor(decoded) !== cursor) throw new Error("invalid");
    return decoded;
  } catch (error) {
    throw new IndexerIntelligenceError("cursor_invalid", { cause: error });
  }
}

function decodeIdCursor(cursor: string | undefined) {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return undefined;
  const match = /^id:([1-9][0-9]{0,9})$/u.exec(decoded);
  if (!match) throw new IndexerIntelligenceError("cursor_invalid");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) {
    throw new IndexerIntelligenceError("cursor_invalid");
  }
  return id;
}

function decodeFailureCursor(cursor: string | undefined, requestedLimit: number) {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return 1;
  const match = /^page:([1-9][0-9]{0,6}):([1-9][0-9]?)$/u.exec(decoded);
  if (!match) throw new IndexerIntelligenceError("cursor_invalid");
  const page = Number(match[1]);
  const limit = Number(match[2]);
  if (!Number.isSafeInteger(page) || page > 1_000_000 || limit !== requestedLimit) {
    throw new IndexerIntelligenceError("cursor_invalid");
  }
  return page;
}

export class IndexerIntelligenceService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<IndexerIntelligenceDependencies["createAdapter"]>;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: IndexerIntelligenceDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createAdapter =
      dependencies.createAdapter ?? ((adapterConfig) => new ProwlarrAdapter(adapterConfig));
  }

  public async readIndexers(
    rawQuery: IndexerPageQuery,
    context: IndexerIntelligenceContext,
    signal?: AbortSignal,
  ): Promise<IndexerIntelligenceResponse> {
    requirePermission(context.principal, "acquisition.manage");
    const query = indexerPageQuerySchema.parse(rawQuery);
    const afterId = decodeIdCursor(query.cursor);
    const result = await this.#adapter("indexer.statistics").readIndexerIntelligencePage(
      { ...(afterId === undefined ? {} : { afterId }), limit: query.limit },
      signal,
    );
    const last = result.items.at(-1);
    return indexerIntelligenceResponseSchema.parse({
      failures: result.failures,
      generatedAt: result.generatedAt,
      items: result.items,
      nextCursor: result.hasMore && last ? encodeCursor(`id:${last.id}`) : null,
      periodEndedAt: result.periodEndedAt,
      periodStartedAt: result.periodStartedAt,
      state: result.failures.length === 0 ? "complete" : "degraded",
      summary: result.summary,
    });
  }

  public async readApplications(
    rawQuery: IndexerPageQuery,
    context: IndexerIntelligenceContext,
    signal?: AbortSignal,
  ): Promise<IndexerApplicationListResponse> {
    requirePermission(context.principal, "acquisition.manage");
    const query = indexerPageQuerySchema.parse(rawQuery);
    const afterId = decodeIdCursor(query.cursor);
    const result = await this.#adapter("indexer.statistics").readApplicationPage(
      { ...(afterId === undefined ? {} : { afterId }), limit: query.limit },
      signal,
    );
    const last = result.items.at(-1);
    return indexerApplicationListResponseSchema.parse({
      generatedAt: result.generatedAt,
      items: result.items,
      nextCursor: result.hasMore && last ? encodeCursor(`id:${last.id}`) : null,
    });
  }

  public async readFailures(
    rawQuery: IndexerPageQuery,
    context: IndexerIntelligenceContext,
    signal?: AbortSignal,
  ): Promise<IndexerFailureListResponse> {
    requirePermission(context.principal, "acquisition.manage");
    const query = indexerPageQuerySchema.parse(rawQuery);
    const page = decodeFailureCursor(query.cursor, query.limit);
    const result = await this.#adapter("indexer.statistics").readFailurePage(
      { limit: query.limit, page },
      signal,
    );
    return indexerFailureListResponseSchema.parse({
      generatedAt: result.generatedAt,
      items: result.items,
      nextCursor: result.hasMore ? encodeCursor(`page:${page + 1}:${query.limit}`) : null,
    });
  }

  public async testIndexer(
    rawParameter: IndexerIdentifierParameter,
    context: IndexerIntelligenceContext,
    signal?: AbortSignal,
  ): Promise<IndexerTestResponse> {
    const principal = requirePermission(context.principal, "acquisition.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new IndexerIntelligenceError("identity_required");
    }
    const parameter = indexerIdentifierParameterSchema.parse(rawParameter);
    try {
      const result = indexerTestResponseSchema.parse(
        await this.#adapter("indexer.test").testIndexer(parameter.indexerId, signal),
      );
      this.#audit("success", parameter.indexerId, context, null);
      return result;
    } catch (error) {
      const failureCode =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code.slice(0, 64)
          : "temporarily_unavailable";
      this.#audit("failure", parameter.indexerId, context, failureCode);
      throw error;
    }
  }

  #adapter(capability: Extract<ConnectorCapability, "indexer.statistics" | "indexer.test">) {
    const row = this.#connector();
    const secrets = connectorSecrets(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      row.type !== "prowlarr" ||
      !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
      !row.displayName.trim() ||
      row.displayName.length > 160 ||
      !hasCapability(row, capability)
    ) {
      throw new IndexerIntelligenceError("connector_integrity_failure");
    }
    try {
      return this.#createAdapter({
        apiKey: secrets.apiKey,
        baseUrl: row.baseUrl,
        connectorId: row.id,
        displayName: row.displayName,
        insecureHttpApproved: row.insecureHttpApproved === 1,
        tlsPolicy,
        ...(secrets.tlsCaCertificatePem === undefined
          ? {}
          : { tlsCaCertificatePem: secrets.tlsCaCertificatePem }),
        clock: { now: this.#clock, monotonicNow: () => performance.now() },
      });
    } catch (error) {
      throw new IndexerIntelligenceError("connector_integrity_failure", { cause: error });
    }
  }

  #connector() {
    try {
      const rows = this.#database.sqlite
        .prepare(
          `select
             id,
             type,
             display_name as displayName,
             base_url as baseUrl,
             encrypted_credentials as encryptedCredentials,
             capability_snapshot_json as capabilitySnapshotJson,
             health_state as healthState,
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type = 'prowlarr' and enabled = 1
           order by id asc
           limit 2`,
        )
        .all() as IndexerConnectorRow[];
      if (rows.length === 0) throw new IndexerIntelligenceError("connector_unconfigured");
      if (rows.length > 1) throw new IndexerIntelligenceError("connector_ambiguous");
      return rows[0]!;
    } catch (error) {
      if (error instanceof IndexerIntelligenceError) throw error;
      throw new IndexerIntelligenceError("storage_failure", { cause: error });
    }
  }

  #audit(
    outcome: "failure" | "success",
    indexerId: number,
    context: IndexerIntelligenceContext,
    failureCode: string | null,
  ) {
    try {
      const id = this.#createId();
      const createdAt = this.#clock().getTime();
      if (!IDENTIFIER_PATTERN.test(id) || !Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new Error("invalid");
      }
      this.#database.sqlite
        .prepare(
          `insert into audit_events (
             id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
             target_type, target_id, request_id, metadata_json, ip_hash, created_at
           ) values (?, ?, ?, ?, ?, ?, 'prowlarr_indexer', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          context.principal.userId,
          context.principal.sessionId,
          context.principal.authenticationMethod.kind,
          outcome === "success" ? "indexer.test.passed" : "indexer.test.failed",
          outcome,
          String(indexerId),
          context.requestId ?? null,
          JSON.stringify({ ...(failureCode ? { failureCode } : {}), indexerId }),
          context.ipAddress
            ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
            : null,
          createdAt,
        );
    } catch (error) {
      throw new IndexerIntelligenceError("storage_failure", { cause: error });
    }
  }
}
