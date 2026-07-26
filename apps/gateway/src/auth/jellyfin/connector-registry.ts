import { randomUUID } from "node:crypto";

import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { EnvelopeCipher } from "../../security/crypto.js";

const ENVIRONMENT_CONNECTOR_ID = "jellyfin";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface JellyfinConnectorRow {
  baseUrl: string;
  displayName: string;
  enabled: number;
  id: string;
  insecureHttpApproved: number;
  type: string;
  updatedAt: number;
}

export interface JellyfinConnectorTarget {
  readonly baseUrl: string;
  readonly connectorId: string;
  readonly displayName: string;
  readonly insecureHttpApproved: boolean;
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
    "{}",
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

  public constructor(database: DatabaseHandle) {
    this.#database = database;
  }

  public resolve(): JellyfinConnectorTarget {
    const rows = this.#database.sqlite
      .prepare(
        `select
          id,
          type,
          display_name as displayName,
          base_url as baseUrl,
          insecure_http_approved as insecureHttpApproved,
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
      !Number.isSafeInteger(row.updatedAt) ||
      row.updatedAt < 0
    ) {
      throw new JellyfinConnectorConfigurationError();
    }
    return Object.freeze({
      baseUrl: row.baseUrl,
      connectorId: row.id,
      displayName: row.displayName,
      insecureHttpApproved: row.insecureHttpApproved === 1,
      updatedAt: row.updatedAt,
    });
  }

  public bindingIsCurrent(target: JellyfinConnectorTarget) {
    const row = this.#database.sqlite
      .prepare(
        `select 1
         from connector_configs
         where id = ?
           and type = 'jellyfin'
           and enabled = 1
           and base_url = ?
           and insecure_http_approved = ?
           and updated_at = ?`,
      )
      .get(
        target.connectorId,
        target.baseUrl,
        target.insecureHttpApproved ? 1 : 0,
        target.updatedAt,
      );
    return Boolean(row);
  }

  public quickConnectIsAdvertisable() {
    const rows = this.#database.sqlite
      .prepare(
        `select json_extract(capability_snapshot_json, '$.authentication.quickConnect') as quickConnect
         from connector_configs
         where type = 'jellyfin' and enabled = 1
         order by id asc
         limit 2`,
      )
      .all() as { quickConnect: unknown }[];
    if (rows.length !== 1) return false;
    return rows[0]?.quickConnect !== 0;
  }

  public recordQuickConnectCapability(target: JellyfinConnectorTarget, available: boolean) {
    const result = this.#database.sqlite
      .prepare(
        `update connector_configs
         set capability_snapshot_json = json_set(
           capability_snapshot_json,
           '$.schemaVersion', 1,
           '$.authentication.password', json('true'),
           '$.authentication.quickConnect', json(?)
         )
         where id = ?
           and type = 'jellyfin'
           and enabled = 1
           and base_url = ?
           and insecure_http_approved = ?
           and updated_at = ?`,
      )
      .run(
        available ? "true" : "false",
        target.connectorId,
        target.baseUrl,
        target.insecureHttpApproved ? 1 : 0,
        target.updatedAt,
      );
    if (result.changes !== 1) throw new JellyfinConnectorConfigurationError();
  }
}
