import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { databaseMaintenanceLockPath } from "./maintenance-lock.js";
import { asStartupError, StartupError } from "../startup-error.js";
import { constantTimeTextEqual, databaseKeyVerifier } from "../security/crypto.js";
import { createRetainedDatabaseBackup } from "./maintenance.js";
import {
  assertCurrentMigrationCatalog,
  migrationDirectory,
  preflightDatabase,
} from "./migration-preflight.js";

export interface DatabaseHandle {
  close: () => void;
  db: BetterSQLite3Database<typeof schema>;
  migrate: () => void;
  sqlite: Database.Database;
}

function ensureParentDirectory(databaseUrl: string) {
  if (databaseUrl === ":memory:") return;
  const parent = path.dirname(path.resolve(databaseUrl));
  let metadata: ReturnType<typeof statSync>;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    metadata = statSync(parent);
  } catch (error) {
    throw new StartupError("database_directory_unavailable", { cause: error });
  }
  const processUserId = process.getuid?.();
  if (processUserId !== undefined && metadata.uid !== processUserId) {
    throw new StartupError("database_directory_owner_invalid");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new StartupError("database_directory_permissions_invalid");
  }
}

function restrictDatabaseFiles(databaseUrl: string) {
  if (databaseUrl === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${path.resolve(databaseUrl)}${suffix}`;
    if (!existsSync(filename)) continue;
    try {
      chmodSync(filename, 0o600);
    } catch (error) {
      throw new StartupError("database_file_permissions_failed", { cause: error });
    }
  }
}

export function openDatabase(databaseUrl: string): DatabaseHandle {
  ensureParentDirectory(databaseUrl);
  if (databaseUrl !== ":memory:" && existsSync(databaseMaintenanceLockPath(databaseUrl))) {
    throw new StartupError("database_maintenance_active");
  }
  let sqlite: Database.Database;
  try {
    sqlite = new Database(databaseUrl);
  } catch (error) {
    throw new StartupError("database_open_failed", { cause: error });
  }
  try {
    restrictDatabaseFiles(databaseUrl);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    if (databaseUrl !== ":memory:") {
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = FULL");
      restrictDatabaseFiles(databaseUrl);
    }

    const db = drizzle(sqlite, { schema });
    return {
      close: () => {
        sqlite.close();
        restrictDatabaseFiles(databaseUrl);
      },
      db,
      migrate: () => {
        try {
          migrate(db, { migrationsFolder: migrationDirectory() });
        } catch (error) {
          throw asStartupError(error, "database_migration_failed");
        }
      },
      sqlite,
    };
  } catch (initializationError) {
    const startupError = asStartupError(initializationError, "database_initialization_failed");
    try {
      sqlite.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Database initialization failed and cleanup did not complete.",
      );
    }
    throw startupError;
  }
}

export interface InitializeDatabaseOptions {
  backupDirectory: string;
  backupRetentionCount: number;
  databaseUrl: string;
  imageReference?: string;
  rootKey: Buffer;
}

interface InitializeDatabaseDependencies {
  afterMigration?: (database: DatabaseHandle) => Promise<void> | void;
  afterPreflight?: () => Promise<void> | void;
  beforeRecoveryBackupPublish?: () => Promise<void> | void;
  beforeMigration?: (database: DatabaseHandle) => Promise<void> | void;
}

function assertMaintenanceInactive(databaseUrl: string) {
  if (databaseUrl !== ":memory:" && existsSync(databaseMaintenanceLockPath(databaseUrl))) {
    throw new StartupError("database_maintenance_active");
  }
}

export function initializeDatabaseKeyVerifier(sqlite: Database.Database, rootKey: Buffer) {
  const expected = databaseKeyVerifier(rootKey);
  try {
    sqlite.transaction(() => {
      const rows = sqlite
        .prepare(
          `select id, format_version as formatVersion, verifier
           from database_key_verifiers`,
        )
        .all() as { formatVersion: number; id: number; verifier: string }[];
      if (rows.length === 0) {
        sqlite
          .prepare(
            `insert into database_key_verifiers (id, format_version, verifier)
             values (1, 1, ?)`,
          )
          .run(expected);
        return;
      }
      if (
        rows.length !== 1 ||
        rows[0]?.id !== 1 ||
        rows[0].formatVersion !== 1 ||
        !constantTimeTextEqual(rows[0].verifier, expected)
      ) {
        throw new StartupError("database_encryption_key_mismatch");
      }
    })();
  } catch (error) {
    throw asStartupError(error, "database_key_verifier_invalid");
  }
}

export function assertDatabasePostMigrationChecks(sqlite: Database.Database, rootKey: Buffer) {
  const integrityRows = sqlite.pragma("integrity_check") as Record<string, unknown>[];
  if (
    integrityRows.length !== 1 ||
    Object.values(integrityRows[0] ?? {}).length !== 1 ||
    Object.values(integrityRows[0] ?? {})[0] !== "ok"
  ) {
    throw new StartupError("database_integrity_check_failed");
  }
  if ((sqlite.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new StartupError("database_foreign_key_check_failed");
  }
  assertCurrentMigrationCatalog(sqlite);
  let expected: Database.Database | undefined;
  try {
    expected = new Database(":memory:");
    migrate(drizzle(expected), { migrationsFolder: migrationDirectory() });
    const schemaDigest = (database: Database.Database) =>
      createHash("sha256")
        .update(
          JSON.stringify(
            database
              .prepare(
                `select name, sql, tbl_name as tableName, type
                 from sqlite_schema where name not like 'sqlite_%'
                 order by type, name`,
              )
              .all(),
          ),
        )
        .digest("hex");
    if (schemaDigest(sqlite) !== schemaDigest(expected)) {
      throw new StartupError("database_schema_validation_failed");
    }
  } catch (error) {
    throw asStartupError(error, "database_schema_validation_failed");
  } finally {
    expected?.close();
  }
  const verifier = sqlite
    .prepare(
      `select verifier from database_key_verifiers
       where id = 1 and format_version = 1`,
    )
    .get() as { verifier: string } | undefined;
  if (!verifier || !constantTimeTextEqual(verifier.verifier, databaseKeyVerifier(rootKey))) {
    throw new StartupError("database_key_verifier_invalid");
  }
}

/**
 * Performs the complete fail-closed startup storage sequence before returning a writable handle.
 */
export async function initializeDatabase(
  options: InitializeDatabaseOptions,
  dependencies: InitializeDatabaseDependencies = {},
): Promise<DatabaseHandle> {
  // Maintenance exclusion is deliberately first: no preflight staging or source/backup mutation may
  // race an offline maintenance operation.
  assertMaintenanceInactive(options.databaseUrl);
  const retainedCopyPath = path.join(
    path.resolve(options.backupDirectory),
    `.omnifin-preflight-${randomUUID()}.sqlite`,
  );
  let preflight: ReturnType<typeof preflightDatabase>;
  try {
    preflight = preflightDatabase(options.databaseUrl, options.rootKey, {
      retainedCopyPath,
      stagingDirectory: options.backupDirectory,
    });
    await dependencies.afterPreflight?.();
    assertMaintenanceInactive(options.databaseUrl);

    if (preflight.databaseExists && (preflight.migrationsPending || preflight.hadSidecars)) {
      await createRetainedDatabaseBackup(
        {
          backupDirectory: options.backupDirectory,
          cleanupGeneratedSourceSidecars: true,
          databasePath: retainedCopyPath,
          retentionCount: options.backupRetentionCount,
          ...(options.imageReference ? { imageReference: options.imageReference } : {}),
        },
        {
          beforeBackupPublish: async () => {
            await dependencies.beforeRecoveryBackupPublish?.();
            assertMaintenanceInactive(options.databaseUrl);
          },
        },
      );
    }
  } catch (error) {
    throw asStartupError(error, "database_recovery_backup_failed");
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${retainedCopyPath}${suffix}`, { force: true });
    }
  }

  assertMaintenanceInactive(options.databaseUrl);
  const database = openDatabase(options.databaseUrl);
  try {
    await dependencies.beforeMigration?.(database);
    database.migrate();
    await dependencies.afterMigration?.(database);
    initializeDatabaseKeyVerifier(database.sqlite, options.rootKey);
    assertDatabasePostMigrationChecks(database.sqlite, options.rootKey);
    return database;
  } catch (error) {
    const failure = asStartupError(error, "database_initialization_failed");
    try {
      database.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, cleanupError],
        "Database startup failed and cleanup did not complete.",
      );
    }
    throw failure;
  }
}
