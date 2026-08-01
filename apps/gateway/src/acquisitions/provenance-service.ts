import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  acquisitionEventSchema,
  acquisitionMonitoringStateSchema,
  acquisitionMonitoringTargetInputSchema,
  acquisitionMonitoringUpdateInputSchema,
  acquisitionProvenanceResponseSchema,
  acquisitionQueueRecoveryIdempotencyKeySchema,
  acquisitionQueueRecoveryInputSchema,
  acquisitionQueueRecoveryResponseSchema,
  acquisitionSearchIdempotencyKeySchema,
  acquisitionSearchInputSchema,
  acquisitionSearchResponseSchema,
  acquisitionTargetInputSchema,
  type AcquisitionMonitoringState,
  type AcquisitionMonitoringTargetInput,
  type AcquisitionMonitoringUpdateInput,
  type AcquisitionEvent,
  type AcquisitionProvenanceResponse,
  type AcquisitionQueueRecoveryInput,
  type AcquisitionQueueRecoveryResponse,
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
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const QUEUE_EVENT_PATTERN = /^(radarr|sonarr):queue:([1-9][0-9]*)$/u;
const RECOVERY_REFERENCE_TTL_MS = 5 * 60 * 1_000;
const RECOVERY_LEASE_MS = 30_000;
const RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RECOVERY_OPERATIONS_PER_USER = 1_000;

const recoveryReferencePayloadSchema = z.strictObject({
  connectorId: z.string().regex(CONNECTOR_IDENTIFIER_PATTERN),
  eventFingerprint: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/u),
  eventId: z.string().regex(/^acquisition_[A-Za-z0-9_-]{22}$/u),
  expiresAt: z.int().nonnegative(),
  externalId: z.int().positive().max(2_147_483_647),
  mediaId: z.int().positive().max(2_147_483_647),
  schemaVersion: z.literal(1),
  seasonNumber: z.int().nonnegative().max(10_000).nullable(),
  service: z.enum(["radarr", "sonarr"]),
  userId: z.string().trim().min(1).max(128),
});

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

interface AcquisitionQueueItem {
  event: AcquisitionEvent;
  externalId: number;
}

interface AcquisitionQueueRecoveryOperationRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  mutationStartedAt: number | null;
  responseJson: string | null;
  state: string;
  updatedAt: number;
}

interface AcquisitionQueueRecoveryReferencePayload {
  connectorId: string;
  eventFingerprint: string;
  eventId: string;
  expiresAt: number;
  externalId: number;
  mediaId: number;
  schemaVersion: 1;
  seasonNumber: number | null;
  service: AcquisitionService;
  userId: string;
}

export interface AcquisitionProvenanceContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface AcquisitionProvenanceAdapter {
  readAcquisitionMonitoring(
    input: AcquisitionMonitoringTargetInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionMonitoringState>;
  queueAcquisitionSearch(
    input: AcquisitionSearchInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionSearchResponse>;
  readAcquisitionProvenance(
    input: AcquisitionTargetInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionProvenanceResponse>;
  readAcquisitionQueue?(
    input: AcquisitionTargetInput,
    signal?: AbortSignal,
  ): Promise<readonly AcquisitionQueueItem[]>;
  removeAndBlocklistAcquisitionQueueItem?(externalId: number, signal?: AbortSignal): Promise<void>;
  updateAcquisitionMonitoring(
    input: AcquisitionMonitoringUpdateInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionMonitoringState>;
}

export interface AcquisitionProvenanceDependencies {
  clock?: () => Date;
  createId?: () => string;
  createOperationId?: () => string;
  createAdapter?: (
    service: AcquisitionService,
    config: ApiKeyConnectorConfig,
  ) => AcquisitionProvenanceAdapter;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface AcquisitionSearchResult {
  replayed: boolean;
  search: AcquisitionSearchResponse;
}

export interface AcquisitionQueueRecoveryResult {
  recovery: AcquisitionQueueRecoveryResponse;
  replayed: boolean;
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
  | "operation_failed"
  | "operation_limit_reached"
  | "outcome_unconfirmed"
  | "reference_expired"
  | "reference_invalid"
  | "stale_state"
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
  capability: Extract<
    ConnectorCapability,
    | "acquisition.history"
    | "acquisition.monitoring"
    | "acquisition.queue.mutate"
    | "acquisition.search"
  >,
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

async function defaultWait(milliseconds: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function knownSearchFailure(error: unknown): AcquisitionSearchFailureCode {
  if (error instanceof AcquisitionProvenanceError) {
    return ACQUISITION_SEARCH_FAILURE_CODES.has(error.reason as AcquisitionSearchFailureCode)
      ? (error.reason as AcquisitionSearchFailureCode)
      : "configuration_unavailable";
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

export class AcquisitionProvenanceService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<AcquisitionProvenanceDependencies["createAdapter"]>;
  readonly #createId: () => string;
  readonly #createOperationId: () => string;
  readonly #database: DatabaseHandle;
  readonly #wait: NonNullable<AcquisitionProvenanceDependencies["wait"]>;

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
    this.#createOperationId =
      dependencies.createOperationId ?? (() => `acquisition_recovery_${randomToken(16)}`);
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapter;
    this.#wait = dependencies.wait ?? defaultWait;
  }

  public async read(
    rawInput: AcquisitionTargetInput,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "acquisition.manage");
    const input = acquisitionTargetInputSchema.parse(rawInput);
    const { adapter, row } = this.#adapterWithRow(input.service, "acquisition.history");
    const provenance = acquisitionProvenanceResponseSchema.parse(
      await adapter.readAcquisitionProvenance(input, signal),
    );
    return this.#publicProvenance(provenance, row, principal);
  }

  public async readMonitoring(
    rawInput: AcquisitionMonitoringTargetInput,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "acquisition.manage");
    const input = acquisitionMonitoringTargetInputSchema.parse(rawInput);
    const adapter = this.#adapter(input.service, "acquisition.monitoring");
    return this.#monitoringState(await adapter.readAcquisitionMonitoring(input, signal), input);
  }

  public async updateMonitoring(
    rawInput: AcquisitionMonitoringUpdateInput,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "acquisition.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new AcquisitionProvenanceError("identity_required");
    }
    const input = acquisitionMonitoringUpdateInputSchema.parse(rawInput);
    const adapter = this.#adapter(input.service, "acquisition.monitoring");
    let current: AcquisitionMonitoringState;
    try {
      current = this.#monitoringState(
        await adapter.readAcquisitionMonitoring(input, signal),
        input,
      );
    } catch (error) {
      this.#auditMonitoring("failed", "failure", input, context, null, knownSearchFailure(error));
      throw error;
    }
    if (current.monitored === input.monitored) {
      this.#auditMonitoring("replayed", "success", input, context, current.monitored, null);
      return current;
    }
    this.#auditMonitoring("requested", "success", input, context, current.monitored, null);
    try {
      const updated = this.#monitoringState(
        await adapter.updateAcquisitionMonitoring(input, signal),
        input,
      );
      if (updated.monitored !== input.monitored) {
        throw new AcquisitionProvenanceError("response_invalid");
      }
      this.#auditMonitoring("updated", "success", input, context, current.monitored, null);
      return updated;
    } catch (error) {
      this.#auditMonitoring(
        "failed",
        "failure",
        input,
        context,
        current.monitored,
        knownSearchFailure(error),
      );
      throw error;
    }
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

  public async recoverQueueItem(
    rawInput: AcquisitionQueueRecoveryInput,
    rawIdempotencyKey: string,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ): Promise<AcquisitionQueueRecoveryResult> {
    const principal = requirePermission(context.principal, "acquisition.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new AcquisitionProvenanceError("identity_required");
    }
    const input = acquisitionQueueRecoveryInputSchema.parse(rawInput);
    const idempotencyKey = acquisitionQueueRecoveryIdempotencyKeySchema.parse(rawIdempotencyKey);
    const reference = this.#recoveryReference(input.reference, principal.userId);
    const now = this.#now();
    if (reference.expiresAt < now) throw new AcquisitionProvenanceError("reference_expired");
    const fingerprintHash = hashToken(
      JSON.stringify({
        eventFingerprint: reference.eventFingerprint,
        eventId: reference.eventId,
        reference: hashToken(input.reference),
      }),
    );
    const keyHash = hashToken(`${principal.userId}\u0000${idempotencyKey}`);
    const reservation = this.#reserveRecovery(
      principal.userId,
      reference.connectorId,
      reference.eventId,
      keyHash,
      fingerprintHash,
    );
    if (reservation.kind === "replay") {
      return { recovery: reservation.response, replayed: true };
    }
    if (reservation.kind === "conflict") {
      throw new AcquisitionProvenanceError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new AcquisitionProvenanceError("idempotency_in_progress");
    }
    if (reservation.kind === "failure") {
      throw new AcquisitionProvenanceError("operation_failed");
    }

    const target = acquisitionTargetInputSchema.parse({
      mediaId: reference.mediaId,
      ...(reference.seasonNumber === null ? {} : { seasonNumber: reference.seasonNumber }),
      service: reference.service,
    });
    let mutationStarted = false;
    try {
      const { adapter, row } = this.#adapterWithRow(reference.service, "acquisition.queue.mutate");
      if (
        row.id !== reference.connectorId ||
        !adapter.readAcquisitionQueue ||
        !adapter.removeAndBlocklistAcquisitionQueueItem
      ) {
        throw new AcquisitionProvenanceError("reference_invalid");
      }
      const exact = await this.#exactQueueItem(adapter, target, reference.externalId, signal);
      if (!exact) throw new AcquisitionProvenanceError("stale_state");
      if (
        exact.event.kind !== "stalled" ||
        !["failure", "warning"].includes(exact.event.state) ||
        this.#eventFingerprint(exact.event) !== reference.eventFingerprint ||
        this.#publicEventId(row.id, exact.event.id) !== reference.eventId
      ) {
        throw new AcquisitionProvenanceError("stale_state");
      }
      this.#prepareRecovery(reservation.operationId, reference, exact.event, context);
      mutationStarted = true;
      await adapter.removeAndBlocklistAcquisitionQueueItem(reference.externalId, signal);

      let removed = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await this.#wait(200 * attempt, signal);
        const remaining = await this.#exactQueueItem(adapter, target, reference.externalId, signal);
        if (!remaining) {
          removed = true;
          break;
        }
      }
      if (!removed) throw new AcquisitionProvenanceError("outcome_unconfirmed");
      const response = acquisitionQueueRecoveryResponseSchema.parse({
        completedAt: new Date(this.#now()).toISOString(),
        eventId: reference.eventId,
        operationId: reservation.operationId,
        service: reference.service,
        state: "removed_and_blocklisted",
      });
      this.#completeRecoverySuccess(reservation.operationId, response, context);
      return { recovery: response, replayed: false };
    } catch (error) {
      const reason = this.#recoveryFailure(error, mutationStarted);
      this.#completeRecoveryFailure(reservation.operationId, reference, reason, context);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof AcquisitionProvenanceError && reason === error.reason) throw error;
      throw new AcquisitionProvenanceError(reason, { cause: error });
    }
  }

  #publicProvenance(
    provenance: AcquisitionProvenanceResponse,
    row: AcquisitionConnectorRow,
    principal: SessionPrincipal,
  ) {
    const canRecover =
      principal.accountState === "active" &&
      Boolean(principal.userId) &&
      hasAcquisitionCapability(row, provenance.target.service, "acquisition.queue.mutate");
    const expiresAt = this.#now() + RECOVERY_REFERENCE_TTL_MS;
    return acquisitionProvenanceResponseSchema.parse({
      ...provenance,
      events: provenance.events.map((event) => {
        const publicId = this.#publicEventId(row.id, event.id);
        const queueMatch = QUEUE_EVENT_PATTERN.exec(event.id);
        if (
          !canRecover ||
          !principal.userId ||
          !queueMatch ||
          queueMatch[1] !== provenance.target.service ||
          event.kind !== "stalled" ||
          !["failure", "warning"].includes(event.state)
        ) {
          return { ...event, id: publicId };
        }
        const externalId = Number(queueMatch[2]);
        if (!Number.isSafeInteger(externalId) || externalId < 1) {
          return { ...event, id: publicId };
        }
        const payload: AcquisitionQueueRecoveryReferencePayload = {
          connectorId: row.id,
          eventFingerprint: this.#eventFingerprint(event),
          eventId: publicId,
          expiresAt,
          externalId,
          mediaId: provenance.target.mediaId,
          schemaVersion: 1,
          seasonNumber: provenance.target.seasonNumber,
          service: provenance.target.service,
          userId: principal.userId,
        };
        return acquisitionEventSchema.parse({
          ...event,
          id: publicId,
          recovery: {
            expiresAt: new Date(expiresAt).toISOString(),
            reference: `aqr_${this.#cipher.encrypt(
              JSON.stringify(payload),
              this.#recoveryReferenceContext(principal.userId),
            )}`,
          },
        });
      }),
    });
  }

  #publicEventId(connectorId: string, upstreamEventId: string) {
    return `acquisition_${privacyHash(
      "acquisition_event",
      `${connectorId}\u0000${upstreamEventId}`,
      this.#config.encryptionKey,
    )}`;
  }

  #eventFingerprint(event: AcquisitionEvent) {
    const { id: ignoredId, recovery: ignoredRecovery, ...snapshot } = event;
    void ignoredId;
    void ignoredRecovery;
    return hashToken(JSON.stringify(snapshot));
  }

  #recoveryReferenceContext(userId: string) {
    return `acquisition_queue_recovery:${userId}`;
  }

  #recoveryReference(reference: string, userId: string) {
    try {
      const parsed = recoveryReferencePayloadSchema.parse(
        JSON.parse(
          this.#cipher.decrypt(
            reference.slice("aqr_".length),
            this.#recoveryReferenceContext(userId),
          ),
        ),
      );
      if (parsed.userId !== userId) throw new Error("identity mismatch");
      return parsed;
    } catch (error) {
      throw new AcquisitionProvenanceError("reference_invalid", { cause: error });
    }
  }

  async #exactQueueItem(
    adapter: AcquisitionProvenanceAdapter,
    target: AcquisitionTargetInput,
    externalId: number,
    signal?: AbortSignal,
  ) {
    if (!adapter.readAcquisitionQueue) {
      throw new AcquisitionProvenanceError("connector_integrity_failure");
    }
    const matches = (await adapter.readAcquisitionQueue(target, signal)).filter(
      (item) => item.externalId === externalId,
    );
    if (matches.length > 1) throw new AcquisitionProvenanceError("response_invalid");
    const match = matches[0];
    if (!match) return null;
    return {
      event: acquisitionEventSchema.parse(match.event),
      externalId: match.externalId,
    };
  }

  #reserveRecovery(
    userId: string,
    connectorId: string,
    eventId: string,
    keyHash: string,
    fingerprintHash: string,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const now = this.#now();
          this.#database.sqlite
            .prepare(
              `delete from acquisition_queue_recovery_operations
               where user_id = ? and state <> 'pending' and completed_at <= ?`,
            )
            .run(userId, now - RECOVERY_RETENTION_MS);
          const existing = this.#database.sqlite
            .prepare(
              `select id, fingerprint_hash as fingerprintHash, state,
                      response_json as responseJson, failure_code as failureCode,
                      mutation_started_at as mutationStartedAt, updated_at as updatedAt
               from acquisition_queue_recovery_operations
               where user_id = ? and idempotency_key_hash = ?
               limit 1`,
            )
            .get(userId, keyHash) as AcquisitionQueueRecoveryOperationRow | undefined;
          if (existing) {
            if (existing.fingerprintHash !== fingerprintHash) return { kind: "conflict" as const };
            if (existing.state === "succeeded" && existing.responseJson) {
              return {
                kind: "replay" as const,
                response: acquisitionQueueRecoveryResponseSchema.parse(
                  JSON.parse(existing.responseJson),
                ),
              };
            }
            if (existing.state === "failed") return { kind: "failure" as const };
            if (existing.state !== "pending") {
              throw new AcquisitionProvenanceError("storage_failure");
            }
            if (
              !Number.isSafeInteger(existing.updatedAt) ||
              existing.updatedAt < 0 ||
              existing.updatedAt > now ||
              now - existing.updatedAt < RECOVERY_LEASE_MS
            ) {
              return { kind: "pending" as const };
            }
            if (existing.mutationStartedAt !== null) {
              this.#database.sqlite
                .prepare(
                  `update acquisition_queue_recovery_operations
                   set state = 'failed', failure_code = 'outcome_unconfirmed',
                       completed_at = ?, updated_at = ?
                   where id = ? and state = 'pending'`,
                )
                .run(now, now, existing.id);
              return { kind: "failure" as const };
            }
            const claimed = this.#database.sqlite
              .prepare(
                `update acquisition_queue_recovery_operations
                 set updated_at = ?
                 where id = ? and state = 'pending' and updated_at = ?`,
              )
              .run(now, existing.id, existing.updatedAt);
            return claimed.changes === 1
              ? { kind: "reserved" as const, operationId: existing.id }
              : { kind: "pending" as const };
          }
          const existingReference = this.#database.sqlite
            .prepare(
              `select id, fingerprint_hash as fingerprintHash, state,
                      response_json as responseJson, failure_code as failureCode,
                      mutation_started_at as mutationStartedAt, updated_at as updatedAt
               from acquisition_queue_recovery_operations
               where user_id = ? and fingerprint_hash = ?
               limit 1`,
            )
            .get(userId, fingerprintHash) as AcquisitionQueueRecoveryOperationRow | undefined;
          if (existingReference?.state === "succeeded" && existingReference.responseJson) {
            return {
              kind: "replay" as const,
              response: acquisitionQueueRecoveryResponseSchema.parse(
                JSON.parse(existingReference.responseJson),
              ),
            };
          }
          if (existingReference?.state === "failed") return { kind: "failure" as const };
          if (existingReference) return { kind: "pending" as const };
          const count = this.#database.sqlite
            .prepare(
              "select count(*) as count from acquisition_queue_recovery_operations where user_id = ?",
            )
            .get(userId) as { count: number };
          if (count.count >= MAX_RECOVERY_OPERATIONS_PER_USER) {
            throw new AcquisitionProvenanceError("operation_limit_reached");
          }
          const operationId = this.#recoveryOperationId();
          this.#database.sqlite
            .prepare(
              `insert into acquisition_queue_recovery_operations (
                 id, user_id, connector_id, event_id, idempotency_key_hash,
                 fingerprint_hash, state, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(operationId, userId, connectorId, eventId, keyHash, fingerprintHash, now, now);
          return { kind: "reserved" as const, operationId };
        })
        .immediate();
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
  }

  #prepareRecovery(
    operationId: string,
    reference: AcquisitionQueueRecoveryReferencePayload,
    event: AcquisitionEvent,
    context: AcquisitionProvenanceContext,
  ) {
    const snapshot = {
      eventId: reference.eventId,
      kind: event.kind,
      service: reference.service,
      state: event.state,
    };
    try {
      const now = this.#now();
      this.#database.sqlite
        .transaction(() => {
          const update = this.#database.sqlite
            .prepare(
              `update acquisition_queue_recovery_operations
               set event_snapshot_json = ?, mutation_started_at = ?, updated_at = ?
               where id = ? and state = 'pending' and mutation_started_at is null`,
            )
            .run(JSON.stringify(snapshot), now, now, operationId);
          if (update.changes !== 1) throw new AcquisitionProvenanceError("storage_failure");
          this.#auditRecovery(
            "acquisition.queue.recovery.requested",
            "success",
            operationId,
            reference.eventId,
            reference.service,
            context,
            now,
            { previousState: event.state },
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
  }

  #completeRecoverySuccess(
    operationId: string,
    response: AcquisitionQueueRecoveryResponse,
    context: AcquisitionProvenanceContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite
        .transaction(() => {
          const update = this.#database.sqlite
            .prepare(
              `update acquisition_queue_recovery_operations
               set state = 'succeeded', response_json = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending' and mutation_started_at is not null`,
            )
            .run(JSON.stringify(response), now, now, operationId);
          if (update.changes !== 1) throw new AcquisitionProvenanceError("storage_failure");
          this.#auditRecovery(
            "acquisition.queue.recovery.completed",
            "success",
            operationId,
            response.eventId,
            response.service,
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
  }

  #completeRecoveryFailure(
    operationId: string,
    reference: AcquisitionQueueRecoveryReferencePayload,
    reason: AcquisitionProvenanceErrorReason,
    context: AcquisitionProvenanceContext,
  ) {
    try {
      const now = this.#now();
      const failureCode = reason.slice(0, 64);
      this.#database.sqlite
        .transaction(() => {
          const update = this.#database.sqlite
            .prepare(
              `update acquisition_queue_recovery_operations
               set state = 'failed', failure_code = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(failureCode, now, now, operationId);
          if (update.changes !== 1) throw new AcquisitionProvenanceError("storage_failure");
          this.#auditRecovery(
            "acquisition.queue.recovery.failed",
            "failure",
            operationId,
            reference.eventId,
            reference.service,
            context,
            now,
            { failureCode },
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
  }

  #auditRecovery(
    eventType: string,
    outcome: "failure" | "success",
    operationId: string,
    eventId: string,
    service: AcquisitionService,
    context: AcquisitionProvenanceContext,
    createdAt: number,
    metadata: Record<string, unknown> = {},
  ) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
           target_type, target_id, request_id, metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, ?, ?, 'acquisition_queue_recovery', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#id(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        outcome,
        operationId,
        context.requestId ?? null,
        JSON.stringify({ eventId, service, ...metadata }),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #recoveryFailure(error: unknown, mutationStarted: boolean): AcquisitionProvenanceErrorReason {
    if (error instanceof DOMException && error.name === "AbortError") {
      return mutationStarted ? "outcome_unconfirmed" : "temporarily_unavailable";
    }
    if (error instanceof AcquisitionProvenanceError) return error.reason;
    if (mutationStarted) return "outcome_unconfirmed";
    return knownSearchFailure(error);
  }

  #recoveryOperationId() {
    const value = this.#createOperationId();
    if (!/^acquisition_recovery_[A-Za-z0-9_-]{22}$/u.test(value)) {
      throw new AcquisitionProvenanceError("connector_integrity_failure");
    }
    return value;
  }

  #adapter(
    service: AcquisitionService,
    capability: Extract<
      ConnectorCapability,
      | "acquisition.history"
      | "acquisition.monitoring"
      | "acquisition.queue.mutate"
      | "acquisition.search"
    >,
  ) {
    return this.#adapterWithRow(service, capability).adapter;
  }

  #adapterWithRow(
    service: AcquisitionService,
    capability: Extract<
      ConnectorCapability,
      | "acquisition.history"
      | "acquisition.monitoring"
      | "acquisition.queue.mutate"
      | "acquisition.search"
    >,
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
      const adapter = this.#createAdapter(service, {
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
      return { adapter, row };
    } catch (error) {
      throw new AcquisitionProvenanceError("connector_integrity_failure", { cause: error });
    }
  }

  #monitoringState(rawState: AcquisitionMonitoringState, target: AcquisitionMonitoringTargetInput) {
    const state = acquisitionMonitoringStateSchema.parse(rawState);
    if (state.target.mediaId !== target.mediaId || state.target.service !== target.service) {
      throw new AcquisitionProvenanceError("response_invalid");
    }
    return state;
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

  #auditMonitoring(
    action: "failed" | "replayed" | "requested" | "updated",
    outcome: "failure" | "success",
    input: AcquisitionMonitoringUpdateInput,
    context: AcquisitionProvenanceContext,
    previousMonitored: boolean | null,
    failureCode: AcquisitionSearchFailureCode | null,
  ) {
    try {
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
           ) values (?, ?, ?, ?, ?, ?, 'acquisition_monitoring', ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#id(),
          context.principal.userId,
          context.principal.sessionId,
          context.principal.authenticationMethod.kind,
          `acquisition.monitoring.${action}`,
          outcome,
          `${input.service}:${input.mediaId}`,
          context.requestId ?? null,
          JSON.stringify({
            ...(failureCode ? { failureCode } : {}),
            mediaId: input.mediaId,
            monitored: input.monitored,
            previousMonitored,
            replayed: action === "replayed",
            service: input.service,
          }),
          context.ipAddress
            ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
            : null,
          this.#now(),
        );
    } catch (error) {
      if (error instanceof AcquisitionProvenanceError) throw error;
      throw new AcquisitionProvenanceError("storage_failure", { cause: error });
    }
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
