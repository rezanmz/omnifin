import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { asStartupError, StartupError } from "../startup-error.js";

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

function migrationDirectory() {
  const candidates = [
    path.resolve(import.meta.dirname, "../drizzle"),
    path.resolve(import.meta.dirname, "../../drizzle"),
    path.resolve(process.cwd(), "apps/gateway/drizzle"),
  ];
  const directory = candidates.find((candidate) => existsSync(candidate));
  if (!directory) throw new StartupError("database_migrations_missing");
  return directory;
}

export function openDatabase(databaseUrl: string): DatabaseHandle {
  ensureParentDirectory(databaseUrl);
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
