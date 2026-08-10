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
import { createHash, createHmac, randomUUID, X509Certificate } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { requirePermission } from "../auth/authorization.js";
import { revokeConnectorSessionsForReplacement } from "../auth/session-service.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";
import type { ConnectorHttpLaneLifecycle } from "./http-lane-registry.js";

const MAX_CONNECTORS = 100;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const CONNECTOR_VALIDATION_TTL_MS = 10 * 60 * 1_000;
const CONNECTOR_PROBE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;

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
  instanceGeneration: number;
  configGeneration: number;
  instanceIdentityHash: string | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

interface StoredSnapshot {
  schemaVersion: 1;
  health?: ConnectorHealth;
  authentication?: unknown;
  configGeneration?: number;
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
  lane?: ConnectorTargetConfig["lane"];
}

export interface ConnectorAdminDependencies {
  clock?: () => Date;
  createAdapter?: (input: ConnectorAdapterFactoryInput) => ConnectorAdapter;
  createId?: () => string;
  laneProvider?: ConnectorHttpLaneLifecycle;
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

function revisionFor(row: Pick<ConnectorRow, "configGeneration" | "id" | "type">) {
  return createHash("sha256")
    .update(`${row.type}\0${row.id}\0${row.configGeneration}`, "utf8")
    .digest("base64url");
}

function legacyRevisionFor(row: Pick<ConnectorRow, "id" | "type" | "updatedAt">) {
  return createHash("sha256")
    .update(`${row.type}\0${row.id}\0${row.updatedAt}`, "utf8")
    .digest("base64url");
}

function revisionMatches(row: ConnectorRow, revision: string) {
  if (revisionFor(row) === revision) return true;
  return (
    row.instanceGeneration === 0 &&
    row.configGeneration === 0 &&
    legacyRevisionFor(row) === revision
  );
}

function safeGeneration(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_GENERATION;
}

function stableInstanceIdentityHash(value: string, key: Buffer) {
  return createHmac("sha256", key)
    .update("omnifin:v1:connector-instance-identity\0", "utf8")
    .update(value, "utf8")
    .digest("base64url");
}

function sameCredentials(left: ConnectorCredentialInput, right: ConnectorCredentialInput) {
  return JSON.stringify(left) === JSON.stringify(right);
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
  const snapshotConfigGeneration = record.configGeneration;
  if (
    snapshotConfigGeneration !== undefined &&
    (!safeGeneration(snapshotConfigGeneration as number) || health === undefined)
  ) {
    throw new ConnectorAdminError("integrity_failure");
  }
  return {
    schemaVersion: 1,
    ...(health === undefined ? {} : { health }),
    ...(record.authentication === undefined ? {} : { authentication: record.authentication }),
    ...(snapshotConfigGeneration === undefined
      ? {}
      : { configGeneration: snapshotConfigGeneration as number }),
  };
}

function validationMatchesGeneration(row: ConnectorRow, snapshot: StoredSnapshot) {
  return (
    snapshot.configGeneration === row.configGeneration ||
    (snapshot.configGeneration === undefined &&
      row.instanceGeneration === 0 &&
      row.configGeneration === row.updatedAt)
  );
}

function carryValidationForward(
  snapshot: StoredSnapshot,
  nextGeneration: number,
  validationIsCurrent: boolean,
) {
  const authentication =
    snapshot.authentication !== null &&
    typeof snapshot.authentication === "object" &&
    !Array.isArray(snapshot.authentication)
      ? {
          ...(snapshot.authentication as Record<string, unknown>),
          configGeneration: nextGeneration,
        }
      : snapshot.authentication;
  return {
    schemaVersion: 1,
    ...(snapshot.health === undefined ? {} : { health: snapshot.health }),
    ...(authentication === undefined ? {} : { authentication }),
    ...(snapshot.health !== undefined && validationIsCurrent
      ? { configGeneration: nextGeneration }
      : {}),
  } satisfies StoredSnapshot;
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
    ...(input.lane === undefined ? {} : { lane: input.lane }),
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
  readonly #laneProvider: ConnectorHttpLaneLifecycle | undefined;

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
    this.#laneProvider = dependencies.laneProvider;
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
            instance_generation as instanceGeneration,
            config_generation as configGeneration,
            instance_identity_hash as instanceIdentityHash,
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
                instance_generation,
                config_generation,
                instance_identity_hash,
                enabled,
                created_at,
                updated_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, 0, null, 0, ?, ?)`,
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
    if (!revisionMatches(current, parsed.data.revision)) {
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
    const displayNameChanged = candidate.data.displayName !== current.displayName;
    const baseUrlChanged = baseUrl !== current.baseUrl;
    const publicUiUrlChanged = publicUiUrl !== current.publicUiUrl;
    const credentialsChanged = !sameCredentials(credentials, currentSecrets.credentials);
    const tlsPolicyChanged = candidate.data.tlsPolicy !== current.tlsPolicy;
    const tlsCaCertificateChanged = tlsCaCertificatePem !== currentSecrets.tlsCaCertificatePem;
    const insecureHttpApprovalChanged =
      candidate.data.insecureHttpApproved !== (current.insecureHttpApproved === 1);
    const requestedEnabled = parsed.data.enabled ?? current.enabled === 1;
    const enablementChanged = requestedEnabled !== (current.enabled === 1);
    const validationSensitiveChange =
      baseUrlChanged ||
      credentialsChanged ||
      tlsPolicyChanged ||
      tlsCaCertificateChanged ||
      insecureHttpApprovalChanged;
    const configChanged =
      displayNameChanged ||
      baseUrlChanged ||
      publicUiUrlChanged ||
      credentialsChanged ||
      tlsPolicyChanged ||
      tlsCaCertificateChanged ||
      insecureHttpApprovalChanged ||
      enablementChanged;
    if (!configChanged) return this.#present(current);
    if (!safeGeneration(current.configGeneration) || current.configGeneration >= MAX_GENERATION) {
      throw new ConnectorAdminError("integrity_failure");
    }
    if (
      baseUrlChanged &&
      (!safeGeneration(current.instanceGeneration) || current.instanceGeneration >= MAX_GENERATION)
    ) {
      throw new ConnectorAdminError("integrity_failure");
    }
    if (validationSensitiveChange && parsed.data.enabled === true) {
      throw new ConnectorAdminError("connector_not_validated");
    }
    const currentSnapshot = parseSnapshot(current);
    if (
      enablementChanged &&
      requestedEnabled &&
      (current.healthState !== "healthy" ||
        !healthIsFresh(currentSnapshot.health, requestedAt) ||
        !validationMatchesGeneration(current, currentSnapshot))
    ) {
      throw new ConnectorAdminError("connector_not_validated");
    }
    const now = Math.max(requestedAt, current.updatedAt + 1);
    const nextConfigGeneration = current.configGeneration + 1;
    const nextInstanceGeneration = baseUrlChanged
      ? current.instanceGeneration + 1
      : current.instanceGeneration;
    const auditId = this.#id();
    const encryptedCredentials =
      credentialsChanged || tlsPolicyChanged || tlsCaCertificateChanged
        ? this.#cipher.encrypt(
            JSON.stringify({
              credentials,
              schemaVersion: 1,
              ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
            } satisfies StoredSecrets),
            credentialContext(service, current.id),
          )
        : current.encryptedCredentials;
    const enabled = validationSensitiveChange ? false : requestedEnabled;
    const snapshot = validationSensitiveChange
      ? ({ schemaVersion: 1 } satisfies StoredSnapshot)
      : carryValidationForward(
          currentSnapshot,
          nextConfigGeneration,
          validationMatchesGeneration(current, currentSnapshot),
        );
    const changedFields = [
      ...(displayNameChanged ? ["displayName"] : []),
      ...(baseUrlChanged ? ["baseUrl"] : []),
      ...(publicUiUrlChanged ? ["publicUiUrl"] : []),
      ...(credentialsChanged ? ["credentials"] : []),
      ...(tlsPolicyChanged ? ["tlsPolicy"] : []),
      ...(tlsCaCertificateChanged ? ["tlsCaCertificatePem"] : []),
      ...(insecureHttpApprovalChanged ? ["insecureHttpApproved"] : []),
      ...(enablementChanged ? ["enabled"] : []),
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
                   instance_generation = ?,
                   config_generation = ?,
                   instance_identity_hash = ?,
                   updated_at = ?
               where id = ?
                 and instance_generation = ?
                 and config_generation = ?
                 and updated_at = ?`,
            )
            .run(
              candidate.data.displayName,
              baseUrl,
              publicUiUrl,
              encryptedCredentials,
              candidate.data.tlsPolicy,
              candidate.data.insecureHttpApproved ? 1 : 0,
              JSON.stringify(snapshot),
              validationSensitiveChange ? "unknown" : current.healthState,
              enabled ? 1 : 0,
              nextInstanceGeneration,
              nextConfigGeneration,
              baseUrlChanged ? null : current.instanceIdentityHash,
              now,
              current.id,
              current.instanceGeneration,
              current.configGeneration,
              current.updatedAt,
            );
          if (result.changes !== 1) throw new ConnectorAdminError("revision_conflict");
          const replacement = baseUrlChanged
            ? this.#invalidateConnectorInstance(current.id, now)
            : undefined;
          this.#audit(
            auditId,
            "connector.configuration.updated",
            "success",
            current.id,
            context,
            {
              changedFields,
              configGeneration: nextConfigGeneration,
              instanceGeneration: nextInstanceGeneration,
              instanceReplaced: baseUrlChanged,
              ...(replacement === undefined ? {} : { replacement }),
              service,
            },
            now,
          );
        })
        .immediate();
      if (
        baseUrlChanged ||
        credentialsChanged ||
        tlsPolicyChanged ||
        tlsCaCertificateChanged ||
        insecureHttpApprovalChanged ||
        (current.enabled === 1 && !requestedEnabled)
      ) {
        this.#laneProvider?.retire(service, current.id);
      }
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
      const lane = this.#laneProvider?.laneFor(service, current.id);
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
        ...(lane === undefined ? {} : { lane }),
      });
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("integrity_failure", { cause: error });
    }
    const identityAware = adapter as ConnectorAdapter & {
      probeWithIdentity?: (signal?: AbortSignal) => Promise<{
        health: ConnectorHealth;
        stableInstanceIdentity: string | null;
      }>;
    };
    const probeResult =
      service === "jellyfin" && typeof identityAware.probeWithIdentity === "function"
        ? await identityAware.probeWithIdentity()
        : { health: await adapter.probe(), stableInstanceIdentity: null };
    const health = connectorHealthSchema.parse(probeResult.health);
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
    let nextInstanceIdentityHash = current.instanceIdentityHash;
    let instanceIdentityReplaced = false;
    if (service === "jellyfin" && health.status === "healthy") {
      if (
        typeof probeResult.stableInstanceIdentity !== "string" ||
        probeResult.stableInstanceIdentity.length < 1 ||
        probeResult.stableInstanceIdentity.length > 256
      ) {
        throw new ConnectorAdminError("integrity_failure");
      }
      nextInstanceIdentityHash = stableInstanceIdentityHash(
        probeResult.stableInstanceIdentity,
        this.#config.encryptionKey,
      );
      instanceIdentityReplaced =
        current.instanceIdentityHash !== null &&
        current.instanceIdentityHash !== nextInstanceIdentityHash;
      if (
        instanceIdentityReplaced &&
        (!safeGeneration(current.instanceGeneration) ||
          current.instanceGeneration >= MAX_GENERATION)
      ) {
        throw new ConnectorAdminError("integrity_failure");
      }
    }
    const previous = parseSnapshot(current);
    const snapshot: StoredSnapshot = {
      schemaVersion: 1,
      health,
      ...(previous.authentication === undefined ? {} : { authentication: previous.authentication }),
      configGeneration: current.configGeneration,
    };
    const auditId = this.#id();
    try {
      this.#database.sqlite
        .transaction(() => {
          const result = instanceIdentityReplaced
            ? this.#database.sqlite
                .prepare(
                  `update connector_configs
                   set capability_snapshot_json = ?, health_state = 'unknown', enabled = 0,
                       instance_generation = instance_generation + 1,
                       instance_identity_hash = ?, updated_at = ?
                   where id = ?
                     and instance_generation = ?
                     and config_generation = ?
                     and updated_at = ?`,
                )
                .run(
                  JSON.stringify({ schemaVersion: 1 } satisfies StoredSnapshot),
                  nextInstanceIdentityHash,
                  now,
                  current.id,
                  current.instanceGeneration,
                  current.configGeneration,
                  current.updatedAt,
                )
            : this.#database.sqlite
                .prepare(
                  `update connector_configs
                   set capability_snapshot_json = ?, health_state = ?,
                       instance_identity_hash = ?, updated_at = ?
                   where id = ?
                     and instance_generation = ?
                     and config_generation = ?
                     and updated_at = ?`,
                )
                .run(
                  JSON.stringify(snapshot),
                  healthStateFor(health),
                  nextInstanceIdentityHash,
                  now,
                  current.id,
                  current.instanceGeneration,
                  current.configGeneration,
                  current.updatedAt,
                );
          if (result.changes !== 1) throw new ConnectorAdminError("revision_conflict");
          const replacement = instanceIdentityReplaced
            ? this.#invalidateConnectorInstance(current.id, now)
            : undefined;
          this.#audit(
            auditId,
            instanceIdentityReplaced ? "connector.instance.replaced" : "connector.probed",
            health.status === "healthy" ? "success" : "failure",
            current.id,
            context,
            {
              failureCode: health.failure?.code ?? null,
              configGeneration: current.configGeneration,
              instanceGeneration: current.instanceGeneration + (instanceIdentityReplaced ? 1 : 0),
              instanceReplaced: instanceIdentityReplaced,
              ...(replacement === undefined ? {} : { replacement }),
              service,
              status: health.status,
              version: health.version,
            },
            now,
          );
        })
        .immediate();
      if (instanceIdentityReplaced) this.#laneProvider?.retire(service, current.id);
      return this.#present(this.#row(current.id));
    } catch (error) {
      if (error instanceof ConnectorAdminError) throw error;
      throw new ConnectorAdminError("storage_failure", { cause: error });
    }
  }

  public delete(connectorId: string, revision: string, context: ConnectorAdminContext) {
    const current = this.#row(connectorId);
    this.#authorize(context, this.#service(current.type));
    if (!revisionMatches(current, revision)) throw new ConnectorAdminError("revision_conflict");
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
            .prepare(
              `delete from connector_configs
               where id = ? and instance_generation = ? and config_generation = ? and updated_at = ?`,
            )
            .run(
              current.id,
              current.instanceGeneration,
              current.configGeneration,
              current.updatedAt,
            );
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
      this.#laneProvider?.retire(this.#service(current.type), current.id);
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

  #invalidateConnectorInstance(connectorId: string, occurredAt: number) {
    if (!this.#database.sqlite.inTransaction) {
      throw new ConnectorAdminError("integrity_failure");
    }
    const overflowingLink = this.#database.sqlite
      .prepare(
        `select 1 from service_identity_links
         where connector_id = ? and revision >= 2147483647 limit 1`,
      )
      .get(connectorId);
    if (overflowingLink) throw new ConnectorAdminError("integrity_failure");

    const revokedSessions = revokeConnectorSessionsForReplacement(
      this.#database,
      connectorId,
      occurredAt,
    );
    const quickConnectTransactions = this.#database.sqlite
      .prepare("delete from jellyfin_quick_connect_transactions where connector_id = ?")
      .run(connectorId).changes;

    const parentOperationUpdates = [
      ["media_request_operations", "media_request_operation"],
      ["media_issue_operations", "media_issue_operation"],
      ["subtitle_download_operations", "subtitle_download_operation"],
      ["library_mutation_operations", "library_mutation_operation"],
      ["user_media_state_operations", "user_media_state_operation"],
      ["acquisition_search_operations", "acquisition_search_operation"],
      ["acquisition_grab_operations", "acquisition_grab_operation"],
    ] as const;
    let invalidatedOperations = 0;
    for (const [table, parentType] of parentOperationUpdates) {
      invalidatedOperations += this.#database.sqlite
        .prepare(
          `update ${table}
           set state = 'failed', response_json = null,
               failure_code = 'connector_instance_replaced',
               completed_at = max(created_at, updated_at, @occurredAt),
               updated_at = max(created_at, updated_at, @occurredAt)
           where state = 'pending'
             and id in (
               select parent_operation_id from external_mutation_dispatches
               where connector_id = @connectorId and parent_operation_type = @parentType
             )`,
        )
        .run({ connectorId, occurredAt, parentType }).changes;
    }
    invalidatedOperations += this.#database.sqlite
      .prepare(
        `update saved_list_operations
         set state = 'failed', encrypted_response = null,
             failure_code = 'connector_instance_replaced',
             completed_at = max(created_at, updated_at, @occurredAt),
             updated_at = max(created_at, updated_at, @occurredAt)
         where state = 'pending'
           and id in (
             select parent_operation_id from external_mutation_dispatches
             where connector_id = @connectorId
               and parent_operation_type = 'saved_list_operation'
           )`,
      )
      .run({ connectorId, occurredAt }).changes;
    invalidatedOperations += this.#database.sqlite
      .prepare(
        `update library_removal_operations
         set state = 'failed', failure_code = 'connector_instance_replaced',
             completed_at = max(created_at, started_at, updated_at, @occurredAt),
             updated_at = max(created_at, started_at, updated_at, @occurredAt)
         where state = 'running'
           and id in (
             select parent_operation_id from external_mutation_dispatches
             where connector_id = @connectorId
               and parent_operation_type = 'library_removal_operation'
           )`,
      )
      .run({ connectorId, occurredAt }).changes;
    for (const [table, parentType] of [
      ["download_queue_removal_operations", "download_queue_removal_operation"],
      ["acquisition_queue_recovery_operations", "acquisition_queue_recovery_operation"],
    ] as const) {
      invalidatedOperations += this.#database.sqlite
        .prepare(
          `update ${table}
           set state = 'failed', response_json = null,
               failure_code = 'connector_instance_replaced',
               completed_at = max(created_at, updated_at, @occurredAt),
               updated_at = max(created_at, updated_at, @occurredAt)
           where connector_id = @connectorId and state = 'pending'`,
        )
        .run({ connectorId, occurredAt, parentType }).changes;
    }
    for (const table of [
      "download_queue_item_operations",
      "playback_progress_operations",
    ] as const) {
      invalidatedOperations += this.#database.sqlite
        .prepare(
          `update ${table}
           set state = 'failed', failure_code = 'connector_instance_replaced',
               completed_at = max(created_at, updated_at, @occurredAt),
               updated_at = max(created_at, updated_at, @occurredAt)
           where connector_id = @connectorId and state = 'pending'`,
        )
        .run({ connectorId, occurredAt }).changes;
    }
    this.#database.sqlite
      .prepare(
        `delete from external_mutation_target_locks
         where owner_dispatch_id in (
           select id from external_mutation_dispatches
           where connector_id = ?
             and state in ('reserved', 'dispatched', 'reconcile_required')
         )`,
      )
      .run(connectorId);
    invalidatedOperations += this.#database.sqlite
      .prepare(
        `update external_mutation_dispatches
         set state = 'failed', lease_owner = null, lease_expires_at = null,
             reconcile_required_at = null, uncertain_at = null,
             completed_at = max(created_at, updated_at, @occurredAt),
             failure_code = 'connector_instance_replaced',
             updated_at = max(created_at, updated_at, @occurredAt)
         where connector_id = @connectorId
           and state in ('reserved', 'dispatched', 'reconcile_required')`,
      )
      .run({ connectorId, occurredAt }).changes;

    const transientReferenceTables = [
      "subtitle_searches",
      "discovery_artwork_references",
      "external_issue_references",
      "media_request_profile_preferences",
    ] as const;
    let invalidatedReferences = 0;
    for (const table of transientReferenceTables) {
      invalidatedReferences += this.#database.sqlite
        .prepare(`delete from ${table} where connector_id = ?`)
        .run(connectorId).changes;
    }
    for (const table of [
      "library_artwork_searches",
      "library_removal_previews",
      "saved_targets",
    ] as const) {
      invalidatedReferences += this.#database.sqlite
        .prepare(
          `delete from ${table}
           where service_identity_link_id in (
             select id from service_identity_links where connector_id = ?
           )`,
        )
        .run(connectorId).changes;
    }
    invalidatedReferences += this.#database.sqlite
      .prepare(
        `delete from media_references
         where service_identity_link_id in (
           select id from service_identity_links where connector_id = ?
         )`,
      )
      .run(connectorId).changes;

    const linkResult = this.#database.sqlite
      .prepare(
        `update service_identity_links
         set encrypted_access_token = null,
             token_created_at = null,
             last_verified_at = null,
             health_state = case
               when health_state = 'revoked' then 'revoked'
               else 'relink_required'
             end,
             revoked_at = case
               when health_state = 'revoked' then max(coalesce(revoked_at, created_at), @occurredAt)
               else null
             end,
             revision = revision + 1,
             updated_at = max(created_at, updated_at, @occurredAt)
         where connector_id = @connectorId`,
      )
      .run({ connectorId, occurredAt });
    const pendingUsers = this.#database.sqlite
      .prepare(
        `update users
         set status = 'pending_link', updated_at = max(created_at, updated_at, @occurredAt)
         where status = 'active'
           and id in (
             select user_id from service_identity_links where connector_id = @connectorId
           )`,
      )
      .run({ connectorId, occurredAt }).changes;
    return {
      invalidatedOperations,
      invalidatedReferences,
      pendingUsers,
      relinkRequiredLinks: linkResult.changes,
      revokedSessions,
      quickConnectTransactions,
    };
  }

  #present(row: ConnectorRow): ConnectorAdmin {
    if (
      !safeGeneration(row.instanceGeneration) ||
      !safeGeneration(row.configGeneration) ||
      (row.instanceIdentityHash !== null && !/^[A-Za-z0-9_-]{43}$/u.test(row.instanceIdentityHash))
    ) {
      throw new ConnectorAdminError("integrity_failure");
    }
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
            instance_generation as instanceGeneration,
            config_generation as configGeneration,
            instance_identity_hash as instanceIdentityHash,
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
