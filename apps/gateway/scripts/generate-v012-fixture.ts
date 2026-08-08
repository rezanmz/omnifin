import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, hkdfSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { initializeDatabase } from "../src/db/client.js";
import { readMigrationCatalog } from "../src/db/migration-preflight.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const SOURCE_COMMIT = "b85488b9517680d59ef87dfdb90ad6ec04da5251";
const RELEASED_MIGRATION_COUNT = 32;
const RELEASED_JOURNAL_DIGEST = "40db0a680c351971faff6ed6909df1f8659f3ba6ec856ae716a1ab91f72cbc4d";
const RELEASED_MIGRATIONS_DIGEST =
  "77165725ab2040b39259e92c77911666603976fdd1c81121e7af3ae621866118";
const FIXTURE_KEY = Buffer.alloc(32, 0x31);
const FIXTURE_KEY_BASE64 = FIXTURE_KEY.toString("base64");
export const IMAGE_FIXTURE_GENERATOR_VERSION = 2;
const gatewayDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(gatewayDirectory, "../..");
const fixtureDirectory = path.join(gatewayDirectory, "test/fixtures/v0.12.0");
const fixturePath = path.join(fixtureDirectory, "v0.12.0.sqlite");
const checksumPath = path.join(fixtureDirectory, "SHA256SUMS");
const provenancePath = path.join(fixtureDirectory, "provenance.json");
const IMMUTABLE_IMAGE_PATTERN = /^[^\s@]+@sha256:[0-9a-f]{64}$/u;
const READY_MARKER_PATTERN = /^OMNIFIN_V012_FIXTURE_READY_[0-9a-f-]{36}$/u;

interface ImageGenerationOptions {
  artifactOutputPath: string;
  containerName: string;
  imageReference: string;
  metadataOutputPath: string;
  readyMarker: string;
}

interface ContainerMetadata {
  buildRevision: string;
  buildVersion: string;
  migrationCount: number;
  sqliteSourceId: string;
  sqliteVersion: string;
}

interface ImageInspectMetadata {
  Architecture?: string;
  Id?: string;
  Os?: string;
  RepoDigests?: string[];
}

interface ContainerState {
  ExitCode?: number;
  Running?: boolean;
}

interface MigrationJournal {
  dialect: "sqlite";
  entries: Array<{
    breakpoints: true;
    idx: number;
    tag: string;
    version: "6";
    when: number;
  }>;
  version: "7";
}

interface ReleasedMigrationCatalog {
  journal: MigrationJournal;
  migrations: Map<string, string>;
}

export interface V012FixtureSourceDependencies {
  readGitFile?: (filePath: string) => string;
  readLocalFile?: (filePath: string) => string;
}

export interface ImageFixtureDockerLifecycleDependencies {
  execute: (arguments_: readonly string[], captureOutput: boolean) => string;
  now?: () => number;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  wait?: (milliseconds: number) => void;
}

function gitFile(filePath: string) {
  return execFileSync("git", ["show", `${SOURCE_COMMIT}:${filePath}`], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  });
}

function localFile(filePath: string) {
  return readFileSync(path.join(repositoryDirectory, filePath), "utf8");
}

class GitSourceUnavailableError extends Error {}

function gitSourceFile(readGitFile: (filePath: string) => string, filePath: string) {
  try {
    return readGitFile(filePath);
  } catch (error) {
    throw new GitSourceUnavailableError("The exact v0.12 Git object is unavailable.", {
      cause: error,
    });
  }
}

function releasedMigrationJournal(rawJournal: string) {
  const parsed = JSON.parse(rawJournal) as unknown;
  const digest = createHash("sha256").update(JSON.stringify(parsed), "utf8").digest("hex");
  const journal = parsed as MigrationJournal;
  if (
    digest !== RELEASED_JOURNAL_DIGEST ||
    journal.version !== "7" ||
    journal.dialect !== "sqlite" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length !== RELEASED_MIGRATION_COUNT ||
    journal.entries.at(-1)?.tag !== "0031_playback_preferences" ||
    journal.entries.some(
      (entry, index) =>
        entry.idx !== index ||
        entry.version !== "6" ||
        entry.breakpoints !== true ||
        !/^[0-9]{4}_[a-z0-9_]+$/u.test(entry.tag),
    )
  ) {
    throw new Error("The exact v0.12 source migration catalog is not the released 0031 prefix.");
  }
  return journal;
}

function validateReleasedMigrationContents(
  journal: MigrationJournal,
  migrations: Map<string, string>,
) {
  const digest = createHash("sha256");
  for (const entry of journal.entries) {
    const migration = migrations.get(entry.tag);
    if (migration === undefined) {
      throw new Error(`The exact v0.12 migration ${entry.tag} is unavailable.`);
    }
    digest
      .update(entry.tag, "utf8")
      .update("\0", "utf8")
      .update(String(Buffer.byteLength(migration)), "utf8")
      .update("\0", "utf8")
      .update(migration, "utf8");
  }
  if (digest.digest("hex") !== RELEASED_MIGRATIONS_DIGEST) {
    throw new Error("The local v0.12 migration prefix does not match the fixed source commit.");
  }
}

function migrationCatalogFromReader(
  journal: MigrationJournal,
  readFile: (filePath: string) => string,
): ReleasedMigrationCatalog {
  const migrations = new Map(
    journal.entries.map((entry) => [entry.tag, readFile(`apps/gateway/drizzle/${entry.tag}.sql`)]),
  );
  validateReleasedMigrationContents(journal, migrations);
  return { journal, migrations };
}

function releasedV012MigrationCatalog(
  dependencies: V012FixtureSourceDependencies,
): ReleasedMigrationCatalog {
  const readGitFile = dependencies.readGitFile ?? gitFile;
  try {
    const journal = releasedMigrationJournal(
      gitSourceFile(readGitFile, "apps/gateway/drizzle/meta/_journal.json"),
    );
    return migrationCatalogFromReader(journal, (filePath) => gitSourceFile(readGitFile, filePath));
  } catch (error) {
    if (!(error instanceof GitSourceUnavailableError)) throw error;
  }

  const readLocalFile = dependencies.readLocalFile ?? localFile;
  const currentJournal = JSON.parse(
    readLocalFile("apps/gateway/drizzle/meta/_journal.json"),
  ) as MigrationJournal;
  const releasedPrefix = releasedMigrationJournal(
    JSON.stringify({
      version: currentJournal.version,
      dialect: currentJournal.dialect,
      entries: currentJournal.entries.slice(0, RELEASED_MIGRATION_COUNT),
    }),
  );
  return migrationCatalogFromReader(releasedPrefix, readLocalFile);
}

export function deterministicV012FixtureEnvelope(plaintext: string, context: string) {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      FIXTURE_KEY,
      Buffer.from("omnifin:v1:key-derivation", "utf8"),
      Buffer.from("omnifin:v1:envelope:aes-256-gcm", "utf8"),
      32,
    ),
  );
  const iv = Buffer.alloc(12, 0x12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `v2.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher
      .getAuthTag()
      .toString("base64url")}`;
  } finally {
    key.fill(0);
  }
}

function seedFixture(sqlite: Database.Database, encryptedCredentials: string) {
  sqlite
    .prepare(
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials,
         capability_snapshot_json, health_state, created_at, updated_at
       ) values (
         'jellyfin-fixture', 'jellyfin', 'v0.12 fixture',
         'https://jellyfin.fixture.invalid', ?, '{}', 'unknown', 1000, 1000
       )`,
    )
    .run(encryptedCredentials);
}

export function generateV012FixtureFromSource(
  outputPath: string,
  sourceDependencies: V012FixtureSourceDependencies = {},
) {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "omnifin-v012-source-"));
  const migrationsDirectory = path.join(temporaryDirectory, "drizzle");
  try {
    mkdirSync(path.join(migrationsDirectory, "meta"), { mode: 0o700, recursive: true });
    const { journal, migrations } = releasedV012MigrationCatalog(sourceDependencies);
    for (const entry of journal.entries) {
      if (entry.idx < 0 || entry.idx >= RELEASED_MIGRATION_COUNT) {
        throw new Error("The exact v0.12 migration order is invalid.");
      }
      writeFileSync(
        path.join(migrationsDirectory, `${entry.tag}.sql`),
        migrations.get(entry.tag)!,
        { mode: 0o600 },
      );
    }
    writeFileSync(
      path.join(migrationsDirectory, "meta/_journal.json"),
      `${JSON.stringify(journal, null, 2)}\n`,
      { mode: 0o600 },
    );

    const sqlite = new Database(outputPath);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: migrationsDirectory });
      seedFixture(
        sqlite,
        deterministicV012FixtureEnvelope(
          JSON.stringify({ accessToken: "fixture-only" }),
          "connector_credentials:jellyfin:jellyfin-fixture",
        ),
      );
      validateGeneratedV012FixtureDatabase(sqlite);
      sqlite.pragma("journal_mode = DELETE");
      sqlite.exec("vacuum");
    } finally {
      sqlite.close();
    }
    chmodSync(outputPath, 0o600);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function validateGeneratedV012FixtureDatabase(sqlite: Database.Database) {
  const migrationCount = (
    sqlite.prepare("select count(*) as count from __drizzle_migrations").get() as { count: number }
  ).count;
  if (migrationCount !== RELEASED_MIGRATION_COUNT) {
    throw new Error(`Generated fixture has ${migrationCount} migrations instead of 32.`);
  }
  if (sqlite.pragma("integrity_check", { simple: true }) !== "ok") {
    throw new Error("Generated fixture failed SQLite integrity_check.");
  }
  if ((sqlite.pragma("foreign_key_check") as unknown[]).length !== 0) {
    throw new Error("Generated fixture failed SQLite foreign_key_check.");
  }
}

function containerProgram(readyMarker: string) {
  return `
    const { chmodSync, readFileSync, writeFileSync } = await import('node:fs');
    const crypto = (await import('node:crypto')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    crypto.randomBytes = (size) => Buffer.alloc(size, 0x12);
    syncBuiltinESMExports();
    const identity = JSON.parse(readFileSync('/opt/omnifin/build-identity.json', 'utf8'));
    if (identity.version !== '0.12.0' || identity.revision !== '${SOURCE_COMMIT}') {
      throw new Error('immutable image source identity mismatch');
    }
    const module = await import('/opt/omnifin/gateway/dist/index.js');
    if (typeof module.openDatabase !== 'function' || typeof module.EnvelopeCipher !== 'function') {
      throw new Error('immutable image fixture exports missing');
    }
    const output = '/tmp/v0.12.0.sqlite';
    const database = module.openDatabase(output);
    let metadata;
    try {
      database.migrate();
      const cipher = new module.EnvelopeCipher(Buffer.from('${FIXTURE_KEY_BASE64}', 'base64'));
      const context = 'connector_credentials:jellyfin:jellyfin-fixture';
      const encrypted = cipher.encrypt(JSON.stringify({ accessToken: 'fixture-only' }), context);
      database.sqlite.prepare(
        "insert into connector_configs (id, type, display_name, base_url, encrypted_credentials, capability_snapshot_json, health_state, created_at, updated_at) values ('jellyfin-fixture', 'jellyfin', 'v0.12 fixture', 'https://jellyfin.fixture.invalid', ?, '{}', 'unknown', 1000, 1000)"
      ).run(encrypted);
      if (cipher.decrypt(encrypted, context) !== JSON.stringify({ accessToken: 'fixture-only' })) {
        throw new Error('immutable image envelope round trip failed');
      }
      const migrationCount = database.sqlite.prepare(
        'select count(*) as count from __drizzle_migrations'
      ).get().count;
      if (migrationCount !== ${RELEASED_MIGRATION_COUNT}) {
        throw new Error('immutable image migration catalog mismatch');
      }
      if (database.sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw new Error('immutable image integrity check failed');
      }
      if (database.sqlite.pragma('foreign_key_check').length !== 0) {
        throw new Error('immutable image foreign key check failed');
      }
      const sqlite = database.sqlite.prepare(
        'select sqlite_version() as version, sqlite_source_id() as sourceId'
      ).get();
      database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      database.sqlite.pragma('journal_mode = DELETE');
      database.sqlite.exec('vacuum');
      metadata = {
        buildRevision: identity.revision,
        buildVersion: identity.version,
        migrationCount,
        sqliteSourceId: sqlite.sourceId,
        sqliteVersion: sqlite.version,
      };
    } finally {
      database.close();
    }
    chmodSync(output, 0o600);
    writeFileSync('/tmp/image-metadata.json', JSON.stringify(metadata), { mode: 0o600 });
    process.stdout.write('${readyMarker}\\n');
    setInterval(() => {}, 60000);
  `;
}

export function imageFixtureDockerCommands(options: ImageGenerationOptions) {
  if (
    !IMMUTABLE_IMAGE_PATTERN.test(options.imageReference) ||
    !READY_MARKER_PATTERN.test(options.readyMarker)
  ) {
    throw new Error("--image must be an immutable image digest reference.");
  }
  const hardening = [
    "--cap-drop",
    "ALL",
    "--cpus",
    "1",
    "--memory",
    "256m",
    "--network",
    "none",
    "--pids-limit",
    "128",
    "--read-only",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=65532,gid=65532",
    "--user",
    "65532:65532",
  ];
  return {
    copyArtifact: [
      "cp",
      `${options.containerName}:/tmp/v0.12.0.sqlite`,
      options.artifactOutputPath,
    ],
    copyMetadata: [
      "cp",
      `${options.containerName}:/tmp/image-metadata.json`,
      options.metadataOutputPath,
    ],
    create: [
      "create",
      "--name",
      options.containerName,
      ...hardening,
      "--entrypoint",
      "/nodejs/bin/node",
      options.imageReference,
      "--input-type=module",
      "--eval",
      containerProgram(options.readyMarker),
    ],
    inspectContainer: ["inspect", "--format", "{{json .State}}", options.containerName],
    inspectImage: ["image", "inspect", options.imageReference, "--format", "{{json .}}"],
    logs: ["logs", options.containerName],
    remove: ["rm", "--force", options.containerName],
    start: ["start", options.containerName],
  } as const;
}

function defaultWait(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function runImageFixtureDockerLifecycle(
  commands: ReturnType<typeof imageFixtureDockerCommands>,
  readyMarker: string,
  dependencies: ImageFixtureDockerLifecycleDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? defaultWait;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 250;
  const readyTimeoutMs = dependencies.readyTimeoutMs ?? 30_000;
  if (
    !READY_MARKER_PATTERN.test(readyMarker) ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    !Number.isSafeInteger(readyTimeoutMs) ||
    readyTimeoutMs < pollIntervalMs
  ) {
    throw new Error("Invalid immutable-image readiness policy.");
  }
  let created = false;
  try {
    dependencies.execute(commands.create, false);
    created = true;
    const inspected = JSON.parse(
      dependencies.execute(commands.inspectImage, true),
    ) as ImageInspectMetadata;
    dependencies.execute(commands.start, false);
    const deadline = now() + readyTimeoutMs;
    while (true) {
      const logs = dependencies.execute(commands.logs, true);
      const state = JSON.parse(
        dependencies.execute(commands.inspectContainer, true),
      ) as ContainerState;
      const ready = logs.split(/\r?\n/u).includes(readyMarker);
      if (ready) {
        if (state.Running !== true) {
          throw new Error("Immutable-image fixture exited after readiness before extraction.");
        }
        dependencies.execute(commands.copyArtifact, false);
        dependencies.execute(commands.copyMetadata, false);
        return inspected;
      }
      if (state.Running !== true) {
        throw new Error(
          `Immutable-image fixture exited before readiness (exit ${state.ExitCode ?? "unknown"}).`,
        );
      }
      if (now() >= deadline) throw new Error("Immutable-image fixture readiness timed out.");
      wait(pollIntervalMs);
    }
  } finally {
    if (created) dependencies.execute(commands.remove, false);
  }
}

function generateFromImage(imageReference: string, artifactPath: string, metadataPath: string) {
  const containerName = `omnifin-v012-fixture-${randomUUID()}`;
  const readyMarker = `OMNIFIN_V012_FIXTURE_READY_${randomUUID()}`;
  const commands = imageFixtureDockerCommands({
    artifactOutputPath: artifactPath,
    containerName,
    imageReference,
    metadataOutputPath: metadataPath,
    readyMarker,
  });
  const inspected = runImageFixtureDockerLifecycle(commands, readyMarker, {
    execute: (arguments_, captureOutput) =>
      captureOutput
        ? execFileSync("docker", [...arguments_], { encoding: "utf8" })
        : (execFileSync("docker", [...arguments_], { stdio: "inherit" }), ""),
  });
  chmodSync(artifactPath, 0o600);
  chmodSync(metadataPath, 0o600);
  return inspected;
}

export function v012FixtureSha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function v012HostSqliteMetadata() {
  const sqlite = new Database();
  try {
    return sqlite
      .prepare("select sqlite_version() as sqliteVersion, sqlite_source_id() as sqliteSourceId")
      .get() as { sqliteSourceId: string; sqliteVersion: string };
  } finally {
    sqlite.close();
  }
}

export async function validateV012FixtureWithCandidate(artifactPath: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "omnifin-v012-candidate-"));
  chmodSync(directory, 0o700);
  const databasePath = path.join(directory, "candidate.sqlite");
  const backupDirectory = path.join(directory, "backups");
  mkdirSync(backupDirectory, { mode: 0o700 });
  copyFileSync(artifactPath, databasePath);
  chmodSync(databasePath, 0o600);
  try {
    const database = await initializeDatabase({
      backupDirectory,
      backupRetentionCount: 2,
      databaseUrl: databasePath,
      rootKey: FIXTURE_KEY,
    });
    try {
      const count = (
        database.sqlite.prepare("select count(*) as count from __drizzle_migrations").get() as {
          count: number;
        }
      ).count;
      if (count !== readMigrationCatalog().length)
        throw new Error("candidate migration count mismatch");
      const encrypted = database.sqlite
        .prepare(
          "select encrypted_credentials as encrypted from connector_configs where id = 'jellyfin-fixture'",
        )
        .get() as { encrypted: string } | undefined;
      if (
        !encrypted ||
        new EnvelopeCipher(FIXTURE_KEY).decrypt(
          encrypted.encrypted,
          "connector_credentials:jellyfin:jellyfin-fixture",
        ) !== JSON.stringify({ accessToken: "fixture-only" })
      ) {
        throw new Error("candidate fixture decryption failed");
      }
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function stableV012FixtureJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function syncFile(filePath: string) {
  const descriptor = openSync(filePath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function publishV012FixtureAtomically(
  artifactPath: string,
  checksum: string,
  provenance: unknown,
  outputDirectory = fixtureDirectory,
) {
  const publishedFixturePath = path.join(outputDirectory, "v0.12.0.sqlite");
  const publishedChecksumPath = path.join(outputDirectory, "SHA256SUMS");
  const publishedProvenancePath = path.join(outputDirectory, "provenance.json");
  mkdirSync(outputDirectory, { mode: 0o700, recursive: true });
  const token = randomUUID();
  const stagedArtifact = path.join(outputDirectory, `.v0.12.0.sqlite.${token}.partial`);
  const stagedChecksum = path.join(outputDirectory, `.SHA256SUMS.${token}.partial`);
  const stagedProvenance = path.join(outputDirectory, `.provenance.json.${token}.partial`);
  const retiredArtifact = path.join(outputDirectory, `.v0.12.0.sqlite.${token}.retired`);
  const retiredChecksum = path.join(outputDirectory, `.SHA256SUMS.${token}.retired`);
  const retiredProvenance = path.join(outputDirectory, `.provenance.json.${token}.retired`);
  let hadOldSet = false;
  let newSetPublished = false;
  try {
    copyFileSync(artifactPath, stagedArtifact);
    chmodSync(stagedArtifact, 0o600);
    writeFileSync(stagedChecksum, checksum, { flag: "wx", mode: 0o600 });
    writeFileSync(stagedProvenance, stableV012FixtureJson(provenance), {
      flag: "wx",
      mode: 0o600,
    });
    for (const candidate of [stagedArtifact, stagedChecksum, stagedProvenance]) syncFile(candidate);
    const existing = [publishedFixturePath, publishedChecksumPath, publishedProvenancePath].filter(
      existsSync,
    );
    if (existing.length !== 0 && existing.length !== 3) {
      throw new Error("Existing fixture evidence is incomplete.");
    }
    if (existing.length === 3) {
      hadOldSet = true;
      renameSync(publishedProvenancePath, retiredProvenance);
      renameSync(publishedChecksumPath, retiredChecksum);
      renameSync(publishedFixturePath, retiredArtifact);
      syncFile(outputDirectory);
    }
    renameSync(stagedArtifact, publishedFixturePath);
    renameSync(stagedChecksum, publishedChecksumPath);
    renameSync(stagedProvenance, publishedProvenancePath);
    syncFile(outputDirectory);
    newSetPublished = true;
    for (const retired of [retiredArtifact, retiredChecksum, retiredProvenance]) {
      rmSync(retired, { force: true });
    }
    syncFile(outputDirectory);
  } catch (error) {
    if (hadOldSet && !newSetPublished) {
      for (const [retired, visible] of [
        [retiredArtifact, publishedFixturePath],
        [retiredChecksum, publishedChecksumPath],
        [retiredProvenance, publishedProvenancePath],
      ] as const) {
        if (!existsSync(retired)) continue;
        rmSync(visible, { force: true });
        renameSync(retired, visible);
      }
      syncFile(outputDirectory);
    }
    throw error;
  } finally {
    for (const candidate of [
      stagedArtifact,
      stagedChecksum,
      stagedProvenance,
      retiredArtifact,
      retiredChecksum,
      retiredProvenance,
    ]) {
      rmSync(candidate, { force: true });
    }
  }
}

export function existingV012FixtureProvenance(outputDirectory = fixtureDirectory) {
  try {
    return JSON.parse(readFileSync(path.join(outputDirectory, "provenance.json"), "utf8")) as {
      provisional?: unknown;
    };
  } catch {
    return undefined;
  }
}

async function run() {
  const arguments_ = process.argv.slice(2);
  const verifyOnly = arguments_.includes("--verify");
  const imageIndex = arguments_.indexOf("--image");
  const imageReference = imageIndex === -1 ? undefined : arguments_[imageIndex + 1];
  if (
    arguments_.some((argument, index) =>
      argument === "--verify" || argument === "--image" || index === imageIndex + 1 ? false : true,
    ) ||
    (imageIndex !== -1 && !imageReference)
  ) {
    throw new Error("Usage: generate-v012-fixture.ts [--verify] [--image <immutable-reference>]");
  }
  if (!imageReference && !verifyOnly && existingV012FixtureProvenance()?.provisional === false) {
    throw new Error("Source-only generation cannot overwrite non-provisional image evidence.");
  }

  const generatedDirectory = mkdtempSync(path.join(tmpdir(), "omnifin-v012-generate-"));
  chmodSync(generatedDirectory, 0o700);
  const generatedPath = path.join(generatedDirectory, "v0.12.0.sqlite");
  const imageMetadataPath = path.join(generatedDirectory, "image-metadata.json");
  try {
    let provenance: Record<string, unknown>;
    if (imageReference) {
      const image = generateFromImage(imageReference, generatedPath, imageMetadataPath);
      const container = JSON.parse(readFileSync(imageMetadataPath, "utf8")) as ContainerMetadata;
      provenance = {
        artifactSha256: v012FixtureSha256(generatedPath),
        buildRevision: container.buildRevision,
        buildVersion: container.buildVersion,
        fixtureEncryptionKeyBase64: FIXTURE_KEY_BASE64,
        generationMode: "image",
        generator: "apps/gateway/scripts/generate-v012-fixture.ts",
        generatorVersion: IMAGE_FIXTURE_GENERATOR_VERSION,
        imageIndexReference: imageReference,
        migrationCount: container.migrationCount,
        provisional: false,
        schemaVersion: 2,
        selectedPlatform: [image.Os, image.Architecture].filter(Boolean).join("/"),
        selectedPlatformImageDigests: [...(image.RepoDigests ?? [])].sort(),
        selectedPlatformImageId: image.Id ?? null,
        sourceCommit: SOURCE_COMMIT,
        sourceTag: "v0.12.0",
        sqliteSourceId: container.sqliteSourceId,
        sqliteVersion: container.sqliteVersion,
      };
    } else {
      generateV012FixtureFromSource(generatedPath);
      provenance = {
        artifactSha256: v012FixtureSha256(generatedPath),
        fixtureEncryptionKeyBase64: FIXTURE_KEY_BASE64,
        generationMode: "source",
        generator: "apps/gateway/scripts/generate-v012-fixture.ts",
        generatorVersion: IMAGE_FIXTURE_GENERATOR_VERSION,
        migrationCount: RELEASED_MIGRATION_COUNT,
        provisional: true,
        schemaVersion: 2,
        sourceCommit: SOURCE_COMMIT,
        sourceTag: "v0.12.0",
        ...v012HostSqliteMetadata(),
      };
    }
    await validateV012FixtureWithCandidate(generatedPath);
    const digest = v012FixtureSha256(generatedPath);
    const checksum = `${digest}  v0.12.0.sqlite\n`;
    if (verifyOnly) {
      if (!readFileSync(fixturePath).equals(readFileSync(generatedPath))) {
        throw new Error("The checked-in v0.12 fixture does not match regenerated evidence.");
      }
      if (readFileSync(checksumPath, "utf8") !== checksum) {
        throw new Error("The checked-in v0.12 fixture checksum is stale.");
      }
      if (readFileSync(provenancePath, "utf8") !== stableV012FixtureJson(provenance)) {
        throw new Error("The checked-in v0.12 fixture provenance is stale.");
      }
    } else {
      publishV012FixtureAtomically(generatedPath, checksum, provenance);
    }
    process.stdout.write(
      `${verifyOnly ? "Verified" : "Generated"} v0.12 fixture ${digest} (${imageReference ? "image evidence" : "source-generated provisional"}).\n`,
    );
  } finally {
    rmSync(generatedDirectory, { force: true, recursive: true });
  }
}

const executedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (executedPath === import.meta.url) await run();
