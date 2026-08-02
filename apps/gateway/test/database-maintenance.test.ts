import Database from "better-sqlite3";
import { createServer } from "node:http";
import { chmod, lstat, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDatabaseMaintenanceLock,
  createDatabaseBackup,
  createRetainedDatabaseBackup,
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
  it.each([1, 366, 2.5, Number.NaN])(
    "rejects invalid retained-backup count %s before writing",
    async (retentionCount) => {
      const directory = await fixtureDirectory();
      const databasePath = path.join(directory, "omnifin.db");
      writeMarker(databasePath, "source");

      await expect(
        createRetainedDatabaseBackup({
          backupDirectory: directory,
          databasePath,
          retentionCount,
        }),
      ).rejects.toMatchObject({ code: "backup_retention_invalid" });
    },
  );

  it("creates and verifies a generated recovery point before applying retention", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "scheduled checkpoint");

    const result = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "00000000-0000-4000-8000-000000000001",
      databasePath,
      now: new Date("2026-08-01T12:00:00.000Z"),
      retentionCount: 2,
    });

    expect(result).toMatchObject({
      backup: {
        fileName: "omnifin-auto-20260801T120000000Z-00000000-0000-4000-8000-000000000001.sqlite",
        manifestFileName:
          "omnifin-auto-20260801T120000000Z-00000000-0000-4000-8000-000000000001.sqlite.manifest.json",
      },
      retention: { candidates: 1, removed: 0, retained: 1, state: "ready" },
    });
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, result.backup.fileName) }),
    ).resolves.toEqual(result.backup);
    expect(readMarker(path.join(directory, result.backup.fileName))).toBe("scheduled checkpoint");
  });

  it("removes only the oldest verified generated pair after the retention limit", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");

    const createScheduledBackup = (day: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `00000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount: 2,
      });

    const oldest = await createScheduledBackup(1);
    const middle = await createScheduledBackup(2);
    await writeFile(path.join(directory, "operator-notes.txt"), "keep", { mode: 0o600 });
    const newest = await createScheduledBackup(3);

    await expect(lstat(path.join(directory, oldest.backup.fileName))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(directory, oldest.backup.manifestFileName))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, middle.backup.fileName) }),
    ).resolves.toEqual(middle.backup);
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, newest.backup.fileName) }),
    ).resolves.toEqual(newest.backup);
    await expect(lstat(path.join(directory, "operator-notes.txt"))).resolves.toBeDefined();
    expect(newest.retention).toEqual({
      candidates: 3,
      removed: 1,
      retained: 2,
      state: "ready",
    });
  });

  it("preserves every recovery point when a generated-looking pair is incomplete", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (day: number, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `10000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount,
      });

    const oldest = await createScheduledBackup(1, 3);
    const middle = await createScheduledBackup(2, 3);
    const incompleteFileName =
      "omnifin-auto-20260731T120000000Z-10000000-0000-4000-8000-000000000099.sqlite";
    await writeFile(path.join(directory, incompleteFileName), "preserve me", { mode: 0o600 });

    const newest = await createScheduledBackup(3, 2);

    expect(newest.retention).toEqual({
      candidates: 4,
      reason: "retention_set_invalid",
      removed: 0,
      retained: 4,
      state: "attention",
    });
    for (const fileName of [
      oldest.backup.fileName,
      oldest.backup.manifestFileName,
      middle.backup.fileName,
      middle.backup.manifestFileName,
      newest.backup.fileName,
      newest.backup.manifestFileName,
      incompleteFileName,
    ]) {
      await expect(lstat(path.join(directory, fileName))).resolves.toBeDefined();
    }
  });

  it("never adopts a manually created backup into the managed retention set", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const manualFileName =
      "omnifin-auto-20260730T120000000Z-11000000-0000-4000-8000-000000000099.sqlite";
    const manual = await createDatabaseBackup({
      databasePath,
      now: new Date("2026-07-30T12:00:00.000Z"),
      outputPath: path.join(directory, manualFileName),
    });
    const createScheduledBackup = (day: number, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `11000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount,
      });
    await createScheduledBackup(1, 3);

    const newest = await createScheduledBackup(2, 2);

    expect(newest.retention).toEqual({
      candidates: 3,
      reason: "retention_set_invalid",
      removed: 0,
      retained: 3,
      state: "attention",
    });
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, manual.fileName) }),
    ).resolves.toEqual(manual);
  });

  it("rejects a managed pair whose generated timestamp no longer matches its manifest", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const first = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "12000000-0000-4000-8000-000000000001",
      databasePath,
      now: new Date("2026-08-01T12:00:00.000Z"),
      retentionCount: 3,
    });
    const renamedFileName = first.backup.fileName.replace("20260801", "20260701");
    await rename(
      path.join(directory, first.backup.fileName),
      path.join(directory, renamedFileName),
    );
    await rename(
      path.join(directory, first.backup.manifestFileName),
      path.join(directory, `${renamedFileName}.manifest.json`),
    );

    const second = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "12000000-0000-4000-8000-000000000002",
      databasePath,
      now: new Date("2026-08-02T12:00:00.000Z"),
      retentionCount: 2,
    });

    expect(second.retention).toMatchObject({
      candidates: 2,
      reason: "retention_set_invalid",
      removed: 0,
      retained: 2,
      state: "attention",
    });
    await expect(lstat(path.join(directory, renamedFileName))).resolves.toBeDefined();
  });

  it("treats an orphan generated manifest as an invalid retention set", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const first = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "20000000-0000-4000-8000-000000000001",
      databasePath,
      now: new Date("2026-08-01T12:00:00.000Z"),
      retentionCount: 2,
    });
    const orphanManifest =
      "omnifin-auto-20260731T120000000Z-20000000-0000-4000-8000-000000000099.sqlite.manifest.json";
    await writeFile(path.join(directory, orphanManifest), "{}", { mode: 0o600 });

    const second = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "20000000-0000-4000-8000-000000000002",
      databasePath,
      now: new Date("2026-08-02T12:00:00.000Z"),
      retentionCount: 2,
    });

    expect(second.retention).toMatchObject({
      candidates: 3,
      reason: "retention_set_invalid",
      removed: 0,
      retained: 3,
      state: "attention",
    });
    await expect(lstat(path.join(directory, first.backup.fileName))).resolves.toBeDefined();
    await expect(lstat(path.join(directory, orphanManifest))).resolves.toBeDefined();
  });

  it("stops a bounded directory scan without pruning existing recovery points", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (day: number, scanLimit?: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `30000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount: 2,
        ...(scanLimit === undefined ? {} : { scanLimit }),
      });
    const oldest = await createScheduledBackup(1);
    await createScheduledBackup(2);
    await writeFile(path.join(directory, "foreign-one.txt"), "one", { mode: 0o600 });
    await writeFile(path.join(directory, "foreign-two.txt"), "two", { mode: 0o600 });

    const newest = await createScheduledBackup(3, 2);

    expect(newest.retention).toMatchObject({
      reason: "retention_scan_limit_exceeded",
      removed: 0,
      state: "attention",
    });
    await expect(lstat(path.join(directory, oldest.backup.fileName))).resolves.toBeDefined();
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, newest.backup.fileName) }),
    ).resolves.toEqual(newest.backup);
    await expect(lstat(path.join(directory, "foreign-one.txt"))).resolves.toBeDefined();
    await expect(lstat(path.join(directory, "foreign-two.txt"))).resolves.toBeDefined();
  });

  it("reports a post-verification directory scan failure without losing the new recovery point", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");

    const current = await createRetainedDatabaseBackup(
      {
        backupDirectory: directory,
        createId: () => "32000000-0000-4000-8000-000000000001",
        databasePath,
        now: new Date("2026-08-01T12:00:00.000Z"),
        retentionCount: 2,
      },
      {
        readDirectoryEntries: async () => {
          throw Object.assign(new Error("unavailable"), { code: "EIO" });
        },
      },
    );

    expect(current.retention).toEqual({
      candidates: 0,
      reason: "retention_scan_failed",
      removed: 0,
      retained: 0,
      state: "attention",
    });
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, current.backup.fileName) }),
    ).resolves.toEqual(current.backup);
  });

  it("bounds generated candidate evaluation before opening a large retention set", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    for (let index = 0; index < 731; index += 1) {
      const fileName = `omnifin-auto-20260701T120000000Z-30000000-0000-4000-8000-${index
        .toString()
        .padStart(12, "0")}.sqlite`;
      await writeFile(path.join(directory, fileName), "bounded", { mode: 0o600 });
    }

    const current = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "31000000-0000-4000-8000-000000000001",
      databasePath,
      now: new Date("2026-08-01T12:00:00.000Z"),
      retentionCount: 2,
    });

    expect(current.retention).toEqual({
      candidates: 732,
      reason: "retention_candidate_limit_exceeded",
      removed: 0,
      retained: 732,
      state: "attention",
    });
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, current.backup.fileName) }),
    ).resolves.toEqual(current.backup);
  });

  it("never prunes the current recovery point when the wall clock moves backward", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (day: number, id: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `40000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-${day.toString().padStart(2, "0")}T12:00:00.000Z`),
        retentionCount: 2,
      });
    const previousOldest = await createScheduledBackup(10, 10);
    const previousNewest = await createScheduledBackup(11, 11);

    const current = await createScheduledBackup(1, 1);

    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, current.backup.fileName) }),
    ).resolves.toEqual(current.backup);
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, previousNewest.backup.fileName) }),
    ).resolves.toEqual(previousNewest.backup);
    await expect(lstat(path.join(directory, previousOldest.backup.fileName))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    expect(current.retention).toEqual({
      candidates: 3,
      removed: 1,
      retained: 2,
      state: "ready",
    });
  });

  it("defers pruning recovery points created by overlapping scheduler starts", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (id: number, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `50000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date("2026-08-01T12:00:00.000Z"),
        retentionCount,
      });
    const first = await createScheduledBackup(1, 3);
    const second = await createScheduledBackup(2, 3);

    const third = await createScheduledBackup(3, 2);

    expect(third.retention).toEqual({
      candidates: 3,
      deferred: 1,
      removed: 0,
      retained: 3,
      state: "ready",
    });
    for (const backup of [first.backup, second.backup, third.backup]) {
      await expect(
        verifyDatabaseBackup({ backupPath: path.join(directory, backup.fileName) }),
      ).resolves.toEqual(backup);
    }
  });

  it("reports deletion failure without removing any verified pair", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (day: number, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `70000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount,
      });
    const oldest = await createScheduledBackup(1, 3);
    const middle = await createScheduledBackup(2, 3);

    const newest = await createRetainedDatabaseBackup(
      {
        backupDirectory: directory,
        createId: () => "70000000-0000-4000-8000-000000000003",
        databasePath,
        now: new Date("2026-08-03T12:00:00.000Z"),
        retentionCount: 2,
      },
      {
        renameFile: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      },
    );

    expect(newest.retention).toEqual({
      candidates: 3,
      reason: "retention_delete_failed",
      removed: 0,
      retained: 3,
      state: "attention",
    });
    for (const backup of [oldest.backup, middle.backup, newest.backup]) {
      await expect(
        verifyDatabaseBackup({ backupPath: path.join(directory, backup.fileName) }),
      ).resolves.toEqual(backup);
    }
  });

  it("reports cleanup failure after safely retiring an expired pair", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (day: number, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `71000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount,
      });
    const oldest = await createScheduledBackup(1, 3);
    const middle = await createScheduledBackup(2, 3);

    const newest = await createRetainedDatabaseBackup(
      {
        backupDirectory: directory,
        createId: () => "71000000-0000-4000-8000-000000000003",
        databasePath,
        now: new Date("2026-08-03T12:00:00.000Z"),
        retentionCount: 2,
      },
      {
        removeFile: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      },
    );

    expect(newest.retention).toEqual({
      candidates: 3,
      reason: "retention_cleanup_failed",
      removed: 1,
      retained: 2,
      state: "attention",
    });
    await expect(lstat(path.join(directory, oldest.backup.fileName))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const backup of [middle.backup, newest.backup]) {
      await expect(
        verifyDatabaseBackup({ backupPath: path.join(directory, backup.fileName) }),
      ).resolves.toEqual(backup);
    }
  });

  it("reports an unavailable pair when a failed retirement cannot roll back", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (day: number, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `72000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount,
      });
    const oldest = await createScheduledBackup(1, 3);
    const middle = await createScheduledBackup(2, 3);
    let renameCall = 0;

    const newest = await createRetainedDatabaseBackup(
      {
        backupDirectory: directory,
        createId: () => "72000000-0000-4000-8000-000000000003",
        databasePath,
        now: new Date("2026-08-03T12:00:00.000Z"),
        retentionCount: 2,
      },
      {
        renameFile: async (source, destination) => {
          renameCall += 1;
          if (renameCall === 2 || renameCall === 3) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          await rename(source, destination);
        },
      },
    );

    expect(newest.retention).toEqual({
      candidates: 3,
      reason: "retention_rollback_failed",
      removed: 0,
      retained: 2,
      state: "attention",
      unavailable: 1,
    });
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, oldest.backup.fileName) }),
    ).rejects.toMatchObject({ code: "backup_manifest_invalid" });
    for (const backup of [middle.backup, newest.backup]) {
      await expect(
        verifyDatabaseBackup({ backupPath: path.join(directory, backup.fileName) }),
      ).resolves.toEqual(backup);
    }
  });

  it("never follows generated-looking symlink pairs during retention", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const first = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "80000000-0000-4000-8000-000000000001",
      databasePath,
      now: new Date("2026-08-01T12:00:00.000Z"),
      retentionCount: 3,
    });
    const linkedFileName =
      "omnifin-auto-20260731T120000000Z-80000000-0000-4000-8000-000000000099.sqlite";
    await symlink(first.backup.fileName, path.join(directory, linkedFileName));
    await symlink(
      first.backup.manifestFileName,
      path.join(directory, `${linkedFileName}.manifest.json`),
    );

    const second = await createRetainedDatabaseBackup({
      backupDirectory: directory,
      createId: () => "80000000-0000-4000-8000-000000000002",
      databasePath,
      now: new Date("2026-08-02T12:00:00.000Z"),
      retentionCount: 2,
    });

    expect(second.retention).toMatchObject({
      candidates: 3,
      reason: "retention_set_invalid",
      removed: 0,
      state: "attention",
    });
    await expect(lstat(path.join(directory, linkedFileName))).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
    expect((await lstat(path.join(directory, linkedFileName))).isSymbolicLink()).toBe(true);
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, first.backup.fileName) }),
    ).resolves.toEqual(first.backup);
  });

  it("preserves all generated pairs when an existing recovery point is tampered", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (day: number, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `90000000-0000-4000-8000-${day.toString().padStart(12, "0")}`,
        databasePath,
        now: new Date(`2026-08-0${day}T12:00:00.000Z`),
        retentionCount,
      });
    const first = await createScheduledBackup(1, 3);
    const second = await createScheduledBackup(2, 3);
    await writeFile(path.join(directory, first.backup.fileName), "tampered", { flag: "a" });

    const third = await createScheduledBackup(3, 2);

    expect(third.retention).toMatchObject({
      candidates: 3,
      reason: "retention_set_invalid",
      removed: 0,
      retained: 3,
      state: "attention",
    });
    await expect(lstat(path.join(directory, first.backup.fileName))).resolves.toBeDefined();
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, second.backup.fileName) }),
    ).resolves.toEqual(second.backup);
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, third.backup.fileName) }),
    ).resolves.toEqual(third.backup);
  });

  it("uses generated names as a deterministic tie-breaker for equal creation times", async () => {
    const directory = await fixtureDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    writeMarker(databasePath, "source");
    const createScheduledBackup = (id: number, now: Date, retentionCount: number) =>
      createRetainedDatabaseBackup({
        backupDirectory: directory,
        createId: () => `a0000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
        databasePath,
        now,
        retentionCount,
      });
    const tiedFirst = await createScheduledBackup(1, new Date("2026-07-01T12:00:00.000Z"), 3);
    const tiedSecond = await createScheduledBackup(2, new Date("2026-07-01T12:00:00.000Z"), 3);

    const current = await createScheduledBackup(3, new Date("2026-08-01T12:00:00.000Z"), 2);

    await expect(lstat(path.join(directory, tiedFirst.backup.fileName))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(directory, tiedSecond.backup.fileName) }),
    ).resolves.toEqual(tiedSecond.backup);
    expect(current.retention).toMatchObject({ candidates: 3, removed: 1, retained: 2 });
  });

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
