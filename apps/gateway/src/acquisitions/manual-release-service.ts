import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  manualReleaseGrabIdempotencyKeySchema,
  manualReleaseGrabInputSchema,
  manualReleaseGrabResponseSchema,
  manualReleaseSearchResponseSchema,
  manualReleaseTargetInputSchema,
  type AcquisitionService,
  type ManualReleaseCandidate,
  type ManualReleaseGrabInput,
  type ManualReleaseGrabResponse,
  type ManualReleaseSearchResponse,
  type ManualReleaseTarget,
  type ManualReleaseTargetInput,
} from "@omnifin/contracts/acquisition";
import {
  type ConnectorCapability,
  connectorCredentialInputSchema,
  connectorHealthSchema,
} from "@omnifin/contracts/connectors";
import { X509Certificate } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";

const RELEASE_TTL_MS = 20 * 60 * 1_000;
const MAX_CACHED_RELEASES = 2_048;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RELEASE_IDENTIFIER_PATTERN = /^release_[A-Za-z0-9_-]{32}$/u;
const OPERATION_IDENTIFIER_PATTERN = /^release_grab_[A-Za-z0-9_-]{32}$/u;

type CandidateDetails = Omit<ManualReleaseCandidate, "id">;

interface ManualReleaseReference {
  guid: string;
  indexerId: number;
}

interface AdapterSearchResult {
  candidates: { details: CandidateDetails; reference: ManualReleaseReference }[];
  generatedAt: string;
  target: ManualReleaseTarget;
}

export interface ManualReleaseAdapter {
  grabManualRelease(reference: ManualReleaseReference, signal?: AbortSignal): Promise<void>;
  searchManualReleases(
    input: ManualReleaseTargetInput,
    signal?: AbortSignal,
  ): Promise<AdapterSearchResult>;
}

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

interface CachedRelease {
  connectorId: string;
  details: CandidateDetails;
  expiresAt: number;
  reference: ManualReleaseReference;
  releaseId: string;
  service: AcquisitionService;
  target: ManualReleaseTarget;
  targetFingerprint: string;
  userId: string;
}

interface GrabOperationRow {
  failureCode: string | null;
  fingerprintHash: string;
  responseJson: string | null;
  state: string;
}

export interface ManualReleaseContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface ManualReleaseDependencies {
  clock?: () => Date;
  createAdapter?: (
    service: AcquisitionService,
    config: ApiKeyConnectorConfig,
  ) => ManualReleaseAdapter;
  createOperationId?: () => string;
  createReleaseId?: () => string;
}

export interface ManualReleaseGrabResult {
  grab: ManualReleaseGrabResponse;
  replayed: boolean;
}

export type ManualReleaseGrabFailureCode =
  | "candidate_expired"
  | "configuration_unavailable"
  | "download_unavailable"
  | "override_required"
  | "rate_limited"
  | "response_invalid"
  | "temporarily_unavailable";

const GRAB_FAILURE_CODES = new Set<ManualReleaseGrabFailureCode>([
  "candidate_expired",
  "configuration_unavailable",
  "download_unavailable",
  "override_required",
  "rate_limited",
  "response_invalid",
  "temporarily_unavailable",
]);

export type ManualReleaseErrorReason =
  | ManualReleaseGrabFailureCode
  | "connector_ambiguous"
  | "connector_integrity_failure"
  | "connector_unconfigured"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_required"
  | "storage_failure";

export class ManualReleaseError extends Error {
  public readonly reason: ManualReleaseErrorReason;

  public constructor(reason: ManualReleaseErrorReason, options?: ErrorOptions) {
    super("Manual release operation could not be completed.", options);
    this.name = "ManualReleaseError";
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
    throw new ManualReleaseError("connector_integrity_failure", { cause: error });
  }
}

function hasGrabCapability(row: AcquisitionConnectorRow, service: AcquisitionService) {
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
      health.data.capabilities.includes("acquisition.grab" satisfies ConnectorCapability)
    );
  } catch {
    return false;
  }
}

function defaultAdapter(service: AcquisitionService, config: ApiKeyConnectorConfig) {
  return service === "radarr" ? new RadarrAdapter(config) : new SonarrAdapter(config);
}

function knownGrabFailure(error: unknown): ManualReleaseGrabFailureCode {
  if (error instanceof ManualReleaseError) {
    if (GRAB_FAILURE_CODES.has(error.reason as ManualReleaseGrabFailureCode)) {
      return error.reason as ManualReleaseGrabFailureCode;
    }
    return "configuration_unavailable";
  }
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

function targetFingerprint(target: ManualReleaseTarget) {
  return hashToken(
    JSON.stringify({
      episodeId: target.episodeId,
      mediaId: target.mediaId,
      seasonNumber: target.seasonNumber,
      service: target.service,
    }),
  );
}

export class ManualReleaseService {
  readonly #cache = new Map<string, CachedRelease>();
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<ManualReleaseDependencies["createAdapter"]>;
  readonly #createOperationId: () => string;
  readonly #createReleaseId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: ManualReleaseDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapter;
    this.#createOperationId =
      dependencies.createOperationId ?? (() => `release_grab_${randomToken(24)}`);
    this.#createReleaseId = dependencies.createReleaseId ?? (() => `release_${randomToken(24)}`);
  }

  public async search(
    rawInput: ManualReleaseTargetInput,
    context: ManualReleaseContext,
    signal?: AbortSignal,
  ): Promise<ManualReleaseSearchResponse> {
    const principal = this.#activePrincipal(context);
    const input = manualReleaseTargetInputSchema.parse(rawInput);
    const { adapter, connectorId } = this.#adapter(input.service);
    const result = await adapter.searchManualReleases(input, signal);
    const now = this.#now();
    const expiresAt = now + RELEASE_TTL_MS;
    const fingerprint = targetFingerprint(result.target);
    this.#prune(now);
    for (const [releaseId, cached] of this.#cache) {
      if (cached.userId === principal.userId && cached.targetFingerprint === fingerprint) {
        this.#cache.delete(releaseId);
      }
    }
    const releases = result.candidates.map(({ details, reference }) => {
      const releaseId = this.#releaseId();
      const candidate = { ...details, id: releaseId };
      this.#cache.set(releaseId, {
        connectorId,
        details,
        expiresAt,
        reference,
        releaseId,
        service: input.service,
        target: result.target,
        targetFingerprint: fingerprint,
        userId: principal.userId,
      });
      return candidate;
    });
    this.#trimCache();
    return manualReleaseSearchResponseSchema.parse({
      expiresAt: new Date(expiresAt).toISOString(),
      generatedAt: result.generatedAt,
      releases,
      target: result.target,
    });
  }

  public async grab(
    rawInput: ManualReleaseGrabInput,
    rawIdempotencyKey: string,
    context: ManualReleaseContext,
    signal?: AbortSignal,
  ): Promise<ManualReleaseGrabResult> {
    const principal = this.#activePrincipal(context);
    const input = manualReleaseGrabInputSchema.parse(rawInput);
    const idempotencyKey = manualReleaseGrabIdempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(
      JSON.stringify({
        overrideRejections: input.overrideRejections,
        releaseId: input.releaseId,
      }),
    );
    const keyHash = hashToken(`${principal.userId}\u0000${idempotencyKey}`);
    const reservation = this.#reserve(principal.userId, keyHash, fingerprintHash);
    if (reservation.kind === "replay") return { grab: reservation.response, replayed: true };
    if (reservation.kind === "failure") {
      throw new ManualReleaseError(reservation.failureCode);
    }
    if (reservation.kind === "conflict") throw new ManualReleaseError("idempotency_conflict");
    if (reservation.kind === "pending") throw new ManualReleaseError("idempotency_in_progress");

    let cached: CachedRelease | undefined;
    try {
      cached = this.#candidate(input.releaseId, principal.userId);
      if (!cached.details.downloadAllowed) {
        throw new ManualReleaseError("download_unavailable");
      }
      if (cached.details.requiresOverride && !input.overrideRejections) {
        throw new ManualReleaseError("override_required");
      }
      const { adapter } = this.#adapter(cached.service, cached.connectorId);
      await adapter.grabManualRelease(cached.reference, signal);
    } catch (error) {
      const failureCode = knownGrabFailure(error);
      this.#complete(
        reservation.operationId,
        "failure",
        null,
        failureCode,
        cached,
        input,
        context,
      );
      throw new ManualReleaseError(failureCode, { cause: error });
    }
    const response = manualReleaseGrabResponseSchema.parse({
      acceptedAt: new Date(this.#now()).toISOString(),
      operationId: reservation.operationId,
      releaseId: cached.releaseId,
      service: cached.service,
      state: "accepted",
    });
    this.#complete(reservation.operationId, "success", response, null, cached, input, context);
    this.#cache.delete(cached.releaseId);
    return { grab: response, replayed: false };
  }

  #activePrincipal(context: ManualReleaseContext) {
    const principal = requirePermission(context.principal, "acquisition.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new ManualReleaseError("identity_required");
    }
    return principal as SessionPrincipal & { userId: string };
  }

  #adapter(service: AcquisitionService, expectedConnectorId?: string) {
    const row = this.#connector(service);
    if (expectedConnectorId !== undefined && row.id !== expectedConnectorId) {
      throw new ManualReleaseError("candidate_expired");
    }
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
      !hasGrabCapability(row, service)
    ) {
      throw new ManualReleaseError("connector_integrity_failure");
    }
    try {
      return {
        adapter: this.#createAdapter(service, {
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
        }),
        connectorId: row.id,
      };
    } catch (error) {
      if (error instanceof ManualReleaseError) throw error;
      throw new ManualReleaseError("connector_integrity_failure", { cause: error });
    }
  }

  #candidate(releaseId: string, userId: string) {
    const now = this.#now();
    this.#prune(now);
    const candidate = this.#cache.get(releaseId);
    if (!candidate || candidate.userId !== userId || candidate.expiresAt <= now) {
      throw new ManualReleaseError("candidate_expired");
    }
    return candidate;
  }

  #prune(now: number) {
    for (const [releaseId, candidate] of this.#cache) {
      if (candidate.expiresAt <= now) this.#cache.delete(releaseId);
    }
  }

  #trimCache() {
    while (this.#cache.size > MAX_CACHED_RELEASES) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
  }

  #releaseId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const releaseId = this.#createReleaseId();
      if (RELEASE_IDENTIFIER_PATTERN.test(releaseId) && !this.#cache.has(releaseId)) {
        return releaseId;
      }
    }
    throw new ManualReleaseError("connector_integrity_failure");
  }

  #reserve(userId: string, keyHash: string, fingerprintHash: string) {
    try {
      return this.#database.sqlite.transaction(() => {
        const existing = this.#database.sqlite
          .prepare(
            `select fingerprint_hash as fingerprintHash, state,
                    response_json as responseJson, failure_code as failureCode
             from acquisition_grab_operations
             where user_id = ? and idempotency_key_hash = ?
             limit 1`,
          )
          .get(userId, keyHash) as GrabOperationRow | undefined;
        if (existing) {
          if (existing.fingerprintHash !== fingerprintHash) return { kind: "conflict" as const };
          if (existing.state === "pending") return { kind: "pending" as const };
          if (existing.state === "failed") {
            if (
              !existing.failureCode ||
              !GRAB_FAILURE_CODES.has(existing.failureCode as ManualReleaseGrabFailureCode)
            ) {
              throw new ManualReleaseError("connector_integrity_failure");
            }
            return {
              failureCode: existing.failureCode as ManualReleaseGrabFailureCode,
              kind: "failure" as const,
            };
          }
          if (existing.state === "succeeded" && existing.responseJson) {
            try {
              return {
                kind: "replay" as const,
                response: manualReleaseGrabResponseSchema.parse(JSON.parse(existing.responseJson)),
              };
            } catch (error) {
              throw new ManualReleaseError("connector_integrity_failure", { cause: error });
            }
          }
          throw new ManualReleaseError("connector_integrity_failure");
        }
        const operationId = this.#operationId();
        const now = this.#now();
        this.#database.sqlite
          .prepare(
            `insert into acquisition_grab_operations (
               id, user_id, idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
             ) values (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(operationId, userId, keyHash, fingerprintHash, now, now);
        return { kind: "reserved" as const, operationId };
      })();
    } catch (error) {
      if (error instanceof ManualReleaseError) throw error;
      throw new ManualReleaseError("storage_failure", { cause: error });
    }
  }

  #complete(
    operationId: string,
    outcome: "success" | "failure",
    response: ManualReleaseGrabResponse | null,
    failureCode: ManualReleaseGrabFailureCode | null,
    candidate: CachedRelease | undefined,
    input: ManualReleaseGrabInput,
    context: ManualReleaseContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite.transaction(() => {
        const update = this.#database.sqlite
          .prepare(
            `update acquisition_grab_operations
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
        if (update.changes !== 1) throw new ManualReleaseError("connector_integrity_failure");
        this.#audit(outcome, operationId, candidate, input, context, now, failureCode);
      })();
    } catch (error) {
      if (error instanceof ManualReleaseError) throw error;
      throw new ManualReleaseError("storage_failure", { cause: error });
    }
  }

  #audit(
    outcome: "success" | "failure",
    operationId: string,
    candidate: CachedRelease | undefined,
    input: ManualReleaseGrabInput,
    context: ManualReleaseContext,
    createdAt: number,
    failureCode: ManualReleaseGrabFailureCode | null,
  ) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
           target_type, target_id, request_id, metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, ?, ?, 'manual_release', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#auditId(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        outcome === "success" ? "acquisition.release.grabbed" : "acquisition.release.failed",
        outcome,
        operationId,
        context.requestId ?? null,
        JSON.stringify({
          ...(candidate
            ? {
                decision: candidate.details.decision,
                mediaId: candidate.target.mediaId,
                service: candidate.service,
              }
            : {}),
          ...(failureCode ? { failureCode } : {}),
          overrideConfirmed: input.overrideRejections,
        }),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #connector(service: AcquisitionService) {
    try {
      const rows = this.#database.sqlite
        .prepare(
          `select id, type, display_name as displayName, base_url as baseUrl,
                  encrypted_credentials as encryptedCredentials,
                  capability_snapshot_json as capabilitySnapshotJson,
                  health_state as healthState, tls_policy as tlsPolicy,
                  insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type = ? and enabled = 1
           order by id asc
           limit 2`,
        )
        .all(service) as AcquisitionConnectorRow[];
      if (rows.length === 0) throw new ManualReleaseError("connector_unconfigured");
      if (rows.length > 1) throw new ManualReleaseError("connector_ambiguous");
      return rows[0]!;
    } catch (error) {
      if (error instanceof ManualReleaseError) throw error;
      throw new ManualReleaseError("storage_failure", { cause: error });
    }
  }

  #now() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ManualReleaseError("connector_integrity_failure");
    }
    return value;
  }

  #operationId() {
    const value = this.#createOperationId();
    if (!OPERATION_IDENTIFIER_PATTERN.test(value)) {
      throw new ManualReleaseError("connector_integrity_failure");
    }
    return value;
  }

  #auditId() {
    const value = `audit_${randomToken(18)}`;
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new ManualReleaseError("connector_integrity_failure");
    }
    return value;
  }
}
