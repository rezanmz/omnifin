import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  imageFixtureDockerCommands,
  runImageFixtureDockerLifecycle,
} from "../scripts/generate-v012-fixture.js";
import {
  assertDatabasePostMigrationChecks,
  initializeDatabase,
  initializeDatabaseKeyVerifier,
  openDatabase,
} from "../src/db/client.js";
import { databaseMaintenanceLockPath } from "../src/db/maintenance-lock.js";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
  restoreDatabaseBackupIntoEmptyTarget,
  sanitizeRestoredDatabase,
  verifyDatabaseBackup,
} from "../src/db/maintenance.js";
import {
  assertLegacyEncryptedSamples,
  encryptedSampleColumns,
  legacyEncryptedSampleFixtures,
  preflightDatabase,
  readMigrationCatalog,
} from "../src/db/migration-preflight.js";
import { ExternalMutationJournal } from "../src/operations/external-mutation-journal.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const cleanupDirectories: string[] = [];
const rootKey = Buffer.alloc(32, 0x31);
const wrongKey = Buffer.alloc(32, 0x72);
const imageReference = `ghcr.io/rezanmz/omnifin@sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function privateDirectory(prefix = "omnifin-recovery-") {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

function createCurrentDatabase(databasePath: string) {
  const database = openDatabase(databasePath);
  try {
    database.migrate();
  } finally {
    database.close();
  }
}

function createMigrationPrefix(databasePath: string, migrationCount = 32, encrypted = false) {
  const sqlite = new Database(databasePath);
  try {
    sqlite.exec(`CREATE TABLE "__drizzle_migrations" (
\t\t\t\tid SERIAL PRIMARY KEY,
\t\t\t\thash text NOT NULL,
\t\t\t\tcreated_at numeric
\t\t\t)`);
    const insertMigration = sqlite.prepare(
      `insert into __drizzle_migrations (hash, created_at) values (?, ?)`,
    );
    sqlite.transaction(() => {
      for (const migration of readMigrationCatalog().slice(0, migrationCount)) {
        for (const statement of migration.sql.split("--> statement-breakpoint")) {
          sqlite.exec(statement);
        }
        insertMigration.run(migration.hash, migration.when);
      }
    })();
    if (encrypted) {
      const cipher = new EnvelopeCipher(rootKey);
      sqlite
        .prepare(
          `insert into connector_configs (
             id, type, display_name, base_url, encrypted_credentials
           ) values ('jellyfin-main', 'jellyfin', 'Jellyfin', 'https://example.test', ?)`,
        )
        .run(
          cipher.encrypt(
            JSON.stringify({ accessToken: "fixture" }),
            "connector_credentials:jellyfin:jellyfin-main",
          ),
        );
    }
  } finally {
    sqlite.close();
    chmodSync(databasePath, 0o600);
  }
}

function createReleasedV012Database(databasePath: string, encrypted = false) {
  createMigrationPrefix(databasePath, 32, encrypted);
}

function seedPendingBulk(databasePath: string, migrationCount: number, suffix: string) {
  createMigrationPrefix(databasePath, migrationCount);
  const sqlite = new Database(databasePath);
  try {
    sqlite.exec(`
      insert into users (id, display_name, status, created_at, updated_at)
      values ('prefix-user-${suffix}', 'Prefix user', 'active', 1, 1);
      insert into download_queue_bulk_operations (
        id, user_id, idempotency_key_hash, fingerprint_hash, state,
        request_json, results_json, created_at, updated_at
      ) values (
        'download_bulk_${suffix.padEnd(22, "X")}', 'prefix-user-${suffix}',
        '${suffix.toLowerCase().padEnd(43, "a")}', '${suffix.toLowerCase().padEnd(43, "b")}',
        'pending', '{}', '[{"preserved":true}]', 1, 1
      );
    `);
  } finally {
    sqlite.close();
  }
}

async function fileSha256(filePath: string) {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function marker(databasePath: string, value?: string) {
  const sqlite = new Database(databasePath);
  try {
    sqlite.exec("create table if not exists recovery_marker (value text not null)");
    if (value !== undefined) {
      sqlite.exec("delete from recovery_marker");
      sqlite.prepare("insert into recovery_marker (value) values (?)").run(value);
    }
    return (
      sqlite.prepare("select value from recovery_marker limit 1").get() as
        { value: string } | undefined
    )?.value;
  } finally {
    sqlite.close();
  }
}

describe("migration and key preflight", () => {
  it("accepts every exact released migration prefix from v0.12 through current", async () => {
    const catalog = readMigrationCatalog();
    for (let migrationCount = 32; migrationCount <= catalog.length; migrationCount += 1) {
      const directory = await privateDirectory(`omnifin-prefix-${migrationCount}-`);
      const databasePath = path.join(directory, "omnifin.db");
      createMigrationPrefix(databasePath, migrationCount);
      const result = preflightDatabase(databasePath, rootKey);
      expect(result.appliedMigrationCount).toBe(migrationCount);
      expect(result.kind).toBe(migrationCount === catalog.length ? "current" : "supported-prefix");
      expect(result.migrationsPending).toBe(migrationCount < catalog.length);
    }
  });

  it("keeps the encrypted-sample catalog complete as encrypted schema classes evolve", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const encryptedColumns = (
        database.sqlite
          .prepare("select name from sqlite_schema where type = 'table' order by name")
          .pluck()
          .all() as string[]
      ).flatMap((table) =>
        (database.sqlite.pragma(`table_info(\"${table}\")`) as { name: string }[])
          .filter(({ name }) => name.startsWith("encrypted_"))
          .map(({ name }) => `${table}.${name}`),
      );
      expect(encryptedSampleColumns()).toEqual(encryptedColumns.sort());
    } finally {
      database.close();
    }
  });

  it("seeds and decrypts one row for every legacy encrypted sample context", () => {
    const sqlite = new Database(":memory:");
    const samples = legacyEncryptedSampleFixtures();
    const byTable = new Map<string, typeof samples>();
    for (const sample of samples) {
      const tableSamples = byTable.get(sample.table) ?? [];
      tableSamples.push(sample);
      byTable.set(sample.table, tableSamples);
    }
    const cipher = new EnvelopeCipher(rootKey);
    try {
      for (const [table, tableSamples] of byTable) {
        const encryptedColumns = [...new Set(tableSamples.map(({ column }) => column))];
        sqlite.exec(
          `create table "${table}" (
             id text primary key, type text, kind text, user_id text, playback_session_id text,
             connector_id text, connector_revision text, connector_instance_generation integer,
             connector_instance_identity_hash text, artifact_revision integer default 1,
             ${encryptedColumns.map((column) => `"${column}" text`).join(", ")}
           )`,
        );
        for (const sample of tableSamples) {
          sqlite
            .prepare(
              `insert into "${table}" (
                 id, type, kind, user_id, playback_session_id,
                 connector_id, connector_revision, connector_instance_generation,
                 connector_instance_identity_hash, artifact_revision, "${sample.column}"
                ) values (?, 'jellyfin', 'playback.progress', 'encrypted-sample-user',
                          'encrypted-sample-session', 'encrypted-sample-connector',
                          'encrypted-sample-revision', 0, null, 1, ?)`,
            )
            .run(sample.id, cipher.encrypt(`plaintext:${sample.id}`, sample.context));
        }
      }
      expect(() => assertLegacyEncryptedSamples(sqlite, rootKey)).not.toThrow();
      expect(() => assertLegacyEncryptedSamples(sqlite, wrongKey)).toThrowError(
        expect.objectContaining({ startupFailureCode: "database_encryption_key_mismatch" }),
      );
    } finally {
      sqlite.close();
    }
  });

  it("migrates the tracked v0.12 fixture through 0032/0033/0034 and validates key/decryption", async () => {
    const directory = await privateDirectory("omnifin-tracked-candidate-");
    const backupDirectory = await privateDirectory("omnifin-tracked-candidate-backups-");
    const databasePath = path.join(directory, "candidate.sqlite");
    await copyFile(
      path.resolve(import.meta.dirname, "fixtures/v0.12.0/v0.12.0.sqlite"),
      databasePath,
    );
    chmodSync(databasePath, 0o600);

    const database = await initializeDatabase({
      backupDirectory,
      backupRetentionCount: 2,
      databaseUrl: databasePath,
      imageReference,
      rootKey,
    });
    try {
      expect(
        database.sqlite.prepare("select count(*) as count from __drizzle_migrations").get(),
      ).toEqual({ count: readMigrationCatalog().length });
      expect(
        database.sqlite.prepare("select count(*) as count from database_key_verifiers").get(),
      ).toEqual({ count: 1 });
      const encrypted = database.sqlite
        .prepare(
          "select encrypted_credentials as encrypted from connector_configs where id = 'jellyfin-fixture'",
        )
        .get() as { encrypted: string };
      expect(
        new EnvelopeCipher(rootKey).decrypt(
          encrypted.encrypted,
          "connector_credentials:jellyfin:jellyfin-fixture",
        ),
      ).toBe(JSON.stringify({ accessToken: "fixture-only" }));
      expect(() => assertDatabasePostMigrationChecks(database.sqlite, rootKey)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("constructs an extractable hardened exact-image fixture container without host binds", () => {
    const exactImage = `ghcr.io/rezanmz/omnifin@sha256:${"c".repeat(64)}`;
    const readyMarker = "OMNIFIN_V012_FIXTURE_READY_00000000-0000-4000-8000-000000000000";
    const commands = imageFixtureDockerCommands({
      artifactOutputPath: "/private/output.sqlite",
      containerName: "omnifin-fixture-test",
      imageReference: exactImage,
      metadataOutputPath: "/private/metadata.json",
      readyMarker,
    });
    expect(commands.create).toContain(exactImage);
    expect(commands.create).toEqual(
      expect.arrayContaining([
        "--cap-drop",
        "ALL",
        "--network",
        "none",
        "--read-only",
        "no-new-privileges:true",
      ]),
    );
    expect(commands.create).not.toEqual(expect.arrayContaining(["--mount", "--volume", "-v"]));
    expect(commands.start).toEqual(["start", "omnifin-fixture-test"]);
    expect(commands.logs).toEqual(["logs", "omnifin-fixture-test"]);
    expect(commands.inspectContainer).toEqual([
      "inspect",
      "--format",
      "{{json .State}}",
      "omnifin-fixture-test",
    ]);
    expect(commands.create.at(-1)).toContain(readyMarker);
    expect(commands.create.at(-1)).toContain("setInterval");
    expect(commands.copyArtifact).toEqual([
      "cp",
      "omnifin-fixture-test:/tmp/v0.12.0.sqlite",
      "/private/output.sqlite",
    ]);
    expect(commands.remove).toEqual(["rm", "--force", "omnifin-fixture-test"]);
    expect(() =>
      imageFixtureDockerCommands({
        artifactOutputPath: "/tmp/output",
        containerName: "invalid",
        imageReference: "ghcr.io/rezanmz/omnifin:latest",
        metadataOutputPath: "/tmp/metadata",
        readyMarker,
      }),
    ).toThrow(/immutable image/u);
  });

  it("waits for a running ready image container before copying tmpfs evidence", () => {
    const readyMarker = "OMNIFIN_V012_FIXTURE_READY_11111111-1111-4111-8111-111111111111";
    const commands = imageFixtureDockerCommands({
      artifactOutputPath: "/private/output.sqlite",
      containerName: "omnifin-fixture-lifecycle",
      imageReference: `ghcr.io/rezanmz/omnifin@sha256:${"d".repeat(64)}`,
      metadataOutputPath: "/private/metadata.json",
      readyMarker,
    });
    const events: string[] = [];
    let logReads = 0;
    const inspected = runImageFixtureDockerLifecycle(commands, readyMarker, {
      execute: (arguments_) => {
        events.push(arguments_.join(" "));
        if (arguments_[0] === "image") {
          return JSON.stringify({ Id: "sha256:platform-image" });
        }
        if (arguments_[0] === "logs") {
          logReads += 1;
          return logReads === 1 ? "building\n" : `building\n${readyMarker}\n`;
        }
        if (arguments_[0] === "inspect") return JSON.stringify({ ExitCode: 0, Running: true });
        return "";
      },
      now: () => 0,
      pollIntervalMs: 1,
      readyTimeoutMs: 10,
      wait: () => undefined,
    });
    expect(inspected).toMatchObject({ Id: "sha256:platform-image" });
    const readyLogIndex = events.lastIndexOf(`logs omnifin-fixture-lifecycle`);
    expect(events.indexOf(commands.copyArtifact.join(" "))).toBeGreaterThan(readyLogIndex);
    expect(events.indexOf(commands.copyMetadata.join(" "))).toBeGreaterThan(readyLogIndex);
    expect(events.at(-1)).toBe(commands.remove.join(" "));
  });

  it("times out without copying image evidence and force-removes the running container", () => {
    const readyMarker = "OMNIFIN_V012_FIXTURE_READY_22222222-2222-4222-8222-222222222222";
    const commands = imageFixtureDockerCommands({
      artifactOutputPath: "/private/output.sqlite",
      containerName: "omnifin-fixture-timeout",
      imageReference: `ghcr.io/rezanmz/omnifin@sha256:${"e".repeat(64)}`,
      metadataOutputPath: "/private/metadata.json",
      readyMarker,
    });
    const events: string[] = [];
    let currentTime = 0;
    expect(() =>
      runImageFixtureDockerLifecycle(commands, readyMarker, {
        execute: (arguments_) => {
          events.push(arguments_.join(" "));
          if (arguments_[0] === "image") return JSON.stringify({ Id: "sha256:platform-image" });
          if (arguments_[0] === "logs") return "still building\n";
          if (arguments_[0] === "inspect") return JSON.stringify({ ExitCode: 0, Running: true });
          return "";
        },
        now: () => currentTime,
        pollIntervalMs: 5,
        readyTimeoutMs: 10,
        wait: (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).toThrow(/timed out/u);
    expect(events).not.toContain(commands.copyArtifact.join(" "));
    expect(events).not.toContain(commands.copyMetadata.join(" "));
    expect(events.at(-1)).toBe(commands.remove.join(" "));
  });

  it("fails an early image-container exit without copying evidence", () => {
    const readyMarker = "OMNIFIN_V012_FIXTURE_READY_33333333-3333-4333-8333-333333333333";
    const commands = imageFixtureDockerCommands({
      artifactOutputPath: "/private/output.sqlite",
      containerName: "omnifin-fixture-exited",
      imageReference: `ghcr.io/rezanmz/omnifin@sha256:${"f".repeat(64)}`,
      metadataOutputPath: "/private/metadata.json",
      readyMarker,
    });
    const events: string[] = [];
    expect(() =>
      runImageFixtureDockerLifecycle(commands, readyMarker, {
        execute: (arguments_) => {
          events.push(arguments_.join(" "));
          if (arguments_[0] === "image") return JSON.stringify({ Id: "sha256:platform-image" });
          if (arguments_[0] === "logs") return "migration failed\n";
          if (arguments_[0] === "inspect") return JSON.stringify({ ExitCode: 17, Running: false });
          return "";
        },
        now: () => 0,
        wait: () => undefined,
      }),
    ).toThrow(/exited before readiness \(exit 17\)/u);
    expect(events).not.toContain(commands.copyArtifact.join(" "));
    expect(events).not.toContain(commands.copyMetadata.join(" "));
    expect(events.at(-1)).toBe(commands.remove.join(" "));
  });

  it("recovers WAL state only in bounded private staging without mutating source files", async () => {
    const directory = await privateDirectory("omnifin-wal-source-");
    const stagingDirectory = await privateDirectory("omnifin-wal-staging-");
    const databasePath = path.join(directory, "omnifin.db");
    const database = openDatabase(databasePath);
    try {
      database.migrate();
      initializeDatabaseKeyVerifier(database.sqlite, rootKey);
      database.sqlite.exec(
        `insert into users (id, display_name, status, created_at, updated_at)
         values ('wal-user', 'WAL user', 'active', 1, 1)`,
      );
      const sourceFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
      expect(await Promise.all(sourceFiles.map((file) => lstat(file)))).toHaveLength(3);
      const before = await Promise.all(sourceFiles.map(fileSha256));

      expect(preflightDatabase(databasePath, rootKey, { stagingDirectory })).toMatchObject({
        hadSidecars: true,
        kind: "current",
      });

      expect(await Promise.all(sourceFiles.map(fileSha256))).toEqual(before);
      expect(await readdir(stagingDirectory)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("fails closed on bounded-staging exhaustion and copy failure without residue", async () => {
    const directory = await privateDirectory("omnifin-staging-source-");
    const stagingDirectory = await privateDirectory("omnifin-staging-failure-");
    const databasePath = path.join(directory, "omnifin.db");
    createCurrentDatabase(databasePath);
    const before = await fileSha256(databasePath);

    expect(() =>
      preflightDatabase(databasePath, rootKey, { maxStagingBytes: 0, stagingDirectory }),
    ).toThrowError(
      expect.objectContaining({ startupFailureCode: "database_recovery_staging_insufficient" }),
    );
    expect(() =>
      preflightDatabase(
        databasePath,
        rootKey,
        { stagingDirectory },
        {
          copyFile: () => {
            throw new Error("injected copy failure");
          },
        },
      ),
    ).toThrowError(
      expect.objectContaining({ startupFailureCode: "database_recovery_staging_failed" }),
    );
    expect(await fileSha256(databasePath)).toBe(before);
    expect(await readdir(stagingDirectory)).toEqual([]);
  });

  it("accepts the checksummed source-generated b85488b/v0.12 fixture provisionally", async () => {
    const fixturePath = path.resolve(import.meta.dirname, "fixtures/v0.12.0/v0.12.0.sqlite");
    const stagingDirectory = await privateDirectory("omnifin-fixture-staging-");
    expect(preflightDatabase(fixturePath, rootKey, { stagingDirectory })).toMatchObject({
      kind: "supported-prefix",
      migrationsPending: true,
    });
    expect(() => preflightDatabase(fixturePath, wrongKey, { stagingDirectory })).toThrowError(
      expect.objectContaining({ startupFailureCode: "database_encryption_key_mismatch" }),
    );
  });

  it("recognizes the released prefix, validates every present encrypted class, and never writes on failure", async () => {
    const directory = await privateDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    createReleasedV012Database(databasePath, true);
    const beforeDigest = await fileSha256(databasePath);
    const beforeEntries = await readdir(directory);

    expect(preflightDatabase(databasePath, rootKey)).toMatchObject({
      kind: "supported-prefix",
      migrationsPending: true,
    });
    expect(() => preflightDatabase(databasePath, wrongKey)).toThrowError(
      expect.objectContaining({ startupFailureCode: "database_encryption_key_mismatch" }),
    );

    expect(await fileSha256(databasePath)).toBe(beforeDigest);
    expect(await readdir(directory)).toEqual(beforeEntries);
  });

  it("fails a hash mismatch and newer catalog before creating a recovery pair", async () => {
    const directory = await privateDirectory();
    const backupDirectory = await privateDirectory("omnifin-preflight-backups-");
    const databasePath = path.join(directory, "omnifin.db");
    createReleasedV012Database(databasePath);
    const sqlite = new Database(databasePath);
    sqlite.prepare("update __drizzle_migrations set hash = ? where rowid = 1").run("0".repeat(64));
    sqlite.close();

    await expect(
      initializeDatabase({
        backupDirectory,
        backupRetentionCount: 2,
        databaseUrl: databasePath,
        rootKey,
      }),
    ).rejects.toMatchObject({ startupFailureCode: "database_migration_history_invalid" });
    expect(await readdir(backupDirectory)).toEqual([]);

    const newerPath = path.join(directory, "newer.db");
    createCurrentDatabase(newerPath);
    const newer = new Database(newerPath);
    newer
      .prepare("insert into __drizzle_migrations (hash, created_at) values (?, ?)")
      .run("f".repeat(64), 8_000_000_000_000);
    newer.close();
    expect(() => preflightDatabase(newerPath, rootKey)).toThrowError(
      expect.objectContaining({ startupFailureCode: "database_schema_newer" }),
    );
    expect(await readdir(backupDirectory)).toEqual([]);
  });

  it("rejects unsupported physical schema drift without creating SQLite sidecars", async () => {
    const directory = await privateDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const database = openDatabase(databasePath);
    try {
      database.migrate();
      initializeDatabaseKeyVerifier(database.sqlite, rootKey);
      database.sqlite.exec("create table unsupported_schema_drift (id integer primary key)");
    } finally {
      database.close();
    }
    const beforeDigest = await fileSha256(databasePath);

    expect(() => preflightDatabase(databasePath, rootKey)).toThrowError(
      expect.objectContaining({ startupFailureCode: "database_schema_unsupported" }),
    );
    expect(await fileSha256(databasePath)).toBe(beforeDigest);
    expect(await readdir(directory)).toEqual(["omnifin.db"]);
  });

  it("creates and verifies recovery before migrating and initializes the singleton verifier", async () => {
    const directory = await privateDirectory();
    const backupDirectory = await privateDirectory("omnifin-startup-backups-");
    const databasePath = path.join(directory, "omnifin.db");
    createReleasedV012Database(databasePath, true);

    const database = await initializeDatabase({
      backupDirectory,
      backupRetentionCount: 2,
      databaseUrl: databasePath,
      imageReference,
      rootKey,
    });
    try {
      expect(
        database.sqlite.prepare("select count(*) as count from __drizzle_migrations").get(),
      ).toEqual({ count: readMigrationCatalog().length });
      expect(
        database.sqlite.prepare("select count(*) as count from database_key_verifiers").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }

    const recoveryFile = (await readdir(backupDirectory)).find((name) => name.endsWith(".sqlite"));
    expect(recoveryFile).toBeDefined();
    await expect(
      verifyDatabaseBackup({ backupPath: path.join(backupDirectory, recoveryFile!) }),
    ).resolves.toMatchObject({ migrationCount: 32 });
    expect(
      JSON.parse(
        await (
          await import("node:fs/promises")
        ).readFile(path.join(backupDirectory, `${recoveryFile!}.manifest.json`), "utf8"),
      ),
    ).toMatchObject({ imageReference });
    expect((await readdir(backupDirectory)).some((name) => name.includes("preflight"))).toBe(false);
    expect(() => preflightDatabase(databasePath, wrongKey)).toThrowError(
      expect.objectContaining({ startupFailureCode: "database_encryption_key_mismatch" }),
    );
  });

  it("checks maintenance exclusion before v0.12 preflight, staging, or backup mutation", async () => {
    const directory = await privateDirectory("omnifin-locked-v012-");
    const backupDirectory = await privateDirectory("omnifin-locked-v012-backups-");
    const databasePath = path.join(directory, "omnifin.db");
    createReleasedV012Database(databasePath, true);
    const writer = new Database(databasePath);
    try {
      writer.pragma("journal_mode = WAL");
      writer
        .prepare("update connector_configs set display_name = ? where id = ?")
        .run("Locked fixture", "jellyfin-main");
      const sourceFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
      const before = await Promise.all(sourceFiles.map(fileSha256));
      await writeFile(databaseMaintenanceLockPath(databasePath), "", { mode: 0o600 });

      await expect(
        initializeDatabase({
          backupDirectory,
          backupRetentionCount: 2,
          databaseUrl: databasePath,
          rootKey,
        }),
      ).rejects.toMatchObject({ startupFailureCode: "database_maintenance_active" });

      expect(await Promise.all(sourceFiles.map(fileSha256))).toEqual(before);
      expect(await readdir(backupDirectory)).toEqual([]);
      expect((await readdir(directory)).some((name) => name.includes("omnifin-inspect"))).toBe(
        false,
      );
    } finally {
      writer.close();
    }
  });

  it("discards staged recovery when maintenance begins at the backup publication boundary", async () => {
    const directory = await privateDirectory("omnifin-lock-race-");
    const backupDirectory = await privateDirectory("omnifin-lock-race-backups-");
    const databasePath = path.join(directory, "omnifin.db");
    createReleasedV012Database(databasePath, true);
    const before = await fileSha256(databasePath);

    await expect(
      initializeDatabase(
        {
          backupDirectory,
          backupRetentionCount: 2,
          databaseUrl: databasePath,
          rootKey,
        },
        {
          beforeRecoveryBackupPublish: () =>
            writeFile(databaseMaintenanceLockPath(databasePath), "", { mode: 0o600 }),
        },
      ),
    ).rejects.toMatchObject({ startupFailureCode: "database_maintenance_active" });
    expect(await fileSha256(databasePath)).toBe(before);
    expect(await readdir(backupDirectory)).toEqual([]);
  });

  it("retains the verified recovery pair when migration or a post-migration check fails", async () => {
    for (const boundary of ["before", "after"] as const) {
      const directory = await privateDirectory(`omnifin-${boundary}-migration-`);
      const backupDirectory = await privateDirectory(`omnifin-${boundary}-backup-`);
      const databasePath = path.join(directory, "omnifin.db");
      createReleasedV012Database(databasePath);
      let observedBackup = false;
      const injection = async () => {
        const fileName = (await readdir(backupDirectory)).find((name) => name.endsWith(".sqlite"));
        if (!fileName) throw new Error("recovery pair was not published before migration");
        await verifyDatabaseBackup({ backupPath: path.join(backupDirectory, fileName) });
        observedBackup = true;
        throw new Error(`injected ${boundary}-migration failure`);
      };

      await expect(
        initializeDatabase(
          {
            backupDirectory,
            backupRetentionCount: 2,
            databaseUrl: databasePath,
            rootKey,
          },
          boundary === "before" ? { beforeMigration: injection } : { afterMigration: injection },
        ),
      ).rejects.toBeDefined();
      expect(observedBackup).toBe(true);
      const sqlite = new Database(databasePath, { readonly: true });
      try {
        expect(
          (
            sqlite.prepare("select count(*) as count from __drizzle_migrations").get() as {
              count: number;
            }
          ).count,
        ).toBe(boundary === "before" ? 32 : readMigrationCatalog().length);
      } finally {
        sqlite.close();
      }
    }
  });

  it("restarts safely after a child is interrupted at the documented pre-migration failpoint", async () => {
    const directory = await privateDirectory("omnifin-child-migration-");
    const backupDirectory = await privateDirectory("omnifin-child-migration-backups-");
    const databasePath = path.join(directory, "omnifin.db");
    createReleasedV012Database(databasePath, true);
    const gatewayDirectory = path.resolve(import.meta.dirname, "..");
    const childProgram = `
      const { initializeDatabase } = await import('./src/db/client.ts');
      await initializeDatabase(
        ${JSON.stringify({
          backupDirectory,
          backupRetentionCount: 2,
          databaseUrl: databasePath,
          rootKey: { type: "Buffer", data: [...rootKey] },
        })},
        { beforeMigration: () => process.kill(process.pid, 'SIGKILL') }
      );
    `.replace(
      JSON.stringify({ type: "Buffer", data: [...rootKey] }),
      `Buffer.from(${JSON.stringify([...rootKey])})`,
    );
    const interrupted = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childProgram],
      { cwd: gatewayDirectory, encoding: "utf8", timeout: 30_000 },
    );
    expect(interrupted.signal).toBe("SIGKILL");
    expect((await readdir(backupDirectory)).some((name) => name.endsWith(".manifest.json"))).toBe(
      true,
    );

    const restarted = await initializeDatabase({
      backupDirectory,
      backupRetentionCount: 2,
      databaseUrl: databasePath,
      rootKey,
    });
    try {
      expect(
        restarted.sqlite.prepare("select count(*) as count from __drizzle_migrations").get(),
      ).toEqual({ count: readMigrationCatalog().length });
      expect(() => assertDatabasePostMigrationChecks(restarted.sqlite, rootKey)).not.toThrow();
    } finally {
      restarted.close();
    }
    await expect(lstat(databaseMaintenanceLockPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects physical schema drift after catalog, integrity, and foreign-key checks", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      initializeDatabaseKeyVerifier(database.sqlite, rootKey);
      database.sqlite.exec("create table unsupported_schema_drift (id integer primary key)");
      expect(() => assertDatabasePostMigrationChecks(database.sqlite, rootKey)).toThrowError(
        expect.objectContaining({ startupFailureCode: "database_schema_validation_failed" }),
      );
    } finally {
      database.close();
    }
  });
});

describe("restore sanitation and rollback", () => {
  it.each([
    { name: "a clear tombstone", state: "cleared" as const },
    { name: "a disabled configuration", state: "disabled" as const },
    { name: "a replaced credential", state: "replaced" as const },
    { name: "current-row absence", state: "absent" as const },
    { equivalent: false, name: "a mismatched target credential", state: "replaced" as const },
  ])("uses the rollback timeline as authority over $name", async ({ equivalent = true, state }) => {
    const directory = await privateDirectory(`omnifin-provisioning-authority-${state}-`);
    const databasePath = path.join(directory, "restored.sqlite");
    const rollbackPath = path.join(directory, "rollback-timeline.sqlite");
    const selectedPath = path.join(directory, "selected.sqlite");
    const rollbackOutputPath = path.join(directory, "pre-restore.sqlite");
    const cipher = new EnvelopeCipher(rootKey);
    const revision = (configGeneration: number) =>
      createHash("sha256")
        .update(`jellyfin\0authority-jellyfin\0${configGeneration}`, "utf8")
        .digest("base64url");
    const context = (connectorRevision: string, generation: number, identity: string | null) =>
      `jellyfin_provisioning:authority-jellyfin:${connectorRevision}:${generation}:${identity ?? "none"}`;
    const configuration = (credential: string, enabled: boolean) =>
      JSON.stringify({
        credential: { accessToken: credential, kind: "access_token" },
        enabled,
        protocolVersion: "10.11",
        schemaVersion: 2,
        template: null,
        validatedAt: 1,
      });
    createCurrentDatabase(databasePath);
    createCurrentDatabase(rollbackPath);
    let sqlite = new Database(databasePath);
    sqlite
      .prepare(
        `insert into connector_configs (
           id, type, display_name, base_url, encrypted_credentials,
           capability_snapshot_json, instance_generation, config_generation,
           instance_identity_hash, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "authority-jellyfin",
        "jellyfin",
        "Jellyfin",
        "https://example.test",
        "connector-secret",
        "{}",
        0,
        0,
        "b".repeat(43),
        1,
        1,
      );
    sqlite
      .prepare(
        `insert into jellyfin_provisioning_configs (
           connector_id, connector_revision, connector_instance_generation,
           connector_instance_identity_hash, encrypted_configuration, revision,
           created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "authority-jellyfin",
        revision(0),
        0,
        "b".repeat(43),
        cipher.encrypt(
          configuration("backup-old-token", true),
          context(revision(0), 0, "b".repeat(43)),
        ),
        2,
        1,
        1,
      );
    sqlite.close();

    sqlite = new Database(rollbackPath);
    sqlite
      .prepare(
        `insert into connector_configs (
           id, type, display_name, base_url, encrypted_credentials,
           capability_snapshot_json, instance_generation, config_generation,
           instance_identity_hash, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "authority-jellyfin",
        "jellyfin",
        "Jellyfin",
        "https://example.test",
        "connector-secret",
        "{}",
        7,
        7,
        (equivalent ? "b" : "c").repeat(43),
        1,
        7,
      );
    if (state !== "absent") {
      const payload =
        state === "cleared"
          ? JSON.stringify({ schemaVersion: 2, state: "cleared" })
          : configuration("current-token", state !== "disabled");
      sqlite
        .prepare(
          `insert into jellyfin_provisioning_configs (
             connector_id, connector_revision, connector_instance_generation,
             connector_instance_identity_hash, encrypted_configuration, revision,
             created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "authority-jellyfin",
          revision(7),
          7,
          (equivalent ? "b" : "c").repeat(43),
          cipher.encrypt(payload, context(revision(7), 7, (equivalent ? "b" : "c").repeat(43))),
          9,
          2,
          2,
        );
    }
    sqlite.close();

    await createDatabaseBackup({ databasePath, outputPath: selectedPath });
    await copyFile(rollbackPath, databasePath);
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await restoreDatabaseBackup({
      backupPath: selectedPath,
      confirmedGatewayStopped: true,
      databasePath,
      now: new Date(5_000),
      rollbackOutputPath,
      rootKey,
    });

    sqlite = new Database(databasePath, { readonly: true });
    try {
      const row = sqlite
        .prepare(
          `select connector_revision as connectorRevision,
                  connector_instance_generation as instanceGeneration,
                  connector_instance_identity_hash as identityHash,
                  encrypted_configuration as encryptedConfiguration,
                  revision
           from jellyfin_provisioning_configs`,
        )
        .get() as
        | {
            connectorRevision: string;
            encryptedConfiguration: string;
            identityHash: string | null;
            instanceGeneration: number;
            revision: number;
          }
        | undefined;
      if (state === "absent") {
        expect(row).toBeUndefined();
      } else if (!equivalent) {
        expect(row).toBeUndefined();
      } else if (state !== "cleared") {
        expect(row).toBeUndefined();
      } else {
        expect(row).toMatchObject({
          connectorRevision: revision(5_001),
          identityHash: null,
          instanceGeneration: 8,
          revision: 9,
        });
        const restored = JSON.parse(
          cipher.decrypt(row!.encryptedConfiguration, context(revision(5_001), 8, null)),
        ) as Record<string, unknown>;
        expect(restored).not.toHaveProperty("credential", {
          accessToken: "backup-old-token",
          kind: "access_token",
        });
        if (state === "cleared") {
          expect(restored).toEqual({ schemaVersion: 2, state: "cleared" });
        } else {
          expect(restored).toMatchObject({
            credential: { accessToken: "current-token", kind: "access_token" },
            enabled: state !== "disabled",
          });
        }
      }
    } finally {
      sqlite.close();
    }
  });

  it("maps restored dispatch boundaries without reclaiming or discarding uncertainty", async () => {
    const directory = await privateDirectory("omnifin-dispatch-restore-");
    const databasePath = path.join(directory, "omnifin.db");
    createCurrentDatabase(databasePath);
    let sqlite = new Database(databasePath);
    const journal = new ExternalMutationJournal(sqlite, rootKey);
    sqlite.exec(`
      insert into users (id, display_name, status, created_at, updated_at)
      values ('search-restore-user', 'Search restore user', 'active', 1000, 1000);
      insert into acquisition_search_operations (
        id, user_id, idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
      ) values (
        'search-restore-pending', 'search-restore-user', '${"a".repeat(43)}',
        '${"b".repeat(43)}', 'pending', 1000, 1000
      );
    `);
    journal.reserve({
      connectorConfigGeneration: 10,
      connectorId: "connector-snapshot",
      connectorInstanceGeneration: 2,
      id: `mutation_dispatch_${"a".repeat(22)}`,
      kind: "acquisition.search",
      leaseExpiresAt: 2_000,
      leaseOwner: "worker-a",
      normalizedRequest: { action: "automatic_search", mediaId: 42 },
      now: 1_000,
      parentOperationId: "search-restore-pending",
      parentOperationType: "acquisition_search_operation",
      targetDigest: "a".repeat(22),
      userId: "search-restore-user",
    });
    journal.markDispatched({
      id: `mutation_dispatch_${"a".repeat(22)}`,
      leaseOwner: "worker-a",
      now: 1_200,
    });
    const reserve = (token: string) =>
      journal.reserve({
        connectorConfigGeneration: 10,
        connectorId: "connector-snapshot",
        connectorInstanceGeneration: 2,
        id: `mutation_dispatch_${token.repeat(22)}`,
        kind: "playback.progress",
        leaseExpiresAt: 2_000,
        leaseOwner: `worker-${token}`,
        normalizedRequest: { positionSeconds: 30 },
        now: 1_000,
        parentOperationId: `playback_progress_operation_${token.repeat(22)}`,
        parentOperationType: "playback_progress_operation",
        targetDigest: token.repeat(22),
        userId: "user-snapshot",
      });
    reserve("r");
    reserve("d");
    journal.markDispatched({
      id: `mutation_dispatch_${"d".repeat(22)}`,
      leaseOwner: "worker-d",
      now: 1_200,
    });
    reserve("c");
    journal.markDispatched({
      id: `mutation_dispatch_${"c".repeat(22)}`,
      leaseOwner: "worker-c",
      now: 1_200,
    });
    journal.markReconcileRequired({
      failureCode: "read_after_write_required",
      id: `mutation_dispatch_${"c".repeat(22)}`,
      now: 1_300,
    });
    reserve("s");
    journal.markDispatched({
      id: `mutation_dispatch_${"s".repeat(22)}`,
      leaseOwner: "worker-s",
      now: 1_200,
    });
    journal.completeSucceeded({ id: `mutation_dispatch_${"s".repeat(22)}`, now: 1_300 });
    sqlite.close();

    sanitizeRestoredDatabase(databasePath, { now: new Date(4_000) });

    sqlite = new Database(databasePath, { readonly: true });
    try {
      expect(
        sqlite
          .prepare(
            `select substr(id, 19, 1) as token, state, failure_code as failureCode
             from external_mutation_dispatches order by token`,
          )
          .all(),
      ).toEqual([
        { failureCode: "restore_timeline_uncertain", state: "uncertain", token: "a" },
        { failureCode: "read_after_write_required", state: "reconcile_required", token: "c" },
        { failureCode: "restore_timeline_uncertain", state: "uncertain", token: "d" },
        { failureCode: "restore_sanitized", state: "failed", token: "r" },
        { failureCode: null, state: "succeeded", token: "s" },
      ]);
      expect(
        sqlite
          .prepare(
            `select substr(owner_dispatch_id, 19, 1) as token
             from external_mutation_target_locks order by token`,
          )
          .all(),
      ).toEqual([{ token: "a" }, { token: "c" }, { token: "d" }]);
      expect(
        sqlite
          .prepare(
            `select parent.state as parentState, parent.failure_code as parentFailureCode,
                    dispatch.state as dispatchState, dispatch.failure_code as dispatchFailureCode,
                    dispatch.parent_operation_type as parentOperationType
             from acquisition_search_operations parent
             join external_mutation_dispatches dispatch on dispatch.parent_operation_id = parent.id
             where parent.id = 'search-restore-pending'`,
          )
          .get(),
      ).toEqual({
        dispatchFailureCode: "restore_timeline_uncertain",
        dispatchState: "uncertain",
        parentFailureCode: "restore_outcome_uncertain",
        parentOperationType: "acquisition_search_operation",
        parentState: "uncertain",
      });
    } finally {
      sqlite.close();
    }
  });

  it("merges restrictive current-timeline facts and quarantines pending idempotency before replacement", async () => {
    const directory = await privateDirectory("omnifin-timeline-merge-");
    const databasePath = path.join(directory, "omnifin.db");
    const selectedPath = path.join(directory, "selected.sqlite");
    const rollbackPath = path.join(directory, "rollback.sqlite");
    createCurrentDatabase(databasePath);
    let sqlite = new Database(databasePath);
    sqlite.exec(`
      insert into users (id, display_name, role, status, created_at, updated_at)
      values ('timeline-user', 'Timeline user', 'admin', 'active', 1, 1);
      insert into connector_configs (
        id, type, display_name, base_url, encrypted_credentials,
        capability_snapshot_json, health_state, created_at, updated_at
      ) values ('timeline-jellyfin', 'jellyfin', 'Jellyfin', 'https://example.test',
        'selected-token', '{}', 'unknown', 1, 1);
      insert into service_identity_links (
        id, user_id, service, connector_id, external_server_id, external_user_id,
        external_username, external_display_name, encrypted_access_token, device_id,
        token_created_at, health_state, revision, created_at, updated_at
      ) values ('timeline-link', 'timeline-user', 'jellyfin', 'timeline-jellyfin',
        'server', 'external', 'user', 'User', 'selected-token', 'device',
        1, 'linked', 2, 1, 1);
      insert into invitations (
        id, token_hash, expires_at, registration_handoff_hash,
        registration_handoff_expires_at, created_at
      ) values
        ('invite_timeline-consumed', '${"c".repeat(43)}', 10000, '${"d".repeat(43)}', 5000, 1),
        ('invite_timeline-revoked', '${"e".repeat(43)}', 10000, '${"f".repeat(43)}', 5000, 1),
        ('invite_timeline-active', '${"g".repeat(43)}', 10000, '${"h".repeat(43)}', 5000, 1);
    `);
    let mutationJournal = new ExternalMutationJournal(sqlite, rootKey);
    mutationJournal.reserve({
      connectorConfigGeneration: 1,
      connectorId: "timeline-jellyfin",
      connectorInstanceGeneration: 0,
      id: `mutation_dispatch_${"t".repeat(22)}`,
      kind: "playback.progress",
      leaseExpiresAt: 10,
      leaseOwner: "timeline-worker",
      normalizedRequest: { positionSeconds: 10 },
      now: 1,
      parentOperationId: `playback_progress_operation_${"t".repeat(22)}`,
      parentOperationType: "playback_progress_operation",
      targetDigest: "t".repeat(22),
      userId: "timeline-user",
    });
    mutationJournal.markDispatched({
      id: `mutation_dispatch_${"t".repeat(22)}`,
      leaseOwner: "timeline-worker",
      now: 2,
    });
    sqlite.close();
    const selected = await createDatabaseBackup({
      databasePath,
      outputPath: selectedPath,
    });

    sqlite = new Database(databasePath);
    mutationJournal = new ExternalMutationJournal(sqlite, rootKey);
    sqlite.exec(`
      update users set role = 'viewer', role_source = 'manual', status = 'disabled', updated_at = 2
      where id = 'timeline-user';
      update connector_configs
      set instance_generation = 7, config_generation = 9000,
          instance_identity_hash = '${"i".repeat(43)}', updated_at = 2
      where id = 'timeline-jellyfin';
      update service_identity_links
      set encrypted_access_token = null, token_created_at = null, health_state = 'revoked',
          revoked_at = 2, revision = 7, updated_at = 2
      where id = 'timeline-link';
      update invitations set consumed_at = 3000,
        registration_handoff_hash = null, registration_handoff_expires_at = null
      where id = 'invite_timeline-consumed';
      update invitations set revoked_at = 3000,
        registration_handoff_hash = null, registration_handoff_expires_at = null
      where id = 'invite_timeline-revoked';
      insert into download_queue_bulk_operations (
        id, user_id, idempotency_key_hash, fingerprint_hash, state,
        request_json, results_json, created_at, updated_at
      ) values (
        'download_bulk_ABCDEFGHIJKLMNOPQRSTUV', 'timeline-user', '${"a".repeat(43)}',
        '${"b".repeat(43)}', 'pending', '{}', '[{"preserved":true}]', 2, 2
      );
    `);
    mutationJournal.completeSucceeded({
      id: `mutation_dispatch_${"t".repeat(22)}`,
      now: 3,
    });
    sqlite.close();

    const restored = await restoreDatabaseBackup({
      backupPath: selectedPath,
      confirmedGatewayStopped: true,
      databasePath,
      now: new Date(5_000),
      rollbackOutputPath: rollbackPath,
    });

    expect(restored.sourceDatabaseSha256).toBe(selected.databaseSha256);
    expect(restored.sanitizedDatabaseSha256).toBe(await fileSha256(databasePath));
    expect(restored.databaseSha256).toBe(restored.sanitizedDatabaseSha256);
    expect(restored.sanitizedDatabaseSha256).not.toBe(restored.sourceDatabaseSha256);
    sqlite = new Database(databasePath, { readonly: true });
    try {
      expect(
        sqlite.prepare("select role, status from users where id = 'timeline-user'").get(),
      ).toEqual({
        role: "viewer",
        status: "disabled",
      });
      expect(
        sqlite
          .prepare(
            `select health_state as healthState, revision, encrypted_access_token as token
             from service_identity_links where id = 'timeline-link'`,
          )
          .get(),
      ).toEqual({ healthState: "revoked", revision: 8, token: null });
      expect(
        sqlite
          .prepare(
            `select instance_generation as instanceGeneration,
                    config_generation as configGeneration,
                    instance_identity_hash as instanceIdentityHash
             from connector_configs where id = 'timeline-jellyfin'`,
          )
          .get(),
      ).toEqual({ configGeneration: 9001, instanceGeneration: 8, instanceIdentityHash: null });
      expect(
        sqlite
          .prepare(
            `select state, failure_code as failureCode
             from external_mutation_dispatches where id = ?`,
          )
          .get(`mutation_dispatch_${"t".repeat(22)}`),
      ).toEqual({ failureCode: null, state: "succeeded" });
      expect(
        sqlite
          .prepare(
            `select count(*) as count from external_mutation_target_locks
             where owner_dispatch_id = ?`,
          )
          .get(`mutation_dispatch_${"t".repeat(22)}`),
      ).toEqual({ count: 0 });
      expect(
        sqlite
          .prepare(
            `select id, consumed_at as consumedAt, revoked_at as revokedAt,
                    registration_handoff_hash as handoffHash,
                    registration_handoff_expires_at as handoffExpiresAt
             from invitations order by id`,
          )
          .all(),
      ).toEqual([
        {
          consumedAt: null,
          handoffExpiresAt: null,
          handoffHash: null,
          id: "invite_timeline-active",
          revokedAt: 5000,
        },
        {
          consumedAt: 3000,
          handoffExpiresAt: null,
          handoffHash: null,
          id: "invite_timeline-consumed",
          revokedAt: null,
        },
        {
          consumedAt: null,
          handoffExpiresAt: null,
          handoffHash: null,
          id: "invite_timeline-revoked",
          revokedAt: 3000,
        },
      ]);
      expect(
        sqlite
          .prepare(
            `select state, results_json as resultsJson, response_json as responseJson
             from download_queue_bulk_operations where idempotency_key_hash = ?`,
          )
          .get("a".repeat(43)),
      ).toEqual({
        responseJson: null,
        resultsJson: '[{"preserved":true}]',
        state: "quarantined",
      });
      expect(
        JSON.parse(
          (
            sqlite
              .prepare(
                `select metadata_json as metadataJson from audit_events
                 where event_type = 'database.restore_sanitized' order by rowid desc limit 1`,
              )
              .get() as { metadataJson: string }
          ).metadataJson,
        ),
      ).toMatchObject({ rollbackSecurityMerge: "verified_current_timeline" });
    } finally {
      sqlite.close();
    }
  });

  it("makes current identity restrictions and OIDC mapping deletions/downgrades authoritative", async () => {
    const directory = await privateDirectory("omnifin-authority-merge-");
    const databasePath = path.join(directory, "omnifin.db");
    const selectedPath = path.join(directory, "selected.sqlite");
    const rollbackPath = path.join(directory, "rollback.sqlite");
    createCurrentDatabase(databasePath);
    let sqlite = new Database(databasePath);
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      insert into users (id, display_name, role, role_source, status, created_at, updated_at)
      values
        ('pending-user', 'Pending user', 'admin', 'recovery_bootstrap', 'active', 1, 1),
        ('disabled-user', 'Disabled user', 'admin', 'manual', 'active', 1, 1);
      insert into oidc_providers (
        id, slug, display_name, issuer, client_id, token_endpoint_auth_method,
        allow_jit_provisioning, enabled, created_at, updated_at
      ) values (
        'authority-provider', 'authority', 'Authority', 'https://issuer.example',
        'client', 'none', 1, 1, 1, 1
      );
      insert into external_identities (
        id, user_id, provider_id, issuer, subject, display_claims_json,
        last_login_at, created_at, updated_at
      ) values (
        'deleted-identity', 'pending-user', 'authority-provider',
        'https://issuer.example', 'subject', '{}', 1, 1, 1
      );
      insert into role_mappings (
        id, provider_id, claim_path_json, operator, values_json, role,
        priority, enabled, created_at, updated_at
      ) values
        ('deleted-mapping', 'authority-provider', '["groups"]', 'contains_any', '["admins"]',
          'admin', 100, 1, 1, 1),
        ('disabled-mapping', 'authority-provider', '["groups"]', 'contains_any', '["operators"]',
          'admin', 90, 1, 1, 1),
        ('downgraded-mapping', 'authority-provider', '["groups"]', 'contains_any', '["household"]',
          'admin', 80, 1, 1, 1);
    `);
    sqlite.close();
    await createDatabaseBackup({ databasePath, outputPath: selectedPath });

    sqlite = new Database(databasePath);
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      update users set role = 'viewer', role_source = 'manual', status = 'pending_link', updated_at = 2
      where id = 'pending-user';
      update users set role = 'viewer', role_source = 'manual', status = 'disabled', updated_at = 2
      where id = 'disabled-user';
      update oidc_providers set allow_jit_provisioning = 0, updated_at = 2
      where id = 'authority-provider';
      delete from external_identities where id = 'deleted-identity';
      delete from role_mappings where id = 'deleted-mapping';
      update role_mappings set enabled = 0, updated_at = 2 where id = 'disabled-mapping';
      update role_mappings set role = 'viewer', priority = 10, updated_at = 2
      where id = 'downgraded-mapping';
      insert into role_mappings (
        id, provider_id, claim_path_json, operator, values_json, role,
        priority, enabled, created_at, updated_at
      ) values (
        'current-only-mapping', 'authority-provider', '["groups"]', 'contains_any', '["viewers"]',
        'viewer', 5, 1, 2, 2
      );
    `);
    sqlite.close();

    await restoreDatabaseBackup({
      backupPath: selectedPath,
      confirmedGatewayStopped: true,
      databasePath,
      now: new Date(5_000),
      rollbackOutputPath: rollbackPath,
    });

    sqlite = new Database(databasePath, { readonly: true });
    try {
      expect(
        sqlite
          .prepare("select id, role, role_source as roleSource, status from users order by id")
          .all(),
      ).toEqual([
        { id: "disabled-user", role: "viewer", roleSource: "manual", status: "disabled" },
        { id: "pending-user", role: "viewer", roleSource: "manual", status: "pending_link" },
      ]);
      expect(
        sqlite
          .prepare(
            "select allow_jit_provisioning as allowJit from oidc_providers where id = 'authority-provider'",
          )
          .get(),
      ).toEqual({ allowJit: 0 });
      expect(sqlite.prepare("select count(*) as count from external_identities").get()).toEqual({
        count: 0,
      });
      expect(
        sqlite.prepare("select id, role, priority, enabled from role_mappings order by id").all(),
      ).toEqual([
        { enabled: 1, id: "current-only-mapping", priority: 5, role: "viewer" },
        { enabled: 0, id: "deleted-mapping", priority: 100, role: "admin" },
        { enabled: 0, id: "disabled-mapping", priority: 90, role: "admin" },
        { enabled: 1, id: "downgraded-mapping", priority: 10, role: "viewer" },
      ]);
      expect(
        sqlite
          .prepare(
            "select count(*) as count from role_mappings where enabled = 1 and role = 'admin'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it.each([32, 33])(
    "migrates selected prefix %i before replacement sanitation and preserves bulk quarantine",
    async (migrationCount) => {
      const directory = await privateDirectory(`omnifin-replace-prefix-${migrationCount}-`);
      const selectedSource = path.join(directory, "selected-source.sqlite");
      const selectedPath = path.join(directory, "selected.sqlite");
      const databasePath = path.join(directory, "omnifin.db");
      const rollbackPath = path.join(directory, "rollback.sqlite");
      const suffix = `r${migrationCount}`;
      seedPendingBulk(selectedSource, migrationCount, suffix);
      await createDatabaseBackup({ databasePath: selectedSource, outputPath: selectedPath });
      createCurrentDatabase(databasePath);
      const current = new Database(databasePath);
      current
        .prepare(
          "insert into users (id, display_name, status, created_at, updated_at) values (?, 'Current user', 'active', 1, 1)",
        )
        .run(`prefix-user-${suffix}`);
      current.close();

      await restoreDatabaseBackup({
        backupPath: selectedPath,
        confirmedGatewayStopped: true,
        databasePath,
        rollbackOutputPath: rollbackPath,
        rootKey,
      });

      const restored = new Database(databasePath, { readonly: true });
      try {
        expect(
          restored.prepare("select count(*) as count from __drizzle_migrations").get(),
        ).toEqual({ count: readMigrationCatalog().length });
        expect(
          restored.prepare("select count(*) as count from database_key_verifiers").get(),
        ).toEqual({ count: 1 });
        expect(
          restored
            .prepare(
              "select state, results_json as resultsJson from download_queue_bulk_operations where idempotency_key_hash = ?",
            )
            .get(suffix.padEnd(43, "a")),
        ).toEqual({ resultsJson: '[{"preserved":true}]', state: "quarantined" });
      } finally {
        restored.close();
      }
    },
  );

  it.each([32, 33])(
    "migrates selected prefix %i before empty-host quarantine without reopening bulk work",
    async (migrationCount) => {
      const sourceDirectory = await privateDirectory(
        `omnifin-empty-prefix-source-${migrationCount}-`,
      );
      const targetDirectory = await privateDirectory(
        `omnifin-empty-prefix-target-${migrationCount}-`,
      );
      const selectedSource = path.join(sourceDirectory, "selected-source.sqlite");
      const selectedPath = path.join(sourceDirectory, "selected.sqlite");
      const databasePath = path.join(targetDirectory, "omnifin.db");
      const suffix = `e${migrationCount}`;
      seedPendingBulk(selectedSource, migrationCount, suffix);
      await createDatabaseBackup({ databasePath: selectedSource, outputPath: selectedPath });

      await restoreDatabaseBackupIntoEmptyTarget({
        backupPath: selectedPath,
        confirmedEmptyTarget: true,
        confirmedGatewayStopped: true,
        databasePath,
        rootKey,
      });

      const restored = new Database(databasePath, { readonly: true });
      try {
        expect(
          restored.prepare("select count(*) as count from __drizzle_migrations").get(),
        ).toEqual({ count: readMigrationCatalog().length });
        expect(
          restored
            .prepare(
              "select state, results_json as resultsJson from download_queue_bulk_operations where idempotency_key_hash = ?",
            )
            .get(suffix.padEnd(43, "a")),
        ).toEqual({ resultsJson: '[{"preserved":true}]', state: "quarantined" });
      } finally {
        restored.close();
      }
    },
  );

  it("never commits a manifest across any database/manifest staging or publication boundary", async () => {
    const boundaries = [
      "database-stage",
      "manifest-stage",
      "database-rename",
      "database-fsync",
      "manifest-rename",
      "manifest-fsync",
    ] as const;

    for (const boundary of boundaries) {
      const directory = await privateDirectory(`omnifin-backup-${boundary}-`);
      const databasePath = path.join(directory, "omnifin.db");
      const backupPath = path.join(directory, "checkpoint.sqlite");
      createCurrentDatabase(databasePath);
      const inject = async () => {
        try {
          await lstat(`${backupPath}.manifest.json`);
          await expect(verifyDatabaseBackup({ backupPath })).resolves.toBeDefined();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        throw new Error(`injected ${boundary} failure`);
      };
      const dependencies =
        boundary === "database-stage"
          ? { afterDatabaseStage: inject }
          : boundary === "manifest-stage"
            ? { afterManifestStage: inject }
            : boundary === "database-rename"
              ? { afterDatabaseRename: inject }
              : boundary === "database-fsync"
                ? { afterDatabaseSync: inject }
                : boundary === "manifest-rename"
                  ? { afterManifestRename: inject }
                  : { afterManifestSync: inject };
      await expect(
        createDatabaseBackup({ databasePath, outputPath: backupPath }, dependencies),
      ).rejects.toMatchObject({ code: "backup_failed" });
      await expect(lstat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(`${backupPath}.manifest.json`)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(directory)).filter((name) => name.includes("partial"))).toEqual([]);
    }
  });

  it("preserves durable facts while revoking transient authority and terminalizing work", async () => {
    const directory = await privateDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    createCurrentDatabase(databasePath);
    const sqlite = new Database(databasePath);
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      insert into users (id, display_name, role, status, created_at, updated_at)
      values ('user-1', 'User', 'viewer', 'active', 1, 1);
      insert into connector_configs (
        id, type, display_name, base_url, encrypted_credentials,
        capability_snapshot_json, health_state, created_at, updated_at
      ) values ('jellyfin', 'jellyfin', 'Jellyfin', 'https://example.test', 'encrypted',
        '{"version":"old"}', 'healthy', 1, 1);
      insert into service_identity_links (
        id, user_id, service, connector_id, external_server_id, external_user_id,
        external_username, external_display_name, encrypted_access_token, device_id,
        token_created_at, health_state, revision, created_at, updated_at
      ) values ('link-1', 'user-1', 'jellyfin', 'jellyfin', 'server', 'external',
        'user', 'User', 'encrypted', 'device', 1, 'linked', 4, 1, 1);
      insert into media_references (
        id, user_id, service_identity_link_id, link_revision, item_digest,
        encrypted_payload, last_used_at, expires_at, created_at, updated_at
      ) values ('media_abcdefghijklmnopqrstuv', 'user-1', 'link-1', 4,
        'abcdefghijklmnopqrstuv', 'encrypted', 2, 5000, 1, 2);
      insert into media_issues (
        id, user_id, service_identity_link_id, media_reference_id, playback_session_id,
        category, position_seconds, state, created_at, updated_at
      ) values ('issue_abcdefghijklmnopqrstuv', 'user-1', 'link-1',
        'media_abcdefghijklmnopqrstuv', 'playback_abcdefghijklmnopqrstuv',
        'other', 0, 'open', 1, 1);
      insert into discovery_artwork_references (
        id, user_id, connector_id, item_digest, encrypted_payload,
        last_used_at, expires_at, created_at, updated_at
      ) values ('discovery_art_abcdefghijklmnopqrstuv', 'user-1', 'jellyfin',
        'abcdefghijklmnopqrstuv', 'encrypted', 5000, 6000, 1, 1);
      insert into sessions (
        id, token_hash, auth_method, csrf_token_hash, encrypted_csrf_token,
        created_at, last_rotated_at, last_seen_at, expires_at, absolute_expires_at
      ) values ('session-1', '${"a".repeat(43)}', 'recovery', '${"b".repeat(43)}',
        'encrypted', 1, 1, 1, 5000, 6000);
      insert into media_request_operations (
        id, user_id, idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
      ) values ('request-1', 'user-1', '${"c".repeat(43)}', '${"d".repeat(43)}',
        'pending', 1, 1);
    `);
    sqlite.close();

    sanitizeRestoredDatabase(databasePath, {
      auditId: "restore-audit-fixture",
      now: new Date(4_000),
    });

    const restored = new Database(databasePath, { readonly: true });
    try {
      expect(restored.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(
        restored.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 2 });
      expect(
        restored
          .prepare(
            `select revision, health_state as healthState,
                    encrypted_access_token as token, last_verified_at as verifiedAt
             from service_identity_links where id = 'link-1'`,
          )
          .get(),
      ).toEqual({ healthState: "revoked", revision: 5, token: null, verifiedAt: null });
      expect(
        restored
          .prepare(
            `select instance_generation as instanceGeneration,
                    config_generation as configGeneration,
                    instance_identity_hash as instanceIdentityHash
             from connector_configs where id = 'jellyfin'`,
          )
          .get(),
      ).toEqual({ configGeneration: 4001, instanceGeneration: 1, instanceIdentityHash: null });
      expect(restored.prepare("select count(*) as count from media_issues").get()).toEqual({
        count: 1,
      });
      expect(
        restored.prepare("select count(*) as count from discovery_artwork_references").get(),
      ).toEqual({ count: 0 });
      expect(
        restored
          .prepare(
            "select expires_at as expiresAt, link_revision as linkRevision from media_references",
          )
          .get(),
      ).toEqual({ expiresAt: 4_000, linkRevision: 4 });
      expect(
        restored
          .prepare("select state, failure_code as failureCode from media_request_operations")
          .get(),
      ).toEqual({ failureCode: "restore_sanitized", state: "failed" });
      expect(
        restored
          .prepare("select count(*) as count from audit_events where id = 'restore-audit-fixture'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        JSON.parse(
          (
            restored
              .prepare(
                "select metadata_json as metadataJson from audit_events where id = 'restore-audit-fixture'",
              )
              .get() as { metadataJson: string }
          ).metadataJson,
        ),
      ).toMatchObject({ rollbackSecurityMerge: "authority_quarantined_no_current_timeline" });
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it("restores into an explicitly confirmed empty target and refuses a nonempty target", async () => {
    const sourceDirectory = await privateDirectory();
    const targetDirectory = await privateDirectory("omnifin-empty-target-");
    const sourcePath = path.join(sourceDirectory, "source.db");
    const backupPath = path.join(sourceDirectory, "selected.sqlite");
    createCurrentDatabase(sourcePath);
    marker(sourcePath, "selected");
    await createDatabaseBackup({ databasePath: sourcePath, outputPath: backupPath });
    const databasePath = path.join(targetDirectory, "omnifin.db");

    await expect(
      restoreDatabaseBackupIntoEmptyTarget({
        backupPath,
        confirmedEmptyTarget: false,
        confirmedGatewayStopped: true,
        databasePath,
      }),
    ).rejects.toMatchObject({ code: "restore_confirmation_required" });

    await expect(
      restoreDatabaseBackupIntoEmptyTarget({
        backupPath,
        confirmedEmptyTarget: true,
        confirmedGatewayStopped: true,
        databasePath,
      }),
    ).resolves.toMatchObject({ restoredFileName: "omnifin.db" });
    expect(marker(databasePath)).toBe("selected");
    await expect(lstat(databaseMaintenanceLockPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      restoreDatabaseBackupIntoEmptyTarget({
        backupPath,
        confirmedEmptyTarget: true,
        confirmedGatewayStopped: true,
        databasePath,
      }),
    ).rejects.toMatchObject({ code: "restore_target_not_empty" });
  });

  it("revokes active invitations and clears registration handoffs on an empty-host restore", async () => {
    const sourceDirectory = await privateDirectory("omnifin-empty-invite-source-");
    const targetDirectory = await privateDirectory("omnifin-empty-invite-target-");
    const sourcePath = path.join(sourceDirectory, "source.db");
    const backupPath = path.join(sourceDirectory, "selected.sqlite");
    const databasePath = path.join(targetDirectory, "omnifin.db");
    createCurrentDatabase(sourcePath);
    const source = new Database(sourcePath);
    source
      .prepare(
        `insert into invitations (
           id, token_hash, expires_at, registration_handoff_hash,
           registration_handoff_expires_at, created_at
         ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run("invite_empty-host", "i".repeat(43), 10000, "j".repeat(43), 5000, 1);
    source.close();
    await createDatabaseBackup({ databasePath: sourcePath, outputPath: backupPath });

    await restoreDatabaseBackupIntoEmptyTarget({
      backupPath,
      confirmedEmptyTarget: true,
      confirmedGatewayStopped: true,
      databasePath,
      now: new Date(4_000),
    });

    const restored = new Database(databasePath, { readonly: true });
    try {
      expect(
        restored
          .prepare(
            `select consumed_at as consumedAt, revoked_at as revokedAt,
                    registration_handoff_hash as handoffHash,
                    registration_handoff_expires_at as handoffExpiresAt
             from invitations where id = 'invite_empty-host'`,
          )
          .get(),
      ).toEqual({
        consumedAt: null,
        handoffExpiresAt: null,
        handoffHash: null,
        revokedAt: 4000,
      });
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it.each(["", "-wal", "-shm", ".maintenance.lock"])(
    "refuses an empty-target restore when the target artifact %s exists",
    async (suffix) => {
      const targetDirectory = await privateDirectory("omnifin-empty-refusal-");
      const databasePath = path.join(targetDirectory, "omnifin.db");
      const artifact =
        suffix === ".maintenance.lock"
          ? databaseMaintenanceLockPath(databasePath)
          : `${databasePath}${suffix}`;
      await writeFile(artifact, "reserved", { mode: 0o600 });

      await expect(
        restoreDatabaseBackupIntoEmptyTarget({
          backupPath: path.join(targetDirectory, "missing-backup.sqlite"),
          confirmedEmptyTarget: true,
          confirmedGatewayStopped: true,
          databasePath,
        }),
      ).rejects.toMatchObject({ code: "restore_target_not_empty" });
    },
  );

  it("fails staged sanitation with real SQLITE_FULL and restarts from untouched original state", async () => {
    const directory = await privateDirectory("omnifin-sqlite-full-");
    const startupBackupDirectory = await privateDirectory("omnifin-sqlite-full-startup-");
    const databasePath = path.join(directory, "omnifin.db");
    const selectedPath = path.join(directory, "selected.sqlite");
    const rollbackPath = path.join(directory, "rollback.sqlite");
    createCurrentDatabase(databasePath);
    let active = new Database(databasePath);
    active.exec(
      "insert into users (id, display_name, status, created_at, updated_at) values ('full-user', 'Selected', 'active', 1, 1)",
    );
    active.close();
    await createDatabaseBackup({ databasePath, outputPath: selectedPath });
    active = new Database(databasePath);
    active.exec("update users set display_name = 'Active', updated_at = 2 where id = 'full-user'");
    active.close();
    const activeDigest = await fileSha256(databasePath);

    await expect(
      restoreDatabaseBackup(
        {
          backupPath: selectedPath,
          confirmedGatewayStopped: true,
          databasePath,
          rollbackOutputPath: rollbackPath,
        },
        {
          sanitationFailpoint: (sqlite) => {
            sqlite.exec("vacuum");
            const pageCount = sqlite.pragma("page_count", { simple: true }) as number;
            const pageSize = sqlite.pragma("page_size", { simple: true }) as number;
            sqlite.pragma(`max_page_count = ${pageCount}`);
            sqlite.exec("create table sqlite_full_failpoint (payload blob not null)");
            const fill = sqlite.prepare("insert into sqlite_full_failpoint (payload) values (?)");
            while (true) fill.run(Buffer.alloc(pageSize * 4));
          },
        },
      ),
    ).rejects.toMatchObject({ code: "restore_sanitization_failed" });
    expect(await fileSha256(databasePath)).toBe(activeDigest);
    active = new Database(databasePath, { readonly: true });
    expect(
      active.prepare("select display_name as displayName from users where id = 'full-user'").get(),
    ).toEqual({ displayName: "Active" });
    active.close();
    await expect(verifyDatabaseBackup({ backupPath: rollbackPath })).resolves.toBeDefined();
    await expect(lstat(databaseMaintenanceLockPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const restarted = await initializeDatabase({
      backupDirectory: startupBackupDirectory,
      backupRetentionCount: 2,
      databaseUrl: databasePath,
      rootKey,
    });
    try {
      expect(
        restarted.sqlite
          .prepare("select display_name as displayName from users where id = 'full-user'")
          .get(),
      ).toEqual({ displayName: "Active" });
      expect(() => assertDatabasePostMigrationChecks(restarted.sqlite, rootKey)).not.toThrow();
    } finally {
      restarted.close();
    }
  });

  it("rolls back controlled post-publication failure and retains the lock if rollback fails", async () => {
    const directory = await privateDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const selectedPath = path.join(directory, "selected.sqlite");
    const rollbackPath = path.join(directory, "rollback.sqlite");
    createCurrentDatabase(databasePath);
    marker(databasePath, "selected");
    await createDatabaseBackup({ databasePath, outputPath: selectedPath });
    marker(databasePath, "active");

    await expect(
      restoreDatabaseBackup(
        {
          backupPath: selectedPath,
          confirmedGatewayStopped: true,
          databasePath,
          rollbackOutputPath: rollbackPath,
        },
        { afterPublish: () => Promise.reject(new Error("injected post-publication failure")) },
      ),
    ).rejects.toMatchObject({ code: "restore_failed" });
    expect(marker(databasePath)).toBe("active");
    await expect(lstat(databaseMaintenanceLockPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const secondRollbackPath = path.join(directory, "rollback-2.sqlite");
    await expect(
      restoreDatabaseBackup(
        {
          backupPath: selectedPath,
          confirmedGatewayStopped: true,
          databasePath,
          rollbackOutputPath: secondRollbackPath,
        },
        {
          afterPublish: async () => {
            await unlink(secondRollbackPath);
            await unlink(`${secondRollbackPath}.manifest.json`);
            throw new Error("injected rollback loss");
          },
        },
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(lstat(databaseMaintenanceLockPath(databasePath))).resolves.toBeDefined();
  });

  it("restores rollback but retains the maintenance lock after publication durability ambiguity", async () => {
    const directory = await privateDirectory();
    const databasePath = path.join(directory, "omnifin.db");
    const selectedPath = path.join(directory, "selected.sqlite");
    const rollbackPath = path.join(directory, "rollback.sqlite");
    createCurrentDatabase(databasePath);
    marker(databasePath, "selected");
    await createDatabaseBackup({ databasePath, outputPath: selectedPath });
    marker(databasePath, "active");

    await expect(
      restoreDatabaseBackup(
        {
          backupPath: selectedPath,
          confirmedGatewayStopped: true,
          databasePath,
          rollbackOutputPath: rollbackPath,
        },
        {
          syncPublishedDirectory: () =>
            Promise.reject(new Error("injected directory fsync ambiguity")),
        },
      ),
    ).rejects.toMatchObject({ code: "restore_failed" });
    expect(marker(databasePath)).toBe("active");
    await expect(lstat(databaseMaintenanceLockPath(databasePath))).resolves.toBeDefined();
  });
});
