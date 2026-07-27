import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  acquisitionProvenanceResponseSchema,
  acquisitionSearchIdempotencyKeySchema,
  acquisitionSearchInputSchema,
  acquisitionSearchResponseSchema,
  acquisitionTargetInputSchema,
  type AcquisitionProvenanceResponse,
  type AcquisitionSearchInput,
  type AcquisitionSearchResponse,
  type AcquisitionService,
  type AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";
import {
  type ConnectorCapability,
  connectorCredentialInputSchema,
  connectorHealthSchema,
} from "@omnifin/contracts/connectors";
import { randomUUID, X509Certificate } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface AcquisitionConnectorRow {
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

interface AcquisitionSearchOperationRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  responseJson: string | null;
  state: string;
}

export interface AcquisitionProvenanceContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface AcquisitionProvenanceAdapter {
  queueAcquisitionSearch(
    input: AcquisitionSearchInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionSearchResponse>;
  readAcquisitionProvenance(
    input: AcquisitionTargetInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionProvenanceResponse>;
}

export interface AcquisitionProvenanceDependencies {
  clock?: () => Date;
  createId?: () => string;
  createAdapter?: (
    service: AcquisitionService,
    config: ApiKeyConnectorConfig,
  ) => AcquisitionProvenanceAdapter;
}

export interface AcquisitionSearchResult {
  replayed: boolean;
  search: AcquisitionSearchResponse;
}

export type AcquisitionSearchFailureCode =
  "configuration_unavailable" | "rate_limited" | "response_invalid" | "temporarily_unavailable";

const ACQUISITION_SEARCH_FAILURE_CODES = new Set<AcquisitionSearchFailureCode>([
  "configuration_unavailable",
  "rate_limited",
  "response_invalid",
  "temporarily_unavailable",
]);

export type AcquisitionProvenanceErrorReason =
  | AcquisitionSearchFailureCode
  | "connector_ambiguous"
  | "connector_integrity_failure"
  | "connector_unconfigured"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_required"
  | "storage_failure";

export class AcquisitionProvenanceError extends Error {
  public readonly reason: AcquisitionProvenanceErrorReason;

  public constructor(reason: AcquisitionProvenanceErrorReason, options?: ErrorOptions) {
    super("Acquisition provenance could not be retrieved.", options);
    this.name = "AcquisitionProvenanceError";
    this.reason = reason;
  }
}

function credentialContext(service: AcquisitionService, connectorId: string) {
  return `connector_credentials:${service}:${connectorId}`;
}

function connectorSecrets(
  row: AcquisitionConnectorRow,
  service: AcquisitionService,
  cipher: EnvelopeCipher,
): { apiKey: string; tlsCaCertificatePem?: string } {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, credentialContext(service, row.id)),
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
    throw new AcquisitionProvenanceError("connector_integrity_failure", { cause: error });
  }
}

function hasAcquisitionCapability(
  row: AcquisitionConnectorRow,
  service: AcquisitionService,
  capability: Extract<ConnectorCapability, "acquisition.history" | "acquisition.search">,
) {
  try {
    const decoded = JSON.parse(row.capabilitySnapshotJson) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const record = decoded as Record<string, unknown>;
    if (record.schemaVersion !== 1) return false;
    const health = connectorHealthSchema.safeParse(record.health);
    return (
      health.success &&
      health.data.connectorId === row.id &&
      health.data.service === service &&
      health.data.status === "healthy" &&
      row.healthState === "healthy" &&
      health.data.capabilities.includes(capability)
    );
  } catch {
    return false;
  }
}

function defaultAdapter(service: AcquisitionService, config: ApiKeyConnectorConfig) {
  return service === "radarr" ? new RadarrAdapter(config) : new SonarrAdapter(config);
}

function knownSearchFailure(error: unknown): AcquisitionSearchFailureCode {
  if (error instanceof AcquisitionProvenanceError) return "configuration_unavailable";
  if (error instanceof SafeConnectorError) {
    if (error.code === "rate_limited") return "rate_limited";
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

export class AcquisitionProvenanceService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<AcquisitionProvenanceDependencies["createAdapter"]>;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: AcquisitionProvenanceDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapter;
  }

  public async read(
    rawInput: AcquisitionTargetInput,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "acquisition.manage");
    const input = acquisitionTargetInputSchema.parse(rawInput);
    const adapter = this.#adapter(input.service, "acquisition.history");
    return acquisitionProvenanceResponseSchema.parse(
      await adapter.readAcquisitionProvenance(input, signal),
    );
  }

  public async queueSearch(
    rawInput: AcquisitionSearchInput,
    rawIdempotencyKey: string,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ): Promise<AcquisitionSearchResult> {
    const principal = requirePermission(context.principal, "acquisition.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new AcquisitionProvenanceError("identity_required");
    }
    const input = acquisitionSearchInputSchema.parse(rawInput);
    const idempotencyKey = acquisitionSearchIdempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(
      JSON.stringify({
        mediaId: input.mediaId,
        seasonNumber: input.seasonNumber ?? null,
        service: input.service,
      }),
    );
    const keyHash = hashToken(`${principal.userId}\u0000${idempotencyKey}`);
    const reservation = this.#reserve(principal.userId, keyHash, fingerprintHash);
    if (reservation.kind === "replay") {
      return { replayed: true, search: reservation.response };
    }
    if (reservation.kind === "failure") {
      throw new AcquisitionProvenanceError(reservation.failureCode);
    }
    if (reservation.kind === "conflict") {
      throw new AcquisitionProvenanceError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new AcquisitionProvenanceError("idempotency_in_progress");
    }

    let response: AcquisitionSearchResponse;
    try {
      const adapter = this.#adapter(input.service, "acquisition.search");
      response = acquisitionSearchResponseSchema.parse(
        await adapter.queueAcquisitionSearch(input, signal),
      );
    } catch (error) {
      const failureCode = knownSearchFailure(error);
      this.#completeFailure(reservation.operationId, failureCode, input, context);
      throw new AcquisitionProvenanceError(failureCode, { cause: error });
    }
    this.#completeSuccess(reservation.operationId, response, input, context);
    return { replayed: false, search: response };
  }

  #adapter(
    service: AcquisitionService,
    capability: Extract<ConnectorCapability, "acquisition.history" | "acquisition.search">,
  ) {
    const row = this.#connector(service);
    const secrets = connectorSecrets(row, service, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      row.type !== service ||
      !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
      !row.displayName.trim() ||
      row.displayName.length > 160 ||
      !hasAcquisitionCapability(row, service, capability)
    ) {
      throw new AcquisitionProvenanceError("connector_integrity_failure");
    }
    try {
      return this.#createAdapter(service, {
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
      throw new AcquisitionProvenanceError("connector_integrity_failure", { cause: error });
    }
  }

  #reserve(userId: string, keyHash: string, fingerprintHash: string) {
    try {
      return this.#database.sqlite.transaction(() => {
        const existing = this.#database.sqlite
          .prepare(
            `select
               id,
               fingerprint_hash as fingerprintHash,
               state,
               response_json as responseJson,
               failure_code as failureCode
             from acquisition_search_operations
             where user_id = ? and idempotency_key_hash = ?
             limit 1`,
          )
          .get(userId, keyHash) as AcquisitionSearchOperationRow | undefined;
        if (existing) {
          if (existing.fingerprintHash !== fingerprintHash) {
            return { kind: "conflict" as const };
          }
          if (existing.state === "pending") return { kind: "pending" as const };
          if (existing.state === "failed") {
            if (
              !existing.failureCode ||
              !ACQUISITION_SEARCH_FAILURE_CODES.has(
                existing.failureCode as AcquisitionSearchFailureCode,
              )
            ) {
              throw new AcquisitionProvenanceError("connector_integrity_failure");
            }
            return {
              failureCode: existing.failureCode as AcquisitionSearchFailureCode,
              kind: "failure" as const,
            };
          }
          if (existing.state === "succeeded" && existing.responseJson) {
            try {
              return {
                kind: "replay" as const,
                response: acquisitionSearchResponseSchema.parse(JSON.parse(existing.responseJson)),
              };
            } catch (error) {
              throw new AcquisitionProvenanceError("connector_integrity_failure", {
                cause: error,
              });
            }
          }
          throw new AcquisitionProvenanceError("connector_integrity_failure");
        }
        const operationId = this.#id();
        const now = this.#now();
        this.#database.sqlite
          .prepare(
            `insert into acquisition_search_operations (
               id, user_id, idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
             ) values (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(operationId, userId, keyHash, fingerprintHash, now, now);
        return { kind: "reserved" as const, operationId };
      })();
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
  }

  #completeSuccess(
    operationId: string,
    response: AcquisitionSearchResponse,
    input: AcquisitionSearchInput,
    context: AcquisitionProvenanceContext,
  ) {
    this.#complete(operationId, "success", response, null, input, context);
  }

  #completeFailure(
    operationId: string,
    failureCode: AcquisitionSearchFailureCode,
    input: AcquisitionSearchInput,
    context: AcquisitionProvenanceContext,
  ) {
    this.#complete(operationId, "failure", null, failureCode, input, context);
  }

  #complete(
    operationId: string,
    outcome: "success" | "failure",
    response: AcquisitionSearchResponse | null,
    failureCode: AcquisitionSearchFailureCode | null,
    input: AcquisitionSearchInput,
    context: AcquisitionProvenanceContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite.transaction(() => {
        const update = this.#database.sqlite
          .prepare(
            `update acquisition_search_operations
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
        if (update.changes !== 1) {
          throw new AcquisitionProvenanceError("connector_integrity_failure");
        }
        this.#audit(
          outcome,
          response?.operationId ?? operationId,
          input,
          context,
          now,
          failureCode,
        );
      })();
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
  }

  #audit(
    outcome: "success" | "failure",
    targetId: string,
    input: AcquisitionSearchInput,
    context: AcquisitionProvenanceContext,
    createdAt: number,
    failureCode: AcquisitionSearchFailureCode | null,
  ) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id,
           actor_user_id,
           actor_session_id,
           actor_auth_method,
           event_type,
           outcome,
           target_type,
           target_id,
           request_id,
           metadata_json,
           ip_hash,
           created_at
         ) values (?, ?, ?, ?, ?, ?, 'acquisition_search', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#id(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        outcome === "success" ? "acquisition.search.queued" : "acquisition.search.failed",
        outcome,
        targetId,
        context.requestId ?? null,
        JSON.stringify({
          ...(failureCode ? { failureCode } : {}),
          mediaId: input.mediaId,
          seasonNumber: input.seasonNumber ?? null,
          service: input.service,
        }),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #now() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AcquisitionProvenanceError("connector_integrity_failure");
    }
    return value;
  }

  #id() {
    const value = this.#createId();
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new AcquisitionProvenanceError("connector_integrity_failure");
    }
    return value;
  }

  #connector(service: AcquisitionService) {
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
           where type = ? and enabled = 1
           order by id asc
           limit 2`,
        )
        .all(service) as AcquisitionConnectorRow[];
      if (rows.length === 0) {
        throw new AcquisitionProvenanceError("connector_unconfigured");
      }
      if (rows.length > 1) {
        throw new AcquisitionProvenanceError("connector_ambiguous");
      }
      return rows[0]!;
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
  }
}
