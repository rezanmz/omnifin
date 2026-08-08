import { createHmac, randomUUID } from "node:crypto";

import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { EnvelopeCipher } from "../../security/crypto.js";

const ENVIRONMENT_CONNECTOR_ID = "jellyfin";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface JellyfinConnectorRow {
  baseUrl: string;
  configGeneration: number;
  displayName: string;
  encryptedCredentials: string;
  enabled: number;
  id: string;
  insecureHttpApproved: number;
  instanceGeneration: number;
  instanceIdentityHash: string | null;
  tlsPolicy: string;
  type: string;
  updatedAt: number;
}

export interface JellyfinConnectorTarget {
  readonly baseUrl: string;
  readonly configGeneration?: number;
  readonly connectorId: string;
  readonly displayName: string;
  readonly insecureHttpApproved: boolean;
  readonly instanceGeneration?: number;
  readonly instanceIdentityHash?: string | null;
  readonly tlsCaCertificatePem?: string;
  readonly tlsPolicy?: "allow_self_signed" | "strict";
  readonly updatedAt: number;
}

export class JellyfinConnectorConfigurationError extends Error {
  public readonly code = "jellyfin_connector_configuration_invalid";

  public constructor(options?: ErrorOptions) {
    super("Jellyfin authentication is not configured.", options);
    this.name = "JellyfinConnectorConfigurationError";
  }
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

export function bootstrapConfiguredJellyfinConnector(
  database: DatabaseHandle,
  config: Pick<AppConfig, "encryptionKey" | "jellyfinInsecureHttpApproved" | "jellyfinUrl">,
  dependencies: { clock?: () => Date; createId?: () => string } = {},
) {
  if (!config.jellyfinUrl) return false;
  const existing = database.sqlite
    .prepare("select id from connector_configs where type = 'jellyfin' limit 1")
    .get() as { id: string } | undefined;
  if (existing) return false;

  const conflicting = database.sqlite
    .prepare("select id from connector_configs where id = ?")
    .get(ENVIRONMENT_CONNECTOR_ID);
  if (conflicting) throw new JellyfinConnectorConfigurationError();

  const occurredAt = (dependencies.clock ?? (() => new Date()))();
  if (!Number.isSafeInteger(occurredAt.getTime()) || occurredAt.getTime() < 0) {
    throw new JellyfinConnectorConfigurationError();
  }
  const createId = dependencies.createId ?? randomUUID;
  const auditId = createId();
  if (!IDENTIFIER_PATTERN.test(auditId)) throw new JellyfinConnectorConfigurationError();
  const encryptedCredentials = new EnvelopeCipher(config.encryptionKey).encrypt(
    JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
    credentialsContext(ENVIRONMENT_CONNECTOR_ID),
  );
  const timestamp = occurredAt.getTime();

  try {
    database.sqlite
      .transaction(() => {
        database.sqlite
          .prepare(
            `insert into connector_configs (
              id,
              type,
              display_name,
              base_url,
              encrypted_credentials,
              insecure_http_approved,
              capability_snapshot_json,
              health_state,
              enabled,
              created_at,
              updated_at
            ) values (?, 'jellyfin', 'Jellyfin', ?, ?, ?, ?, 'unknown', 1, ?, ?)`,
          )
          .run(
            ENVIRONMENT_CONNECTOR_ID,
            config.jellyfinUrl!.href,
            encryptedCredentials,
            config.jellyfinInsecureHttpApproved ? 1 : 0,
            JSON.stringify({
              authentication: { password: true, quickConnect: "unknown" },
              schemaVersion: 1,
            }),
            timestamp,
            timestamp,
          );
        database.sqlite
          .prepare(
            `insert into audit_events (
              id,
              event_type,
              outcome,
              target_type,
              target_id,
              metadata_json,
              created_at
            ) values (?, 'connector.configuration.bootstrapped', 'success', 'connector', ?, ?, ?)`,
          )
          .run(
            auditId,
            ENVIRONMENT_CONNECTOR_ID,
            JSON.stringify({ service: "jellyfin", source: "deployment_config" }),
            timestamp,
          );
      })
      .immediate();
    return true;
  } catch (error) {
    if (error instanceof JellyfinConnectorConfigurationError) throw error;
    throw new JellyfinConnectorConfigurationError({ cause: error });
  }
}

export class JellyfinConnectorRegistry {
  readonly #database: DatabaseHandle;
  readonly #encryptionKey: Buffer | undefined;

  public constructor(database: DatabaseHandle, encryptionKey?: Buffer) {
    this.#database = database;
    this.#encryptionKey = encryptionKey;
  }

  public resolve(): JellyfinConnectorTarget {
    const rows = this.#database.sqlite
      .prepare(
        `select
          id,
          type,
          display_name as displayName,
          base_url as baseUrl,
          encrypted_credentials as encryptedCredentials,
          tls_policy as tlsPolicy,
          insecure_http_approved as insecureHttpApproved,
          instance_generation as instanceGeneration,
          config_generation as configGeneration,
          instance_identity_hash as instanceIdentityHash,
          enabled,
          updated_at as updatedAt
         from connector_configs
         where type = 'jellyfin' and enabled = 1
         order by id asc
         limit 2`,
      )
      .all() as JellyfinConnectorRow[];
    if (rows.length !== 1) throw new JellyfinConnectorConfigurationError();
    const row = rows[0];
    if (
      !row ||
      row.type !== "jellyfin" ||
      row.enabled !== 1 ||
      !IDENTIFIER_PATTERN.test(row.id) ||
      row.displayName.length < 1 ||
      row.displayName.length > 160 ||
      row.displayName.trim() !== row.displayName ||
      row.baseUrl.length < 1 ||
      row.baseUrl.length > 2_048 ||
      (row.insecureHttpApproved !== 0 && row.insecureHttpApproved !== 1) ||
      (row.tlsPolicy !== "strict" && row.tlsPolicy !== "allow_self_signed") ||
      !Number.isSafeInteger(row.instanceGeneration) ||
      row.instanceGeneration < 0 ||
      !Number.isSafeInteger(row.configGeneration) ||
      row.configGeneration < 0 ||
      (row.instanceIdentityHash !== null &&
        !/^[A-Za-z0-9_-]{43}$/u.test(row.instanceIdentityHash)) ||
      !Number.isSafeInteger(row.updatedAt) ||
      row.updatedAt < 0
    ) {
      throw new JellyfinConnectorConfigurationError();
    }
    let tlsCaCertificatePem: string | undefined;
    if (row.tlsPolicy === "allow_self_signed") {
      if (!this.#encryptionKey) throw new JellyfinConnectorConfigurationError();
      try {
        const plaintext = new EnvelopeCipher(this.#encryptionKey).decrypt(
          row.encryptedCredentials,
          credentialsContext(row.id),
        );
        const secrets = JSON.parse(plaintext) as unknown;
        if (
          !secrets ||
          typeof secrets !== "object" ||
          Array.isArray(secrets) ||
          typeof (secrets as Record<string, unknown>).tlsCaCertificatePem !== "string"
        ) {
          throw new Error("invalid");
        }
        tlsCaCertificatePem = (secrets as { tlsCaCertificatePem: string }).tlsCaCertificatePem;
      } catch (error) {
        throw new JellyfinConnectorConfigurationError({ cause: error });
      }
    }
    return Object.freeze({
      baseUrl: row.baseUrl,
      configGeneration: row.configGeneration,
      connectorId: row.id,
      displayName: row.displayName,
      insecureHttpApproved: row.insecureHttpApproved === 1,
      instanceGeneration: row.instanceGeneration,
      instanceIdentityHash: row.instanceIdentityHash,
      ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
      tlsPolicy: row.tlsPolicy,
      updatedAt: row.updatedAt,
    });
  }

  public bindingIsCurrent(target: JellyfinConnectorTarget) {
    const generationAware =
      target.instanceGeneration !== undefined && target.configGeneration !== undefined;
    const row = this.#database.sqlite
      .prepare(
        `select 1
         from connector_configs
         where id = ?
           and type = 'jellyfin'
           and enabled = 1
           and base_url = ?
           and insecure_http_approved = ?
           and instance_identity_hash is ?
           and tls_policy = ?
           and (
             (? = 1 and instance_generation = ? and config_generation = ?)
             or (? = 0 and updated_at = ?)
           )`,
      )
      .get(
        target.connectorId,
        target.baseUrl,
        target.insecureHttpApproved ? 1 : 0,
        target.instanceIdentityHash ?? null,
        target.tlsPolicy ?? "strict",
        generationAware ? 1 : 0,
        target.instanceGeneration ?? 0,
        target.configGeneration ?? 0,
        generationAware ? 1 : 0,
        target.updatedAt,
      );
    return Boolean(row);
  }

  public serverIdentityIsCurrent(target: JellyfinConnectorTarget, serverId: string) {
    if ((target.instanceIdentityHash ?? null) === null) return true;
    if (
      !this.#encryptionKey ||
      typeof serverId !== "string" ||
      serverId.length < 1 ||
      serverId.length > 256
    ) {
      return false;
    }
    return (
      createHmac("sha256", this.#encryptionKey)
        .update("omnifin:v1:connector-instance-identity\0", "utf8")
        .update(serverId, "utf8")
        .digest("base64url") === target.instanceIdentityHash
    );
  }

  public quickConnectIsAdvertisable() {
    const rows = this.#database.sqlite
      .prepare(
        `select
           json_extract(capability_snapshot_json, '$.authentication.quickConnect') as quickConnect,
           json_extract(capability_snapshot_json, '$.authentication.configGeneration') as capabilityGeneration,
           config_generation as configGeneration
         from connector_configs
         where type = 'jellyfin' and enabled = 1
         order by id asc
         limit 2`,
      )
      .all() as {
      capabilityGeneration: unknown;
      configGeneration: number;
      quickConnect: unknown;
    }[];
    if (rows.length !== 1) return false;
    const row = rows[0];
    return (
      row !== undefined &&
      row.quickConnect !== 0 &&
      (row.capabilityGeneration === null || row.capabilityGeneration === row.configGeneration)
    );
  }

  public recordQuickConnectCapability(target: JellyfinConnectorTarget, available: boolean) {
    const result = this.#database.sqlite
      .prepare(
        `update connector_configs
         set capability_snapshot_json = json_set(
           capability_snapshot_json,
           '$.schemaVersion', 1,
           '$.authentication.password', json('true'),
           '$.authentication.quickConnect', json(?),
           '$.authentication.configGeneration', ?
         ),
         updated_at = updated_at + 1
         where id = ?
           and type = 'jellyfin'
           and enabled = 1
           and base_url = ?
           and insecure_http_approved = ?
           and instance_generation = ?
           and config_generation = ?
           and updated_at = ?`,
      )
      .run(
        available ? "true" : "false",
        target.configGeneration ?? 0,
        target.connectorId,
        target.baseUrl,
        target.insecureHttpApproved ? 1 : 0,
        target.instanceGeneration ?? 0,
        target.configGeneration ?? 0,
        target.updatedAt,
      );
    if (result.changes !== 1) throw new JellyfinConnectorConfigurationError();
  }
}
