import { BazarrAdapter } from "@omnifin/connectors/adapters/bazarr";
import { JellyfinAdapter } from "@omnifin/connectors/adapters/jellyfin";
import { ProwlarrAdapter } from "@omnifin/connectors/adapters/prowlarr";
import { QBittorrentAdapter } from "@omnifin/connectors/adapters/qbittorrent";
import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SabnzbdAdapter } from "@omnifin/connectors/adapters/sabnzbd";
import { SeerrAdapter } from "@omnifin/connectors/adapters/seerr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import { validateDestinationUrlLiteral } from "@omnifin/connectors/security/destination";
import type { ConnectorAdapter, ConnectorTargetConfig } from "@omnifin/connectors/types";
import {
  connectorAdminSchema,
  connectorCreateRequestSchema,
  connectorCredentialInputSchema,
  connectorHealthSchema,
  connectorListQuerySchema,
  connectorUpdateRequestSchema,
  type ConnectorAdmin,
  type ConnectorCreateRequest,
  type ConnectorCredentialInput,
  type ConnectorHealth,
  type ConnectorListQuery,
  type ConnectorUpdateRequest,
  type ManagedConnectorService,
} from "@omnifin/contracts/connectors";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { createHash, randomUUID, X509Certificate } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { requirePermission } from "../auth/authorization.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";

const MAX_CONNECTORS = 100;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const CONNECTOR_VALIDATION_TTL_MS = 10 * 60 * 1_000;
const CONNECTOR_PROBE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

interface ConnectorRow {
  id: string;
  type: string;
  displayName: string;
  baseUrl: string;
  publicUiUrl: string | null;
  encryptedCredentials: string;
  tlsPolicy: string;
  insecureHttpApproved: number;
  capabilitySnapshotJson: string;
  healthState: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

interface StoredSnapshot {
  schemaVersion: 1;
  health?: ConnectorHealth;
  authentication?: unknown;
}

interface StoredSecrets {
  schemaVersion: 1;
  credentials: ConnectorCredentialInput;
  tlsCaCertificatePem?: string;
}

export type ConnectorAdminErrorReason =
  | "configuration_conflict"
  | "configuration_invalid"
  | "connector_in_use"
  | "connector_limit_reached"
  | "connector_must_be_disabled"
  | "connector_not_found"
  | "connector_not_validated"
  | "integrity_failure"
  | "revision_conflict"
  | "storage_failure";

export class ConnectorAdminError extends Error {
  public readonly reason: ConnectorAdminErrorReason;

  public constructor(reason: ConnectorAdminErrorReason, options?: ErrorOptions) {
    super("Connector administration could not be completed.", options);
    this.name = "ConnectorAdminError";
    this.reason = reason;
  }
}

export interface ConnectorAdminContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface ConnectorAdapterFactoryInput {
  connectorId: string;
  service: ManagedConnectorService;
  displayName: string;
  baseUrl: string;
  credentials: ConnectorCredentialInput;
  insecureHttpApproved: boolean;
  tlsPolicy: "strict" | "allow_self_signed";
  tlsCaCertificatePem?: string;
}

export interface ConnectorAdminDependencies {
  clock?: () => Date;
  createAdapter?: (input: ConnectorAdapterFactoryInput) => ConnectorAdapter;
  createId?: () => string;
}

function credentialContext(service: ManagedConnectorService, connectorId: string) {
  return `connector_credentials:${service}:${connectorId}`;
}

function parseCaCertificate(pem: string) {
  try {
    const certificate = new X509Certificate(pem);
    if (!certificate.ca) throw new Error("not-ca");
    return certificate;
  } catch (error) {
    throw new ConnectorAdminError("configuration_invalid", { cause: error });
  }
}

function validateCaCertificate(pem: string, now: number) {
  const certificate = parseCaCertificate(pem);
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (
    !Number.isSafeInteger(validFrom) ||
    !Number.isSafeInteger(validTo) ||
    now < validFrom ||
    now >= validTo
  ) {
    throw new ConnectorAdminError("configuration_invalid");
  }
}

function healthIsFresh(health: ConnectorHealth | undefined, now: number) {
  if (health?.status !== "healthy") return false;
  const checkedAt = Date.parse(health.checkedAt);
  return (
    Number.isSafeInteger(checkedAt) &&
    checkedAt >= now - CONNECTOR_VALIDATION_TTL_MS &&
    checkedAt <= now + CONNECTOR_PROBE_CLOCK_SKEW_MS
  );
}

function revisionFor(row: Pick<ConnectorRow, "id" | "type" | "updatedAt">) {
  return createHash("sha256")
    .update(`${row.type}\0${row.id}\0${row.updatedAt}`, "utf8")
    .digest("base64url");
}

function canonicalBaseUrl(value: string, allowInsecureHttp: boolean) {
  const url = validateDestinationUrlLiteral(value, { allowInsecureHttp });
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
}

function canonicalPublicUiUrl(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
}

function credentialAllowed(
  service: ManagedConnectorService,
  credentials: ConnectorCredentialInput,
) {
  if (service === "jellyfin") return credentials.kind === "none";
  if (service === "seerr" || service === "sabnzbd") {
    return credentials.kind === "none" || credentials.kind === "api_key";
  }
  if (service === "qbittorrent") return credentials.kind === "username_password";
  return credentials.kind === "api_key";
}

function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (
      !IDENTIFIER_PATTERN.test(decoded) ||
      Buffer.from(decoded, "utf8").toString("base64url") !== cursor
    ) {
      throw new Error("invalid");
    }
    return decoded;
  } catch {
    throw new ConnectorAdminError("configuration_invalid");
  }
}

function encodeCursor(connectorId: string) {
  return Buffer.from(connectorId, "utf8").toString("base64url");
}

function parseSnapshot(row: ConnectorRow): StoredSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(row.capabilitySnapshotJson) as unknown;
  } catch {
    throw new ConnectorAdminError("integrity_failure");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConnectorAdminError("integrity_failure");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) {
    throw new ConnectorAdminError("integrity_failure");
  }
  let health: ConnectorHealth | undefined;
  if (record.health !== undefined) {
    const parsedHealth = connectorHealthSchema.safeParse(record.health);
    if (
      !parsedHealth.success ||
      parsedHealth.data.connectorId !== row.id ||
      parsedHealth.data.service !== row.type
    ) {
      throw new ConnectorAdminError("integrity_failure");
    }
    health = parsedHealth.data;
  }
  return {
    schemaVersion: 1,
    ...(health === undefined ? {} : { health }),
    ...(record.authentication === undefined ? {} : { authentication: record.authentication }),
  };
}

function defaultAdapterFactory(input: ConnectorAdapterFactoryInput): ConnectorAdapter {
  const target = {
    connectorId: input.connectorId,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    insecureHttpApproved: input.insecureHttpApproved,
    tlsPolicy: input.tlsPolicy,
    ...(input.tlsCaCertificatePem === undefined
      ? {}
      : { tlsCaCertificatePem: input.tlsCaCertificatePem }),
  } satisfies ConnectorTargetConfig;
  switch (input.service) {
    case "jellyfin":
      return new JellyfinAdapter(target);
    case "seerr":
      return new SeerrAdapter({
        ...target,
        ...(input.credentials.kind === "api_key" ? { apiKey: input.credentials.apiKey } : {}),
      });
    case "radarr":
      if (input.credentials.kind !== "api_key") break;
      return new RadarrAdapter({ ...target, apiKey: input.credentials.apiKey });
    case "sonarr":
      if (input.credentials.kind !== "api_key") break;
      return new SonarrAdapter({ ...target, apiKey: input.credentials.apiKey });
    case "prowlarr":
      if (input.credentials.kind !== "api_key") break;
      return new ProwlarrAdapter({ ...target, apiKey: input.credentials.apiKey });
    case "bazarr":
      if (input.credentials.kind !== "api_key") break;
      return new BazarrAdapter({ ...target, apiKey: input.credentials.apiKey });
    case "qbittorrent":
      if (input.credentials.kind !== "username_password") break;
      return new QBittorrentAdapter({
        ...target,
        username: input.credentials.username,
        password: input.credentials.password,
      });
    case "sabnzbd":
      return new SabnzbdAdapter({
        ...target,
        ...(input.credentials.kind === "api_key" ? { apiKey: input.credentials.apiKey } : {}),
      });
  }
  throw new ConnectorAdminError("integrity_failure");
}

function healthStateFor(health: ConnectorHealth): ConnectorRow["healthState"] {
  if (health.status === "healthy") return "healthy";
  if (health.status === "unavailable") return "offline";
  if (health.status === "unknown") return "unknown";
  return "degraded";
}

export class ConnectorAdminService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: (input: ConnectorAdapterFactoryInput) => ConnectorAdapter;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: ConnectorAdminDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapterFactory;
    this.#createId = dependencies.createId ?? randomUUID;
  }

  public list(query: ConnectorListQuery, context: ConnectorAdminContext) {
    const scope = this.#authorize(context);
    const parsed = connectorListQuerySchema.safeParse(query);
    if (!parsed.success) throw new ConnectorAdminError("configuration_invalid");
    const after = decodeCursor(parsed.data.cursor);
    try {
      const rows = this.#database.sqlite
        .prepare(
          `select
            id,
            type,
            display_name as displayName,
            base_url as baseUrl,
            public_ui_url as publicUiUrl,
            encrypted_credentials as encryptedCredentials,
            tls_policy as tlsPolicy,
            insecure_http_approved as insecureHttpApproved,
            capability_snapshot_json as capabilitySnapshotJson,
            health_state as healthState,
            enabled,
            created_at as createdAt,
            updated_at as updatedAt
           from connector_configs
           where (? = 'all' or type = 'jellyfin')
             and (? is null or id > ?)
           order by id asc
           limit ?`,
        )
        .all(scope, after ?? null, after ?? null, parsed.data.limit + 1) as ConnectorRow[];
      const hasMore = rows.length > parsed.data.limit;
      const page = rows.slice(0, parsed.data.limit);
      return {
        items: page.map((row) => this.#present(row)),
        nextCursor: hasMore && page.at(-1) ? encodeCursor(page.at(-1)!.id) : null,
      };
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("storage_failure", { cause: error });
    }
  }

  public get(connectorId: string, context: ConnectorAdminContext) {
    const row = this.#row(connectorId);
    this.#authorize(context, this.#service(row.type));
    return this.#present(row);
  }

  public create(input: ConnectorCreateRequest, context: ConnectorAdminContext) {
    const parsed = connectorCreateRequestSchema.safeParse(input);
    if (!parsed.success) throw new ConnectorAdminError("configuration_invalid");
    const connector = parsed.data;
    this.#authorize(context, connector.service);
    let baseUrl: string;
    let publicUiUrl: string | null;
    try {
      baseUrl = canonicalBaseUrl(connector.baseUrl, connector.insecureHttpApproved);
      publicUiUrl = canonicalPublicUiUrl(connector.publicUiUrl);
    } catch (error) {
      throw new ConnectorAdminError("configuration_invalid", { cause: error });
    }
    const now = this.#now();
    if (connector.tlsCaCertificatePem !== undefined) {
      validateCaCertificate(connector.tlsCaCertificatePem, now);
    }
    const auditId = this.#id();
    const encryptedCredentials = this.#cipher.encrypt(
      JSON.stringify({
        credentials: connector.credentials,
        schemaVersion: 1,
        ...(connector.tlsCaCertificatePem === undefined
          ? {}
          : { tlsCaCertificatePem: connector.tlsCaCertificatePem }),
      } satisfies StoredSecrets),
      credentialContext(connector.service, connector.id),
    );
    try {
      this.#database.sqlite
        .transaction(() => {
          const count = this.#database.sqlite
            .prepare("select count(*) as count from connector_configs")
            .get() as { count: number };
          if (count.count >= MAX_CONNECTORS) {
            throw new ConnectorAdminError("connector_limit_reached");
          }
          const conflict = this.#database.sqlite
            .prepare("select id from connector_configs where id = ? limit 1")
            .get(connector.id);
          if (conflict) throw new ConnectorAdminError("configuration_conflict");
          this.#database.sqlite
            .prepare(
              `insert into connector_configs (
                id,
                type,
                display_name,
                base_url,
                public_ui_url,
                encrypted_credentials,
                tls_policy,
                insecure_http_approved,
                capability_snapshot_json,
                health_state,
                enabled,
                created_at,
                updated_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, ?, ?)`,
            )
            .run(
              connector.id,
              connector.service,
              connector.displayName,
              baseUrl,
              publicUiUrl,
              encryptedCredentials,
              connector.tlsPolicy,
              connector.insecureHttpApproved ? 1 : 0,
              JSON.stringify({ schemaVersion: 1 }),
              now,
              now,
            );
          this.#audit(
            auditId,
            "connector.configuration.created",
            "success",
            connector.id,
            context,
            {
              credentialKind: connector.credentials.kind,
              insecureHttpApproved: connector.insecureHttpApproved,
              publicUiUrlConfigured: publicUiUrl !== null,
              service: connector.service,
              tlsCaCertificateConfigured: connector.tlsCaCertificatePem !== undefined,
              tlsPolicy: connector.tlsPolicy,
            },
            now,
          );
        })
        .immediate();
      return this.#present(this.#row(connector.id));
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("storage_failure", { cause: error });
    }
  }

  public update(
    connectorId: string,
    input: ConnectorUpdateRequest,
    context: ConnectorAdminContext,
  ) {
    const parsed = connectorUpdateRequestSchema.safeParse(input);
    if (!parsed.success) throw new ConnectorAdminError("configuration_invalid");
    const current = this.#row(connectorId);
    const service = this.#service(current.type);
    this.#authorize(context, service);
    if (revisionFor(current) !== parsed.data.revision) {
      throw new ConnectorAdminError("revision_conflict");
    }
    const currentSecrets = this.#secrets(current, service);
    const credentials = parsed.data.credentials ?? currentSecrets.credentials;
    const tlsPolicy = parsed.data.tlsPolicy ?? current.tlsPolicy;
    const tlsCaCertificatePem =
      tlsPolicy === "allow_self_signed"
        ? (parsed.data.tlsCaCertificatePem ?? currentSecrets.tlsCaCertificatePem)
        : undefined;
    if (parsed.data.tlsCaCertificatePem !== undefined && tlsPolicy !== "allow_self_signed") {
      throw new ConnectorAdminError("configuration_invalid");
    }
    const candidate = connectorCreateRequestSchema.safeParse({
      id: current.id,
      service,
      displayName: parsed.data.displayName ?? current.displayName,
      baseUrl: parsed.data.baseUrl ?? current.baseUrl,
      publicUiUrl:
        parsed.data.publicUiUrl === undefined ? current.publicUiUrl : parsed.data.publicUiUrl,
      credentials,
      tlsPolicy,
      ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
      insecureHttpApproved: parsed.data.insecureHttpApproved ?? current.insecureHttpApproved === 1,
    });
    if (!candidate.success) throw new ConnectorAdminError("configuration_invalid");
    let baseUrl: string;
    let publicUiUrl: string | null;
    try {
      baseUrl = canonicalBaseUrl(candidate.data.baseUrl, candidate.data.insecureHttpApproved);
      publicUiUrl = canonicalPublicUiUrl(candidate.data.publicUiUrl);
    } catch (error) {
      throw new ConnectorAdminError("configuration_invalid", { cause: error });
    }
    const requestedAt = this.#now();
    if (parsed.data.tlsCaCertificatePem !== undefined) {
      validateCaCertificate(parsed.data.tlsCaCertificatePem, requestedAt);
    }
    const materialChange =
      baseUrl !== current.baseUrl ||
      parsed.data.credentials !== undefined ||
      candidate.data.tlsPolicy !== current.tlsPolicy ||
      parsed.data.tlsCaCertificatePem !== undefined ||
      candidate.data.insecureHttpApproved !== (current.insecureHttpApproved === 1);
    if (materialChange && parsed.data.enabled === true) {
      throw new ConnectorAdminError("connector_not_validated");
    }
    if (
      !materialChange &&
      parsed.data.enabled === true &&
      (current.healthState !== "healthy" ||
        !healthIsFresh(parseSnapshot(current).health, requestedAt))
    ) {
      throw new ConnectorAdminError("connector_not_validated");
    }
    const now = Math.max(requestedAt, current.updatedAt + 1);
    const auditId = this.#id();
    const encryptedCredentials = this.#cipher.encrypt(
      JSON.stringify({
        credentials,
        schemaVersion: 1,
        ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
      } satisfies StoredSecrets),
      credentialContext(service, current.id),
    );
    const enabled = materialChange ? false : (parsed.data.enabled ?? current.enabled === 1);
    const changedFields = [
      ...(parsed.data.displayName === undefined ? [] : ["displayName"]),
      ...(parsed.data.baseUrl === undefined ? [] : ["baseUrl"]),
      ...(parsed.data.publicUiUrl === undefined ? [] : ["publicUiUrl"]),
      ...(parsed.data.credentials === undefined ? [] : ["credentials"]),
      ...(parsed.data.tlsPolicy === undefined ? [] : ["tlsPolicy"]),
      ...(parsed.data.tlsCaCertificatePem === undefined ? [] : ["tlsCaCertificatePem"]),
      ...(parsed.data.insecureHttpApproved === undefined ? [] : ["insecureHttpApproved"]),
      ...(parsed.data.enabled === undefined ? [] : ["enabled"]),
    ];
    try {
      this.#database.sqlite
        .transaction(() => {
          const result = this.#database.sqlite
            .prepare(
              `update connector_configs
               set display_name = ?,
                   base_url = ?,
                   public_ui_url = ?,
                   encrypted_credentials = ?,
                   tls_policy = ?,
                   insecure_http_approved = ?,
                   capability_snapshot_json = ?,
                   health_state = ?,
                   enabled = ?,
                   updated_at = ?
               where id = ? and updated_at = ?`,
            )
            .run(
              candidate.data.displayName,
              baseUrl,
              publicUiUrl,
              encryptedCredentials,
              candidate.data.tlsPolicy,
              candidate.data.insecureHttpApproved ? 1 : 0,
              materialChange
                ? JSON.stringify({ schemaVersion: 1 })
                : current.capabilitySnapshotJson,
              materialChange ? "unknown" : current.healthState,
              enabled ? 1 : 0,
              now,
              current.id,
              current.updatedAt,
            );
          if (result.changes !== 1) throw new ConnectorAdminError("revision_conflict");
          this.#audit(
            auditId,
            "connector.configuration.updated",
            "success",
            current.id,
            context,
            { changedFields, service },
            now,
          );
        })
        .immediate();
      return this.#present(this.#row(current.id));
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("storage_failure", { cause: error });
    }
  }

  public async probe(connectorId: string, context: ConnectorAdminContext) {
    const current = this.#row(connectorId);
    const service = this.#service(current.type);
    this.#authorize(context, service);
    const secrets = this.#secrets(current, service);
    const credentials = secrets.credentials;
    if (!credentialAllowed(service, credentials)) {
      throw new ConnectorAdminError("integrity_failure");
    }
    let adapter: ConnectorAdapter;
    try {
      adapter = this.#createAdapter({
        connectorId: current.id,
        service,
        displayName: current.displayName,
        baseUrl: current.baseUrl,
        credentials,
        insecureHttpApproved: current.insecureHttpApproved === 1,
        tlsPolicy: current.tlsPolicy === "allow_self_signed" ? "allow_self_signed" : "strict",
        ...(secrets.tlsCaCertificatePem === undefined
          ? {}
          : { tlsCaCertificatePem: secrets.tlsCaCertificatePem }),
      });
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("integrity_failure", { cause: error });
    }
    const health = connectorHealthSchema.parse(await adapter.probe());
    if (health.connectorId !== current.id || health.service !== service) {
      throw new ConnectorAdminError("integrity_failure");
    }
    const now = Math.max(this.#now(), current.updatedAt + 1);
    const checkedAt = Date.parse(health.checkedAt);
    if (
      !Number.isSafeInteger(checkedAt) ||
      checkedAt < now - CONNECTOR_PROBE_CLOCK_SKEW_MS ||
      checkedAt > now + CONNECTOR_PROBE_CLOCK_SKEW_MS
    ) {
      throw new ConnectorAdminError("integrity_failure");
    }
    const previous = parseSnapshot(current);
    const snapshot: StoredSnapshot = {
      schemaVersion: 1,
      health,
      ...(previous.authentication === undefined ? {} : { authentication: previous.authentication }),
    };
    const auditId = this.#id();
    try {
      this.#database.sqlite
        .transaction(() => {
          const result = this.#database.sqlite
            .prepare(
              `update connector_configs
               set capability_snapshot_json = ?, health_state = ?, updated_at = ?
               where id = ? and updated_at = ?`,
            )
            .run(
              JSON.stringify(snapshot),
              healthStateFor(health),
              now,
              current.id,
              current.updatedAt,
            );
          if (result.changes !== 1) throw new ConnectorAdminError("revision_conflict");
          this.#audit(
            auditId,
            "connector.probed",
            health.status === "healthy" ? "success" : "failure",
            current.id,
            context,
            {
              failureCode: health.failure?.code ?? null,
              service,
              status: health.status,
              version: health.version,
            },
            now,
          );
        })
        .immediate();
      return this.#present(this.#row(current.id));
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("storage_failure", { cause: error });
    }
  }

  public delete(connectorId: string, revision: string, context: ConnectorAdminContext) {
    const current = this.#row(connectorId);
    this.#authorize(context, this.#service(current.type));
    if (revisionFor(current) !== revision) throw new ConnectorAdminError("revision_conflict");
    if (current.enabled === 1) throw new ConnectorAdminError("connector_must_be_disabled");
    const auditId = this.#id();
    const now = Math.max(this.#now(), current.updatedAt + 1);
    try {
      this.#database.sqlite
        .transaction(() => {
          const inUse = this.#database.sqlite
            .prepare("select id from service_identity_links where connector_id = ? limit 1")
            .get(current.id);
          if (inUse) throw new ConnectorAdminError("connector_in_use");
          const result = this.#database.sqlite
            .prepare("delete from connector_configs where id = ? and updated_at = ?")
            .run(current.id, current.updatedAt);
          if (result.changes !== 1) throw new ConnectorAdminError("revision_conflict");
          this.#audit(
            auditId,
            "connector.configuration.deleted",
            "success",
            current.id,
            context,
            { service: current.type },
            now,
          );
        })
        .immediate();
      return { deletedConnectorId: current.id };
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("storage_failure", { cause: error });
    }
  }

  #authorize(context: ConnectorAdminContext, service?: ManagedConnectorService) {
    const recovery = context.principal.authenticationMethod.kind === "recovery";
    if (recovery) {
      requirePermission(context.principal, "recovery.jellyfin.manage");
      if (service !== undefined && service !== "jellyfin") {
        requirePermission(context.principal, "connectors.manage");
      }
    } else {
      requirePermission(context.principal, "connectors.manage");
    }
    if (
      (context.ipAddress !== undefined && context.ipAddress.length > 256) ||
      (context.requestId !== undefined &&
        (context.requestId.length < 1 || context.requestId.length > 128))
    ) {
      throw new ConnectorAdminError("integrity_failure");
    }
    return recovery ? "jellyfin" : "all";
  }

  #secrets(row: ConnectorRow, service: ManagedConnectorService): StoredSecrets {
    let plaintext: string;
    try {
      plaintext = this.#cipher.decrypt(
        row.encryptedCredentials,
        credentialContext(service, row.id),
      );
      const decoded = JSON.parse(plaintext) as unknown;
      const isRecord = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded);
      const record = isRecord ? (decoded as Record<string, unknown>) : undefined;
      const isVersioned = record?.schemaVersion === 1;
      if (
        isVersioned &&
        Object.keys(record).some(
          (key) => !["credentials", "schemaVersion", "tlsCaCertificatePem"].includes(key),
        )
      ) {
        throw new Error("invalid");
      }
      const legacyCredentials =
        service === "jellyfin" && record && Object.keys(record).length === 0
          ? { kind: "none" }
          : decoded;
      const parsed = connectorCredentialInputSchema.safeParse(
        isVersioned ? record.credentials : legacyCredentials,
      );
      if (!parsed.success || !credentialAllowed(service, parsed.data)) {
        throw new Error("invalid");
      }
      const tlsCaCertificatePem = isVersioned ? record.tlsCaCertificatePem : undefined;
      if (tlsCaCertificatePem !== undefined) {
        if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
          throw new Error("invalid");
        }
        parseCaCertificate(tlsCaCertificatePem);
      }
      return {
        credentials: parsed.data,
        schemaVersion: 1,
        ...(typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {}),
      };
    } catch (error) {
      throw new ConnectorAdminError("integrity_failure", { cause: error });
    }
  }

  #present(row: ConnectorRow): ConnectorAdmin {
    const service = this.#service(row.type);
    const secrets = this.#secrets(row, service);
    const snapshot = parseSnapshot(row);
    const parsed = connectorAdminSchema.safeParse({
      id: row.id,
      service,
      displayName: row.displayName,
      baseUrl: row.baseUrl,
      publicUiUrl: row.publicUiUrl,
      credentialKind: secrets.credentials.kind,
      credentialsConfigured: secrets.credentials.kind !== "none",
      tlsPolicy: row.tlsPolicy,
      tlsCaCertificateConfigured: secrets.tlsCaCertificatePem !== undefined,
      insecureHttpApproved: row.insecureHttpApproved === 1,
      enabled: row.enabled === 1,
      healthState: row.healthState,
      lastProbe: snapshot.health ?? null,
      revision: revisionFor(row),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    });
    if (!parsed.success) throw new ConnectorAdminError("integrity_failure");
    return parsed.data;
  }

  #row(connectorId: string): ConnectorRow {
    if (!IDENTIFIER_PATTERN.test(connectorId)) {
      throw new ConnectorAdminError("configuration_invalid");
    }
    try {
      const row = this.#database.sqlite
        .prepare(
          `select
            id,
            type,
            display_name as displayName,
            base_url as baseUrl,
            public_ui_url as publicUiUrl,
            encrypted_credentials as encryptedCredentials,
            tls_policy as tlsPolicy,
            insecure_http_approved as insecureHttpApproved,
            capability_snapshot_json as capabilitySnapshotJson,
            health_state as healthState,
            enabled,
            created_at as createdAt,
            updated_at as updatedAt
           from connector_configs
           where id = ?
           limit 1`,
        )
        .get(connectorId) as ConnectorRow | undefined;
      if (!row) throw new ConnectorAdminError("connector_not_found");
      return row;
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("storage_failure", { cause: error });
    }
  }

  #service(value: string): ManagedConnectorService {
    if (
      ![
        "jellyfin",
        "seerr",
        "radarr",
        "sonarr",
        "prowlarr",
        "bazarr",
        "qbittorrent",
        "sabnzbd",
      ].includes(value)
    ) {
      throw new ConnectorAdminError("integrity_failure");
    }
    return value as ManagedConnectorService;
  }

  #audit(
    auditId: string,
    eventType: string,
    outcome: "success" | "failure",
    connectorId: string,
    context: ConnectorAdminContext,
    metadata: Record<string, unknown>,
    createdAt: number,
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
        ) values (?, ?, ?, ?, ?, ?, 'connector', ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        outcome,
        connectorId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now.getTime()) || now.getTime() < 0) {
      throw new ConnectorAdminError("integrity_failure");
    }
    return now.getTime();
  }

  #id() {
    const id = this.#createId();
    if (!IDENTIFIER_PATTERN.test(id)) throw new ConnectorAdminError("integrity_failure");
    return id;
  }
}
