import { QBittorrentAdapter } from "@omnifin/connectors/adapters/qbittorrent";
import { SabnzbdAdapter } from "@omnifin/connectors/adapters/sabnzbd";
import type { DownloadQueueReader } from "@omnifin/connectors/downloads";
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
  downloadQueueItemSchema,
  downloadQueueResponseSchema,
  type DownloadClientService,
  type DownloadQueueClient,
  type DownloadQueueItem,
  type DownloadQueueResponse,
} from "@omnifin/contracts/downloads";
import { X509Certificate } from "node:crypto";
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
  principal: SessionPrincipal;
}

export interface DownloadQueueAdapterFactoryInput extends ConnectorTargetConfig {
  credentials: ConnectorCredentialInput;
  insecureHttpApproved: boolean;
  service: DownloadClientService;
  tlsPolicy: "allow_self_signed" | "strict";
}

export interface DownloadQueueDependencies {
  clock?: () => Date;
  createAdapter?: (input: DownloadQueueAdapterFactoryInput) => DownloadQueueReader;
}

export type DownloadQueueErrorReason = "storage_failure";

export class DownloadQueueError extends Error {
  public readonly reason: DownloadQueueErrorReason;

  public constructor(reason: DownloadQueueErrorReason, options?: ErrorOptions) {
    super("The download queue could not be retrieved.", options);
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

function hasQueueCapability(row: DownloadConnectorRow, service: DownloadClientService) {
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
      health.data.capabilities.includes("download.queue.read")
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

function defaultAdapter(input: DownloadQueueAdapterFactoryInput): DownloadQueueReader {
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

export class DownloadQueueService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<DownloadQueueDependencies["createAdapter"]>;
  readonly #database: DatabaseHandle;

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

  async #readClient(row: DownloadConnectorRow, signal?: AbortSignal): Promise<ClientResult> {
    const service = row.type as DownloadClientService;
    const displayName = safeDisplayName(row.displayName, service);
    const occurredAt = this.#clock();
    try {
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
      const adapter = this.#createAdapter({
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
      const queue = await adapter.readDownloadQueue(signal);
      const items = queue.items.map((item) => {
        const { externalId, ...publicItem } = item;
        return downloadQueueItemSchema.parse({
          ...publicItem,
          client: service,
          clientName: displayName,
          connectorId: row.id,
          id: `download_${privacyHash(
            "download_queue_item",
            `${row.id}\u0000${externalId}`,
            this.#config.encryptionKey,
          )}`,
          protocol: service === "qbittorrent" ? "torrent" : "usenet",
        });
      });
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
