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
  downloadQueueItemSchema,
  downloadQueuePromotionInputSchema,
  downloadQueuePromotionResponseSchema,
  downloadQueueRemovalInputSchema,
  downloadQueueRemovalResponseSchema,
  downloadQueueResponseSchema,
  type DownloadClientService,
  type DownloadQueueActionInput,
  type DownloadQueueActionResponse,
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
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";

const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REMOVAL_OPERATION_IDENTIFIER_PATTERN = /^download_removal_[A-Za-z0-9_-]{22}$/u;
const MAX_REMOVAL_OPERATIONS_PER_USER = 1_000;
const REMOVAL_RECOVERY_LEASE_MS = 30_000;
const REMOVAL_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface DownloadConnectorRow {
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

interface RemovalOperationRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  itemSnapshotJson: string | null;
  responseJson: string | null;
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
  | "queue_order_unavailable"
  | "response_invalid"
  | "stale_state"
  | "storage_failure"
  | "target_not_found";

export class DownloadQueueError extends Error {
  public readonly reason: DownloadQueueErrorReason;

  public constructor(reason: DownloadQueueErrorReason, options?: ErrorOptions) {
    super("The download queue operation could not be completed.", options);
    this.name = "DownloadQueueError";
    this.reason = reason;
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
  publicItem: DownloadQueueItem;
  queuePosition: number | null;
}

export class DownloadQueueService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<DownloadQueueDependencies["createAdapter"]>;
  readonly #createId: () => string;
  readonly #createOperationId: () => string;
  readonly #database: DatabaseHandle;
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
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createOperationId =
      dependencies.createOperationId ?? (() => `download_removal_${randomToken(16)}`);
    this.#wait = dependencies.wait ?? defaultWait;
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
  ): Promise<DownloadQueueActionResponse> {
    const principal = requirePermission(context.principal, "downloads.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new DownloadQueueError("identity_required");
    }
    const input = downloadQueueActionInputSchema.parse(rawInput);
    let row: DownloadConnectorRow;
    try {
      row = this.#actionConnector(input.connectorId);
    } catch (error) {
      this.#audit("failed", "failure", input, context, null, actionFailureCode(error));
      throw error;
    }
    let adapter: DownloadQueueController;
    try {
      adapter = this.#adapter(row);
    } catch (error) {
      const unavailable = new DownloadQueueError("connector_unavailable", { cause: error });
      this.#audit("failed", "failure", input, context, null, unavailable.reason);
      throw unavailable;
    }
    let current: ExactQueueItem | null;
    try {
      current = await this.#exactItem(adapter, row, input.itemId, signal);
    } catch (error) {
      this.#audit("failed", "failure", input, context, null, actionFailureCode(error));
      throw error;
    }
    if (!current) {
      this.#audit("failed", "failure", input, context, null, "target_not_found");
      throw new DownloadQueueError("target_not_found");
    }
    if (actionAchieved(input.action, current.publicItem.state)) {
      this.#audit("replayed", "success", input, context, current.publicItem.state, null);
      return downloadQueueActionResponseSchema.parse({
        action: input.action,
        item: current.publicItem,
        previousState: current.publicItem.state,
        replayed: true,
        verifiedAt: this.#clock().toISOString(),
      });
    }
    if (current.publicItem.state !== input.expectedState) {
      this.#audit("failed", "failure", input, context, current.publicItem.state, "stale_state");
      throw new DownloadQueueError("stale_state");
    }
    this.#audit("requested", "success", input, context, current.publicItem.state, null);
    try {
      await adapter.updateDownloadQueueItem(
        { action: input.action, externalId: current.externalId },
        signal,
      );
      let verified: ExactQueueItem | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        verified = await this.#exactItem(adapter, row, input.itemId, signal);
        if (verified && actionAchieved(input.action, verified.publicItem.state)) break;
        if (attempt < 2) await this.#wait(150 * (attempt + 1), signal);
      }
      if (!verified || !actionAchieved(input.action, verified.publicItem.state)) {
        throw new DownloadQueueError("response_invalid");
      }
      this.#audit("updated", "success", input, context, current.publicItem.state, null);
      return downloadQueueActionResponseSchema.parse({
        action: input.action,
        item: verified.publicItem,
        previousState: current.publicItem.state,
        replayed: false,
        verifiedAt: this.#clock().toISOString(),
      });
    } catch (error) {
      this.#audit(
        "failed",
        "failure",
        input,
        context,
        current.publicItem.state,
        actionFailureCode(error),
      );
      throw error;
    }
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
    const row = this.#actionConnector(input.connectorId);
    const fingerprintHash = hashToken(
      JSON.stringify({ contentDisposition: "preserved", input, version: 1 }),
    );
    const keyHash = hashToken(
      `${principal.userId}\u0000download_queue_removal\u0000${idempotencyKey}`,
    );
    const reservation = this.#reserveRemoval(principal.userId, input, keyHash, fingerprintHash);
    if (reservation.kind === "replay") {
      return downloadQueueRemovalResponseSchema.parse({
        ...reservation.response,
        replayed: true,
      });
    }
    if (reservation.kind === "failure") throw new DownloadQueueError("operation_failed");
    if (reservation.kind === "conflict") throw new DownloadQueueError("idempotency_conflict");
    if (reservation.kind === "pending") throw new DownloadQueueError("idempotency_in_progress");
    let adapter: DownloadQueueController;
    try {
      adapter = this.#adapter(row);
    } catch (error) {
      const unavailable = new DownloadQueueError("connector_unavailable", { cause: error });
      this.#completeRemovalFailure(reservation.operationId, input, context, unavailable.reason);
      throw unavailable;
    }

    let current: ExactQueueItem | null;
    try {
      current = await this.#exactItem(adapter, row, input.itemId, signal);
      if (reservation.kind === "recovered" && reservation.itemSnapshot) {
        if (!current) {
          const recovered = downloadQueueRemovalResponseSchema.parse({
            contentDisposition: "preserved",
            item: reservation.itemSnapshot,
            operationId: reservation.operationId,
            removedAt: this.#clock().toISOString(),
            replayed: true,
          });
          this.#completeRemovalSuccess(reservation.operationId, recovered, input, context);
          return recovered;
        }
        if (!sameRemovalTarget(reservation.itemSnapshot, current.publicItem)) {
          throw new DownloadQueueError("stale_state");
        }
      }
      if (!current) throw new DownloadQueueError("target_not_found");
      if (reservation.kind !== "recovered" && current.publicItem.state !== input.expectedState) {
        throw new DownloadQueueError("stale_state");
      }
      if (reservation.kind === "reserved" || !reservation.itemSnapshot) {
        this.#prepareRemoval(reservation.operationId, current.publicItem, input, context);
      }
    } catch (error) {
      this.#completeRemovalFailure(
        reservation.operationId,
        input,
        context,
        actionFailureCode(error),
      );
      throw error;
    }

    await adapter.removeDownloadQueueItem({ externalId: current.externalId }, signal);
    let stillPresent: ExactQueueItem | null = current;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      stillPresent = await this.#exactItem(adapter, row, input.itemId, signal);
      if (!stillPresent) break;
      if (attempt < 2) await this.#wait(150 * (attempt + 1), signal);
    }
    if (stillPresent) {
      const unconfirmed = new DownloadQueueError("response_invalid");
      this.#completeRemovalFailure(reservation.operationId, input, context, unconfirmed.reason);
      throw unconfirmed;
    }
    const response = downloadQueueRemovalResponseSchema.parse({
      contentDisposition: "preserved",
      item: current.publicItem,
      operationId: reservation.operationId,
      removedAt: this.#clock().toISOString(),
      replayed: false,
    });
    this.#completeRemovalSuccess(reservation.operationId, response, input, context);
    return response;
  }

  public async promote(
    rawInput: DownloadQueuePromotionInput,
    context: DownloadQueueContext,
    signal?: AbortSignal,
  ): Promise<DownloadQueuePromotionResponse> {
    const principal = requirePermission(context.principal, "downloads.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new DownloadQueueError("identity_required");
    }
    const input = downloadQueuePromotionInputSchema.parse(rawInput);
    let row: DownloadConnectorRow;
    try {
      row = this.#actionConnector(input.connectorId);
    } catch (error) {
      this.#auditPromotion("failed", "failure", input, context, null, actionFailureCode(error));
      throw error;
    }
    let adapter: DownloadQueueController;
    try {
      adapter = this.#adapter(row);
    } catch (error) {
      const unavailable = new DownloadQueueError("connector_unavailable", { cause: error });
      this.#auditPromotion("failed", "failure", input, context, null, unavailable.reason);
      throw unavailable;
    }
    let current: ExactQueueItem | null;
    try {
      current = await this.#exactItem(adapter, row, input.itemId, signal);
    } catch (error) {
      this.#auditPromotion("failed", "failure", input, context, null, actionFailureCode(error));
      throw error;
    }
    if (!current) {
      this.#auditPromotion("failed", "failure", input, context, null, "target_not_found");
      throw new DownloadQueueError("target_not_found");
    }
    if (current.queuePosition === 0) {
      this.#auditPromotion("replayed", "success", input, context, 0, null);
      return downloadQueuePromotionResponseSchema.parse({
        item: current.publicItem,
        position: 0,
        previousPosition: 0,
        promotedAt: this.#clock().toISOString(),
        replayed: true,
      });
    }
    if (current.publicItem.state !== input.expectedState) {
      this.#auditPromotion(
        "failed",
        "failure",
        input,
        context,
        current.queuePosition,
        "stale_state",
      );
      throw new DownloadQueueError("stale_state");
    }
    if (current.queuePosition === null) {
      this.#auditPromotion("failed", "failure", input, context, null, "queue_order_unavailable");
      throw new DownloadQueueError("queue_order_unavailable");
    }
    this.#auditPromotion("requested", "success", input, context, current.queuePosition, null);
    try {
      await adapter.promoteDownloadQueueItem({ externalId: current.externalId }, signal);
      let verified: ExactQueueItem | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        verified = await this.#exactItem(adapter, row, input.itemId, signal);
        if (verified?.queuePosition === 0) break;
        if (attempt < 2) await this.#wait(150 * (attempt + 1), signal);
      }
      if (!verified || verified.queuePosition !== 0) {
        throw new DownloadQueueError("response_invalid");
      }
      this.#auditPromotion("completed", "success", input, context, current.queuePosition, null);
      return downloadQueuePromotionResponseSchema.parse({
        item: verified.publicItem,
        position: 0,
        previousPosition: current.queuePosition,
        promotedAt: this.#clock().toISOString(),
        replayed: false,
      });
    } catch (error) {
      this.#auditPromotion(
        "failed",
        "failure",
        input,
        context,
        current.queuePosition,
        actionFailureCode(error),
      );
      throw error;
    }
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
      id: this.#publicId(row.id, externalId),
      protocol: service === "qbittorrent" ? "torrent" : "usenet",
    });
  }

  #publicId(connectorId: string, externalId: string) {
    return `download_${privacyHash(
      "download_queue_item",
      `${connectorId}\u0000${externalId}`,
      this.#config.encryptionKey,
    )}`;
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
        (item) => this.#publicId(row.id, item.externalId) === itemId,
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
          this.#database.sqlite
            .prepare(
              `delete from download_queue_removal_operations
               where user_id = ? and state <> 'pending' and completed_at <= ?`,
            )
            .run(userId, now - REMOVAL_OPERATION_RETENTION_MS);
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
              return { kind: "conflict" as const };
            }
            if (existing.state === "pending") {
              if (
                !Number.isSafeInteger(existing.updatedAt) ||
                existing.updatedAt < 0 ||
                existing.updatedAt > now ||
                now - existing.updatedAt < REMOVAL_RECOVERY_LEASE_MS
              ) {
                return { kind: "pending" as const };
              }
              let itemSnapshot: DownloadQueueItem | null = null;
              if (existing.itemSnapshotJson) {
                itemSnapshot = downloadQueueItemSchema.parse(JSON.parse(existing.itemSnapshotJson));
              }
              const claimed = this.#database.sqlite
                .prepare(
                  `update download_queue_removal_operations
                   set updated_at = ?
                   where id = ? and state = 'pending' and updated_at = ?`,
                )
                .run(now, existing.id, existing.updatedAt);
              if (claimed.changes !== 1) return { kind: "pending" as const };
              return {
                itemSnapshot,
                kind: "recovered" as const,
                operationId: existing.id,
              };
            }
            if (existing.state === "failed" && existing.failureCode) {
              return { kind: "failure" as const };
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
    item: DownloadQueueItem,
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
            .run(JSON.stringify(item), now, now, operationId);
          if (updated.changes !== 1) throw new DownloadQueueError("storage_failure");
          this.#auditRemoval(
            "download.queue.removal.requested",
            "success",
            operationId,
            input,
            context,
            now,
            { previousState: item.state },
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
