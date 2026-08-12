import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { EnvelopeCipher, constantTimeTextEqual, databaseKeyVerifier } from "../security/crypto.js";
import { StartupError } from "../startup-error.js";

export const RELEASED_V012_MIGRATION_COUNT = 32;

interface MigrationJournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface MigrationCatalogEntry extends MigrationJournalEntry {
  hash: string;
  sql: string;
}

export interface MigrationPreflightResult {
  appliedMigrationCount: number;
  catalog: readonly MigrationCatalogEntry[];
  databaseExists: boolean;
  hadSidecars: boolean;
  kind: "current" | "fresh" | "supported-prefix";
  migrationsPending: boolean;
}

export interface FileInspectionOptions {
  maxStagingBytes?: number;
  retainedCopyPath?: string;
  stagingDirectory?: string;
}

export interface FileInspectionDependencies {
  copyFile?: typeof copyFileSync;
}

const MAX_RECOVERY_STAGING_BYTES = 64 * 1024 * 1024 * 1024;

export function migrationDirectory() {
  const candidates = [
    path.resolve(import.meta.dirname, "../drizzle"),
    path.resolve(import.meta.dirname, "../../drizzle"),
    path.resolve(process.cwd(), "apps/gateway/drizzle"),
  ];
  const directory = candidates.find((candidate) => existsSync(candidate));
  if (!directory) throw new StartupError("database_migrations_missing");
  return directory;
}

export function readMigrationCatalog(): readonly MigrationCatalogEntry[] {
  try {
    const directory = migrationDirectory();
    const journal = JSON.parse(
      readFileSync(path.join(directory, "meta/_journal.json"), "utf8"),
    ) as { dialect?: unknown; entries?: MigrationJournalEntry[] };
    if (journal.dialect !== "sqlite" || !Array.isArray(journal.entries)) {
      throw new Error("invalid migration journal");
    }
    return journal.entries.map((entry, index) => {
      if (
        entry.idx !== index ||
        !Number.isSafeInteger(entry.when) ||
        (index > 0 && entry.when <= journal.entries![index - 1]!.when) ||
        typeof entry.tag !== "string" ||
        !/^\d{4}_[a-z0-9_]+$/u.test(entry.tag)
      ) {
        throw new Error("invalid migration catalog order");
      }
      const sql = readFileSync(path.join(directory, `${entry.tag}.sql`), "utf8");
      return {
        ...entry,
        hash: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    });
  } catch (error) {
    if (error instanceof StartupError) throw error;
    throw new StartupError("database_migrations_missing", { cause: error });
  }
}

function databaseHasNoApplicationSchema(sqlite: Database.Database) {
  const row = sqlite
    .prepare(
      `select count(*) as count from sqlite_schema
       where name not like 'sqlite_%'`,
    )
    .get() as { count: number };
  return row.count === 0;
}

function inspectMigrationRows(
  sqlite: Database.Database,
  catalog: readonly MigrationCatalogEntry[],
) {
  const migrationTable = sqlite
    .prepare(
      `select count(*) as count from sqlite_schema
       where type = 'table' and name = '__drizzle_migrations'`,
    )
    .get() as { count: number };
  if (migrationTable.count !== 1) {
    if (databaseHasNoApplicationSchema(sqlite)) return 0;
    throw new StartupError("database_schema_unsupported");
  }

  let rows: { createdAt: number; hash: string; sequence: number }[];
  try {
    rows = sqlite
      .prepare(
        `select rowid as sequence, hash, created_at as createdAt
         from __drizzle_migrations order by rowid`,
      )
      .all() as typeof rows;
  } catch (error) {
    throw new StartupError("database_migration_history_invalid", { cause: error });
  }

  const newestKnownTimestamp = catalog.at(-1)?.when;
  if (
    rows.length > catalog.length ||
    (newestKnownTimestamp !== undefined && rows.some((row) => row.createdAt > newestKnownTimestamp))
  ) {
    throw new StartupError("database_schema_newer");
  }
  if (rows.length < RELEASED_V012_MIGRATION_COUNT) {
    throw new StartupError("database_schema_unsupported");
  }
  for (let index = 0; index < rows.length; index += 1) {
    const actual = rows[index]!;
    const expected = catalog[index];
    if (
      !expected ||
      actual.sequence !== index + 1 ||
      actual.createdAt !== expected.when ||
      actual.hash !== expected.hash
    ) {
      throw new StartupError("database_migration_history_invalid");
    }
  }
  return rows.length;
}

function physicalSchemaDigest(sqlite: Database.Database) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        sqlite
          .prepare(
            `select name, sql, tbl_name as tableName, type
             from sqlite_schema
             where name not like 'sqlite_%' and name <> '__drizzle_migrations'
             order by type, name`,
          )
          .all(),
      ),
    )
    .digest("hex");
}

function validatePhysicalSchema(
  sqlite: Database.Database,
  catalog: readonly MigrationCatalogEntry[],
  appliedMigrationCount: number,
) {
  let expected: Database.Database | undefined;
  try {
    expected = new Database(":memory:");
    expected.pragma("foreign_keys = ON");
    expected.exec(`
      create table "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text not null,
        created_at numeric
      )
    `);
    const insertMigration = expected.prepare(
      `insert into "__drizzle_migrations" (hash, created_at) values (?, ?)`,
    );
    expected.transaction(() => {
      for (const migration of catalog.slice(0, appliedMigrationCount)) {
        for (const statement of migration.sql.split("--> statement-breakpoint")) {
          expected!.exec(statement);
        }
        insertMigration.run(migration.hash, migration.when);
      }
    })();
    if (physicalSchemaDigest(sqlite) !== physicalSchemaDigest(expected)) {
      throw new StartupError("database_schema_unsupported");
    }
  } catch (error) {
    if (error instanceof StartupError) throw error;
    throw new StartupError("database_schema_unsupported", { cause: error });
  } finally {
    expected?.close();
  }
}

function stagingRequirement(databasePath: string) {
  const mainBytes = statSync(databasePath).size;
  let sidecarBytes = 0;
  for (const suffix of ["-wal", "-shm"]) {
    const sidecarPath = `${databasePath}${suffix}`;
    if (!existsSync(sidecarPath)) continue;
    const metadata = lstatSync(sidecarPath);
    const processUserId = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      (processUserId !== undefined && metadata.uid !== processUserId)
    ) {
      throw new StartupError("database_recovery_staging_failed");
    }
    sidecarBytes += metadata.size;
  }
  return { mainBytes, requiredBytes: mainBytes + sidecarBytes * 2 };
}

/**
 * Opens a clean database read-only. Unclean WAL databases are recovered only in a bounded private
 * copy, leaving the original main/WAL/SHM timeline untouched.
 */
export function inspectDatabaseFile<T>(
  databasePath: string,
  options: FileInspectionOptions,
  inspect: (sqlite: Database.Database) => T,
  dependencies: FileInspectionDependencies = {},
) {
  const hadSidecars = existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`);
  let temporaryDirectory: string | undefined;
  let primaryError: unknown;
  try {
    const stagingDirectory = options.stagingDirectory ?? path.dirname(databasePath);
    const stagingMetadata = statSync(stagingDirectory);
    const processUserId = process.getuid?.();
    if (
      !stagingMetadata.isDirectory() ||
      (stagingMetadata.mode & 0o077) !== 0 ||
      (processUserId !== undefined && stagingMetadata.uid !== processUserId)
    ) {
      throw new StartupError("database_recovery_staging_failed");
    }
    const { requiredBytes } = stagingRequirement(databasePath);
    const maximum = options.maxStagingBytes ?? MAX_RECOVERY_STAGING_BYTES;
    const filesystem = statfsSync(stagingDirectory, { bigint: true });
    const availableBytes = filesystem.bavail * filesystem.bsize;
    if (
      !Number.isSafeInteger(requiredBytes) ||
      requiredBytes < 0 ||
      requiredBytes > maximum ||
      BigInt(requiredBytes) > availableBytes
    ) {
      throw new StartupError("database_recovery_staging_insufficient");
    }
    temporaryDirectory = mkdtempSync(path.join(stagingDirectory, ".omnifin-inspect-"));
    chmodSync(temporaryDirectory, 0o700);
    const inspectionPath = path.join(temporaryDirectory, "database.sqlite");
    const copy = dependencies.copyFile ?? copyFileSync;
    copy(databasePath, inspectionPath, constants.COPYFILE_EXCL);
    chmodSync(inspectionPath, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${databasePath}${suffix}`;
      if (!existsSync(source)) continue;
      copy(source, `${inspectionPath}${suffix}`, constants.COPYFILE_EXCL);
      chmodSync(`${inspectionPath}${suffix}`, 0o600);
    }
    if (hadSidecars) {
      const recovery = new Database(inspectionPath, { fileMustExist: true });
      try {
        recovery.pragma("busy_timeout = 0");
        recovery.pragma("wal_checkpoint(TRUNCATE)");
        recovery.pragma("journal_mode = DELETE");
      } finally {
        recovery.close();
      }
    }

    const sqlite = new Database(inspectionPath, { fileMustExist: true, readonly: true });
    let result: T;
    try {
      sqlite.pragma("query_only = ON");
      result = inspect(sqlite);
    } finally {
      sqlite.close();
    }
    if (options.retainedCopyPath) {
      const retainedCopyPath = path.resolve(options.retainedCopyPath);
      if (
        path.dirname(retainedCopyPath) !== path.resolve(stagingDirectory) ||
        existsSync(retainedCopyPath)
      ) {
        throw new StartupError("database_recovery_staging_failed");
      }
      renameSync(inspectionPath, retainedCopyPath);
      chmodSync(retainedCopyPath, 0o600);
    }
    return { hadSidecars, result };
  } catch (error) {
    primaryError = error;
    if (error instanceof StartupError) throw error;
    throw new StartupError("database_recovery_staging_failed", { cause: error });
  } finally {
    if (temporaryDirectory) {
      try {
        rmSync(temporaryDirectory, { force: true, recursive: true });
      } catch (cleanupError) {
        if (!primaryError) {
          throw new StartupError("database_recovery_staging_failed", { cause: cleanupError });
        }
      }
    }
  }
}

interface EncryptedSample {
  context: (row: Record<string, string | null>) => string;
  orderBy: string;
  select: string;
  table: string;
}

const ENCRYPTED_SAMPLES: readonly EncryptedSample[] = [
  {
    table: "jellyfin_activation_operations",
    select: "id, artifact_revision as artifactRevision, encrypted_stage_artifact as encryptedValue",
    orderBy: "id",
    context: ({ id, artifactRevision }) =>
      `omnifin:v1:jellyfin-activation:${id}:artifact:${artifactRevision}`,
  },
  {
    table: "oidc_providers",
    select: "id, encrypted_client_secret as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `omnifin:v1:oidc-provider:${id}:client-secret`,
  },
  {
    table: "connector_configs",
    select: "id, type, encrypted_credentials as encryptedValue",
    orderBy: "id",
    context: ({ id, type }) => `connector_credentials:${type}:${id}`,
  },
  {
    table: "service_identity_links",
    select: "id, encrypted_access_token as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `service_identity_access_token:jellyfin:${id}`,
  },
  {
    table: "media_references",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `media_reference:jellyfin:${id}`,
  },
  {
    table: "discovery_artwork_references",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `discovery_artwork_reference:${id}`,
  },
  {
    table: "playback_sessions",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `playback_session:jellyfin:${id}`,
  },
  {
    table: "playback_asset_handles",
    select: "id, playback_session_id as sessionId, encrypted_target as encryptedValue",
    orderBy: "id",
    context: ({ id, sessionId }) => `playback_asset_handle:jellyfin:${sessionId}:${id}`,
  },
  {
    table: "media_issues",
    select: "id, encrypted_description as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `media_issue_description:${id}`,
  },
  {
    table: "media_issues",
    select: "id, encrypted_resolution as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `media_issue_resolution:${id}`,
  },
  {
    table: "external_issue_references",
    select: "id, encrypted_upstream_id as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `external_issue_reference:seerr:${id}`,
  },
  {
    table: "subtitle_searches",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `subtitle_search:${id}`,
  },
  {
    table: "library_artwork_searches",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `library_artwork_search:${id}`,
  },
  {
    table: "library_removal_previews",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `library_removal_preview:${id}`,
  },
  {
    table: "library_removal_operations",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `library_removal_operation:${id}`,
  },
  {
    table: "saved_lists",
    select: "id, user_id as userId, encrypted_name as encryptedValue",
    orderBy: "id",
    context: ({ id, userId }) => `saved_list_name:${userId}:${id}`,
  },
  {
    table: "saved_lists",
    select: "id, user_id as userId, encrypted_description as encryptedValue",
    orderBy: "id",
    context: ({ id, userId }) => `saved_list_description:${userId}:${id}`,
  },
  {
    table: "saved_catalog_items",
    select: "id, user_id as userId, encrypted_identity as encryptedValue",
    orderBy: "id",
    context: ({ id, userId }) => `saved_catalog_identity_payload:${userId}:${id}`,
  },
  {
    table: "saved_catalog_items",
    select: "id, user_id as userId, encrypted_snapshot as encryptedValue",
    orderBy: "id",
    context: ({ id, userId }) => `saved_catalog_snapshot:${userId}:${id}`,
  },
  {
    table: "saved_targets",
    select: "id, user_id as userId, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id, userId }) => `saved_target_payload:${userId}:${id}`,
  },
  {
    table: "saved_list_operations",
    select: "id, user_id as userId, encrypted_response as encryptedValue",
    orderBy: "id",
    context: ({ id, userId }) => `saved_list_operation:${userId}:${id}`,
  },
  {
    table: "sessions",
    select: "id, encrypted_id_token_hint as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `session:${id}:oidc-id-token-hint`,
  },
  {
    table: "sessions",
    select: "id, encrypted_csrf_token as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `session:${id}:csrf`,
  },
  {
    table: "media_download_grants",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `media_download_grant:jellyfin:${id}`,
  },
  {
    table: "auth_transactions",
    select: "id, encrypted_code_verifier as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `oidc-transaction:${id}:code-verifier`,
  },
  {
    table: "auth_transactions",
    select: "id, encrypted_nonce as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `oidc-transaction:${id}:nonce`,
  },
  {
    table: "jellyfin_quick_connect_transactions",
    select: "id, encrypted_payload as encryptedValue",
    orderBy: "id",
    context: ({ id }) => `jellyfin-quick-connect:${id}:payload`,
  },
  {
    table: "jellyfin_provisioning_configs",
    select:
      "connector_id as connectorId, connector_revision as connectorRevision, connector_instance_generation as instanceGeneration, connector_instance_identity_hash as instanceIdentityHash, encrypted_configuration as encryptedValue",
    orderBy: "connector_id",
    context: ({ connectorId, connectorRevision, instanceGeneration, instanceIdentityHash }) =>
      `jellyfin_provisioning:${connectorId}:${connectorRevision}:${instanceGeneration}:${instanceIdentityHash ?? "none"}`,
  },
  {
    table: "external_mutation_dispatches",
    select: "id, kind, encrypted_normalized_request as encryptedValue",
    orderBy: "id",
    context: ({ id, kind }) => `omnifin:v1:external-mutation:${kind}:${id}:normalized-request`,
  },
];

function encryptedSampleColumn(sample: EncryptedSample) {
  const column = /([a-z_]+) as encryptedValue/u.exec(sample.select)?.[1];
  if (!column) throw new Error("invalid encrypted sample catalog");
  return column;
}

export function assertLegacyEncryptedSamples(sqlite: Database.Database, rootKey: Buffer) {
  const cipher = new EnvelopeCipher(rootKey);
  try {
    for (const sample of ENCRYPTED_SAMPLES) {
      const tableExists = sqlite
        .prepare("select 1 from sqlite_schema where type = 'table' and name = ?")
        .get(sample.table);
      if (!tableExists) continue;
      const encryptedColumn = encryptedSampleColumn(sample);
      const row = sqlite
        .prepare(
          `select ${sample.select} from ${sample.table}
           where ${encryptedColumn} is not null order by ${sample.orderBy} limit 1`,
        )
        .get() as (Record<string, string> & { encryptedValue: string }) | undefined;
      if (row) cipher.decrypt(row.encryptedValue, sample.context(row));
    }
  } catch (error) {
    throw new StartupError("database_encryption_key_mismatch", { cause: error });
  }
}

export function encryptedSampleColumns() {
  return ENCRYPTED_SAMPLES.map((sample) => {
    return `${sample.table}.${encryptedSampleColumn(sample)}`;
  }).sort();
}

export function legacyEncryptedSampleFixtures() {
  return ENCRYPTED_SAMPLES.map((sample, index) => {
    const row = {
      connectorId: "encrypted-sample-connector",
      connectorRevision: "encrypted-sample-revision",
      instanceGeneration: "0",
      instanceIdentityHash: null,
      artifactRevision: "1",
      id: `encrypted-sample-${index.toString().padStart(2, "0")}`,
      kind: "playback.progress",
      sessionId: "encrypted-sample-session",
      type: "jellyfin",
      userId: "encrypted-sample-user",
    };
    return {
      column: encryptedSampleColumn(sample),
      context: sample.context(row),
      id: row.id,
      table: sample.table,
    };
  });
}

function validateCurrentKeyVerifier(sqlite: Database.Database, rootKey: Buffer) {
  let rows: { formatVersion: number; id: number; verifier: string }[];
  try {
    rows = sqlite
      .prepare(
        `select id, format_version as formatVersion, verifier
         from database_key_verifiers`,
      )
      .all() as typeof rows;
  } catch (error) {
    throw new StartupError("database_key_verifier_invalid", { cause: error });
  }
  if (rows.length === 0) return false;
  if (
    rows.length !== 1 ||
    rows[0]?.id !== 1 ||
    rows[0].formatVersion !== 1 ||
    !constantTimeTextEqual(rows[0].verifier, databaseKeyVerifier(rootKey))
  ) {
    throw new StartupError("database_encryption_key_mismatch");
  }
  return true;
}

export function preflightDatabase(
  databaseUrl: string,
  rootKey: Buffer,
  options: FileInspectionOptions = {},
  dependencies: FileInspectionDependencies = {},
): MigrationPreflightResult {
  const catalog = readMigrationCatalog();
  if (
    catalog.length < RELEASED_V012_MIGRATION_COUNT ||
    catalog[RELEASED_V012_MIGRATION_COUNT - 1]?.tag !== "0031_playback_preferences"
  ) {
    throw new StartupError("database_migrations_missing");
  }
  const fresh = (databaseExists: boolean): MigrationPreflightResult => ({
    appliedMigrationCount: 0,
    catalog,
    databaseExists,
    hadSidecars: false,
    kind: "fresh",
    migrationsPending: true,
  });
  if (databaseUrl === ":memory:") return fresh(false);
  const databasePath = path.resolve(databaseUrl);
  if (!existsSync(databasePath)) return fresh(false);
  const metadata = lstatSync(databasePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new StartupError("database_schema_unsupported");
  }

  try {
    const inspected = inspectDatabaseFile(
      databasePath,
      options,
      (sqlite) => {
        const appliedMigrationCount = inspectMigrationRows(sqlite, catalog);
        if (appliedMigrationCount === 0) return appliedMigrationCount;
        validatePhysicalSchema(sqlite, catalog, appliedMigrationCount);
        const verifierMigrationCount =
          catalog.findIndex(({ tag }) => tag === "0032_database_key_verifier") + 1;
        if (
          verifierMigrationCount <= 0 ||
          appliedMigrationCount < verifierMigrationCount ||
          !validateCurrentKeyVerifier(sqlite, rootKey)
        ) {
          assertLegacyEncryptedSamples(sqlite, rootKey);
        }
        return appliedMigrationCount;
      },
      dependencies,
    );
    const appliedMigrationCount = inspected.result;
    return {
      appliedMigrationCount,
      catalog,
      databaseExists: true,
      hadSidecars: inspected.hadSidecars,
      kind:
        appliedMigrationCount === 0
          ? "fresh"
          : appliedMigrationCount === catalog.length
            ? "current"
            : "supported-prefix",
      migrationsPending: appliedMigrationCount < catalog.length,
    };
  } catch (error) {
    if (error instanceof StartupError) throw error;
    throw new StartupError("database_schema_unsupported", { cause: error });
  }
}

export function assertCurrentMigrationCatalog(sqlite: Database.Database) {
  const catalog = readMigrationCatalog();
  if (inspectMigrationRows(sqlite, catalog) !== catalog.length) {
    throw new StartupError("database_schema_validation_failed");
  }
}
