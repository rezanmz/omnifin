import { SeerrAdapter } from "@omnifin/connectors/adapters/seerr";
import type { OptionalApiKeyConnectorConfig } from "@omnifin/connectors/types";
import { connectorCredentialInputSchema } from "@omnifin/contracts/connectors";
import {
  discoveryMediaDetailParamsSchema,
  discoveryMediaDetailQuerySchema,
  discoveryMediaDetailResponseSchema,
  discoverySearchQuerySchema,
  discoverySearchResponseSchema,
  type DiscoveryMediaDetailParams,
  type DiscoveryMediaDetailQuery,
  type DiscoveryMediaDetailResponse,
  type DiscoverySearchQuery,
  type DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { X509Certificate } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { requirePermission } from "../auth/authorization.js";
import { EnvelopeCipher } from "../security/crypto.js";

interface DiscoveryConnectorRow {
  baseUrl: string;
  displayName: string;
  encryptedCredentials: string;
  id: string;
  insecureHttpApproved: number;
  tlsPolicy: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

export interface DiscoverySearchContext {
  principal: SessionPrincipal;
}

export interface DiscoverySearchAdapter {
  detail(
    params: DiscoveryMediaDetailParams,
    query: DiscoveryMediaDetailQuery,
    signal?: AbortSignal,
  ): Promise<DiscoveryMediaDetailResponse>;
  search(input: DiscoverySearchQuery, signal?: AbortSignal): Promise<DiscoverySearchResponse>;
}

export interface DiscoverySearchDependencies {
  clock?: () => Date;
  createAdapter?: (config: OptionalApiKeyConnectorConfig) => DiscoverySearchAdapter;
}

export type DiscoverySearchErrorReason =
  | "connector_ambiguous"
  | "connector_integrity_failure"
  | "connector_unconfigured"
  | "storage_failure";

export class DiscoverySearchError extends Error {
  public readonly reason: DiscoverySearchErrorReason;

  public constructor(reason: DiscoverySearchErrorReason, options?: ErrorOptions) {
    super("Discovery search could not be completed.", options);
    this.name = "DiscoverySearchError";
    this.reason = reason;
  }
}

function credentialContext(connectorId: string) {
  return `connector_credentials:seerr:${connectorId}`;
}

function connectorSecrets(
  row: DiscoveryConnectorRow,
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
    throw new DiscoverySearchError("connector_integrity_failure", { cause: error });
  }
}

export class DiscoverySearchService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createAdapter: (config: OptionalApiKeyConnectorConfig) => DiscoverySearchAdapter;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: DiscoverySearchDependencies = {},
  ) {
    this.#database = database;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? ((input) => new SeerrAdapter(input));
  }

  public async search(
    input: DiscoverySearchQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "media.view");
    const query = discoverySearchQuerySchema.parse(input);
    const adapter = this.#adapter();
    return discoverySearchResponseSchema.parse(await adapter.search(query, signal));
  }

  public async detail(
    paramsInput: DiscoveryMediaDetailParams,
    queryInput: DiscoveryMediaDetailQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "media.view");
    const params = discoveryMediaDetailParamsSchema.parse(paramsInput);
    const query = discoveryMediaDetailQuerySchema.parse(queryInput);
    const adapter = this.#adapter();
    return discoveryMediaDetailResponseSchema.parse(await adapter.detail(params, query, signal));
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
      !row.id ||
      row.id.length > 128 ||
      !row.displayName.trim() ||
      row.displayName.length > 160
    ) {
      throw new DiscoverySearchError("connector_integrity_failure");
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
      throw new DiscoverySearchError("connector_integrity_failure", { cause: error });
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
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type = 'seerr' and enabled = 1
           order by id asc
           limit 2`,
        )
        .all() as DiscoveryConnectorRow[];
      if (rows.length === 0) throw new DiscoverySearchError("connector_unconfigured");
      if (rows.length > 1) throw new DiscoverySearchError("connector_ambiguous");
      return rows[0]!;
    } catch (error) {
      if (error instanceof DiscoverySearchError) throw error;
      throw new DiscoverySearchError("storage_failure", { cause: error });
    }
  }
}
