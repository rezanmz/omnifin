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

    process.stdout.write(`Migration smoke passed with ${names.size} application tables.\n`);
  } finally {
    database.close();
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
