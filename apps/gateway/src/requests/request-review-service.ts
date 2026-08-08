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
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import {
  ExternalMutationJournal,
  ExternalMutationJournalError,
  type ExternalMutationRecord,
} from "../operations/external-mutation-journal.js";
import { EnvelopeCipher, hashToken, privacyHash } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const REQUEST_IDENTIFIER_PATTERN = /^request:([1-9][0-9]{0,9})$/u;
const MUTATION_LEASE_MS = 30_000;
const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const persistedRequestReviewItemSchema = requestReviewItemSchema.or(
  requestReviewItemSchema
    .omit({ qualityProfile: true })
    .transform((request) => ({ ...request, qualityProfile: "Profile unavailable" })),
);

interface SeerrConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  configGeneration: number;
  displayName: string;
  encryptedCredentials: string;
  healthState: string;
  id: string;
  insecureHttpApproved: number;
  instanceGeneration: number;
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

type RequestReviewReservation =
  | { kind: "conflict" }
  | { failureCode: RequestReviewFailureCode; kind: "failure"; operationId: string }
  | { kind: "new" }
  | { kind: "pending"; operationId: string }
  | { kind: "reconcile_required"; operationId: string }
  | { kind: "replay"; operationId: string; response: RequestReviewItem }
  | { kind: "reserved"; operationId: string }
  | { kind: "uncertain"; operationId: string };

export interface RequestReviewAdapter {
  listMediaRequests(input: RequestReviewQuery, signal?: AbortSignal): Promise<RequestReviewPage>;
  readMediaRequest?(requestId: string, signal?: AbortSignal): Promise<RequestReviewItem>;
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
  | "request_review_outcome_uncertain"
  | "request_review_reconcile_required"
  | "storage_failure";

export class RequestReviewServiceError extends Error {
  public readonly operationId: string | undefined;
  public readonly reason: RequestReviewServiceErrorReason;

  public constructor(
    reason: RequestReviewServiceErrorReason,
    options?: ErrorOptions & { operationId?: string },
  ) {
    super("The media request review could not be completed.", options);
    this.name = "RequestReviewServiceError";
    this.reason = reason;
    this.operationId = options?.operationId;
  }
}

const storedRequestReviewMutationSchema = z.strictObject({
  decision: z.enum(["approve", "decline"]),
  desiredStatus: z.enum(["approved", "declined"]),
  operation: z.literal("review"),
  requestId: z.string().regex(REQUEST_IDENTIFIER_PATTERN),
  schemaVersion: z.literal(1),
});

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
  readonly #journal: ExternalMutationJournal;

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
    this.#journal = new ExternalMutationJournal(database.sqlite, config.encryptionKey);
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
    const desiredStatus =
      input.decision === "approve" ? ("approved" as const) : ("declined" as const);
    const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(JSON.stringify({ input, requestId }));
    const keyHash = hashToken(`${principal.userId}\u0000request_review\u0000${idempotencyKey}`);
    const existing = this.#lookupReservation(principal.userId, keyHash, fingerprintHash);
    const terminal = this.#terminalReservation(existing);
    if (terminal) return terminal;
    if (existing.kind === "uncertain") throw this.#uncertainError(existing.operationId);

    let operationId =
      existing.kind === "pending" || existing.kind === "reconcile_required"
        ? existing.operationId
        : undefined;
    let dispatch = operationId ? this.#requestDispatch(operationId) : undefined;
    if (existing.kind === "reconcile_required" && !dispatch) {
      throw this.#reconcileError(existing.operationId);
    }
    if (dispatch?.state === "uncertain") throw this.#uncertainError(operationId!);
    if (dispatch?.state === "succeeded") throw this.#uncertainError(operationId!);
    if (dispatch) this.#assertStoredMutation(dispatch, requestId, input, desiredStatus);

    const connection = this.#connection();
    if (dispatch) this.#assertDispatchConnector(dispatch, connection.connector);
    const exactReader = connection.adapter.readMediaRequest?.bind(connection.adapter);

    if (dispatch && dispatch.state !== "reserved") {
      if (!exactReader) {
        this.#recordUncertain(operationId!, dispatch, requestId, input, context);
        throw this.#uncertainError(operationId!);
      }
      let current: RequestReviewItem;
      try {
        current = this.#exactReviewItem(await exactReader(requestId, signal), requestId);
      } catch (error) {
        this.#recordReadFailure(operationId!, dispatch, requestId, input, context, error);
        throw error instanceof SeerrRequestError && error.reason === "request_not_found"
          ? this.#reconcileError(operationId!, error)
          : this.#uncertainError(operationId!, error);
      }
      if (current.status === desiredStatus) {
        this.#finishExternalSuccess(operationId!, dispatch, current, input, context);
        return { replayed: false, request: current };
      }
      if (!this.#reviewableStatus(current.status, desiredStatus)) {
        this.#recordReconcileRequired(operationId!, dispatch, requestId, input, context);
        throw this.#reconcileError(operationId!);
      }
      this.#recordReconcileRequired(operationId!, dispatch, requestId, input, context);
      throw this.#reconcileError(operationId!);
    }

    let current: RequestReviewItem | undefined;
    if (exactReader) {
      try {
        current = this.#exactReviewItem(await exactReader(requestId, signal), requestId);
      } catch (error) {
        throw new RequestReviewServiceError(knownFailure(error), { cause: error });
      }
      if (current.status === desiredStatus) {
        if (!operationId) {
          const reservation = this.#reserve(principal.userId, keyHash, fingerprintHash);
          const raced = this.#terminalReservation(reservation);
          if (raced) return raced;
          if (reservation.kind !== "reserved") {
            throw reservation.kind === "reconcile_required" || reservation.kind === "uncertain"
              ? this.#reconcileError(reservation.operationId)
              : new RequestReviewServiceError("idempotency_in_progress", {
                  ...(reservation.kind === "pending"
                    ? { operationId: reservation.operationId }
                    : {}),
                });
          }
          operationId = reservation.operationId;
        }
        if (dispatch?.state === "reserved") {
          this.#completeAlreadyDesired(operationId, dispatch, current, input, context);
        } else {
          this.#completeSuccess(operationId, current, input, context);
        }
        return { replayed: false, request: current };
      }
      if (!this.#reviewableStatus(current.status, desiredStatus)) {
        throw new RequestReviewServiceError("request_conflict");
      }
    }

    if (!operationId) {
      const reservation = this.#reserve(principal.userId, keyHash, fingerprintHash);
      const raced = this.#terminalReservation(reservation);
      if (raced) return raced;
      if (reservation.kind !== "reserved") {
        if (reservation.kind === "reconcile_required" || reservation.kind === "uncertain") {
          throw this.#reconcileError(reservation.operationId);
        }
        throw new RequestReviewServiceError("idempotency_in_progress", {
          ...(reservation.kind === "pending" ? { operationId: reservation.operationId } : {}),
        });
      }
      operationId = reservation.operationId;
    }

    if (dispatch?.state === "reserved") {
      if ((dispatch.leaseExpiresAt ?? 0) >= this.#now()) {
        throw new RequestReviewServiceError("idempotency_in_progress", { operationId });
      }
      const now = this.#now();
      dispatch = this.#journal.claimStaleReserved({
        expectedLeaseExpiresAt: dispatch.leaseExpiresAt!,
        expectedLeaseOwner: dispatch.leaseOwner!,
        id: dispatch.id,
        leaseExpiresAt: now + MUTATION_LEASE_MS,
        leaseOwner: this.#leaseOwner(operationId),
        now,
      });
    } else {
      const desired = storedRequestReviewMutationSchema.parse({
        decision: input.decision,
        desiredStatus,
        operation: "review",
        requestId,
        schemaVersion: 1,
      });
      try {
        const now = this.#now();
        dispatch = this.#journal.reserve({
          connectorConfigGeneration: connection.connector.configGeneration,
          connectorId: connection.connector.id,
          connectorInstanceGeneration: connection.connector.instanceGeneration,
          id: this.#dispatchId(operationId),
          kind: "media_request.submit",
          leaseExpiresAt: now + MUTATION_LEASE_MS,
          leaseOwner: this.#leaseOwner(operationId),
          normalizedRequest: desired,
          now,
          parentOperationId: operationId,
          parentOperationType: "media_request_operation",
          targetDigest: privacyHash(
            "media_item",
            `${connection.connector.id}\u0000${connection.connector.instanceGeneration}\u0000request.review\u0000${requestId}`,
            this.#config.encryptionKey,
          ),
          userId: principal.userId,
        });
      } catch (error) {
        if (
          error instanceof ExternalMutationJournalError &&
          error.code === "reservation_conflict" &&
          this.#requestDispatch(operationId)
        ) {
          throw new RequestReviewServiceError("idempotency_in_progress", { operationId });
        }
        const failureCode =
          error instanceof ExternalMutationJournalError && error.code === "target_locked"
            ? "request_conflict"
            : "configuration_unavailable";
        this.#completeFailure(operationId, requestId, input, failureCode, context);
        throw new RequestReviewServiceError(failureCode, { cause: error, operationId });
      }
    }

    try {
      this.#assertConnectorGeneration(dispatch);
      dispatch = this.#journal.markDispatched({
        id: dispatch.id,
        leaseOwner: dispatch.leaseOwner!,
        now: this.#now(),
      });
    } catch (error) {
      this.#completeExternalFailure(
        operationId,
        dispatch,
        requestId,
        input,
        "configuration_unavailable",
        context,
      );
      throw new RequestReviewServiceError("configuration_unavailable", {
        cause: error,
        operationId,
      });
    }
    return this.#sendReviewDecision(
      operationId,
      dispatch,
      connection,
      requestId,
      input,
      desiredStatus,
      context,
      signal,
    );
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
             instance_generation as instanceGeneration,
             config_generation as configGeneration,
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
    return this.#connection().adapter;
  }

  #connection() {
    const connector = this.#connector();
    const secrets = connectorSecrets(connector, this.#cipher);
    try {
      return {
        adapter: this.#createAdapter({
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
        }),
        connector,
      };
    } catch (error) {
      throw new RequestReviewServiceError("integrity_failure", { cause: error });
    }
  }

  #lookupReservation(
    userId: string,
    keyHash: string,
    fingerprintHash: string,
  ): RequestReviewReservation {
    try {
      const existing = this.#database.sqlite
        .prepare(
          `select id, fingerprint_hash as fingerprintHash, state,
                  response_json as responseJson, failure_code as failureCode
           from media_request_operations
           where user_id = ? and idempotency_key_hash = ?
           limit 1`,
        )
        .get(userId, keyHash) as IdempotencyRow | undefined;
      return existing ? this.#existingReservation(existing, fingerprintHash) : { kind: "new" };
    } catch (error) {
      if (error instanceof RequestReviewServiceError) throw error;
      throw new RequestReviewServiceError("storage_failure", { cause: error });
    }
  }

  #existingReservation(
    existing: IdempotencyRow,
    fingerprintHash: string,
  ): RequestReviewReservation {
    if (existing.fingerprintHash !== fingerprintHash) return { kind: "conflict" };
    if (existing.state === "pending") return { kind: "pending", operationId: existing.id };
    if (existing.state === "reconcile_required") {
      return { kind: "reconcile_required", operationId: existing.id };
    }
    if (existing.state === "uncertain") return { kind: "uncertain", operationId: existing.id };
    if (existing.state === "failed") {
      if (
        !existing.failureCode ||
        !REQUEST_REVIEW_FAILURE_CODES.has(existing.failureCode as RequestReviewFailureCode)
      ) {
        throw new RequestReviewServiceError("integrity_failure");
      }
      return {
        failureCode: existing.failureCode as RequestReviewFailureCode,
        kind: "failure",
        operationId: existing.id,
      };
    }
    if (existing.state === "succeeded" && existing.responseJson) {
      try {
        return {
          kind: "replay",
          operationId: existing.id,
          response: persistedRequestReviewItemSchema.parse(JSON.parse(existing.responseJson)),
        };
      } catch (error) {
        throw new RequestReviewServiceError("integrity_failure", { cause: error });
      }
    }
    throw new RequestReviewServiceError("integrity_failure");
  }

  #terminalReservation(reservation: RequestReviewReservation): RequestReviewResult | undefined {
    switch (reservation.kind) {
      case "replay":
        return { replayed: true, request: reservation.response };
      case "failure":
        throw new RequestReviewServiceError(reservation.failureCode, {
          operationId: reservation.operationId,
        });
      case "conflict":
        throw new RequestReviewServiceError("idempotency_conflict");
      case "new":
      case "pending":
      case "reconcile_required":
      case "reserved":
      case "uncertain":
        return undefined;
    }
  }

  #reserve(userId: string, keyHash: string, fingerprintHash: string): RequestReviewReservation {
    try {
      return this.#database.sqlite.transaction(() => {
        const cleanup = this.#journal.cleanupTerminalParents({
          completedBefore: this.#now() - OPERATION_RETENTION_MS,
          limit: 100,
          parentOperationType: "media_request_operation",
          userId,
        });
        if (cleanup.mismatchedParents > 0) {
          throw new RequestReviewServiceError("storage_failure");
        }
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
        if (existing) return this.#existingReservation(existing, fingerprintHash);
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

  #requestDispatch(operationId: string) {
    try {
      return this.#journal.replay({
        kind: "media_request.submit",
        parentOperationId: operationId,
        parentOperationType: "media_request_operation",
      });
    } catch (error) {
      throw new RequestReviewServiceError("storage_failure", { cause: error, operationId });
    }
  }

  #assertStoredMutation(
    dispatch: ExternalMutationRecord,
    requestId: string,
    input: RequestReviewDecisionInput,
    desiredStatus: "approved" | "declined",
  ) {
    try {
      const desired = storedRequestReviewMutationSchema.parse(dispatch.normalizedRequest);
      if (
        desired.operation !== "review" ||
        desired.requestId !== requestId ||
        desired.decision !== input.decision ||
        desired.desiredStatus !== desiredStatus
      ) {
        throw new Error("invalid");
      }
    } catch (error) {
      throw new RequestReviewServiceError("integrity_failure", { cause: error });
    }
  }

  #assertDispatchConnector(dispatch: ExternalMutationRecord, connector: SeerrConnectorRow) {
    if (
      dispatch.connectorId !== connector.id ||
      dispatch.connectorInstanceGeneration !== connector.instanceGeneration ||
      dispatch.connectorConfigGeneration !== connector.configGeneration
    ) {
      throw new RequestReviewServiceError("configuration_unavailable");
    }
  }

  #assertConnectorGeneration(dispatch: ExternalMutationRecord) {
    const current = this.#database.sqlite
      .prepare(
        `select instance_generation as instanceGeneration,
                config_generation as configGeneration
         from connector_configs
         where id = ? and type = 'seerr' and enabled = 1
         limit 1`,
      )
      .get(dispatch.connectorId) as
      { configGeneration: number; instanceGeneration: number } | undefined;
    if (
      !current ||
      current.instanceGeneration !== dispatch.connectorInstanceGeneration ||
      current.configGeneration !== dispatch.connectorConfigGeneration
    ) {
      throw new RequestReviewServiceError("configuration_unavailable");
    }
  }

  #dispatchId(operationId: string) {
    return `mutation_dispatch_${hashToken(`request.review\u0000${operationId}`).slice(0, 22)}`;
  }

  #leaseOwner(operationId: string) {
    return `request-review-${hashToken(`${operationId}\u0000${this.#id()}`).slice(0, 22)}`;
  }

  #uncertainError(operationId: string, cause?: unknown) {
    return new RequestReviewServiceError("request_review_outcome_uncertain", {
      ...(cause === undefined ? {} : { cause }),
      operationId,
    });
  }

  #reconcileError(operationId: string, cause?: unknown) {
    return new RequestReviewServiceError("request_review_reconcile_required", {
      ...(cause === undefined ? {} : { cause }),
      operationId,
    });
  }

  #exactReviewItem(response: RequestReviewItem, requestId: string) {
    const parsed = requestReviewItemSchema.parse(response);
    if (parsed.id !== requestId) throw new RequestReviewServiceError("integrity_failure");
    return parsed;
  }

  #reviewableStatus(status: RequestReviewItem["status"], desiredStatus: "approved" | "declined") {
    const opposite = desiredStatus === "approved" ? "declined" : "approved";
    return status === "pending" || status === opposite;
  }

  #markReconcileRequired(dispatch: ExternalMutationRecord) {
    const current = this.#journal.read(dispatch.id);
    if (current?.state === "dispatched") {
      this.#journal.markReconcileRequired({
        failureCode: "read_after_write_required",
        id: dispatch.id,
        now: this.#now(),
      });
    }
  }

  async #sendReviewDecision(
    operationId: string,
    dispatch: ExternalMutationRecord,
    connection: { adapter: RequestReviewAdapter; connector: SeerrConnectorRow },
    requestId: string,
    input: RequestReviewDecisionInput,
    desiredStatus: "approved" | "declined",
    context: RequestReviewContext,
    signal: AbortSignal | undefined,
  ): Promise<RequestReviewResult> {
    try {
      const response = this.#exactReviewItem(
        await connection.adapter.reviewMediaRequest(requestId, input, signal),
        requestId,
      );
      if (response.status !== desiredStatus) {
        throw new RequestReviewServiceError("integrity_failure");
      }
      this.#finishExternalSuccess(operationId, dispatch, response, input, context);
      return { replayed: false, request: response };
    } catch (error) {
      if (
        error instanceof RequestReviewServiceError &&
        error.reason === "request_review_outcome_uncertain"
      ) {
        throw error;
      }
      this.#markReconcileRequired(dispatch);
      const reader = connection.adapter.readMediaRequest?.bind(connection.adapter);
      if (!reader) {
        this.#recordUncertain(operationId, dispatch, requestId, input, context);
        throw this.#uncertainError(operationId, error);
      }
      let current: RequestReviewItem;
      try {
        current = this.#exactReviewItem(await reader(requestId, signal), requestId);
      } catch (readError) {
        this.#recordReadFailure(operationId, dispatch, requestId, input, context, readError);
        throw readError instanceof SeerrRequestError && readError.reason === "request_not_found"
          ? this.#reconcileError(operationId, readError)
          : this.#uncertainError(operationId, readError);
      }
      if (current.status === desiredStatus) {
        this.#finishExternalSuccess(operationId, dispatch, current, input, context);
        return { replayed: false, request: current };
      }
      if (!this.#reviewableStatus(current.status, desiredStatus)) {
        this.#recordReconcileRequired(operationId, dispatch, requestId, input, context);
        throw this.#reconcileError(operationId, error);
      }
      this.#recordReconcileRequired(operationId, dispatch, requestId, input, context);
      throw this.#reconcileError(operationId, error);
    }
  }

  #completeAlreadyDesired(
    operationId: string,
    dispatch: ExternalMutationRecord,
    response: RequestReviewItem,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    this.#complete(operationId, response.id, "success", response, null, input, context, () => {
      this.#journal.completeFailed({
        failureCode: "already_in_desired_state",
        id: dispatch.id,
        now: this.#now(),
      });
    });
  }

  #completeExternalSuccess(
    operationId: string,
    dispatch: ExternalMutationRecord,
    response: RequestReviewItem,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    this.#complete(operationId, response.id, "success", response, null, input, context, () => {
      this.#journal.completeSucceeded({ id: dispatch.id, now: this.#now() });
    });
  }

  #finishExternalSuccess(
    operationId: string,
    dispatch: ExternalMutationRecord,
    response: RequestReviewItem,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    try {
      this.#completeExternalSuccess(operationId, dispatch, response, input, context);
    } catch (error) {
      this.#recordUncertain(operationId, dispatch, response.id, input, context);
      throw this.#uncertainError(operationId, error);
    }
  }

  #completeExternalFailure(
    operationId: string,
    dispatch: ExternalMutationRecord,
    requestId: string,
    input: RequestReviewDecisionInput,
    failureCode: RequestReviewFailureCode,
    context: RequestReviewContext,
  ) {
    this.#complete(operationId, requestId, "failure", null, failureCode, input, context, () => {
      this.#journal.completeFailed({ failureCode, id: dispatch.id, now: this.#now() });
    });
  }

  #recordReadFailure(
    operationId: string,
    dispatch: ExternalMutationRecord,
    requestId: string,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
    error: unknown,
  ) {
    if (error instanceof SeerrRequestError && error.reason === "request_not_found") {
      this.#recordReconcileRequired(operationId, dispatch, requestId, input, context);
    } else {
      this.#recordUncertain(operationId, dispatch, requestId, input, context);
    }
  }

  #recordReconcileRequired(
    operationId: string,
    dispatch: ExternalMutationRecord,
    requestId: string,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    this.#recordUnresolved(
      "reconcile_required",
      "request_review_reconcile_required",
      operationId,
      dispatch,
      requestId,
      input,
      context,
    );
  }

  #recordUncertain(
    operationId: string,
    dispatch: ExternalMutationRecord,
    requestId: string,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    this.#recordUnresolved(
      "uncertain",
      "request_review_outcome_uncertain",
      operationId,
      dispatch,
      requestId,
      input,
      context,
    );
  }

  #recordUnresolved(
    state: "reconcile_required" | "uncertain",
    failureCode: "request_review_outcome_uncertain" | "request_review_reconcile_required",
    operationId: string,
    dispatch: ExternalMutationRecord,
    requestId: string,
    input: RequestReviewDecisionInput,
    context: RequestReviewContext,
  ) {
    try {
      this.#database.sqlite.transaction(() => {
        const current = this.#journal.read(dispatch.id);
        if (current?.state === "dispatched") {
          this.#journal.markReconcileRequired({
            failureCode: "read_after_write_required",
            id: dispatch.id,
            now: this.#now(),
          });
        }
        if (state === "uncertain") {
          const reconciled = this.#journal.read(dispatch.id);
          if (reconciled?.state === "reconcile_required" || reconciled?.state === "dispatched") {
            this.#journal.completeUncertain({ failureCode, id: dispatch.id, now: this.#now() });
          }
        }
        const now = this.#now();
        const updated = this.#database.sqlite
          .prepare(
            `update media_request_operations
             set state = ?, response_json = null, failure_code = ?,
                 completed_at = ?, updated_at = ?
             where id = ? and state in ('pending', 'reconcile_required')`,
          )
          .run(state, failureCode, now, now, operationId);
        if (updated.changes === 1) {
          this.#audit(requestId, "failure", input, context, now, "temporarily_unavailable");
        }
      })();
    } catch {
      // The journal's post-dispatch state remains fail-closed on the next replay.
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
    completeDispatch?: () => void,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite.transaction(() => {
        const update = this.#database.sqlite
          .prepare(
            `update media_request_operations
             set state = ?, response_json = ?, failure_code = ?, completed_at = ?, updated_at = ?
             where id = ? and state in ('pending', 'reconcile_required')`,
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
        completeDispatch?.();
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
