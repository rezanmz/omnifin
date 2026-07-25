import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { startupFailureDetails } from "../src/startup-error.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("database file permissions", () => {
  it("restricts SQLite database, WAL, and shared-memory files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-database-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "omnifin.db");
    const database = openDatabase(databasePath);

    database.sqlite.exec("CREATE TABLE permission_probe (id INTEGER PRIMARY KEY)");
    expect(database.sqlite.pragma("synchronous", { simple: true })).toBe(2);
    for (const filename of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      expect(statSync(filename).mode & 0o777).toBe(0o600);
    }
    database.close();
  });

  it("rejects a database directory exposed to group or other users", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-database-"));
    temporaryDirectories.push(directory);
    const exposedDirectory = path.join(directory, "exposed");
    mkdirSync(exposedDirectory, { mode: 0o755 });
    chmodSync(exposedDirectory, 0o755);

    let failure: unknown;
    try {
      openDatabase(path.join(exposedDirectory, "omnifin.db"));
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).toMatch(/must not be accessible/);
    expect(startupFailureDetails(failure)).toEqual({
      category: "database",
      code: "database_directory_permissions_invalid",
    });
  });
});
