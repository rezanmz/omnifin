import { QBittorrentAdapter } from "@omnifin/connectors/adapters/qbittorrent";
import { SabnzbdAdapter } from "@omnifin/connectors/adapters/sabnzbd";
import type {
  ConnectorDownloadQueueItem,
  DownloadQueueController,
} from "@omnifin/connectors/downloads";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
  type ConnectorCredentialInput,
  type PartialFailure,
} from "@omnifin/contracts/connectors";
import {
  DOWNLOAD_QUEUE_MAX_CLIENTS,
  DOWNLOAD_QUEUE_MAX_ITEMS,
  downloadQueueActionInputSchema,
  downloadQueueActionResponseSchema,
  downloadQueueBulkActionInputSchema,
  downloadQueueBulkActionResponseSchema,
  downloadQueueBulkResultSchema,
  downloadQueueItemSchema,
  downloadQueuePromotionInputSchema,
  downloadQueuePromotionResponseSchema,
  downloadQueueRemovalInputSchema,
  downloadQueueRemovalResponseSchema,
  downloadQueueResponseSchema,
  type DownloadClientService,
  type DownloadQueueActionInput,
  type DownloadQueueActionResponse,
  type DownloadQueueBulkActionInput,
  type DownloadQueueBulkActionResponse,
  type DownloadQueueBulkFailureCode,
  type DownloadQueueBulkResult,
  type DownloadQueueClient,
  type DownloadQueueItem,
  type DownloadQueuePromotionInput,
  type DownloadQueuePromotionResponse,
  type DownloadQueueRemovalInput,
  type DownloadQueueRemovalResponse,
  type DownloadQueueResponse,
} from "@omnifin/contracts/downloads";
import { idempotencyKeySchema } from "@omnifin/contracts/requests";
import { randomUUID, X509Certificate } from "node:crypto";
import { ZodError } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import {
  ExternalMutationJournal,
  ExternalMutationJournalError,
  externalMutationRequestEncryptionContext,
  type ExternalMutationRecord,
} from "../operations/external-mutation-journal.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";

const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REMOVAL_OPERATION_IDENTIFIER_PATTERN = /^download_removal_[A-Za-z0-9_-]{22}$/u;
const BULK_OPERATION_IDENTIFIER_PATTERN = /^download_bulk_[A-Za-z0-9_-]{22}$/u;
const ITEM_OPERATION_IDENTIFIER_PATTERN = /^download_item_operation_[A-Za-z0-9_-]{22}$/u;
const MUTATION_DISPATCH_IDENTIFIER_PATTERN = /^mutation_dispatch_[A-Za-z0-9_-]{22}$/u;
const MAX_REMOVAL_OPERATIONS_PER_USER = 1_000;
const MAX_BULK_OPERATIONS_PER_USER = 200;
const REMOVAL_RECOVERY_LEASE_MS = 30_000;
const BULK_RECOVERY_LEASE_MS = 30_000;
const ITEM_OPERATION_LEASE_MS = 30_000;
const REMOVAL_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const BULK_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ITEM_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const BULK_MUTATION_CONCURRENCY = 4;

interface DownloadConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  displayName: string;
  encryptedCredentials: string;
  healthState: string;
  id: string;
  insecureHttpApproved: number;
  instanceGeneration: number;
  configGeneration: number;
  tlsPolicy: string;
  type: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

interface RemovalOperationRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  itemSnapshotJson: string | null;
  responseJson: string | null;
  state: string;
  updatedAt: number;
}

interface ItemOperationRow {
  bulkOperationId: string | null;
  completedAt: number | null;
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  itemDigest: string;
  kind: "pause" | "promote" | "resume";
  state: "failed" | "pending" | "reconcile_required" | "succeeded" | "uncertain";
  updatedAt: number;
}

interface BulkOperationRow {
  fingerprintHash: string;
  id: string;
  requestJson: string;
  responseJson: string | null;
  resultsJson: string;
  state: string;
  updatedAt: number;
}

export interface DownloadQueueContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface DownloadQueueAdapterFactoryInput extends ConnectorTargetConfig {
  credentials: ConnectorCredentialInput;
  insecureHttpApproved: boolean;
  service: DownloadClientService;
  tlsPolicy: "allow_self_signed" | "strict";
}

export interface DownloadQueueDependencies {
  clock?: () => Date;
  createAdapter?: (input: DownloadQueueAdapterFactoryInput) => DownloadQueueController;
  createId?: () => string;
  createBulkOperationId?: () => string;
  createDispatchId?: () => string;
  createItemOperationId?: () => string;
  createLeaseOwner?: () => string;
  createOperationId?: () => string;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type DownloadQueueErrorReason =
  | "connector_unavailable"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_required"
  | "operation_failed"
  | "operation_limit_reached"
  | "operation_uncertain"
  | "queue_order_unavailable"
  | "reconciliation_required"
  | "response_invalid"
  | "stale_state"
  | "storage_failure"
  | "target_locked"
  | "generation_mismatch"
  | "target_not_found";

export class DownloadQueueError extends Error {
  public readonly operationId: string | undefined;
  public readonly reason: DownloadQueueErrorReason;
  public readonly replayed: boolean;

  public constructor(
    reason: DownloadQueueErrorReason,
    options?: ErrorOptions & { operationId?: string; replayed?: boolean },
  ) {
    super("The download queue operation could not be completed.", options);
    this.name = "DownloadQueueError";
    this.reason = reason;
    this.operationId = options?.operationId;
    this.replayed = options?.replayed ?? false;
  }
}

class DownloadConnectorIntegrityError extends Error {}

function credentialContext(service: DownloadClientService, connectorId: string) {
  return `connector_credentials:${service}:${connectorId}`;
}

function isDownloadService(value: string): value is DownloadClientService {
  return value === "qbittorrent" || value === "sabnzbd";
}

function safeDisplayName(value: string, service: DownloadClientService) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || (service === "qbittorrent" ? "qBittorrent" : "SABnzbd")).slice(0, 160);
}

function hasQueueCapability(
  row: DownloadConnectorRow,
  service: DownloadClientService,
  capability: "download.queue.mutate" | "download.queue.read" = "download.queue.read",
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

function connectorSecrets(
  row: DownloadConnectorRow,
  service: DownloadClientService,
  cipher: EnvelopeCipher,
) {
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
    if (
      (service === "qbittorrent" && credentials.kind !== "username_password") ||
      (service === "sabnzbd" && credentials.kind !== "api_key")
    ) {
      throw new Error("invalid");
    }
    const tlsCaCertificatePem = stored.tlsCaCertificatePem;
    if (tlsCaCertificatePem !== undefined) {
      if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
        throw new Error("invalid");
      }
      const certificate = new X509Certificate(tlsCaCertificatePem);
      if (!certificate.ca) throw new Error("invalid");
    }
    return {
      credentials,
      ...(typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {}),
    };
  } catch (error) {
    throw new DownloadConnectorIntegrityError("invalid", { cause: error });
  }
}

function defaultAdapter(input: DownloadQueueAdapterFactoryInput): DownloadQueueController {
  const target = {
    baseUrl: input.baseUrl,
    connectorId: input.connectorId,
    displayName: input.displayName,
    insecureHttpApproved: input.insecureHttpApproved,
    tlsPolicy: input.tlsPolicy,
    ...(input.tlsCaCertificatePem === undefined
      ? {}
      : { tlsCaCertificatePem: input.tlsCaCertificatePem }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  } satisfies ConnectorTargetConfig;
  if (input.service === "qbittorrent" && input.credentials.kind === "username_password") {
    return new QBittorrentAdapter({
      ...target,
      password: input.credentials.password,
      username: input.credentials.username,
    });
  }
  if (input.service === "sabnzbd" && input.credentials.kind === "api_key") {
    return new SabnzbdAdapter({ ...target, apiKey: input.credentials.apiKey });
  }
  throw new DownloadConnectorIntegrityError("invalid");
}

function defaultWait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function actionAchieved(
  action: DownloadQueueActionInput["action"],
  state: DownloadQueueItem["state"],
) {
  return action === "pause"
    ? state === "paused"
    : ["checking", "downloading", "moving", "queued", "stalled"].includes(state);
}

function actionFailureCode(error: unknown) {
  if (error instanceof DownloadQueueError) return error.reason;
  if (error instanceof SafeConnectorError) return error.code;
  return "upstream_failure";
}

function bulkFailure(error: unknown): {
  code: DownloadQueueBulkFailureCode;
  retryable: boolean;
} {
  if (error instanceof DownloadQueueError) {
    switch (error.reason) {
      case "target_not_found":
        return { code: "target_not_found", retryable: false };
      case "stale_state":
        return { code: "state_changed", retryable: false };
      case "response_invalid":
        return { code: "action_unconfirmed", retryable: true };
      case "operation_uncertain":
      case "reconciliation_required":
      case "target_locked":
        return { code: "action_unconfirmed", retryable: false };
      case "generation_mismatch":
        return { code: "configuration_unavailable", retryable: false };
      case "connector_unavailable":
        return { code: "configuration_unavailable", retryable: true };
      case "storage_failure":
        throw error;
      default:
        return { code: "action_unavailable", retryable: true };
    }
  }
  if (error instanceof SafeConnectorError) {
    if (error.code === "rate_limited") return { code: "rate_limited", retryable: true };
    if (error.code === "response_invalid" || error.code === "unsupported_version") {
      return { code: "action_unconfirmed", retryable: true };
    }
  }
  return { code: "action_unavailable", retryable: true };
}

function sameRemovalTarget(left: DownloadQueueItem, right: DownloadQueueItem) {
  return (
    left.id === right.id &&
    left.connectorId === right.connectorId &&
    left.client === right.client &&
    left.title === right.title &&
    left.sizeBytes === right.sizeBytes &&
    left.addedAt === right.addedAt
  );
}

function safeFailure(
  service: DownloadClientService,
  displayName: string,
  error: unknown,
  occurredAt: Date,
): PartialFailure {
  if (error instanceof SafeConnectorError && error.service === service) {
    return error.toPartialFailure(occurredAt);
  }
  if (error instanceof DownloadConnectorIntegrityError) {
    return {
      code: "configuration_invalid",
      message: `${displayName} queue configuration could not be used.`,
      occurredAt: occurredAt.toISOString(),
      operation: "download.queue",
      retryable: false,
      service,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "response_invalid",
      message: `${displayName} returned a queue response that could not be safely interpreted.`,
      occurredAt: occurredAt.toISOString(),
      operation: "download.queue",
      retryable: false,
      service,
    };
  }
  return {
    code: "upstream_error",
    message: `${displayName} queue is temporarily unavailable.`,
    occurredAt: occurredAt.toISOString(),
    operation: "download.queue",
    retryable: true,
    service,
  };
}

function summary(items: readonly DownloadQueueItem[]) {
  return {
    attention: items.filter((item) => item.state === "failed" || item.state === "stalled").length,
    downloading: items.filter((item) => ["checking", "downloading", "moving"].includes(item.state))
      .length,
    paused: items.filter((item) => item.state === "paused").length,
    queued: items.filter((item) => item.state === "queued").length,
    remainingBytes: items.reduce((total, item) => total + item.remainingBytes, 0),
    total: items.length,
    totalRateBytesPerSecond: items.reduce((total, item) => total + item.rateBytesPerSecond, 0),
  };
}

interface ClientResult {
  client: DownloadQueueClient;
  items: DownloadQueueItem[];
  sourceTruncated: boolean;
}

interface ConnectorSelection {
  rows: DownloadConnectorRow[];
  truncated: boolean;
}

interface ExactQueueItem {
  externalId: string;
  identityDigest: string;
  publicItem: DownloadQueueItem;
  queuePosition: number | null;
}

interface StoredExactTarget {
  identityDigest: string;
  publicItem: DownloadQueueItem;
  queuePosition: number | null;
}

interface StoredItemMutationEvidence {
  input: DownloadQueueActionInput | DownloadQueuePromotionInput;
  response?: DownloadQueueActionResponse | DownloadQueuePromotionResponse;
  schemaVersion: 1;
  target?: StoredExactTarget;
}

interface StoredRemovalSnapshot {
  connectorConfigGeneration?: number;
  connectorInstanceGeneration?: number;
  identityDigest: string;
  item: DownloadQueueItem;
  schemaVersion: 1 | 2;
}

interface OperationReceipt {
  operationId: string;
  replayed: boolean;
}

type ItemMutationInput = DownloadQueueActionInput | DownloadQueuePromotionInput;
type ItemMutationResponse = DownloadQueueActionResponse | DownloadQueuePromotionResponse;

interface ItemMutationExecution {
  dispatch: ExternalMutationRecord;
  operation: ItemOperationRow;
  row: DownloadConnectorRow;
}

export class DownloadQueueService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<DownloadQueueDependencies["createAdapter"]>;
  readonly #createBulkOperationId: () => string;
  readonly #createDispatchId: () => string;
  readonly #createId: () => string;
  readonly #createItemOperationId: () => string;
  readonly #createLeaseOwner: () => string;
  readonly #createOperationId: () => string;
  readonly #database: DatabaseHandle;
  readonly #journal: ExternalMutationJournal;
  readonly #receipts = new WeakMap<object, OperationReceipt>();
  readonly #wait: NonNullable<DownloadQueueDependencies["wait"]>;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: DownloadQueueDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapter;
    this.#createBulkOperationId =
      dependencies.createBulkOperationId ?? (() => `download_bulk_${randomToken(16)}`);
    this.#createDispatchId =
      dependencies.createDispatchId ?? (() => `mutation_dispatch_${randomToken(16)}`);
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createItemOperationId =
      dependencies.createItemOperationId ?? (() => `download_item_operation_${randomToken(16)}`);
    this.#createLeaseOwner =
      dependencies.createLeaseOwner ?? (() => `download-queue-${randomToken(16)}`);
    this.#createOperationId =
      dependencies.createOperationId ?? (() => `download_removal_${randomToken(16)}`);
    this.#journal = new ExternalMutationJournal(database.sqlite, config.encryptionKey);
    this.#wait = dependencies.wait ?? defaultWait;
  }

  public operationReceipt(response: object): OperationReceipt | undefined {
    return this.#receipts.get(response);
  }

  public async read(
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ): Promise<DownloadQueueResponse> {
    requirePermission(context.principal, "downloads.manage");
    const selection = this.#connectors();
    const results = await Promise.all(selection.rows.map((row) => this.#readClient(row, signal)));
    const availableItems = results.flatMap((result) => result.items);
    const items = availableItems.slice(0, DOWNLOAD_QUEUE_MAX_ITEMS);
    const returnedByConnector = new Map<string, DownloadQueueItem[]>();
    for (const item of items) {
      const clientItems = returnedByConnector.get(item.connectorId) ?? [];
      clientItems.push(item);
      returnedByConnector.set(item.connectorId, clientItems);
    }
    const clients = results.map((result) => {
      const clientItems = returnedByConnector.get(result.client.connectorId) ?? [];
      return {
        ...result.client,
        itemCount: clientItems.length,
        rateBytesPerSecond: clientItems.reduce((total, item) => total + item.rateBytesPerSecond, 0),
      };
    });
    const failures = clients
      .map((client) => client.failure)
      .filter((failure): failure is PartialFailure => failure !== null);
    return downloadQueueResponseSchema.parse({
      clients,
      failures,
      generatedAt: this.#clock().toISOString(),
      items,
      state:
        clients.length === 0 ? "unconfigured" : failures.length === 0 ? "complete" : "degraded",
      summary: summary(items),
      truncated:
        selection.truncated ||
        availableItems.length > DOWNLOAD_QUEUE_MAX_ITEMS ||
        results.some((result) => result.sourceTruncated),
    });
  }

  public async update(
    rawInput: DownloadQueueActionInput,
    context: DownloadQueueContext,
    signal?: AbortSignal,
    rawIdempotencyKey?: string,
  ): Promise<DownloadQueueActionResponse> {
    const principal = requirePermission(context.principal, "downloads.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new DownloadQueueError("identity_required");
    }
    const input = downloadQueueActionInputSchema.parse(rawInput);
    const idempotencyKey = idempotencyKeySchema.parse(
      rawIdempotencyKey ?? `automatic-${randomToken(16)}`,
    );
    return this.#runDirectItemMutation(
      input.action,
      input,
      idempotencyKey,
      context,
      signal,
    ) as Promise<DownloadQueueActionResponse>;
  }

  public async bulkUpdate(
    rawInput: DownloadQueueBulkActionInput,
    rawIdempotencyKey: string,
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ): Promise<DownloadQueueBulkActionResponse> {
    const principal = requirePermission(context.principal, "downloads.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new DownloadQueueError("identity_required");
    }
    const input = downloadQueueBulkActionInputSchema.parse(rawInput);
    const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(JSON.stringify({ input, version: 1 }));
    const keyHash = hashToken(
      `${principal.userId}\u0000download_queue_bulk_action\u0000${idempotencyKey}`,
    );
    const reservation = this.#reserveBulk(principal.userId, input, keyHash, fingerprintHash);
    if (reservation.kind === "replay") {
      return downloadQueueBulkActionResponseSchema.parse({
        ...reservation.response,
        replayed: true,
      });
    }
    if (reservation.kind === "conflict") {
      throw new DownloadQueueError("idempotency_conflict", {
        operationId: reservation.operationId,
        replayed: true,
      });
    }
    if (reservation.kind === "quarantined") {
      throw new DownloadQueueError("operation_failed", {
        operationId: reservation.operationId,
        replayed: true,
      });
    }
    if (reservation.kind === "pending") {
      throw new DownloadQueueError("idempotency_in_progress", {
        operationId: reservation.operationId,
        replayed: true,
      });
    }

    if (reservation.kind === "reserved") {
      this.#auditBulk("requested", "success", reservation.operationId, input, context, {
        requested: input.targets.length,
      });
    }
    const results = [...reservation.results];
    const completed = new Set(
      results.map((result) => `${result.target.connectorId}\u0000${result.target.itemId}`),
    );
    const remaining = input.targets.filter(
      (target) => !completed.has(`${target.connectorId}\u0000${target.itemId}`),
    );

    for (let offset = 0; offset < remaining.length; offset += BULK_MUTATION_CONCURRENCY) {
      const batch = remaining.slice(offset, offset + BULK_MUTATION_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (target): Promise<DownloadQueueBulkResult> => {
          try {
            const childInput = downloadQueueActionInputSchema.parse(
              input.action === "pause"
                ? {
                    action: "pause",
                    connectorId: target.connectorId,
                    expectedState: target.expectedState,
                    itemId: target.itemId,
                  }
                : {
                    action: "resume",
                    connectorId: target.connectorId,
                    expectedState: "paused",
                    itemId: target.itemId,
                  },
            );
            const response = await this.#runBulkItemMutation(
              reservation.operationId,
              childInput,
              context,
              signal,
            );
            return downloadQueueBulkResultSchema.parse({
              response,
              status: "succeeded",
              target,
            });
          } catch (error) {
            if (signal?.aborted) throw error;
            const failure = bulkFailure(error);
            return downloadQueueBulkResultSchema.parse({
              ...failure,
              status: "failed",
              target,
            });
          }
        }),
      );
      results.push(...batchResults);
      this.#saveBulkProgress(reservation.operationId, results);
    }

    const byTarget = new Map(
      results.map((result) => [
        `${result.target.connectorId}\u0000${result.target.itemId}`,
        result,
      ]),
    );
    const orderedResults = input.targets.map((target) =>
      byTarget.get(`${target.connectorId}\u0000${target.itemId}`)!,
    );
    if (orderedResults.some((result) => result === undefined)) {
      throw new DownloadQueueError("storage_failure");
    }
    const succeeded = orderedResults.filter((result) => result.status === "succeeded").length;
    const failed = orderedResults.length - succeeded;
    const response = downloadQueueBulkActionResponseSchema.parse({
      action: input.action,
      completedAt: this.#clock().toISOString(),
      operationId: reservation.operationId,
      replayed: false,
      results: orderedResults,
      state: failed === 0 ? "complete" : succeeded === 0 ? "failed" : "partial",
      summary: { failed, requested: orderedResults.length, succeeded },
    });
    this.#completeBulk(reservation.operationId, response, input, context);
    return response;
  }

  public async remove(
    rawInput: DownloadQueueRemovalInput,
    rawIdempotencyKey: string,
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ): Promise<DownloadQueueRemovalResponse> {
    const principal = requirePermission(context.principal, "downloads.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new DownloadQueueError("identity_required");
    }
    const input = downloadQueueRemovalInputSchema.parse(rawInput);
    const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(
      JSON.stringify({ contentDisposition: "preserved", input, version: 1 }),
    );
    const keyHash = hashToken(
      `${principal.userId}\u0000download_queue_removal\u0000${idempotencyKey}`,
    );
    const reservation = this.#reserveRemoval(principal.userId, input, keyHash, fingerprintHash);
    if (reservation.kind === "replay") {
      const response = downloadQueueRemovalResponseSchema.parse({
        ...reservation.response,
        replayed: true,
      });
      this.#receipts.set(response, {
        operationId: reservation.response.operationId,
        replayed: true,
      });
      return response;
    }
    if (reservation.kind === "failure") {
      throw new DownloadQueueError(this.#storedItemFailureReason(reservation.failureCode), {
        operationId: reservation.operationId,
        replayed: true,
      });
    }
    if (reservation.kind === "uncertain") {
      throw new DownloadQueueError("operation_uncertain", {
        operationId: reservation.operationId,
        replayed: true,
      });
    }
    if (reservation.kind === "reconcile") {
      throw new DownloadQueueError("reconciliation_required", {
        operationId: reservation.operationId,
        replayed: true,
      });
    }
    if (reservation.kind === "conflict") {
      throw new DownloadQueueError("idempotency_conflict", {
        operationId: reservation.operationId,
        replayed: true,
      });
    }
    if (reservation.kind === "pending") {
      throw new DownloadQueueError("idempotency_in_progress", {
        operationId: reservation.operationId,
        replayed: true,
      });
    }
    let row: DownloadConnectorRow;
    try {
      row = this.#operationConnector(input.connectorId);
    } catch (error) {
      this.#completeRemovalFailure(
        reservation.operationId,
        input,
        context,
        actionFailureCode(error),
      );
      throw this.#operationError(error, reservation.operationId);
    }
    let dispatch = this.#journal.replay({
      kind: "download_queue.remove",
      parentOperationId: reservation.operationId,
      parentOperationType: "download_queue_removal_operation",
    });
    if (!dispatch) {
      try {
        if (
          this.#legacyDownloadTargetUnresolved(
            input.connectorId,
            input.itemId,
            reservation.operationId,
          )
        ) {
          this.#completeRemovalFailure(reservation.operationId, input, context, "target_locked");
          throw new DownloadQueueError("target_locked", {
            operationId: reservation.operationId,
          });
        }
        dispatch = this.#reserveRemovalDispatch(
          reservation.operationId,
          principal.userId,
          input,
          row,
        );
      } catch (error) {
        if (error instanceof ExternalMutationJournalError && error.code === "target_locked") {
          this.#completeRemovalFailure(reservation.operationId, input, context, "target_locked");
          throw new DownloadQueueError("target_locked", { operationId: reservation.operationId });
        }
        throw error;
      }
    } else if (dispatch.state === "reserved") {
      const currentNow = this.#now();
      if (!dispatch.leaseOwner || dispatch.leaseExpiresAt === null) {
        throw new DownloadQueueError("storage_failure");
      }
      if (dispatch.leaseExpiresAt >= currentNow) {
        throw new DownloadQueueError("idempotency_in_progress", {
          operationId: reservation.operationId,
          replayed: true,
        });
      }
      dispatch = this.#journal.claimStaleReserved({
        expectedLeaseExpiresAt: dispatch.leaseExpiresAt,
        expectedLeaseOwner: dispatch.leaseOwner,
        id: dispatch.id,
        leaseExpiresAt: currentNow + ITEM_OPERATION_LEASE_MS,
        leaseOwner: this.#leaseOwner(),
        now: currentNow,
      });
    } else {
      this.#completeRemovalIndefinite(
        reservation.operationId,
        dispatch.state === "uncertain" ? "uncertain" : "reconcile_required",
        dispatch.failureCode ?? "read_after_write_required",
      );
      throw new DownloadQueueError(
        dispatch.state === "uncertain" ? "operation_uncertain" : "reconciliation_required",
        { operationId: reservation.operationId, replayed: true },
      );
    }
    if (!dispatch) throw new DownloadQueueError("storage_failure");
    try {
      const activeRow = this.#actionConnector(input.connectorId);
      if (
        activeRow.instanceGeneration !== dispatch.connectorInstanceGeneration ||
        activeRow.configGeneration !== dispatch.connectorConfigGeneration
      ) {
        this.#journal.completeFailed({
          failureCode: "generation_mismatch",
          id: dispatch.id,
          now: this.#now(),
        });
        this.#completeRemovalFailure(
          reservation.operationId,
          input,
          context,
          "generation_mismatch",
        );
        throw new DownloadQueueError("generation_mismatch", {
          operationId: reservation.operationId,
        });
      }
      row = activeRow;
    } catch (error) {
      if (error instanceof DownloadQueueError && error.reason === "generation_mismatch") {
        throw error;
      }
      this.#journal.completeFailed({
        failureCode: "connector_unavailable",
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalFailure(
        reservation.operationId,
        input,
        context,
        "connector_unavailable",
      );
      throw new DownloadQueueError("connector_unavailable", {
        cause: error,
        operationId: reservation.operationId,
      });
    }
    let adapter: DownloadQueueController;
    try {
      adapter = this.#adapter(row);
    } catch (error) {
      const unavailable = new DownloadQueueError("connector_unavailable", { cause: error });
      this.#journal.completeFailed({
        failureCode: unavailable.reason,
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalFailure(reservation.operationId, input, context, unavailable.reason);
      throw new DownloadQueueError(unavailable.reason, {
        cause: error,
        operationId: reservation.operationId,
      });
    }

    let current: ExactQueueItem | null;
    let snapshot = reservation.itemSnapshot;
    const recoveringDispatched = reservation.kind === "recovered" && snapshot !== null;
    if (recoveringDispatched) {
      dispatch = this.#journal.markDispatched({
        id: dispatch.id,
        leaseOwner: dispatch.leaseOwner!,
        now: this.#now(),
      });
    }
    try {
      current = await this.#exactItem(adapter, row, input.itemId, signal);
      if (reservation.kind === "recovered" && snapshot) {
        if (!current) {
          const recovered = downloadQueueRemovalResponseSchema.parse({
            contentDisposition: "preserved",
            item: snapshot.item,
            operationId: reservation.operationId,
            removedAt: this.#clock().toISOString(),
            replayed: true,
          });
          this.#journal.completeSucceeded({ id: dispatch.id, now: this.#now() });
          this.#completeRemovalSuccess(reservation.operationId, recovered, input, context);
          this.#receipts.set(recovered, { operationId: reservation.operationId, replayed: true });
          return recovered;
        }
        if (!this.#sameRemovalSnapshot(snapshot, current, row)) {
          this.#journal.completeUncertain({
            failureCode: "target_changed",
            id: dispatch.id,
            now: this.#now(),
          });
          this.#completeRemovalIndefinite(reservation.operationId, "uncertain", "target_changed");
          throw new DownloadQueueError("operation_uncertain", {
            operationId: reservation.operationId,
          });
        }
      }
      if (!current) throw new DownloadQueueError("target_not_found");
      if (reservation.kind !== "recovered" && current.publicItem.state !== input.expectedState) {
        throw new DownloadQueueError("stale_state");
      }
      if (reservation.kind === "reserved" || !snapshot) {
        const preparedSnapshot = this.#removalSnapshot(row, current);
        snapshot = preparedSnapshot;
        this.#prepareRemoval(reservation.operationId, preparedSnapshot, input, context);
      }
    } catch (error) {
      if (error instanceof DownloadQueueError && error.reason === "operation_uncertain")
        throw error;
      if (dispatch.state === "reserved") {
        this.#journal.completeFailed({
          failureCode: this.#safeFailureCode(actionFailureCode(error)),
          id: dispatch.id,
          now: this.#now(),
        });
      } else {
        this.#journal.completeUncertain({
          failureCode: "reconciliation_failed",
          id: dispatch.id,
          now: this.#now(),
        });
        this.#completeRemovalIndefinite(
          reservation.operationId,
          "uncertain",
          "reconciliation_failed",
        );
        throw new DownloadQueueError("operation_uncertain", {
          cause: error,
          operationId: reservation.operationId,
        });
      }
      this.#completeRemovalFailure(
        reservation.operationId,
        input,
        context,
        actionFailureCode(error),
      );
      throw this.#operationError(error, reservation.operationId);
    }

    if (!snapshot) throw new DownloadQueueError("storage_failure");
    if (!this.#removalGenerationMatches(dispatch, row)) {
      if (dispatch.state === "reserved") {
        this.#journal.completeFailed({
          failureCode: "generation_mismatch",
          id: dispatch.id,
          now: this.#now(),
        });
        this.#completeRemovalFailure(
          reservation.operationId,
          input,
          context,
          "generation_mismatch",
        );
        throw new DownloadQueueError("generation_mismatch", {
          operationId: reservation.operationId,
        });
      }
      this.#journal.completeUncertain({
        failureCode: "generation_mismatch",
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalIndefinite(reservation.operationId, "uncertain", "generation_mismatch");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: reservation.operationId,
      });
    }
    if (recoveringDispatched) {
      dispatch = this.#journal.markReconcileRequired({
        failureCode: "identical_target_present",
        id: dispatch.id,
        now: this.#now(),
      });
      dispatch = this.#markItemRetryDispatched(dispatch);
    } else {
      dispatch = this.#journal.markDispatched({
        id: dispatch.id,
        leaseOwner: dispatch.leaseOwner!,
        now: this.#now(),
      });
    }
    try {
      await adapter.removeDownloadQueueItem({ externalId: current.externalId }, signal);
    } catch {
      // A lost response is reconciled through the exact reader below.
    }
    return this.#verifyRemoval(
      dispatch,
      reservation.operationId,
      snapshot,
      current,
      adapter,
      row,
      input,
      context,
      signal,
      recoveringDispatched,
    );
  }

  public async promote(
    rawInput: DownloadQueuePromotionInput,
    context: DownloadQueueContext,
    signal?: AbortSignal,
    rawIdempotencyKey?: string,
  ): Promise<DownloadQueuePromotionResponse> {
    const principal = requirePermission(context.principal, "downloads.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new DownloadQueueError("identity_required");
    }
    const input = downloadQueuePromotionInputSchema.parse(rawInput);
    const idempotencyKey = idempotencyKeySchema.parse(
      rawIdempotencyKey ?? `automatic-${randomToken(16)}`,
    );
    return this.#runDirectItemMutation(
      "promote",
      input,
      idempotencyKey,
      context,
      signal,
    ) as Promise<DownloadQueuePromotionResponse>;
  }

  async #readClient(row: DownloadConnectorRow, signal?: AbortSignal): Promise<ClientResult> {
    const service = row.type as DownloadClientService;
    const displayName = safeDisplayName(row.displayName, service);
    const occurredAt = this.#clock();
    try {
      const adapter = this.#adapter(row);
      const queue = await adapter.readDownloadQueue(signal);
      const items = queue.items.map((item) => this.#publicItem(row, item.externalId, item));
      return {
        client: {
          connectorId: row.id,
          displayName,
          failure: null,
          itemCount: items.length,
          rateBytesPerSecond: items.reduce((total, item) => total + item.rateBytesPerSecond, 0),
          service,
          status: "healthy",
        },
        items,
        sourceTruncated: queue.truncated,
      };
    } catch (error) {
      const failure = safeFailure(service, displayName, error, occurredAt);
      return {
        client: {
          connectorId: row.id,
          displayName,
          failure,
          itemCount: 0,
          rateBytesPerSecond: 0,
          service,
          status: "unavailable",
        },
        items: [],
        sourceTruncated: false,
      };
    }
  }

  #adapter(row: DownloadConnectorRow) {
    const service = row.type as DownloadClientService;
    const displayName = safeDisplayName(row.displayName, service);
    const secrets = connectorSecrets(row, service, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
      !row.displayName.trim() ||
      row.displayName.length > 160
    ) {
      throw new DownloadConnectorIntegrityError("invalid");
    }
    return this.#createAdapter({
      baseUrl: row.baseUrl,
      clock: { monotonicNow: () => performance.now(), now: this.#clock },
      connectorId: row.id,
      credentials: secrets.credentials,
      displayName,
      insecureHttpApproved: row.insecureHttpApproved === 1,
      service,
      tlsPolicy,
      ...(secrets.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: secrets.tlsCaCertificatePem }),
    });
  }

  #publicItem(row: DownloadConnectorRow, externalId: string, item: ConnectorDownloadQueueItem) {
    const {
      externalId: ignoredExternalId,
      queuePosition: ignoredQueuePosition,
      ...publicItem
    } = item;
    void ignoredExternalId;
    void ignoredQueuePosition;
    const service = row.type as DownloadClientService;
    return downloadQueueItemSchema.parse({
      ...publicItem,
      client: service,
      clientName: safeDisplayName(row.displayName, service),
      connectorId: row.id,
      id: this.#publicIdForGeneration(row.id, externalId, row.instanceGeneration),
      protocol: service === "qbittorrent" ? "torrent" : "usenet",
    });
  }

  #publicIdForGeneration(connectorId: string, externalId: string, instanceGeneration: number) {
    return `download_${privacyHash(
      "download_queue_item",
      instanceGeneration === 0
        ? `${connectorId}\u0000${externalId}`
        : `${connectorId}\u0000generation:${instanceGeneration}\u0000${externalId}`,
      this.#config.encryptionKey,
    )}`;
  }

  #exactIdentityDigest(
    row: DownloadConnectorRow,
    externalId: string,
    item: ConnectorDownloadQueueItem,
  ) {
    return hashToken(
      JSON.stringify({
        addedAt: item.addedAt,
        category: item.category,
        client: row.type,
        connectorId: row.id,
        externalId,
        instanceGeneration: row.instanceGeneration,
        sizeBytes: item.sizeBytes,
        title: item.title,
        version: 1,
      }),
    );
  }

  async #exactItem(
    adapter: DownloadQueueController,
    row: DownloadConnectorRow,
    itemId: string,
    signal?: AbortSignal,
  ): Promise<ExactQueueItem | null> {
    try {
      const queue = await adapter.readDownloadQueue(signal);
      const matches = queue.items.filter(
        (item) =>
          this.#publicIdForGeneration(row.id, item.externalId, row.instanceGeneration) === itemId,
      );
      if (matches.length === 0) return null;
      if (matches.length !== 1 || !matches[0]) {
        throw new DownloadQueueError("response_invalid");
      }
      const queuePosition = matches[0].queuePosition ?? null;
      if (queuePosition !== null && (!Number.isSafeInteger(queuePosition) || queuePosition < 0)) {
        throw new DownloadQueueError("response_invalid");
      }
      return {
        externalId: matches[0].externalId,
        identityDigest: this.#exactIdentityDigest(row, matches[0].externalId, matches[0]),
        publicItem: this.#publicItem(row, matches[0].externalId, matches[0]),
        queuePosition,
      };
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      if (error instanceof ZodError) {
        throw new DownloadQueueError("response_invalid", { cause: error });
      }
      throw error;
    }
  }

  async #runDirectItemMutation(
    kind: "pause" | "promote" | "resume",
    input: ItemMutationInput,
    idempotencyKey: string,
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ): Promise<ItemMutationResponse> {
    const userId = context.principal.userId!;
    const keyHash = hashToken(
      `${userId}\u0000download_queue_item_operation\u0000${idempotencyKey}`,
    );
    const fingerprintHash = this.#itemOperationFingerprint(kind, input);
    const existing = this.#itemOperationByKey(userId, keyHash);
    if (existing) {
      return this.#resumeItemMutation(
        existing,
        kind,
        input,
        fingerprintHash,
        context,
        false,
        signal,
      );
    }

    let row: DownloadConnectorRow;
    try {
      row = this.#operationConnector(input.connectorId);
    } catch (error) {
      this.#auditItemFailure(kind, input, context, null, actionFailureCode(error));
      throw error;
    }
    const execution = this.#createItemMutationExecution({
      bulkOperationId: null,
      fingerprintHash,
      input,
      keyHash,
      kind,
      row,
      userId,
    });
    const response = await this.#executeReservedItemMutation(execution, input, context, signal);
    this.#receipts.set(response, { operationId: execution.operation.id, replayed: false });
    return response;
  }

  async #runBulkItemMutation(
    bulkOperationId: string,
    input: DownloadQueueActionInput,
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ): Promise<DownloadQueueActionResponse> {
    const kind = input.action;
    const itemDigest = this.#itemDigest(input.itemId);
    const existing = this.#database.sqlite
      .prepare(
        `select id, bulk_operation_id as bulkOperationId, connector_id as connectorId,
                connector_instance_generation as connectorInstanceGeneration,
                connector_config_generation as connectorConfigGeneration,
                item_digest as itemDigest, kind, fingerprint_hash as fingerprintHash,
                state, failure_code as failureCode, completed_at as completedAt,
                updated_at as updatedAt
         from download_queue_item_operations
         where bulk_operation_id = ? and kind = ? and item_digest = ? limit 1`,
      )
      .get(bulkOperationId, kind, itemDigest) as ItemOperationRow | undefined;
    const fingerprintHash = this.#itemOperationFingerprint(kind, input, bulkOperationId);
    if (existing) {
      return this.#resumeItemMutation(
        existing,
        kind,
        input,
        fingerprintHash,
        context,
        true,
        signal,
      ) as Promise<DownloadQueueActionResponse>;
    }
    const row = this.#operationConnector(input.connectorId);
    const execution = this.#createItemMutationExecution({
      bulkOperationId,
      fingerprintHash,
      input,
      keyHash: null,
      kind,
      row,
      userId: context.principal.userId!,
    });
    return this.#executeReservedItemMutation(
      execution,
      input,
      context,
      signal,
    ) as Promise<DownloadQueueActionResponse>;
  }

  async #resumeItemMutation(
    operation: ItemOperationRow,
    kind: "pause" | "promote" | "resume",
    input: ItemMutationInput,
    fingerprintHash: string,
    context: DownloadQueueContext,
    allowReconciliation: boolean,
    signal?: AbortSignal,
  ): Promise<ItemMutationResponse> {
    if (
      operation.kind !== kind ||
      operation.fingerprintHash !== fingerprintHash ||
      operation.connectorId !== input.connectorId ||
      operation.itemDigest !== this.#itemDigest(input.itemId)
    ) {
      throw new DownloadQueueError("idempotency_conflict", {
        operationId: operation.id,
        replayed: true,
      });
    }
    const dispatch = this.#journal.replay({
      kind: `download_queue.${kind}`,
      parentOperationId: operation.id,
      parentOperationType: "download_queue_item_operation",
    });
    const evidence = dispatch ? this.#itemMutationEvidence(dispatch, kind) : undefined;
    if (operation.state === "succeeded") {
      if (!dispatch || !evidence?.response) throw new DownloadQueueError("storage_failure");
      if (dispatch.state !== "succeeded" && dispatch.state !== "failed") {
        this.#finishItemDispatchSuccess(operation.id, dispatch, evidence.response);
      }
      this.#receipts.set(evidence.response, { operationId: operation.id, replayed: true });
      return evidence.response;
    }
    if (operation.state === "failed") {
      throw new DownloadQueueError(this.#storedItemFailureReason(operation.failureCode), {
        operationId: operation.id,
        replayed: true,
      });
    }
    if (operation.state === "uncertain" || dispatch?.state === "uncertain") {
      throw new DownloadQueueError("operation_uncertain", {
        operationId: operation.id,
        replayed: true,
      });
    }
    if (operation.state === "reconcile_required" || dispatch?.state === "reconcile_required") {
      if (!allowReconciliation || !dispatch) {
        throw new DownloadQueueError("reconciliation_required", {
          operationId: operation.id,
          replayed: true,
        });
      }
      const row = this.#actionConnector(input.connectorId);
      return this.#reconcileItemMutation({ dispatch, operation, row }, input, context, signal);
    }
    if (!dispatch) {
      if (this.#now() - operation.updatedAt < ITEM_OPERATION_LEASE_MS) {
        throw new DownloadQueueError("idempotency_in_progress", {
          operationId: operation.id,
          replayed: true,
        });
      }
      const row = this.#actionConnector(input.connectorId);
      const reserved = this.#reserveDispatch(operation, input);
      return this.#executeReservedItemMutation(
        { dispatch: reserved, operation, row },
        input,
        context,
        signal,
      );
    }
    if (dispatch.state === "reserved") {
      const now = this.#now();
      if (!dispatch.leaseOwner || dispatch.leaseExpiresAt === null) {
        throw new DownloadQueueError("storage_failure");
      }
      if (dispatch.leaseExpiresAt >= now) {
        throw new DownloadQueueError("idempotency_in_progress", {
          operationId: operation.id,
          replayed: true,
        });
      }
      const row = this.#actionConnector(input.connectorId);
      const claimed = this.#journal.claimStaleReserved({
        expectedLeaseExpiresAt: dispatch.leaseExpiresAt,
        expectedLeaseOwner: dispatch.leaseOwner,
        id: dispatch.id,
        leaseExpiresAt: now + ITEM_OPERATION_LEASE_MS,
        leaseOwner: this.#leaseOwner(),
        now,
      });
      return this.#executeReservedItemMutation(
        { dispatch: claimed, operation, row },
        input,
        context,
        signal,
      );
    }
    if (dispatch.state === "dispatched") {
      if (evidence?.response) {
        this.#finishItemDispatchSuccess(operation.id, dispatch, evidence.response);
        this.#receipts.set(evidence.response, { operationId: operation.id, replayed: true });
        return evidence.response;
      }
      const reconciled = this.#markItemReconcile(operation, dispatch, "read_after_write_required");
      if (!allowReconciliation) {
        throw new DownloadQueueError("reconciliation_required", {
          operationId: operation.id,
          replayed: true,
        });
      }
      const row = this.#actionConnector(input.connectorId);
      return this.#reconcileItemMutation(
        { dispatch: reconciled, operation: { ...operation, state: "reconcile_required" }, row },
        input,
        context,
        signal,
      );
    }
    throw new DownloadQueueError("storage_failure");
  }

  #createItemMutationExecution(input: {
    bulkOperationId: string | null;
    fingerprintHash: string;
    input: ItemMutationInput;
    keyHash: string | null;
    kind: "pause" | "promote" | "resume";
    row: DownloadConnectorRow;
    userId: string;
  }): ItemMutationExecution {
    const now = this.#now();
    const operationId = this.#itemOperationId();
    try {
      this.#database.sqlite
        .transaction(() => {
          const cleanup = this.#journal.cleanupTerminalParents({
            completedBefore: now - ITEM_OPERATION_RETENTION_MS,
            limit: 100,
            parentOperationType: "download_queue_item_operation",
            userId: input.userId,
          });
          if (cleanup.mismatchedParents > 0) throw new DownloadQueueError("storage_failure");
          this.#database.sqlite
            .prepare(
              `insert into download_queue_item_operations (
                 id, bulk_operation_id, user_id, connector_id,
                 connector_instance_generation, connector_config_generation,
                 item_digest, kind, idempotency_key_hash, fingerprint_hash,
                 state, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
              operationId,
              input.bulkOperationId,
              input.userId,
              input.row.id,
              input.row.instanceGeneration,
              input.row.configGeneration,
              this.#itemDigest(input.input.itemId),
              input.kind,
              input.keyHash,
              input.fingerprintHash,
              now,
              now,
            );
        })
        .immediate();
      const operation = this.#itemOperation(operationId)!;
      if (
        this.#legacyDownloadTargetUnresolved(
          input.input.connectorId,
          input.input.itemId,
          operationId,
        )
      ) {
        this.#completeItemOperation(operationId, "failed", "target_locked");
        throw new DownloadQueueError("target_locked", { operationId });
      }
      const dispatch = this.#reserveDispatch(operation, input.input);
      return { dispatch, operation, row: input.row };
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      if (error instanceof ExternalMutationJournalError && error.code === "target_locked") {
        this.#completeItemOperation(operationId, "failed", "target_locked");
        throw new DownloadQueueError("target_locked", { operationId });
      }
      throw new DownloadQueueError("storage_failure", { cause: error, operationId });
    }
  }

  #reserveDispatch(operation: ItemOperationRow, input: ItemMutationInput) {
    const now = this.#now();
    return this.#journal.reserve({
      connectorConfigGeneration: operation.connectorConfigGeneration,
      connectorId: operation.connectorId,
      connectorInstanceGeneration: operation.connectorInstanceGeneration,
      id: this.#dispatchId(),
      kind: `download_queue.${operation.kind}`,
      leaseExpiresAt: now + ITEM_OPERATION_LEASE_MS,
      leaseOwner: this.#leaseOwner(),
      normalizedRequest: { input, schemaVersion: 1 },
      now,
      parentOperationId: operation.id,
      parentOperationType: "download_queue_item_operation",
      targetDigest: operation.itemDigest,
      userId: operation.bulkOperationId
        ? (this.#database.sqlite
            .prepare("select user_id from download_queue_bulk_operations where id = ?")
            .pluck()
            .get(operation.bulkOperationId) as string)
        : (this.#database.sqlite
            .prepare("select user_id from download_queue_item_operations where id = ?")
            .pluck()
            .get(operation.id) as string),
    });
  }

  async #executeReservedItemMutation(
    execution: ItemMutationExecution,
    input: ItemMutationInput,
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ): Promise<ItemMutationResponse> {
    try {
      const activeRow = this.#actionConnector(execution.operation.connectorId);
      if (
        activeRow.instanceGeneration !== execution.operation.connectorInstanceGeneration ||
        activeRow.configGeneration !== execution.operation.connectorConfigGeneration
      ) {
        this.#failItemBeforeDispatch(execution, input, context, "generation_mismatch");
        throw new DownloadQueueError("generation_mismatch", {
          operationId: execution.operation.id,
        });
      }
      execution.row = activeRow;
    } catch (error) {
      if (error instanceof DownloadQueueError && error.reason === "generation_mismatch") {
        throw error;
      }
      this.#failItemBeforeDispatch(execution, input, context, "connector_unavailable");
      throw new DownloadQueueError("connector_unavailable", {
        cause: error,
        operationId: execution.operation.id,
      });
    }
    let adapter: DownloadQueueController;
    try {
      adapter = this.#adapter(execution.row);
    } catch (error) {
      this.#failItemBeforeDispatch(execution, input, context, "connector_unavailable");
      throw new DownloadQueueError("connector_unavailable", {
        cause: error,
        operationId: execution.operation.id,
      });
    }
    let current: ExactQueueItem | null;
    try {
      current = await this.#exactItem(adapter, execution.row, input.itemId, signal);
    } catch (error) {
      this.#failItemBeforeDispatch(execution, input, context, actionFailureCode(error));
      throw this.#operationError(error, execution.operation.id);
    }
    if (!current) {
      this.#failItemBeforeDispatch(execution, input, context, "target_not_found");
      throw new DownloadQueueError("target_not_found", { operationId: execution.operation.id });
    }
    const noOp =
      execution.operation.kind === "promote"
        ? current.queuePosition === 0
        : actionAchieved(execution.operation.kind, current.publicItem.state);
    if (!noOp && current.publicItem.state !== input.expectedState) {
      this.#failItemBeforeDispatch(execution, input, context, "stale_state", current);
      throw new DownloadQueueError("stale_state", { operationId: execution.operation.id });
    }
    if (execution.operation.kind === "promote" && !noOp && current.queuePosition === null) {
      this.#failItemBeforeDispatch(execution, input, context, "queue_order_unavailable", current);
      throw new DownloadQueueError("queue_order_unavailable", {
        operationId: execution.operation.id,
      });
    }
    const evidence: StoredItemMutationEvidence = {
      input,
      schemaVersion: 1,
      target: this.#storedExactTarget(current),
    };
    try {
      this.#storeDispatchEvidence(execution.dispatch, evidence);
      this.#auditItemRequested(execution.operation.kind, input, context, current);
    } catch (error) {
      this.#journal.completeFailed({
        failureCode: "storage_failure",
        id: execution.dispatch.id,
        now: this.#now(),
      });
      this.#completeItemOperation(execution.operation.id, "failed", "storage_failure");
      throw this.#operationError(error, execution.operation.id);
    }
    if (noOp) {
      const response = this.#itemMutationResponse(
        execution.operation.kind,
        input,
        current,
        current,
        true,
      );
      evidence.response = response;
      this.#storeDispatchEvidence(execution.dispatch, evidence);
      this.#journal.completeFailed({
        failureCode: "no_dispatch_required",
        id: execution.dispatch.id,
        now: this.#now(),
      });
      this.#completeItemOperation(execution.operation.id, "succeeded", null);
      this.#auditItemCompleted(execution.operation.kind, input, context, current, true);
      return response;
    }
    if (!this.#connectorGenerationMatches(execution.operation)) {
      this.#failItemBeforeDispatch(execution, input, context, "generation_mismatch", current);
      throw new DownloadQueueError("generation_mismatch", {
        operationId: execution.operation.id,
      });
    }
    execution.dispatch = this.#journal.markDispatched({
      id: execution.dispatch.id,
      leaseOwner: execution.dispatch.leaseOwner!,
      now: this.#now(),
    });
    try {
      await this.#dispatchItemMutation(
        adapter,
        execution.operation.kind,
        current.externalId,
        signal,
      );
    } catch {
      // A transport error after dispatch is not evidence that the mutation failed.
    }
    return this.#verifyItemMutation(execution, input, current, adapter, context, signal);
  }

  async #reconcileItemMutation(
    execution: ItemMutationExecution,
    input: ItemMutationInput,
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ) {
    const evidence = this.#itemMutationEvidence(execution.dispatch, execution.operation.kind);
    if (!evidence?.target) throw new DownloadQueueError("storage_failure");
    const adapter = this.#adapter(execution.row);
    let current: ExactQueueItem | null;
    try {
      current = await this.#exactItem(adapter, execution.row, input.itemId, signal);
    } catch (error) {
      throw new DownloadQueueError("reconciliation_required", {
        cause: error,
        operationId: execution.operation.id,
        replayed: true,
      });
    }
    if (!this.#connectorGenerationMatches(execution.operation)) {
      this.#makeItemUncertain(execution, input, context, "generation_mismatch");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
        replayed: true,
      });
    }
    if (!current || current.identityDigest !== evidence.target.identityDigest) {
      this.#makeItemUncertain(execution, input, context, "target_changed");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
        replayed: true,
      });
    }
    if (this.#itemMutationAchieved(execution.operation.kind, current)) {
      const before = this.#exactTargetFromStored(evidence.target, current.externalId);
      return this.#succeedItemMutation(execution, input, before, current, context);
    }
    if (!this.#sameItemPrecondition(execution.operation.kind, current, evidence.target)) {
      this.#makeItemUncertain(execution, input, context, "target_changed");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
        replayed: true,
      });
    }
    if (execution.dispatch.dispatchAttemptCount !== 1) {
      this.#makeItemUncertain(execution, input, context, "retry_unconfirmed");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
        replayed: true,
      });
    }
    if (!this.#connectorGenerationMatches(execution.operation)) {
      this.#makeItemUncertain(execution, input, context, "generation_mismatch");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
        replayed: true,
      });
    }
    execution.dispatch = this.#markItemRetryDispatched(execution.dispatch);
    try {
      await this.#dispatchItemMutation(
        adapter,
        execution.operation.kind,
        current.externalId,
        signal,
      );
    } catch {
      // The final exact read, not the transport result, determines the outcome.
    }
    return this.#verifyItemMutation(execution, input, current, adapter, context, signal, true);
  }

  async #verifyItemMutation(
    execution: ItemMutationExecution,
    input: ItemMutationInput,
    before: ExactQueueItem,
    adapter: DownloadQueueController,
    context: DownloadQueueContext,
    signal?: AbortSignal,
    retryConsumed = false,
  ): Promise<ItemMutationResponse> {
    let current: ExactQueueItem | null;
    try {
      current = await this.#exactItem(adapter, execution.row, input.itemId, signal);
    } catch (error) {
      if (retryConsumed) {
        this.#makeItemUncertain(execution, input, context, "retry_outcome_unknown");
        throw new DownloadQueueError("operation_uncertain", {
          cause: error,
          operationId: execution.operation.id,
        });
      }
      this.#markItemReconcile(execution.operation, execution.dispatch, "read_after_write_required");
      throw new DownloadQueueError("reconciliation_required", {
        cause: error,
        operationId: execution.operation.id,
      });
    }
    if (!this.#connectorGenerationMatches(execution.operation)) {
      this.#makeItemUncertain(execution, input, context, "generation_mismatch");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
      });
    }
    if (!current || current.identityDigest !== before.identityDigest) {
      this.#makeItemUncertain(execution, input, context, "target_changed");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
      });
    }
    if (this.#itemMutationAchieved(execution.operation.kind, current)) {
      return this.#succeedItemMutation(execution, input, before, current, context);
    }
    const stored = this.#storedExactTarget(before);
    if (retryConsumed || !this.#sameItemPrecondition(execution.operation.kind, current, stored)) {
      this.#makeItemUncertain(execution, input, context, "postcondition_changed");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
      });
    }
    execution.dispatch = this.#journal.markReconcileRequired({
      failureCode: "opposite_postcondition",
      id: execution.dispatch.id,
      now: this.#now(),
    });
    if (!this.#connectorGenerationMatches(execution.operation)) {
      this.#makeItemUncertain(execution, input, context, "generation_mismatch");
      throw new DownloadQueueError("operation_uncertain", {
        operationId: execution.operation.id,
      });
    }
    execution.dispatch = this.#markItemRetryDispatched(execution.dispatch);
    try {
      await this.#dispatchItemMutation(
        adapter,
        execution.operation.kind,
        current.externalId,
        signal,
      );
    } catch {
      // The retry is consumed even when its response is lost.
    }
    return this.#verifyItemMutation(execution, input, before, adapter, context, signal, true);
  }

  #succeedItemMutation(
    execution: ItemMutationExecution,
    input: ItemMutationInput,
    before: ExactQueueItem,
    current: ExactQueueItem,
    context: DownloadQueueContext,
  ) {
    const response = this.#itemMutationResponse(
      execution.operation.kind,
      input,
      before,
      current,
      false,
    );
    const evidence = this.#itemMutationEvidence(execution.dispatch, execution.operation.kind);
    if (!evidence) throw new DownloadQueueError("storage_failure");
    evidence.response = response;
    this.#storeDispatchEvidence(execution.dispatch, evidence);
    this.#finishItemDispatchSuccess(execution.operation.id, execution.dispatch, response);
    this.#auditItemCompleted(execution.operation.kind, input, context, before, false);
    return response;
  }

  #finishItemDispatchSuccess(
    operationId: string,
    dispatch: ExternalMutationRecord,
    _response: ItemMutationResponse,
  ) {
    this.#database.sqlite.transaction(() => {
      this.#completeItemOperation(operationId, "succeeded", null);
      if (dispatch.state === "dispatched" || dispatch.state === "reconcile_required") {
        this.#journal.completeSucceeded({ id: dispatch.id, now: this.#now() });
      }
    })();
  }

  #failItemBeforeDispatch(
    execution: ItemMutationExecution,
    input: ItemMutationInput,
    context: DownloadQueueContext,
    failureCode: string,
    current?: ExactQueueItem,
  ) {
    const safeCode = this.#safeFailureCode(failureCode);
    this.#journal.completeFailed({
      failureCode: safeCode,
      id: execution.dispatch.id,
      now: this.#now(),
    });
    this.#completeItemOperation(execution.operation.id, "failed", safeCode);
    this.#auditItemFailure(execution.operation.kind, input, context, current ?? null, safeCode);
  }

  #markItemReconcile(
    operation: ItemOperationRow,
    dispatch: ExternalMutationRecord,
    failureCode: string,
  ) {
    const safeCode = this.#safeFailureCode(failureCode);
    const reconciled =
      dispatch.state === "dispatched"
        ? this.#journal.markReconcileRequired({
            failureCode: safeCode,
            id: dispatch.id,
            now: this.#now(),
          })
        : dispatch;
    this.#completeItemOperation(operation.id, "reconcile_required", safeCode);
    return reconciled;
  }

  #makeItemUncertain(
    execution: ItemMutationExecution,
    input: ItemMutationInput,
    context: DownloadQueueContext,
    failureCode: string,
  ) {
    const safeCode = this.#safeFailureCode(failureCode);
    this.#journal.completeUncertain({
      failureCode: safeCode,
      id: execution.dispatch.id,
      now: this.#now(),
    });
    this.#completeItemOperation(execution.operation.id, "uncertain", safeCode);
    this.#auditItemFailure(execution.operation.kind, input, context, null, safeCode);
  }

  #markItemRetryDispatched(dispatch: ExternalMutationRecord) {
    const now = this.#now();
    const updated = this.#database.sqlite
      .prepare(
        `update external_mutation_dispatches
         set dispatch_attempt_count = 2, updated_at = max(updated_at, ?)
         where id = ? and state = 'reconcile_required' and dispatch_attempt_count = 1`,
      )
      .run(now, dispatch.id);
    if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
    return this.#journal.read(dispatch.id)!;
  }

  async #dispatchItemMutation(
    adapter: DownloadQueueController,
    kind: "pause" | "promote" | "resume",
    externalId: string,
    signal?: AbortSignal,
  ) {
    if (kind === "promote") {
      await adapter.promoteDownloadQueueItem({ externalId }, signal);
      return;
    }
    await adapter.updateDownloadQueueItem({ action: kind, externalId }, signal);
  }

  #itemMutationResponse(
    kind: "pause" | "promote" | "resume",
    _input: ItemMutationInput,
    before: ExactQueueItem,
    current: ExactQueueItem,
    replayed: boolean,
  ): ItemMutationResponse {
    if (kind === "promote") {
      return downloadQueuePromotionResponseSchema.parse({
        item: current.publicItem,
        position: 0,
        previousPosition: before.queuePosition,
        promotedAt: this.#clock().toISOString(),
        replayed,
      });
    }
    return downloadQueueActionResponseSchema.parse({
      action: kind,
      item: current.publicItem,
      previousState: before.publicItem.state,
      replayed,
      verifiedAt: this.#clock().toISOString(),
    });
  }

  #itemMutationAchieved(kind: "pause" | "promote" | "resume", current: ExactQueueItem) {
    return kind === "promote"
      ? current.queuePosition === 0
      : actionAchieved(kind, current.publicItem.state);
  }

  #sameItemPrecondition(
    kind: "pause" | "promote" | "resume",
    current: ExactQueueItem,
    target: StoredExactTarget,
  ) {
    return (
      current.identityDigest === target.identityDigest &&
      current.publicItem.state === target.publicItem.state &&
      (kind !== "promote" || current.queuePosition === target.queuePosition)
    );
  }

  #storedExactTarget(item: ExactQueueItem): StoredExactTarget {
    return {
      identityDigest: item.identityDigest,
      publicItem: item.publicItem,
      queuePosition: item.queuePosition,
    };
  }

  #exactTargetFromStored(target: StoredExactTarget, externalId: string): ExactQueueItem {
    return {
      externalId,
      identityDigest: target.identityDigest,
      publicItem: target.publicItem,
      queuePosition: target.queuePosition,
    };
  }

  #storeDispatchEvidence(dispatch: ExternalMutationRecord, evidence: StoredItemMutationEvidence) {
    const encrypted = this.#cipher.encrypt(
      JSON.stringify(evidence),
      externalMutationRequestEncryptionContext(dispatch.id, dispatch.kind),
    );
    const updated = this.#database.sqlite
      .prepare(
        `update external_mutation_dispatches
         set encrypted_normalized_request = ?, updated_at = max(updated_at, ?)
         where id = ? and state in ('reserved', 'dispatched', 'reconcile_required')`,
      )
      .run(encrypted, this.#now(), dispatch.id);
    if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
  }

  #itemMutationEvidence(
    dispatch: ExternalMutationRecord,
    kind: "pause" | "promote" | "resume",
  ): StoredItemMutationEvidence | undefined {
    const value = (this.#journal.read(dispatch.id) ?? dispatch).normalizedRequest;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1) return undefined;
    const parsedInput =
      kind === "promote"
        ? downloadQueuePromotionInputSchema.safeParse(record.input)
        : downloadQueueActionInputSchema.safeParse(record.input);
    if (!parsedInput.success) return undefined;
    let target: StoredExactTarget | undefined;
    if (record.target !== undefined) {
      if (!record.target || typeof record.target !== "object" || Array.isArray(record.target)) {
        return undefined;
      }
      const rawTarget = record.target as Record<string, unknown>;
      const item = downloadQueueItemSchema.safeParse(rawTarget.publicItem);
      if (
        !item.success ||
        typeof rawTarget.identityDigest !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(rawTarget.identityDigest) ||
        (rawTarget.queuePosition !== null &&
          (!Number.isSafeInteger(rawTarget.queuePosition) || Number(rawTarget.queuePosition) < 0))
      ) {
        return undefined;
      }
      target = {
        identityDigest: rawTarget.identityDigest,
        publicItem: item.data,
        queuePosition: rawTarget.queuePosition as number | null,
      };
    }
    let response: ItemMutationResponse | undefined;
    if (record.response !== undefined) {
      const parsed =
        kind === "promote"
          ? downloadQueuePromotionResponseSchema.safeParse(record.response)
          : downloadQueueActionResponseSchema.safeParse(record.response);
      if (!parsed.success) return undefined;
      response = parsed.data;
    }
    return {
      input: parsedInput.data,
      schemaVersion: 1,
      ...(target ? { target } : {}),
      ...(response ? { response } : {}),
    };
  }

  #completeItemOperation(
    operationId: string,
    state: "failed" | "reconcile_required" | "succeeded" | "uncertain",
    failureCode: string | null,
  ) {
    const now = this.#now();
    const updated = this.#database.sqlite
      .prepare(
        `update download_queue_item_operations
         set state = ?, failure_code = ?, completed_at = ?, updated_at = max(updated_at, ?)
         where id = ? and state in ('pending', 'reconcile_required')`,
      )
      .run(state, failureCode, now, now, operationId);
    if (updated.changes !== 1) {
      const current = this.#itemOperation(operationId);
      if (current?.state !== state) throw new DownloadQueueError("storage_failure");
    }
  }

  #itemOperation(id: string) {
    return this.#database.sqlite
      .prepare(
        `select id, bulk_operation_id as bulkOperationId, connector_id as connectorId,
                connector_instance_generation as connectorInstanceGeneration,
                connector_config_generation as connectorConfigGeneration,
                item_digest as itemDigest, kind, fingerprint_hash as fingerprintHash,
                state, failure_code as failureCode, completed_at as completedAt,
                updated_at as updatedAt
         from download_queue_item_operations where id = ? limit 1`,
      )
      .get(id) as ItemOperationRow | undefined;
  }

  #itemOperationByKey(userId: string, keyHash: string) {
    return this.#database.sqlite
      .prepare(
        `select id, bulk_operation_id as bulkOperationId, connector_id as connectorId,
                connector_instance_generation as connectorInstanceGeneration,
                connector_config_generation as connectorConfigGeneration,
                item_digest as itemDigest, kind, fingerprint_hash as fingerprintHash,
                state, failure_code as failureCode, completed_at as completedAt,
                updated_at as updatedAt
         from download_queue_item_operations
         where user_id = ? and idempotency_key_hash = ? limit 1`,
      )
      .get(userId, keyHash) as ItemOperationRow | undefined;
  }

  #itemOperationFingerprint(
    kind: "pause" | "promote" | "resume",
    input: ItemMutationInput,
    bulkOperationId?: string,
  ) {
    return hashToken(
      JSON.stringify({ bulkOperationId: bulkOperationId ?? null, input, kind, version: 2 }),
    );
  }

  #itemDigest(itemId: string) {
    const digest = itemId.slice("download_".length);
    if (!/^[A-Za-z0-9_-]{22}$/u.test(digest)) throw new DownloadQueueError("storage_failure");
    return digest;
  }

  #connectorGenerationMatches(operation: ItemOperationRow) {
    const current = this.#database.sqlite
      .prepare(
        `select instance_generation as instanceGeneration, config_generation as configGeneration
         from connector_configs where id = ? limit 1`,
      )
      .get(operation.connectorId) as
      { configGeneration: number; instanceGeneration: number } | undefined;
    return (
      current?.instanceGeneration === operation.connectorInstanceGeneration &&
      current.configGeneration === operation.connectorConfigGeneration
    );
  }

  #storedItemFailureReason(failureCode: string | null): DownloadQueueErrorReason {
    if (failureCode === "target_locked") return "target_locked";
    if (failureCode === "generation_mismatch") return "generation_mismatch";
    return "operation_failed";
  }

  #legacyDownloadTargetUnresolved(
    connectorId: string,
    itemId: string,
    excludedOperationId: string,
  ) {
    return Boolean(
      this.#database.sqlite
        .prepare(
          `select 1
           from download_queue_removal_operations removal
           where removal.connector_id = ? and removal.item_id = ?
             and removal.id <> ? and removal.state in ('reconcile_required', 'uncertain')
             and not exists (
               select 1 from external_mutation_dispatches dispatch
               where dispatch.parent_operation_type = 'download_queue_removal_operation'
                 and dispatch.parent_operation_id = removal.id
             )
           union all
           select 1
           from download_queue_item_operations item
           where item.connector_id = ? and item.item_digest = ?
             and item.id <> ? and item.state in ('reconcile_required', 'uncertain')
             and not exists (
               select 1 from external_mutation_dispatches dispatch
               where dispatch.parent_operation_type = 'download_queue_item_operation'
                 and dispatch.parent_operation_id = item.id
             )
           limit 1`,
        )
        .get(
          connectorId,
          itemId,
          excludedOperationId,
          connectorId,
          this.#itemDigest(itemId),
          excludedOperationId,
        ),
    );
  }

  #operationError(error: unknown, operationId: string) {
    if (error instanceof DownloadQueueError) {
      return new DownloadQueueError(error.reason, { cause: error, operationId });
    }
    if (error instanceof SafeConnectorError) {
      Object.defineProperty(error, "operationId", {
        configurable: true,
        enumerable: false,
        value: operationId,
        writable: false,
      });
      return error;
    }
    return new DownloadQueueError("connector_unavailable", { cause: error, operationId });
  }

  #safeFailureCode(value: string) {
    const safe = value
      .toLowerCase()
      .replace(/[^a-z0-9_]/gu, "_")
      .slice(0, 64);
    return safe || "upstream_failure";
  }

  #auditItemRequested(
    kind: "pause" | "promote" | "resume",
    input: ItemMutationInput,
    context: DownloadQueueContext,
    current: ExactQueueItem,
  ) {
    if (kind === "promote") {
      this.#auditPromotion(
        "requested",
        "success",
        input as DownloadQueuePromotionInput,
        context,
        current.queuePosition,
        null,
      );
    } else {
      this.#audit(
        "requested",
        "success",
        input as DownloadQueueActionInput,
        context,
        current.publicItem.state,
        null,
      );
    }
  }

  #auditItemCompleted(
    kind: "pause" | "promote" | "resume",
    input: ItemMutationInput,
    context: DownloadQueueContext,
    before: ExactQueueItem,
    replayed: boolean,
  ) {
    if (kind === "promote") {
      this.#auditPromotion(
        replayed ? "replayed" : "completed",
        "success",
        input as DownloadQueuePromotionInput,
        context,
        before.queuePosition,
        null,
      );
    } else {
      this.#audit(
        replayed ? "replayed" : "updated",
        "success",
        input as DownloadQueueActionInput,
        context,
        before.publicItem.state,
        null,
      );
    }
  }

  #auditItemFailure(
    kind: "pause" | "promote" | "resume",
    input: ItemMutationInput,
    context: DownloadQueueContext,
    current: ExactQueueItem | null,
    failureCode: string,
  ) {
    if (kind === "promote") {
      this.#auditPromotion(
        "failed",
        "failure",
        input as DownloadQueuePromotionInput,
        context,
        current?.queuePosition ?? null,
        failureCode,
      );
    } else {
      this.#audit(
        "failed",
        "failure",
        input as DownloadQueueActionInput,
        context,
        current?.publicItem.state ?? null,
        failureCode,
      );
    }
  }

  #reserveBulk(
    userId: string,
    input: DownloadQueueBulkActionInput,
    keyHash: string,
    fingerprintHash: string,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const now = this.#now();
          const cleanup = this.#journal.cleanupTerminalParents({
            completedBefore: now - BULK_OPERATION_RETENTION_MS,
            limit: 100,
            parentOperationType: "download_queue_item_operation",
            userId,
          });
          if (cleanup.mismatchedParents > 0) throw new DownloadQueueError("storage_failure");
          this.#database.sqlite
            .prepare(
              `delete from download_queue_bulk_operations where id in (
                 select parent.id from download_queue_bulk_operations parent
                 where parent.user_id = ? and parent.state = 'succeeded'
                   and parent.completed_at <= ?
                   and not exists (
                     select 1 from download_queue_item_operations child
                     where child.bulk_operation_id = parent.id
                   )
                 order by parent.completed_at asc, parent.id asc limit 100
               )`,
            )
            .run(userId, now - BULK_OPERATION_RETENTION_MS);
          const existing = this.#database.sqlite
            .prepare(
              `select id, fingerprint_hash as fingerprintHash, state,
                      request_json as requestJson, results_json as resultsJson,
                      response_json as responseJson, updated_at as updatedAt
               from download_queue_bulk_operations
               where user_id = ? and idempotency_key_hash = ?
               limit 1`,
            )
            .get(userId, keyHash) as BulkOperationRow | undefined;
          if (existing) {
            if (existing.fingerprintHash !== fingerprintHash) {
              return { kind: "conflict" as const, operationId: existing.id };
            }
            const storedInput = downloadQueueBulkActionInputSchema.parse(
              JSON.parse(existing.requestJson),
            );
            if (JSON.stringify(storedInput) !== JSON.stringify(input)) {
              throw new DownloadQueueError("storage_failure");
            }
            if (existing.state === "succeeded" && existing.responseJson) {
              return {
                kind: "replay" as const,
                response: downloadQueueBulkActionResponseSchema.parse(
                  JSON.parse(existing.responseJson),
                ),
              };
            }
            if (existing.state === "quarantined" && !existing.responseJson) {
              return { kind: "quarantined" as const, operationId: existing.id };
            }
            if (existing.state !== "pending" || existing.responseJson) {
              throw new DownloadQueueError("storage_failure");
            }
            if (
              !Number.isSafeInteger(existing.updatedAt) ||
              existing.updatedAt < 0 ||
              existing.updatedAt > now ||
              now - existing.updatedAt < BULK_RECOVERY_LEASE_MS
            ) {
              return { kind: "pending" as const, operationId: existing.id };
            }
            const results = downloadQueueBulkResultSchema
              .array()
              .parse(JSON.parse(existing.resultsJson));
            const requestedTargets = new Map(
              input.targets.map((target) => [
                `${target.connectorId}\u0000${target.itemId}`,
                target,
              ]),
            );
            const persistedTargets = new Set<string>();
            for (const result of results) {
              const target = `${result.target.connectorId}\u0000${result.target.itemId}`;
              const requested = requestedTargets.get(target);
              if (
                !requested ||
                result.target.expectedState !== requested.expectedState ||
                persistedTargets.has(target)
              ) {
                throw new DownloadQueueError("storage_failure");
              }
              persistedTargets.add(target);
            }
            const claimed = this.#database.sqlite
              .prepare(
                `update download_queue_bulk_operations
                 set updated_at = ?
                 where id = ? and state = 'pending' and updated_at = ?`,
              )
              .run(now, existing.id, existing.updatedAt);
            if (claimed.changes !== 1) {
              return { kind: "pending" as const, operationId: existing.id };
            }
            return {
              kind: "recovered" as const,
              operationId: existing.id,
              results,
            };
          }
          const count = this.#database.sqlite
            .prepare(
              "select count(*) as count from download_queue_bulk_operations where user_id = ?",
            )
            .get(userId) as { count: number };
          if (count.count >= MAX_BULK_OPERATIONS_PER_USER) {
            throw new DownloadQueueError("operation_limit_reached");
          }
          const operationId = this.#bulkOperationId();
          this.#database.sqlite
            .prepare(
              `insert into download_queue_bulk_operations (
                 id, user_id, idempotency_key_hash, fingerprint_hash, state,
                 request_json, results_json, created_at, updated_at
               ) values (?, ?, ?, ?, 'pending', ?, '[]', ?, ?)`,
            )
            .run(operationId, userId, keyHash, fingerprintHash, JSON.stringify(input), now, now);
          return {
            kind: "reserved" as const,
            operationId,
            results: [] as DownloadQueueBulkResult[],
          };
        })
        .immediate();
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #saveBulkProgress(operationId: string, results: DownloadQueueBulkResult[]) {
    try {
      const validated = downloadQueueBulkResultSchema.array().parse(results);
      const updated = this.#database.sqlite
        .prepare(
          `update download_queue_bulk_operations
           set results_json = ?, updated_at = ?
           where id = ? and state = 'pending'`,
        )
        .run(JSON.stringify(validated), this.#now(), operationId);
      if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #completeBulk(
    operationId: string,
    response: DownloadQueueBulkActionResponse,
    input: DownloadQueueBulkActionInput,
    context: DownloadQueueContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite
        .transaction(() => {
          const updated = this.#database.sqlite
            .prepare(
              `update download_queue_bulk_operations
               set state = 'succeeded', results_json = ?, response_json = ?,
                   completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(JSON.stringify(response.results), JSON.stringify(response), now, now, operationId);
          if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
          this.#auditBulk(
            "completed",
            response.state === "failed" ? "failure" : "success",
            operationId,
            input,
            context,
            response.summary,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #auditBulk(
    action: "completed" | "requested",
    outcome: "failure" | "success",
    operationId: string,
    input: DownloadQueueBulkActionInput,
    context: DownloadQueueContext,
    metadata: Record<string, unknown>,
    createdAt = this.#now(),
  ) {
    try {
      this.#database.sqlite
        .prepare(
          `insert into audit_events (
             id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
             target_type, target_id, request_id, metadata_json, ip_hash, created_at
           ) values (?, ?, ?, ?, ?, ?, 'download_queue_bulk_operation', ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#createId(),
          context.principal.userId,
          context.principal.sessionId,
          context.principal.authenticationMethod.kind,
          `download.queue.bulk.${action}`,
          outcome,
          operationId,
          context.requestId ?? null,
          JSON.stringify({
            action: input.action,
            connectorCount: new Set(input.targets.map((target) => target.connectorId)).size,
            ...metadata,
          }),
          context.ipAddress
            ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
            : null,
          createdAt,
        );
    } catch (error) {
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #reserveRemovalDispatch(
    operationId: string,
    userId: string,
    input: DownloadQueueRemovalInput,
    row: DownloadConnectorRow,
  ) {
    const now = this.#now();
    return this.#journal.reserve({
      connectorConfigGeneration: row.configGeneration,
      connectorId: row.id,
      connectorInstanceGeneration: row.instanceGeneration,
      id: this.#dispatchId(),
      kind: "download_queue.remove",
      leaseExpiresAt: now + ITEM_OPERATION_LEASE_MS,
      leaseOwner: this.#leaseOwner(),
      normalizedRequest: { contentDisposition: "preserved", input, schemaVersion: 1 },
      now,
      parentOperationId: operationId,
      parentOperationType: "download_queue_removal_operation",
      targetDigest: this.#itemDigest(input.itemId),
      userId,
    });
  }

  #removalSnapshot(row: DownloadConnectorRow, current: ExactQueueItem): StoredRemovalSnapshot {
    return {
      connectorConfigGeneration: row.configGeneration,
      connectorInstanceGeneration: row.instanceGeneration,
      identityDigest: current.identityDigest,
      item: current.publicItem,
      schemaVersion: 2,
    };
  }

  #parseRemovalSnapshot(value: string): StoredRemovalSnapshot {
    const decoded = JSON.parse(value) as unknown;
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const record = decoded as Record<string, unknown>;
      if (record.schemaVersion === 2) {
        const item = downloadQueueItemSchema.parse(record.item);
        if (
          typeof record.identityDigest !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(record.identityDigest) ||
          !Number.isSafeInteger(record.connectorInstanceGeneration) ||
          Number(record.connectorInstanceGeneration) < 0 ||
          !Number.isSafeInteger(record.connectorConfigGeneration) ||
          Number(record.connectorConfigGeneration) < 0
        ) {
          throw new DownloadQueueError("storage_failure");
        }
        return {
          connectorConfigGeneration: Number(record.connectorConfigGeneration),
          connectorInstanceGeneration: Number(record.connectorInstanceGeneration),
          identityDigest: record.identityDigest,
          item,
          schemaVersion: 2,
        };
      }
    }
    const item = downloadQueueItemSchema.parse(decoded);
    return {
      identityDigest: hashToken(
        JSON.stringify({
          addedAt: item.addedAt,
          category: item.category,
          client: item.client,
          connectorId: item.connectorId,
          sizeBytes: item.sizeBytes,
          title: item.title,
          version: 1,
        }),
      ),
      item,
      schemaVersion: 1,
    };
  }

  #sameRemovalSnapshot(
    snapshot: StoredRemovalSnapshot,
    current: ExactQueueItem,
    row: DownloadConnectorRow,
  ) {
    if (snapshot.schemaVersion === 2) {
      return (
        snapshot.identityDigest === current.identityDigest &&
        snapshot.connectorInstanceGeneration === row.instanceGeneration &&
        snapshot.connectorConfigGeneration === row.configGeneration
      );
    }
    return sameRemovalTarget(snapshot.item, current.publicItem);
  }

  #removalGenerationMatches(dispatch: ExternalMutationRecord, row: DownloadConnectorRow) {
    const current = this.#database.sqlite
      .prepare(
        `select instance_generation as instanceGeneration, config_generation as configGeneration
         from connector_configs where id = ? limit 1`,
      )
      .get(row.id) as { configGeneration: number; instanceGeneration: number } | undefined;
    return (
      dispatch.connectorInstanceGeneration === row.instanceGeneration &&
      dispatch.connectorConfigGeneration === row.configGeneration &&
      current?.instanceGeneration === dispatch.connectorInstanceGeneration &&
      current.configGeneration === dispatch.connectorConfigGeneration
    );
  }

  async #verifyRemoval(
    dispatch: ExternalMutationRecord,
    operationId: string,
    snapshot: StoredRemovalSnapshot,
    before: ExactQueueItem,
    adapter: DownloadQueueController,
    row: DownloadConnectorRow,
    input: DownloadQueueRemovalInput,
    context: DownloadQueueContext,
    signal?: AbortSignal,
    retryConsumed = false,
  ): Promise<DownloadQueueRemovalResponse> {
    let current: ExactQueueItem | null;
    try {
      current = await this.#exactItem(adapter, row, input.itemId, signal);
    } catch (error) {
      if (retryConsumed) {
        this.#journal.completeUncertain({
          failureCode: "retry_outcome_unknown",
          id: dispatch.id,
          now: this.#now(),
        });
        this.#completeRemovalIndefinite(operationId, "uncertain", "retry_outcome_unknown");
        throw new DownloadQueueError("operation_uncertain", { cause: error, operationId });
      }
      this.#journal.markReconcileRequired({
        failureCode: "read_after_write_required",
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalIndefinite(
        operationId,
        "reconcile_required",
        "read_after_write_required",
      );
      throw new DownloadQueueError("reconciliation_required", { cause: error, operationId });
    }
    if (!this.#removalGenerationMatches(dispatch, row)) {
      this.#journal.completeUncertain({
        failureCode: "generation_mismatch",
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalIndefinite(operationId, "uncertain", "generation_mismatch");
      throw new DownloadQueueError("operation_uncertain", { operationId });
    }
    if (!current) {
      const response = downloadQueueRemovalResponseSchema.parse({
        contentDisposition: "preserved",
        item: snapshot.item,
        operationId,
        removedAt: this.#clock().toISOString(),
        replayed: false,
      });
      this.#journal.completeSucceeded({ id: dispatch.id, now: this.#now() });
      this.#completeRemovalSuccess(operationId, response, input, context);
      this.#receipts.set(response, { operationId, replayed: false });
      return response;
    }
    if (!this.#sameRemovalSnapshot(snapshot, current, row)) {
      this.#journal.completeUncertain({
        failureCode: "target_changed",
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalIndefinite(operationId, "uncertain", "target_changed");
      throw new DownloadQueueError("operation_uncertain", { operationId });
    }
    if (retryConsumed || dispatch.dispatchAttemptCount !== 1) {
      this.#journal.completeUncertain({
        failureCode: "retry_unconfirmed",
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalIndefinite(operationId, "uncertain", "retry_unconfirmed");
      throw new DownloadQueueError("operation_uncertain", { operationId });
    }
    const reconciled = this.#journal.markReconcileRequired({
      failureCode: "identical_target_present",
      id: dispatch.id,
      now: this.#now(),
    });
    if (!this.#removalGenerationMatches(reconciled, row)) {
      this.#journal.completeUncertain({
        failureCode: "generation_mismatch",
        id: dispatch.id,
        now: this.#now(),
      });
      this.#completeRemovalIndefinite(operationId, "uncertain", "generation_mismatch");
      throw new DownloadQueueError("operation_uncertain", { operationId });
    }
    const retried = this.#markItemRetryDispatched(reconciled);
    try {
      await adapter.removeDownloadQueueItem({ externalId: current.externalId }, signal);
    } catch {
      // The proof-based retry is consumed even if its response is lost.
    }
    return this.#verifyRemoval(
      retried,
      operationId,
      snapshot,
      before,
      adapter,
      row,
      input,
      context,
      signal,
      true,
    );
  }

  #completeRemovalIndefinite(
    operationId: string,
    state: "reconcile_required" | "uncertain",
    failureCode: string,
  ) {
    const now = this.#now();
    const updated = this.#database.sqlite
      .prepare(
        `update download_queue_removal_operations
         set state = ?, failure_code = ?, response_json = null,
             completed_at = ?, updated_at = max(updated_at, ?)
         where id = ? and state in ('pending', 'reconcile_required')`,
      )
      .run(state, this.#safeFailureCode(failureCode), now, now, operationId);
    if (updated.changes !== 1) {
      const current = this.#database.sqlite
        .prepare("select state from download_queue_removal_operations where id = ?")
        .pluck()
        .get(operationId);
      if (current !== state) throw new DownloadQueueError("storage_failure");
    }
  }

  #reserveRemoval(
    userId: string,
    input: DownloadQueueRemovalInput,
    keyHash: string,
    fingerprintHash: string,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const now = this.#now();
          const cleanup = this.#journal.cleanupTerminalParents({
            completedBefore: now - REMOVAL_OPERATION_RETENTION_MS,
            limit: 100,
            parentOperationType: "download_queue_removal_operation",
            userId,
          });
          if (cleanup.mismatchedParents > 0) throw new DownloadQueueError("storage_failure");
          const existing = this.#database.sqlite
            .prepare(
              `select id, fingerprint_hash as fingerprintHash, state,
                      item_snapshot_json as itemSnapshotJson,
                      response_json as responseJson, failure_code as failureCode,
                      updated_at as updatedAt
               from download_queue_removal_operations
               where user_id = ? and idempotency_key_hash = ?
               limit 1`,
            )
            .get(userId, keyHash) as RemovalOperationRow | undefined;
          if (existing) {
            if (existing.fingerprintHash !== fingerprintHash) {
              return { kind: "conflict" as const, operationId: existing.id };
            }
            if (existing.state === "pending") {
              if (
                !Number.isSafeInteger(existing.updatedAt) ||
                existing.updatedAt < 0 ||
                existing.updatedAt > now ||
                now - existing.updatedAt < REMOVAL_RECOVERY_LEASE_MS
              ) {
                return { kind: "pending" as const, operationId: existing.id };
              }
              let itemSnapshot: StoredRemovalSnapshot | null = null;
              if (existing.itemSnapshotJson) {
                itemSnapshot = this.#parseRemovalSnapshot(existing.itemSnapshotJson);
              }
              const claimed = this.#database.sqlite
                .prepare(
                  `update download_queue_removal_operations
                   set updated_at = ?
                   where id = ? and state = 'pending' and updated_at = ?`,
                )
                .run(now, existing.id, existing.updatedAt);
              if (claimed.changes !== 1) {
                return { kind: "pending" as const, operationId: existing.id };
              }
              return {
                itemSnapshot,
                kind: "recovered" as const,
                operationId: existing.id,
              };
            }
            if (existing.state === "failed" && existing.failureCode) {
              return {
                failureCode: existing.failureCode,
                kind: "failure" as const,
                operationId: existing.id,
              };
            }
            if (existing.state === "uncertain" && existing.failureCode) {
              return { kind: "uncertain" as const, operationId: existing.id };
            }
            if (existing.state === "reconcile_required" && existing.failureCode) {
              return { kind: "reconcile" as const, operationId: existing.id };
            }
            if (existing.state === "succeeded" && existing.responseJson) {
              return {
                kind: "replay" as const,
                response: downloadQueueRemovalResponseSchema.parse(
                  JSON.parse(existing.responseJson),
                ),
              };
            }
            throw new DownloadQueueError("storage_failure");
          }
          const count = this.#database.sqlite
            .prepare(
              "select count(*) as count from download_queue_removal_operations where user_id = ?",
            )
            .get(userId) as { count: number };
          if (count.count >= MAX_REMOVAL_OPERATIONS_PER_USER) {
            throw new DownloadQueueError("operation_limit_reached");
          }
          const operationId = this.#removalOperationId();
          this.#database.sqlite
            .prepare(
              `insert into download_queue_removal_operations (
                 id, user_id, connector_id, item_id, idempotency_key_hash,
                 fingerprint_hash, state, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
              operationId,
              userId,
              input.connectorId,
              input.itemId,
              keyHash,
              fingerprintHash,
              now,
              now,
            );
          return { kind: "reserved" as const, operationId };
        })
        .immediate();
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #prepareRemoval(
    operationId: string,
    snapshot: StoredRemovalSnapshot,
    input: DownloadQueueRemovalInput,
    context: DownloadQueueContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite
        .transaction(() => {
          const updated = this.#database.sqlite
            .prepare(
              `update download_queue_removal_operations
               set item_snapshot_json = ?, mutation_started_at = ?, updated_at = ?
               where id = ? and state = 'pending' and mutation_started_at is null`,
            )
            .run(JSON.stringify(snapshot), now, now, operationId);
          if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
          this.#auditRemoval(
            "download.queue.removal.requested",
            "success",
            operationId,
            input,
            context,
            now,
            { previousState: snapshot.item.state },
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #completeRemovalSuccess(
    operationId: string,
    response: DownloadQueueRemovalResponse,
    input: DownloadQueueRemovalInput,
    context: DownloadQueueContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite
        .transaction(() => {
          const updated = this.#database.sqlite
            .prepare(
              `update download_queue_removal_operations
               set state = 'succeeded', response_json = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending' and item_snapshot_json is not null`,
            )
            .run(JSON.stringify(response), now, now, operationId);
          if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
          this.#auditRemoval(
            "download.queue.removal.completed",
            "success",
            operationId,
            input,
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #completeRemovalFailure(
    operationId: string,
    input: DownloadQueueRemovalInput,
    context: DownloadQueueContext,
    failureCode: string,
  ) {
    try {
      const now = this.#now();
      const safeFailureCode = failureCode.slice(0, 64) || "upstream_failure";
      this.#database.sqlite
        .transaction(() => {
          const updated = this.#database.sqlite
            .prepare(
              `update download_queue_removal_operations
               set state = 'failed', failure_code = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(safeFailureCode, now, now, operationId);
          if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
          this.#auditRemoval(
            "download.queue.removal.failed",
            "failure",
            operationId,
            input,
            context,
            now,
            { failureCode: safeFailureCode },
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #auditRemoval(
    eventType: string,
    outcome: "failure" | "success",
    operationId: string,
    input: DownloadQueueRemovalInput,
    context: DownloadQueueContext,
    createdAt: number,
    metadata: Record<string, unknown> = {},
  ) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
           target_type, target_id, request_id, metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, ?, ?, 'download_queue_item', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#createId(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        outcome,
        input.itemId,
        context.requestId ?? null,
        JSON.stringify({
          connectorId: input.connectorId,
          contentDisposition: "preserved",
          operationId,
          ...metadata,
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
      throw new DownloadQueueError("storage_failure");
    }
    return value;
  }

  #bulkOperationId() {
    const value = this.#createBulkOperationId();
    if (!BULK_OPERATION_IDENTIFIER_PATTERN.test(value)) {
      throw new DownloadQueueError("storage_failure");
    }
    return value;
  }

  #dispatchId() {
    const value = this.#createDispatchId();
    if (!MUTATION_DISPATCH_IDENTIFIER_PATTERN.test(value)) {
      throw new DownloadQueueError("storage_failure");
    }
    return value;
  }

  #itemOperationId() {
    const value = this.#createItemOperationId();
    if (!ITEM_OPERATION_IDENTIFIER_PATTERN.test(value)) {
      throw new DownloadQueueError("storage_failure");
    }
    return value;
  }

  #leaseOwner() {
    const value = this.#createLeaseOwner();
    if (value.length < 1 || value.length > 128) throw new DownloadQueueError("storage_failure");
    return value;
  }

  #removalOperationId() {
    const value = this.#createOperationId();
    if (!REMOVAL_OPERATION_IDENTIFIER_PATTERN.test(value)) {
      throw new DownloadQueueError("storage_failure");
    }
    return value;
  }

  #audit(
    action: "failed" | "replayed" | "requested" | "updated",
    outcome: "failure" | "success",
    input: DownloadQueueActionInput,
    context: DownloadQueueContext,
    previousState: DownloadQueueItem["state"] | null,
    failureCode: string | null,
  ) {
    try {
      const createdAt = this.#clock().getTime();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("invalid clock");
      this.#database.sqlite
        .prepare(
          `insert into audit_events (
             id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
             target_type, target_id, request_id, metadata_json, ip_hash, created_at
           ) values (?, ?, ?, ?, ?, ?, 'download_queue_item', ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#createId(),
          context.principal.userId,
          context.principal.sessionId,
          context.principal.authenticationMethod.kind,
          `download.queue.action.${action}`,
          outcome,
          input.itemId,
          context.requestId ?? null,
          JSON.stringify({
            action: input.action,
            connectorId: input.connectorId,
            ...(failureCode ? { failureCode } : {}),
            previousState,
            replayed: action === "replayed",
          }),
          context.ipAddress
            ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
            : null,
          createdAt,
        );
    } catch (error) {
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #auditPromotion(
    action: "completed" | "failed" | "replayed" | "requested",
    outcome: "failure" | "success",
    input: DownloadQueuePromotionInput,
    context: DownloadQueueContext,
    previousPosition: number | null,
    failureCode: string | null,
  ) {
    try {
      const createdAt = this.#clock().getTime();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("invalid clock");
      this.#database.sqlite
        .prepare(
          `insert into audit_events (
             id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
             target_type, target_id, request_id, metadata_json, ip_hash, created_at
           ) values (?, ?, ?, ?, ?, ?, 'download_queue_item', ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#createId(),
          context.principal.userId,
          context.principal.sessionId,
          context.principal.authenticationMethod.kind,
          `download.queue.promotion.${action}`,
          outcome,
          input.itemId,
          context.requestId ?? null,
          JSON.stringify({
            connectorId: input.connectorId,
            ...(failureCode ? { failureCode } : {}),
            previousPosition,
            replayed: action === "replayed",
          }),
          context.ipAddress
            ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
            : null,
          createdAt,
        );
    } catch (error) {
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #actionConnector(connectorId: string) {
    try {
      const row = this.#database.sqlite
        .prepare(
          `select
             id,
             type,
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
           where id = ? and type in ('qbittorrent', 'sabnzbd') and enabled = 1
           limit 1`,
        )
        .get(connectorId) as DownloadConnectorRow | undefined;
      if (
        !row ||
        !isDownloadService(row.type) ||
        !hasQueueCapability(row, row.type) ||
        !hasQueueCapability(row, row.type, "download.queue.mutate")
      ) {
        throw new DownloadQueueError("connector_unavailable");
      }
      return row;
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #operationConnector(connectorId: string) {
    try {
      const row = this.#database.sqlite
        .prepare(
          `select
             id,
             type,
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
           where id = ? and type in ('qbittorrent', 'sabnzbd')
           limit 1`,
        )
        .get(connectorId) as DownloadConnectorRow | undefined;
      if (!row || !isDownloadService(row.type)) {
        throw new DownloadQueueError("connector_unavailable");
      }
      return row;
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }

  #connectors(): ConnectorSelection {
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
             instance_generation as instanceGeneration,
             config_generation as configGeneration,
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type in ('qbittorrent', 'sabnzbd') and enabled = 1
           order by id asc
           limit 101`,
        )
        .all() as DownloadConnectorRow[];
      const capable = rows.filter(
        (row) => isDownloadService(row.type) && hasQueueCapability(row, row.type),
      );
      return {
        rows: capable.slice(0, DOWNLOAD_QUEUE_MAX_CLIENTS),
        truncated: capable.length > DOWNLOAD_QUEUE_MAX_CLIENTS,
      };
    } catch (error) {
      throw new DownloadQueueError("storage_failure", { cause: error });
    }
  }
}
