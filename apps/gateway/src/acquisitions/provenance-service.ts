import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  acquisitionProvenanceResponseSchema,
  acquisitionTargetInputSchema,
  type AcquisitionProvenanceResponse,
  type AcquisitionService,
  type AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
} from "@omnifin/contracts/connectors";
import { X509Certificate } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher } from "../security/crypto.js";

const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

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

export interface AcquisitionProvenanceContext {
  principal: SessionPrincipal;
}

export interface AcquisitionProvenanceAdapter {
  readAcquisitionProvenance(
    input: AcquisitionTargetInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionProvenanceResponse>;
}

export interface AcquisitionProvenanceDependencies {
  clock?: () => Date;
  createAdapter?: (
    service: AcquisitionService,
    config: ApiKeyConnectorConfig,
  ) => AcquisitionProvenanceAdapter;
}

export type AcquisitionProvenanceErrorReason =
  | "connector_ambiguous"
  | "connector_integrity_failure"
  | "connector_unconfigured"
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

function hasAcquisitionCapability(row: AcquisitionConnectorRow, service: AcquisitionService) {
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
      health.data.capabilities.includes("acquisition.history")
    );
  } catch {
    return false;
  }
}

function defaultAdapter(service: AcquisitionService, config: ApiKeyConnectorConfig) {
  return service === "radarr" ? new RadarrAdapter(config) : new SonarrAdapter(config);
}

export class AcquisitionProvenanceService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createAdapter: NonNullable<AcquisitionProvenanceDependencies["createAdapter"]>;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: AcquisitionProvenanceDependencies = {},
  ) {
    this.#database = database;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapter;
  }

  public async read(
    rawInput: AcquisitionTargetInput,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "acquisition.manage");
    const input = acquisitionTargetInputSchema.parse(rawInput);
    const row = this.#connector(input.service);
    const secrets = connectorSecrets(row, input.service, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      row.type !== input.service ||
      !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
      !row.displayName.trim() ||
      row.displayName.length > 160 ||
      !hasAcquisitionCapability(row, input.service)
    ) {
      throw new AcquisitionProvenanceError("connector_integrity_failure");
    }
    let adapter: AcquisitionProvenanceAdapter;
    try {
      adapter = this.#createAdapter(input.service, {
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
      throw new AcquisitionProvenanceError("connector_integrity_failure", { cause: error });
    }
    return acquisitionProvenanceResponseSchema.parse(
      await adapter.readAcquisitionProvenance(input, signal),
    );
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
