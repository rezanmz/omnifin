import { ProwlarrAdapter } from "@omnifin/connectors/adapters/prowlarr";
import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type {
  ConnectorStorageCapacity,
  ConnectorSystemSignal,
  SystemHealthReader,
} from "@omnifin/connectors/system";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { connectorCredentialInputSchema, type PartialFailure } from "@omnifin/contracts/connectors";
import {
  SYSTEM_STATUS_MAX_SIGNALS_PER_SOURCE,
  SYSTEM_STATUS_MAX_SOURCES,
  SYSTEM_STATUS_MAX_STORAGE_PER_SOURCE,
  systemStatusResponseSchema,
  systemStatusSourceSchema,
  type OperationalService,
  type StorageCapacity,
  type SystemHealthSignal,
  type SystemStatusResponse,
  type SystemStatusSource,
} from "@omnifin/contracts/system";
import { X509Certificate } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";

const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface SystemConnectorRow {
  baseUrl: string;
  displayName: string;
  encryptedCredentials: string;
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

export interface SystemStatusContext {
  principal: SessionPrincipal;
}

export interface SystemStatusAdapter extends SystemHealthReader {
  readStorageCapacity?: (signal?: AbortSignal) => Promise<readonly ConnectorStorageCapacity[]>;
}

export interface SystemStatusAdapterFactoryInput extends ApiKeyConnectorConfig {
  service: OperationalService;
}

export interface SystemStatusDependencies {
  clock?: () => Date;
  createAdapter?: (input: SystemStatusAdapterFactoryInput) => SystemStatusAdapter;
}

export type SystemStatusErrorReason = "source_limit_exceeded" | "storage_failure";

export class SystemStatusError extends Error {
  public readonly reason: SystemStatusErrorReason;

  public constructor(reason: SystemStatusErrorReason, options?: ErrorOptions) {
    super("System status could not be retrieved.", options);
    this.name = "SystemStatusError";
    this.reason = reason;
  }
}

class SystemConnectorIntegrityError extends Error {}
class SystemSourceResponseError extends Error {}

function isOperationalService(value: string): value is OperationalService {
  return value === "radarr" || value === "sonarr" || value === "prowlarr";
}

function credentialContext(service: OperationalService, connectorId: string) {
  return `connector_credentials:${service}:${connectorId}`;
}

function safeDisplayName(value: string, service: OperationalService) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const fallback = service[0]!.toUpperCase() + service.slice(1);
  return (cleaned || fallback).slice(0, 160);
}

function connectorSecrets(
  row: SystemConnectorRow,
  service: OperationalService,
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
    throw new SystemConnectorIntegrityError("invalid connector credentials", { cause: error });
  }
}

function safeFailure(
  service: OperationalService,
  displayName: string,
  error: unknown,
  occurredAt: Date,
  operation: string,
): PartialFailure {
  if (error instanceof SafeConnectorError && error.service === service) {
    return error.toPartialFailure(occurredAt);
  }
  return {
    code:
      error instanceof SystemConnectorIntegrityError ? "configuration_invalid" : "upstream_error",
    message:
      error instanceof SystemConnectorIntegrityError
        ? `${displayName} configuration could not be verified.`
        : `${displayName} telemetry is temporarily unavailable.`,
    occurredAt: occurredAt.toISOString(),
    operation,
    retryable: !(error instanceof SystemConnectorIntegrityError),
    service,
  };
}

function capacityState(capacity: ConnectorStorageCapacity): StorageCapacity["state"] {
  const freeRatio = capacity.freeBytes / capacity.totalBytes;
  if (freeRatio <= 0.05) return "critical";
  if (freeRatio <= 0.15) return "warning";
  return "healthy";
}

function summary(sources: readonly SystemStatusSource[]): SystemStatusResponse["summary"] {
  const signals = sources.flatMap((source) => source.signals);
  const storage = sources.flatMap((source) => source.storage);
  return {
    attentionSources: sources.filter((source) => source.status === "attention").length,
    criticalStorage: storage.filter((item) => item.state === "critical").length,
    errorSignals: signals.filter((signal) => signal.severity === "error").length,
    healthySources: sources.filter((source) => source.status === "healthy").length,
    noticeSignals: signals.filter((signal) => signal.severity === "notice").length,
    sources: sources.length,
    unavailableSources: sources.filter((source) => source.status === "unavailable").length,
    warningSignals: signals.filter((signal) => signal.severity === "warning").length,
    warningStorage: storage.filter((item) => item.state === "warning").length,
  };
}

export class SystemStatusService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<SystemStatusDependencies["createAdapter"]>;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: SystemStatusDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter =
      dependencies.createAdapter ??
      ((input) => {
        const { service, ...adapterConfig } = input;
        if (service === "radarr") return new RadarrAdapter(adapterConfig);
        if (service === "sonarr") return new SonarrAdapter(adapterConfig);
        return new ProwlarrAdapter(adapterConfig);
      });
  }

  public async read(
    context: SystemStatusContext,
    signal?: AbortSignal,
  ): Promise<SystemStatusResponse> {
    requirePermission(context.principal, "acquisition.manage");
    const generatedAt = this.#clock();
    const rows = this.#connectors();
    const sources = await Promise.all(
      rows.map((row) => this.#readSource(row, generatedAt, signal)),
    );
    const ordered = sources.toSorted((left, right) => {
      const serviceOrder = { radarr: 0, sonarr: 1, prowlarr: 2 } as const;
      const byService = serviceOrder[left.service] - serviceOrder[right.service];
      return byService === 0 ? left.displayName.localeCompare(right.displayName) : byService;
    });
    const degraded = ordered.some(
      (source) => source.status === "unavailable" || source.failure !== null,
    );
    return systemStatusResponseSchema.parse({
      generatedAt: generatedAt.toISOString(),
      sources: ordered,
      state: ordered.length === 0 ? "unconfigured" : degraded ? "degraded" : "complete",
      summary: summary(ordered),
    });
  }

  async #readSource(
    row: SystemConnectorRow,
    occurredAt: Date,
    signal?: AbortSignal,
  ): Promise<SystemStatusSource> {
    const service = isOperationalService(row.type) ? row.type : "prowlarr";
    const displayName = safeDisplayName(row.displayName, service);
    const sourceId = `source_${privacyHash(
      "system_status_source",
      `${service}\u0000${row.id}`,
      this.#config.encryptionKey,
    )}`;
    try {
      if (
        !isOperationalService(row.type) ||
        !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
        ![0, 1].includes(row.insecureHttpApproved) ||
        !["strict", "allow_self_signed"].includes(row.tlsPolicy)
      ) {
        throw new SystemConnectorIntegrityError("invalid connector metadata");
      }
      const secrets = connectorSecrets(row, service, this.#cipher);
      const adapter = this.#createAdapter({
        apiKey: secrets.apiKey,
        baseUrl: row.baseUrl,
        clock: { monotonicNow: () => performance.now(), now: this.#clock },
        connectorId: row.id,
        displayName,
        insecureHttpApproved: row.insecureHttpApproved === 1,
        service,
        tlsPolicy: row.tlsPolicy as "strict" | "allow_self_signed",
        ...(secrets.tlsCaCertificatePem === undefined
          ? {}
          : { tlsCaCertificatePem: secrets.tlsCaCertificatePem }),
      });
      const [healthResult, storageResult] = await Promise.allSettled([
        adapter.readSystemHealth(signal),
        adapter.readStorageCapacity?.(signal) ?? Promise.resolve([]),
      ]);
      const healthFailure =
        healthResult.status === "rejected"
          ? safeFailure(service, displayName, healthResult.reason, occurredAt, "system.health")
          : null;
      const storageFailure =
        storageResult.status === "rejected"
          ? safeFailure(service, displayName, storageResult.reason, occurredAt, "storage.read")
          : null;
      const failure = healthFailure ?? storageFailure;
      const rawSignals = healthResult.status === "fulfilled" ? healthResult.value : [];
      const rawStorage = storageResult.status === "fulfilled" ? storageResult.value : [];
      if (
        rawSignals.length > SYSTEM_STATUS_MAX_SIGNALS_PER_SOURCE ||
        rawStorage.length > SYSTEM_STATUS_MAX_STORAGE_PER_SOURCE
      ) {
        throw new SystemSourceResponseError("source response exceeded its public bounds");
      }
      const signals = this.#publicSignals(row, rawSignals);
      const storage = this.#publicStorage(row, displayName, rawStorage);
      const unavailable = healthResult.status === "rejected" && storage.length === 0;
      const attention =
        failure !== null ||
        signals.length > 0 ||
        storage.some((capacity) => capacity.state !== "healthy");
      return systemStatusSourceSchema.parse({
        displayName,
        failure: unavailable ? healthFailure : failure,
        id: sourceId,
        service,
        signals: unavailable ? [] : signals,
        status: unavailable ? "unavailable" : attention ? "attention" : "healthy",
        storage: unavailable ? [] : storage,
      });
    } catch (error) {
      return systemStatusSourceSchema.parse({
        displayName,
        failure: safeFailure(service, displayName, error, occurredAt, "system.status"),
        id: sourceId,
        service,
        signals: [],
        status: "unavailable",
        storage: [],
      });
    }
  }

  #publicSignals(row: SystemConnectorRow, signals: readonly ConnectorSystemSignal[]) {
    const ids = new Set<string>();
    const normalized = signals.map((signal) => {
      const id = `signal_${privacyHash(
        "system_status_signal",
        `${row.id}\u0000${signal.externalId}`,
        this.#config.encryptionKey,
      )}`;
      if (ids.has(id)) throw new SystemSourceResponseError("duplicate health signal");
      ids.add(id);
      return {
        id,
        message: signal.message,
        severity: signal.severity,
        sourceLabel: signal.sourceLabel,
      } satisfies SystemHealthSignal;
    });
    const severityOrder = { error: 0, warning: 1, notice: 2 } as const;
    return normalized.toSorted((left, right) => {
      const bySeverity = severityOrder[left.severity] - severityOrder[right.severity];
      return bySeverity === 0 ? left.id.localeCompare(right.id) : bySeverity;
    });
  }

  #publicStorage(
    row: SystemConnectorRow,
    displayName: string,
    capacities: readonly ConnectorStorageCapacity[],
  ) {
    const ordered = capacities.toSorted((left, right) =>
      left.externalId.localeCompare(right.externalId),
    );
    const ids = new Set<string>();
    return ordered.map((capacity, index) => {
      const id = `storage_${privacyHash(
        "system_status_storage",
        `${row.id}\u0000${capacity.externalId}`,
        this.#config.encryptionKey,
      )}`;
      if (ids.has(id)) throw new SystemSourceResponseError("duplicate storage capacity");
      ids.add(id);
      return {
        freeBytes: capacity.freeBytes,
        id,
        label: `${displayName} storage ${index + 1}`,
        state: capacityState(capacity),
        totalBytes: capacity.totalBytes,
      } satisfies StorageCapacity;
    });
  }

  #connectors() {
    try {
      const rows = this.#database.sqlite
        .prepare(
          `select
             id,
             type,
             display_name as displayName,
             base_url as baseUrl,
             encrypted_credentials as encryptedCredentials,
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type in ('radarr', 'sonarr', 'prowlarr') and enabled = 1
           order by type asc, id asc
           limit ?`,
        )
        .all(SYSTEM_STATUS_MAX_SOURCES + 1) as SystemConnectorRow[];
      if (rows.length > SYSTEM_STATUS_MAX_SOURCES) {
        throw new SystemStatusError("source_limit_exceeded");
      }
      return rows;
    } catch (error) {
      if (error instanceof SystemStatusError) throw error;
      throw new SystemStatusError("storage_failure", { cause: error });
    }
  }
}
