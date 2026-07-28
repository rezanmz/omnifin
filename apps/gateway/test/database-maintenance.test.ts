import Database from "better-sqlite3";
import { createServer } from "node:http";
import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDatabaseMaintenanceLock,
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "../src/db/maintenance.js";
import { openDatabase } from "../src/db/client.js";
import { databaseMaintenanceLockPath } from "../src/db/maintenance-lock.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixtureDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-backup-test-"));
  cleanupDirectories.push(directory);
  return directory;
}

function writeMarker(databasePath: string, marker: string) {
  const database = openDatabase(databasePath);
  try {
    database.migrate();
    database.sqlite.exec(
      "create table if not exists maintenance_fixture (id integer primary key, marker text not null)",
    );
    database.sqlite
      .prepare(
        "insert into maintenance_fixture (id, marker) values (1, ?) on conflict(id) do update set marker = excluded.marker",
      )
      .run(marker);
  } finally {
    database.close();
  }
}

function readMarker(databasePath: string) {
  const database = new Database(databasePath, { fileMustExist: true, readonly: true });
  try {
    return (
      database.prepare("select marker from maintenance_fixture where id = 1").get() as {
        marker: string;
      }
    ).marker;
  } finally {
    database.close();
  }
}

describe("database backup maintenance", () => {
  it("creates and independently verifies a private, consistent backup", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const backupPath = path.join(directory, "checkpoint.sqlite");
    writeMarker(databasePath, "selected checkpoint");

    const result = await createDatabaseBackup({
      databasePath,
      imageReference: "ghcr.io/rezanmz/omnifin@sha256:fixture",
      now: new Date("2026-07-28T12:00:00.000Z"),
      outputPath: backupPath,
    });

    expect(result).toMatchObject({
      fileName: "checkpoint.sqlite",
      manifestFileName: "checkpoint.sqlite.manifest.json",
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.databaseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readMarker(backupPath)).toBe("selected checkpoint");
    await expect(verifyDatabaseBackup({ backupPath })).resolves.toEqual(result);

    const manifest = await readFile(`${backupPath}.manifest.json`, "utf8");
    expect(manifest).toContain('"format": "omnifin-sqlite-backup"');
    expect(manifest).toContain('"formatVersion": 1');
    expect(manifest).not.toContain(directory);
    expect(manifest).not.toContain(databasePath);
  });

  it("never overwrites an existing backup or manifest", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const backupPath = path.join(directory, "checkpoint.sqlite");
    writeMarker(databasePath, "source");
    await writeFile(backupPath, "reserved", { mode: 0o600 });

    await expect(
      createDatabaseBackup({ databasePath, outputPath: backupPath }),
    ).rejects.toMatchObject({ code: "backup_already_exists" });
    expect(await readFile(backupPath, "utf8")).toBe("reserved");
  });

  it("rejects writable backup directories and tampered backup bytes", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const backupPath = path.join(directory, "checkpoint.sqlite");
    writeMarker(databasePath, "source");
    await chmod(directory, 0o755);

    await expect(
      createDatabaseBackup({ databasePath, outputPath: backupPath }),
    ).rejects.toMatchObject({ code: "backup_directory_insecure" });

    await chmod(directory, 0o700);
    await createDatabaseBackup({ databasePath, outputPath: backupPath });
    await writeFile(backupPath, Buffer.from("tampered"), { flag: "a" });
    await expect(verifyDatabaseBackup({ backupPath })).rejects.toMatchObject({
      code: "backup_mismatch",
    });
  });
});

describe("database restore maintenance", () => {
  it("restores a verified checkpoint and preserves the replaced database as a verified rollback", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const backupPath = path.join(directory, "selected.sqlite");
    const rollbackOutputPath = path.join(directory, "pre-restore.sqlite");
    writeMarker(databasePath, "selected checkpoint");
    const selected = await createDatabaseBackup({ databasePath, outputPath: backupPath });
    writeMarker(databasePath, "state before restore");

    const restored = await restoreDatabaseBackup({
      backupPath,
      confirmedGatewayStopped: true,
      databasePath,
      rollbackOutputPath,
    });

    expect(restored.databaseSha256).toBe(selected.databaseSha256);
    expect(restored.restoredFileName).toBe("omnifin.db");
    expect(readMarker(databasePath)).toBe("selected checkpoint");
    expect(readMarker(rollbackOutputPath)).toBe("state before restore");
    await expect(verifyDatabaseBackup({ backupPath: rollbackOutputPath })).resolves.toEqual(
      restored.rollback,
    );
  });

  it("requires an explicit stopped-gateway confirmation", async () => {
    const directory = await fixtureDirectory();
    await expect(
      restoreDatabaseBackup({
        backupPath: path.join(directory, "selected.sqlite"),
        confirmedGatewayStopped: false,
        databasePath: path.join(directory, "omnifin.db"),
        rollbackOutputPath: path.join(directory, "pre-restore.sqlite"),
      }),
    ).rejects.toMatchObject({ code: "restore_confirmation_required" });
  });

  it("rejects a tampered checkpoint before replacing the active database", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const backupPath = path.join(directory, "selected.sqlite");
    const rollbackOutputPath = path.join(directory, "pre-restore.sqlite");
    writeMarker(databasePath, "selected checkpoint");
    await createDatabaseBackup({ databasePath, outputPath: backupPath });
    writeMarker(databasePath, "active state");
    await writeFile(backupPath, Buffer.from("tampered"), { flag: "a" });

    await expect(
      restoreDatabaseBackup({
        backupPath,
        confirmedGatewayStopped: true,
        databasePath,
        rollbackOutputPath,
      }),
    ).rejects.toMatchObject({ code: "backup_mismatch" });
    expect(readMarker(databasePath)).toBe("active state");
    await expect(lstat(rollbackOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses restoration whenever the configured gateway endpoint responds", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"status":"unavailable"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server address missing");

    try {
      const directory = await fixtureDirectory();
      await expect(
        restoreDatabaseBackup({
          backupPath: path.join(directory, "selected.sqlite"),
          confirmedGatewayStopped: true,
          databasePath: path.join(directory, "omnifin.db"),
          gatewayHealthUrl: `http://127.0.0.1:${address.port}/healthz`,
          rollbackOutputPath: path.join(directory, "pre-restore.sqlite"),
        }),
      ).rejects.toMatchObject({ code: "gateway_still_running" });
      await expect(
        lstat(databaseMaintenanceLockPath(path.join(directory, "omnifin.db"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("clears only a private stale maintenance lock after an explicit stopped-gateway confirmation", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const lockPath = databaseMaintenanceLockPath(databasePath);
    await writeFile(lockPath, "", { mode: 0o600 });

    await expect(
      clearDatabaseMaintenanceLock({
        confirmedGatewayStopped: false,
        databasePath,
      }),
    ).rejects.toMatchObject({ code: "restore_confirmation_required" });
    await expect(lstat(lockPath)).resolves.toMatchObject({ mode: expect.any(Number) });

    await expect(
      clearDatabaseMaintenanceLock({
        confirmedGatewayStopped: true,
        databasePath,
      }),
    ).resolves.toEqual({ fileName: "omnifin.db.maintenance.lock" });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a restore while SQLite sidecar files prove storage is not quiescent", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const backupPath = path.join(directory, "selected.sqlite");
    const rollbackOutputPath = path.join(directory, "pre-restore.sqlite");
    writeMarker(databasePath, "selected checkpoint");
    await createDatabaseBackup({ databasePath, outputPath: backupPath });
    await writeFile(`${databasePath}-wal`, "active", { mode: 0o600 });

    await expect(
      restoreDatabaseBackup({
        backupPath,
        confirmedGatewayStopped: true,
        databasePath,
        rollbackOutputPath,
      }),
    ).rejects.toMatchObject({ code: "database_not_quiescent" });
    expect(readMarker(databasePath)).toBe("selected checkpoint");
  });
});
