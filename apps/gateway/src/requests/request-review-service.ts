import { SeerrAdapter, SeerrRequestError } from "@omnifin/connectors/adapters/seerr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { OptionalApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
} from "@omnifin/contracts/connectors";
import {
  idempotencyKeySchema,
  requestReviewDecisionInputSchema,
  requestReviewItemSchema,
  requestReviewPageSchema,
  requestReviewQuerySchema,
  type RequestReviewDecisionInput,
  type RequestReviewItem,
  type RequestReviewPage,
  type RequestReviewQuery,
} from "@omnifin/contracts/requests";
import { randomUUID, X509Certificate } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const REQUEST_IDENTIFIER_PATTERN = /^request:([1-9][0-9]{0,9})$/u;
const persistedRequestReviewItemSchema = requestReviewItemSchema.or(
  requestReviewItemSchema
    .omit({ qualityProfile: true })
    .transform((request) => ({ ...request, qualityProfile: "Profile unavailable" })),
);

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

interface IdempotencyRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  responseJson: string | null;
  state: string;
}

export interface RequestReviewAdapter {
  listMediaRequests(input: RequestReviewQuery, signal?: AbortSignal): Promise<RequestReviewPage>;
  reviewMediaRequest(
    requestId: string,
    input: RequestReviewDecisionInput,
    signal?: AbortSignal,
  ): Promise<RequestReviewItem>;
}

export interface RequestReviewDependencies {
  clock?: () => Date;
  createAdapter?: (config: OptionalApiKeyConnectorConfig) => RequestReviewAdapter;
  createId?: () => string;
}

export interface RequestReviewContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface RequestReviewResult {
  replayed: boolean;
  request: RequestReviewItem;
}

export type RequestReviewFailureCode =
  | "configuration_unavailable"
  | "request_conflict"
  | "request_denied"
  | "request_not_found"
  | "response_invalid"
  | "temporarily_unavailable";

const REQUEST_REVIEW_FAILURE_CODES = new Set<RequestReviewFailureCode>([
  "configuration_unavailable",
  "request_conflict",
  "request_denied",
  "request_not_found",
  "response_invalid",
  "temporarily_unavailable",
]);

export type RequestReviewServiceErrorReason =
  | RequestReviewFailureCode
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "integrity_failure"
  | "principal_unavailable"
  | "storage_failure";

export class RequestReviewServiceError extends Error {
  public readonly reason: RequestReviewServiceErrorReason;

  public constructor(reason: RequestReviewServiceErrorReason, options?: ErrorOptions) {
    super("The media request review could not be completed.", options);
    this.name = "RequestReviewServiceError";
    this.reason = reason;
  }
}

function credentialContext(connectorId: string) {
  return `connector_credentials:seerr:${connectorId}`;
}

function connectorSecrets(
  row: SeerrConnectorRow,
  cipher: EnvelopeCipher,
): { apiKey: string; tlsCaCertificatePem?: string } {
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
    throw new RequestReviewServiceError("integrity_failure", { cause: error });
  }
}

function hasReviewCapability(row: SeerrConnectorRow) {
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
      health.data.capabilities.includes("request.review")
    );
  } catch {
    return false;
  }
}

function knownFailure(error: unknown): RequestReviewFailureCode {
  if (error instanceof RequestReviewServiceError) {
    if (
      error.reason === "configuration_unavailable" ||
      error.reason === "integrity_failure" ||
      error.reason === "storage_failure"
    ) {
      return "configuration_unavailable";
    }
  }
  if (error instanceof SeerrRequestError) {
    switch (error.reason) {
      case "request_conflict":
        return "request_conflict";
      case "request_denied":
        return "request_denied";
      case "request_not_found":
        return "request_not_found";
      case "identity_ambiguous":
      case "identity_not_found":
      case "no_seasons_available":
        return "response_invalid";
    }
  }
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

export class RequestReviewService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: (config: OptionalApiKeyConnectorConfig) => RequestReviewAdapter;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: RequestReviewDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createAdapter = dependencies.createAdapter ?? ((input) => new SeerrAdapter(input));
  }

  public async list(
    rawQuery: RequestReviewQuery,
    context: RequestReviewContext,
    signal?: AbortSignal,
  ): Promise<RequestReviewPage> {
    this.#principal(context.principal);
    const query = requestReviewQuerySchema.parse(rawQuery);
    try {
      return requestReviewPageSchema.parse(await this.#adapter().listMediaRequests(query, signal));
    } catch (error) {
      throw new RequestReviewServiceError(knownFailure(error), { cause: error });
    }
  }

  public async review(
    rawRequestId: string,
    rawInput: RequestReviewDecisionInput,
    rawIdempotencyKey: string,
    context: RequestReviewContext,
    signal?: AbortSignal,
  ): Promise<RequestReviewResult> {
    const principal = this.#principal(context.principal);
    const requestMatch = REQUEST_IDENTIFIER_PATTERN.exec(rawRequestId);
    const upstreamId = Number(requestMatch?.[1]);
    if (!Number.isSafeInteger(upstreamId) || upstreamId > 2_147_483_647) {
      throw new RequestReviewServiceError("request_not_found");
    }
    const requestId = `request:${upstreamId}`;
    const input = requestReviewDecisionInputSchema.parse(rawInput);
    const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(JSON.stringify({ input, requestId }));
    const keyHash = hashToken(`${principal.userId}\u0000request_review\u0000${idempotencyKey}`);
    const reservation = this.#reserve(principal.userId, keyHash, fingerprintHash);
    if (reservation.kind === "replay") {
      return { replayed: true, request: reservation.response };
    }
    if (reservation.kind === "failure") {
      throw new RequestReviewServiceError(reservation.failureCode);
    }
    if (reservation.kind === "conflict") {
      throw new RequestReviewServiceError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new RequestReviewServiceError("idempotency_in_progress");
    }

    let response: RequestReviewItem;
    try {
      response = requestReviewItemSchema.parse(
        await this.#adapter().reviewMediaRequest(requestId, input, signal),
      );
      if (response.id !== requestId) throw new RequestReviewServiceError("integrity_failure");
    } catch (error) {
      const failureCode = knownFailure(error);
      this.#completeFailure(reservation.operationId, requestId, input, failureCode, context);
      throw new RequestReviewServiceError(failureCode, { cause: error });
    }

    this.#completeSuccess(reservation.operationId, response, input, context);
    return { replayed: false, request: response };
  }

  #principal(principal: SessionPrincipal) {
    const authorized = requirePermission(principal, "request.review");
    if (authorized.accountState !== "active" || !authorized.userId) {
      throw new RequestReviewServiceError("principal_unavailable");
    }
    return authorized as typeof authorized & { userId: string };
  }

  #connector() {
    try {
      const rows = this.#database.sqlite
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
           where type = 'seerr' and enabled = 1
           order by id asc
           limit 2`,
        )
        .all() as SeerrConnectorRow[];
      if (rows.length !== 1 || !hasReviewCapability(rows[0]!)) {
        throw new RequestReviewServiceError("configuration_unavailable");
      }
      return rows[0]!;
    } catch (error) {
      if (error instanceof RequestReviewServiceError) throw error;
      throw new RequestReviewServiceError("storage_failure", { cause: error });
    }
  }

  #adapter() {
    const connector = this.#connector();
    const secrets = connectorSecrets(connector, this.#cipher);
    try {
      return this.#createAdapter({
        apiKey: secrets.apiKey,
        baseUrl: connector.baseUrl,
        connectorId: connector.id,
        displayName: connector.displayName,
        insecureHttpApproved: connector.insecureHttpApproved === 1,
        tlsPolicy: connector.tlsPolicy === "allow_self_signed" ? "allow_self_signed" : "strict",
        ...(secrets.tlsCaCertificatePem
          ? { tlsCaCertificatePem: secrets.tlsCaCertificatePem }
          : {}),
        clock: { now: this.#clock, monotonicNow: () => performance.now() },
      });
    } catch (error) {
      throw new RequestReviewServiceError("integrity_failure", { cause: error });
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
             from media_request_operations
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
              !REQUEST_REVIEW_FAILURE_CODES.has(existing.failureCode as RequestReviewFailureCode)
            ) {
              throw new RequestReviewServiceError("integrity_failure");
            }
            return {
              failureCode: existing.failureCode as RequestReviewFailureCode,
              kind: "failure" as const,
            };
          }
          if (existing.state === "succeeded" && existing.responseJson) {
            try {
              return {
                kind: "replay" as const,
                response: persistedRequestReviewItemSchema.parse(JSON.parse(existing.responseJson)),
              };
            } catch (error) {
              throw new RequestReviewServiceError("integrity_failure", { cause: error });
            }
          }
          throw new RequestReviewServiceError("integrity_failure");
        }
        const operationId = this.#id();
        const now = this.#now();
        this.#database.sqlite
          .prepare(
            `insert into media_request_operations (
               id, user_id, idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
             ) values (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(operationId, userId, keyHash, fingerprintHash, now, now);
        return { kind: "reserved" as const, operationId };
      })();
    } catch (error) {
      if (error instanceof RequestReviewServiceError) throw error;
      throw new RequestReviewServiceError("storage_failure", { cause: error });
    }
  }

  #completeSuccess(
    operationId: string,
    response: RequestReviewItem,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    this.#complete(operationId, response.id, "success", response, null, input, context);
  }

  #completeFailure(
    operationId: string,
    requestId: string,
    input: RequestReviewDecisionInput,
    failureCode: RequestReviewFailureCode,
    context: RequestReviewContext,
  ) {
    this.#complete(operationId, requestId, "failure", null, failureCode, input, context);
  }

  #complete(
    operationId: string,
    targetId: string,
    outcome: "success" | "failure",
    response: RequestReviewItem | null,
    failureCode: RequestReviewFailureCode | null,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite.transaction(() => {
        const update = this.#database.sqlite
          .prepare(
            `update media_request_operations
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
        if (update.changes !== 1) throw new RequestReviewServiceError("integrity_failure");
        this.#audit(targetId, outcome, input, context, now, failureCode);
      })();
    } catch (error) {
      if (error instanceof RequestReviewServiceError) throw error;
      throw new RequestReviewServiceError("storage_failure", { cause: error });
    }
  }

  #audit(
    targetId: string,
    outcome: "success" | "failure",
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
    createdAt: number,
    failureCode: RequestReviewFailureCode | null,
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
         ) values (?, ?, ?, ?, ?, ?, 'media_request', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#id(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        outcome === "success"
          ? input.decision === "approve"
            ? "media.request.approved"
            : "media.request.declined"
          : "media.request.review_failed",
        outcome,
        targetId,
        context.requestId ?? null,
        JSON.stringify({
          decision: input.decision,
          ...(failureCode ? { failureCode } : {}),
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
      throw new RequestReviewServiceError("integrity_failure");
    }
    return value;
  }

  #id() {
    const value = this.#createId();
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new RequestReviewServiceError("integrity_failure");
    }
    return value;
  }
}
