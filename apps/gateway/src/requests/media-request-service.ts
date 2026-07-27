import {
  SeerrAdapter,
  SeerrRequestError,
  type SeerrUserIdentity,
} from "@omnifin/connectors/adapters/seerr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { OptionalApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
} from "@omnifin/contracts/connectors";
import {
  idempotencyKeySchema,
  mediaRequestInputSchema,
  mediaRequestResponseSchema,
  type MediaRequestInput,
  type MediaRequestResponse,
} from "@omnifin/contracts/requests";
import { randomUUID, X509Certificate } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

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

interface IdentityLinkRow {
  externalUserId: string;
  externalUsername: string;
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

export interface MediaRequestAdapter {
  createMediaRequest(
    input: MediaRequestInput,
    seerrUserId: number,
    signal?: AbortSignal,
  ): Promise<MediaRequestResponse>;
  resolveUser(identity: SeerrUserIdentity, signal?: AbortSignal): Promise<number>;
}

export interface MediaRequestDependencies {
  clock?: () => Date;
  createAdapter?: (config: OptionalApiKeyConnectorConfig) => MediaRequestAdapter;
  createId?: () => string;
}

export interface MediaRequestContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface MediaRequestResult {
  replayed: boolean;
  request: MediaRequestResponse;
}

export type MediaRequestFailureCode =
  | "configuration_unavailable"
  | "identity_unavailable"
  | "no_seasons_available"
  | "request_conflict"
  | "request_denied"
  | "response_invalid"
  | "temporarily_unavailable";

const MEDIA_REQUEST_FAILURE_CODES = new Set<MediaRequestFailureCode>([
  "configuration_unavailable",
  "identity_unavailable",
  "no_seasons_available",
  "request_conflict",
  "request_denied",
  "response_invalid",
  "temporarily_unavailable",
]);

export type MediaRequestServiceErrorReason =
  | MediaRequestFailureCode
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_link_required"
  | "integrity_failure"
  | "storage_failure";

export class MediaRequestServiceError extends Error {
  public readonly reason: MediaRequestServiceErrorReason;

  public constructor(reason: MediaRequestServiceErrorReason, options?: ErrorOptions) {
    super("The media request could not be completed.", options);
    this.name = "MediaRequestServiceError";
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
    throw new MediaRequestServiceError("integrity_failure", { cause: error });
  }
}

function canonicalInput(input: MediaRequestInput): MediaRequestInput {
  if (input.kind !== "series" || input.seasons === "all") return input;
  return { ...input, seasons: [...input.seasons].sort((left, right) => left - right) };
}

function hasRequestCapability(row: SeerrConnectorRow) {
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
      health.data.capabilities.includes("request.create")
    );
  } catch {
    return false;
  }
}

function knownFailure(error: unknown): MediaRequestFailureCode {
  if (error instanceof MediaRequestServiceError) {
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
      case "identity_ambiguous":
      case "identity_not_found":
        return "identity_unavailable";
      case "no_seasons_available":
        return "no_seasons_available";
      case "request_conflict":
        return "request_conflict";
      case "request_denied":
        return "request_denied";
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

export class MediaRequestService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: (config: OptionalApiKeyConnectorConfig) => MediaRequestAdapter;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: MediaRequestDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createAdapter = dependencies.createAdapter ?? ((input) => new SeerrAdapter(input));
  }

  public async create(
    rawInput: MediaRequestInput,
    rawIdempotencyKey: string,
    context: MediaRequestContext,
    signal?: AbortSignal,
  ): Promise<MediaRequestResult> {
    const principal = requirePermission(context.principal, "request.create");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new MediaRequestServiceError("identity_link_required");
    }
    const input = canonicalInput(mediaRequestInputSchema.parse(rawInput));
    const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
    const identity = this.#identity(principal);
    const fingerprintHash = hashToken(JSON.stringify(input));
    const keyHash = hashToken(`${principal.userId}\u0000${idempotencyKey}`);
    const reservation = this.#reserve(principal.userId, keyHash, fingerprintHash);
    if (reservation.kind === "replay") {
      return { replayed: true, request: reservation.response };
    }
    if (reservation.kind === "failure") {
      throw new MediaRequestServiceError(reservation.failureCode);
    }
    if (reservation.kind === "conflict") {
      throw new MediaRequestServiceError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new MediaRequestServiceError("idempotency_in_progress");
    }

    let adapter: MediaRequestAdapter;
    let seerrUserId: number;
    try {
      adapter = this.#adapter();
      seerrUserId = await adapter.resolveUser(identity, signal);
    } catch (error) {
      const failureCode = knownFailure(error);
      this.#completeFailure(reservation.operationId, failureCode, input, context);
      throw new MediaRequestServiceError(failureCode, { cause: error });
    }

    let response: MediaRequestResponse;
    try {
      response = mediaRequestResponseSchema.parse(
        await adapter.createMediaRequest(input, seerrUserId, signal),
      );
    } catch (error) {
      const failureCode = knownFailure(error);
      this.#completeFailure(reservation.operationId, failureCode, input, context);
      throw new MediaRequestServiceError(failureCode, { cause: error });
    }
    this.#completeSuccess(reservation.operationId, response, input, context);
    return { replayed: false, request: response };
  }

  #adapter() {
    const row = this.#connector();
    const secrets = connectorSecrets(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
      !row.displayName.trim() ||
      row.displayName.length > 160 ||
      !hasRequestCapability(row)
    ) {
      throw new MediaRequestServiceError("integrity_failure");
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
      throw new MediaRequestServiceError("integrity_failure", { cause: error });
    }
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
      if (rows.length !== 1) throw new MediaRequestServiceError("configuration_unavailable");
      return rows[0]!;
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #identity(principal: SessionPrincipal): SeerrUserIdentity {
    const link = principal.linkedServices.find((candidate) => candidate.service === "jellyfin");
    if (
      !principal.userId ||
      !link ||
      !link.externalUserId ||
      !link.username ||
      !["linked", "unavailable"].includes(link.health)
    ) {
      throw new MediaRequestServiceError("identity_link_required");
    }
    try {
      const row = this.#database.sqlite
        .prepare(
          `select
             external_user_id as externalUserId,
             external_username as externalUsername
           from service_identity_links
           where id = ?
             and user_id = ?
             and service = 'jellyfin'
             and health_state in ('linked', 'unavailable')
           limit 1`,
        )
        .get(link.id, principal.userId) as IdentityLinkRow | undefined;
      if (
        !row ||
        row.externalUserId !== link.externalUserId ||
        row.externalUsername !== link.username
      ) {
        throw new MediaRequestServiceError("identity_link_required");
      }
      return {
        jellyfinUserId: row.externalUserId,
        jellyfinUsername: row.externalUsername,
      };
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
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
          if (existing.fingerprintHash !== fingerprintHash) {
            return { kind: "conflict" as const };
          }
          if (existing.state === "pending") return { kind: "pending" as const };
          if (existing.state === "failed") {
            if (
              !existing.failureCode ||
              !MEDIA_REQUEST_FAILURE_CODES.has(existing.failureCode as MediaRequestFailureCode)
            ) {
              throw new MediaRequestServiceError("integrity_failure");
            }
            return {
              failureCode: existing.failureCode as MediaRequestFailureCode,
              kind: "failure" as const,
            };
          }
          if (existing.state === "succeeded" && existing.responseJson) {
            try {
              return {
                kind: "replay" as const,
                response: mediaRequestResponseSchema.parse(JSON.parse(existing.responseJson)),
              };
            } catch (error) {
              throw new MediaRequestServiceError("integrity_failure", { cause: error });
            }
          }
          throw new MediaRequestServiceError("integrity_failure");
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
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #completeSuccess(
    operationId: string,
    response: MediaRequestResponse,
    input: MediaRequestInput,
    context: MediaRequestContext,
  ) {
    this.#complete(operationId, "success", response, null, input, context);
  }

  #completeFailure(
    operationId: string,
    failureCode: MediaRequestFailureCode,
    input: MediaRequestInput,
    context: MediaRequestContext,
  ) {
    this.#complete(operationId, "failure", null, failureCode, input, context);
  }

  #complete(
    operationId: string,
    outcome: "success" | "failure",
    response: MediaRequestResponse | null,
    failureCode: MediaRequestFailureCode | null,
    input: MediaRequestInput,
    context: MediaRequestContext,
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
        if (update.changes !== 1) throw new MediaRequestServiceError("integrity_failure");
        this.#audit(outcome, response?.id ?? operationId, input, context, now, failureCode);
      })();
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #audit(
    outcome: "success" | "failure",
    targetId: string | null,
    input: MediaRequestInput,
    context: MediaRequestContext,
    createdAt: number,
    failureCode: MediaRequestFailureCode | null,
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
        outcome === "success" ? "media.request.created" : "media.request.failed",
        outcome,
        targetId,
        context.requestId ?? null,
        JSON.stringify({
          ...(failureCode ? { failureCode } : {}),
          is4k: input.is4k,
          kind: input.kind,
          tmdbId: input.tmdbId,
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
      throw new MediaRequestServiceError("integrity_failure");
    }
    return value;
  }

  #id() {
    const value = this.#createId();
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new MediaRequestServiceError("integrity_failure");
    }
    return value;
  }
}
