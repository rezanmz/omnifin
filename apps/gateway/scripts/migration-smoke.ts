import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/client.js";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "omnifin-migration-"));
const databasePath = path.join(temporaryDirectory, "smoke.db");
const requiredTables = [
  "audit_events",
  "auth_transactions",
  "connector_configs",
  "external_identities",
  "oidc_providers",
  "operational_failures",
  "role_mappings",
  "service_identity_links",
  "sessions",
  "users",
] as const;
const requiredColumns = {
  audit_events: ["actor_auth_method", "actor_session_id", "request_id"],
  auth_transactions: ["browser_binding_hash", "redirect_uri"],
  service_identity_links: [
    "connector_id",
    "device_id",
    "encrypted_access_token",
    "external_display_name",
    "external_server_id",
    "revision",
    "revoked_at",
    "token_created_at",
  ],
  sessions: [
    "encrypted_csrf_token",
    "encrypted_id_token_hint",
    "last_rotated_at",
    "service_identity_link_id",
  ],
  users: ["role_source"],
} as const;
const requiredIndexes = {
  audit_events: ["audit_events_actor_session_idx", "audit_events_request_idx"],
  connector_configs: ["connector_configs_id_type_unique"],
  service_identity_links: ["service_identity_links_connector_idx"],
} as const;

try {
  const database = openDatabase(databasePath);
  try {
    database.migrate();
    database.migrate();
    const tables = database.sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle_%'",
      )
      .all() as { name: string }[];
    const names = new Set(tables.map(({ name }) => name));
    const missing = requiredTables.filter((required) => !names.has(required));
    const unexpected = [...names].filter(
      (name) => !requiredTables.includes(name as (typeof requiredTables)[number]),
    );

    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Migration table set mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
      );
    }

    for (const [table, columns] of Object.entries(requiredColumns)) {
      const availableColumns = new Set(
        (
          database.sqlite.pragma(`table_info(${table})`) as {
            name: string;
          }[]
        ).map(({ name }) => name),
      );
      const missingColumns = columns.filter((column) => !availableColumns.has(column));
      if (missingColumns.length > 0) {
        throw new Error(`Migration columns missing from ${table}: ${missingColumns.join(", ")}.`);
      }
    }

    for (const [table, indexes] of Object.entries(requiredIndexes)) {
      const availableIndexes = new Set(
        (
          database.sqlite.pragma(`index_list(${table})`) as {
            name: string;
          }[]
        ).map(({ name }) => name),
      );
      const missingIndexes = indexes.filter((indexName) => !availableIndexes.has(indexName));
      if (missingIndexes.length > 0) {
        throw new Error(`Migration indexes missing from ${table}: ${missingIndexes.join(", ")}.`);
      }
    }

    const serviceLinkForeignKeys = database.sqlite.pragma(
      "foreign_key_list(service_identity_links)",
    ) as {
      from: string;
      id: number;
      seq: number;
      table: string;
      to: string;
    }[];
    const connectorForeignKeyId = serviceLinkForeignKeys.find(
      ({ from, table }) => from === "connector_id" && table === "connector_configs",
    )?.id;
    const connectorForeignKeyColumns = serviceLinkForeignKeys
      .filter(({ id }) => id === connectorForeignKeyId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ from, to }) => `${from}:${to}`);
    if (connectorForeignKeyColumns.join(",") !== "connector_id:id,service:type") {
      throw new Error(
        "Migration is missing the connector type-bound service identity foreign key.",
      );
    }

    const foreignKeyViolations = database.sqlite.pragma("foreign_key_check") as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(`Migration left ${foreignKeyViolations.length} foreign-key violations.`);
    }

    process.stdout.write(
      `Migration smoke passed with ${names.size} application tables and hardened authentication invariants.\n`,
    );
  } finally {
    database.close();
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
