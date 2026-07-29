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
  downloadQueueResponseSchema,
  type DownloadClientService,
  type DownloadQueueActionInput,
  type DownloadQueueActionResponse,
  type DownloadQueueClient,
  type DownloadQueueItem,
  type DownloadQueueResponse,
} from "@omnifin/contracts/downloads";
import { randomUUID, X509Certificate } from "node:crypto";
import { ZodError } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";

const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

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
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type DownloadQueueErrorReason =
  | "connector_unavailable"
  | "identity_required"
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
}

export class DownloadQueueService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<DownloadQueueDependencies["createAdapter"]>;
  readonly #createId: () => string;
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
    const { externalId: ignoredExternalId, ...publicItem } = item;
    void ignoredExternalId;
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
      return {
        externalId: matches[0].externalId,
        publicItem: this.#publicItem(row, matches[0].externalId, matches[0]),
      };
    } catch (error) {
      if (error instanceof DownloadQueueError) throw error;
      if (error instanceof ZodError) {
        throw new DownloadQueueError("response_invalid", { cause: error });
      }
      throw error;
    }
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
