import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { chmodSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { databaseMaintenanceLockPath } from "./maintenance-lock.js";
import {
  inspectDatabaseFile,
  migrationDirectory,
  preflightDatabase,
  readMigrationCatalog,
} from "./migration-preflight.js";
import { constantTimeTextEqual, databaseKeyVerifier, EnvelopeCipher } from "../security/crypto.js";

const BACKUP_FORMAT = "omnifin-sqlite-backup";
const BACKUP_FORMAT_VERSION = 1;
const PRIVATE_MODE_MASK = 0o077;
const RETAINED_BACKUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RETAINED_BACKUP_FILE_PATTERN =
  /^omnifin-auto-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/;
const MAX_RETAINED_BACKUPS = 365;
const MIN_RETAINED_BACKUPS = 2;
const MAX_RETENTION_DIRECTORY_ENTRIES = 10_000;
const MAX_RETENTION_CANDIDATES = MAX_RETAINED_BACKUPS * 2;
const RETENTION_OVERLAP_GRACE_MS = 15 * 60 * 1_000;
const IMMUTABLE_IMAGE_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;

const backupManifestSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    databaseBytes: z.number().int().nonnegative(),
    databaseSha256: z.string().regex(/^[0-9a-f]{64}$/),
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    imageReference: z.union([
      z.literal("unknown"),
      z.string().max(512).regex(IMMUTABLE_IMAGE_PATTERN),
    ]),
    migrationCount: z.number().int().nonnegative(),
    retentionManaged: z.literal(true).optional(),
    schemaSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sqliteVersion: z.string().min(1).max(64),
  })
  .strict();

export type BackupManifest = z.infer<typeof backupManifestSchema>;

export type MaintenanceFailureCode =
  | "backup_already_exists"
  | "backup_directory_insecure"
  | "backup_failed"
  | "backup_integrity_failed"
  | "backup_manifest_invalid"
  | "backup_mismatch"
  | "backup_path_invalid"
  | "backup_retention_invalid"
  | "database_not_quiescent"
  | "database_path_invalid"
  | "database_maintenance_active"
  | "gateway_still_running"
  | "maintenance_lock_missing"
  | "restore_confirmation_required"
  | "restore_failed"
  | "restore_sanitization_failed"
  | "restore_target_not_empty";

export class MaintenanceError extends Error {
  readonly code: MaintenanceFailureCode;

  constructor(code: MaintenanceFailureCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "MaintenanceError";
    this.code = code;
  }
}

export interface BackupResult {
  bytes: number;
  databaseSha256: string;
  fileName: string;
  manifestFileName: string;
  migrationCount: number;
  schemaSha256: string;
}

export interface RetainedBackupResult {
  backup: BackupResult;
  retention: {
    candidates: number;
    deferred?: number;
    reason?:
      | "retention_candidate_limit_exceeded"
      | "retention_cleanup_failed"
      | "retention_delete_failed"
      | "retention_rollback_failed"
      | "retention_scan_failed"
      | "retention_scan_limit_exceeded"
      | "retention_set_invalid";
    removed: number;
    retained: number;
    state: "attention" | "ready";
    unavailable?: number;
  };
}

export interface RestoreResult {
  databaseSha256: string;
  restoredFileName: string;
  rollback: BackupResult;
  sanitizedDatabaseSha256: string;
  sourceDatabaseSha256: string;
}

export interface EmptyRestoreResult {
  databaseSha256: string;
  restoredFileName: string;
  sanitizedDatabaseSha256: string;
  sourceDatabaseSha256: string;
}

export interface MaintenanceLockResult {
  fileName: string;
}

interface DatabaseInspection {
  migrationCount: number;
  schemaSha256: string;
  sqliteVersion: string;
}

interface BackupOptions {
  cleanupGeneratedSourceSidecars?: boolean;
  databasePath: string;
  imageReference?: string;
  now?: Date;
  outputPath: string;
  retentionManaged?: boolean;
}

interface BackupDependencies {
  afterDatabaseRename?: () => Promise<void> | void;
  afterDatabaseStage?: () => Promise<void> | void;
  afterDatabaseSync?: () => Promise<void> | void;
  afterDatabasePublish?: () => Promise<void> | void;
  afterManifestRename?: () => Promise<void> | void;
  afterManifestStage?: () => Promise<void> | void;
  afterManifestSync?: () => Promise<void> | void;
  afterManifestPublish?: () => Promise<void> | void;
  beforeDatabasePublish?: () => Promise<void> | void;
  beforeManifestPublish?: () => Promise<void> | void;
}

interface RetainedBackupOptions {
  backupDirectory: string;
  cleanupGeneratedSourceSidecars?: boolean;
  createId?: () => string;
  databasePath: string;
  imageReference?: string;
  now?: Date;
  retentionCount: number;
  scanLimit?: number;
}

interface RetainedBackupDependencies {
  beforeBackupPublish?: () => Promise<void> | void;
  readDirectoryEntries?: typeof readBoundedDirectoryEntries;
  removeFile?: typeof unlink;
  renameFile?: typeof rename;
}

interface RestoreOptions {
  backupPath: string;
  confirmedGatewayStopped: boolean;
  databasePath: string;
  gatewayHealthUrl?: string;
  imageReference?: string;
  now?: Date;
  rootKey?: Buffer;
  rollbackOutputPath: string;
}

interface EmptyRestoreOptions {
  backupPath: string;
  confirmedEmptyTarget: boolean;
  confirmedGatewayStopped: boolean;
  databasePath: string;
  gatewayHealthUrl?: string;
  now?: Date;
  rootKey?: Buffer;
}

interface RestoreDependencies {
  afterPublish?: () => Promise<void> | void;
  sanitationFailpoint?: (sqlite: Database.Database) => void;
  syncPublishedDirectory?: (directory: string) => Promise<void>;
}

interface VerifyOptions {
  backupPath: string;
}

interface UnlockOptions {
  confirmedGatewayStopped: boolean;
  databasePath: string;
  gatewayHealthUrl?: string;
}

function wrapMaintenanceError(code: MaintenanceFailureCode, error: unknown) {
  if (error instanceof MaintenanceError) return error;
  return new MaintenanceError(code, { cause: error });
}

async function optionalUnlink(filePath: string) {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertPrivateDirectory(directory: string) {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(directory);
  } catch (error) {
    throw new MaintenanceError("backup_path_invalid", { cause: error });
  }
  if (!metadata.isDirectory()) throw new MaintenanceError("backup_path_invalid");
  const processUserId = process.getuid?.();
  if (
    (processUserId !== undefined && metadata.uid !== processUserId) ||
    (metadata.mode & PRIVATE_MODE_MASK) !== 0
  ) {
    throw new MaintenanceError("backup_directory_insecure");
  }
}

async function assertRegularPrivateFile(filePath: string, code: MaintenanceFailureCode) {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    throw new MaintenanceError(code, { cause: error });
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & PRIVATE_MODE_MASK) !== 0
  ) {
    throw new MaintenanceError(code);
  }
  return metadata;
}

async function assertDestinationAvailable(outputPath: string) {
  for (const candidate of [outputPath, manifestPath(outputPath)]) {
    try {
      await lstat(candidate);
      throw new MaintenanceError("backup_already_exists");
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new MaintenanceError("backup_path_invalid", { cause: error });
      }
    }
  }
}

function manifestPath(backupPath: string) {
  return `${backupPath}.manifest.json`;
}

async function sha256File(filePath: string) {
  const digest = createHash("sha256");
  const file = await open(filePath, "r");
  try {
    for await (const chunk of file.readableWebStream()) {
      digest.update(Buffer.from(chunk));
    }
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

async function syncFile(filePath: string) {
  const file = await open(filePath, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireMaintenanceLock(databasePath: string) {
  const lockPath = databaseMaintenanceLockPath(databasePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.sync();
    await syncDirectory(path.dirname(databasePath));
  } catch (error) {
    await handle?.close();
    if (handle) await optionalUnlink(lockPath);
    throw new MaintenanceError("database_maintenance_active", { cause: error });
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle?.close();
  };
  return {
    release: async () => {
      await close();
      await optionalUnlink(lockPath);
      await syncDirectory(path.dirname(databasePath));
    },
    retain: async () => {
      await close();
      await syncDirectory(path.dirname(databasePath));
    },
  };
}

function inspectDatabase(databasePath: string): DatabaseInspection {
  try {
    const inspected = inspectDatabaseFile(
      databasePath,
      { stagingDirectory: path.dirname(databasePath) },
      (sqlite) => {
        const integrityRows = sqlite.pragma("integrity_check") as Record<string, unknown>[];
        if (
          integrityRows.length !== 1 ||
          Object.values(integrityRows[0] ?? {}).length !== 1 ||
          Object.values(integrityRows[0] ?? {})[0] !== "ok"
        ) {
          throw new MaintenanceError("backup_integrity_failed");
        }
        const foreignKeyFailures = sqlite.pragma("foreign_key_check") as unknown[];
        if (foreignKeyFailures.length > 0) throw new MaintenanceError("backup_integrity_failed");

        const migrationTable = sqlite
          .prepare(
            "select count(*) as count from sqlite_schema where type = 'table' and name = '__drizzle_migrations'",
          )
          .get() as { count: number };
        if (migrationTable.count !== 1) throw new MaintenanceError("backup_integrity_failed");

        const migrationRow = sqlite
          .prepare("select count(*) as count from __drizzle_migrations")
          .get() as { count: number };
        const schemaRows = sqlite
          .prepare(
            "select name, sql, type from sqlite_schema where name not like 'sqlite_%' order by type, name",
          )
          .all();
        const sqliteVersion = sqlite.prepare("select sqlite_version() as version").get() as {
          version: string;
        };

        return {
          migrationCount: migrationRow.count,
          schemaSha256: createHash("sha256").update(JSON.stringify(schemaRows)).digest("hex"),
          sqliteVersion: sqliteVersion.version,
        };
      },
    );
    if (inspected.hadSidecars) throw new MaintenanceError("backup_integrity_failed");
    return inspected.result;
  } catch (error) {
    throw wrapMaintenanceError("backup_integrity_failed", error);
  }
}

async function readAndValidateManifest(backupPath: string) {
  await assertPrivateDirectory(path.dirname(backupPath));
  await assertRegularPrivateFile(backupPath, "backup_path_invalid");
  await assertRegularPrivateFile(manifestPath(backupPath), "backup_manifest_invalid");

  let manifest: BackupManifest;
  try {
    manifest = backupManifestSchema.parse(
      JSON.parse(await readFile(manifestPath(backupPath), "utf8")),
    );
  } catch (error) {
    throw new MaintenanceError("backup_manifest_invalid", { cause: error });
  }

  const metadata = await stat(backupPath);
  const databaseSha256 = await sha256File(backupPath);
  if (metadata.size !== manifest.databaseBytes || databaseSha256 !== manifest.databaseSha256) {
    throw new MaintenanceError("backup_mismatch");
  }

  const inspection = inspectDatabase(backupPath);
  if (
    inspection.migrationCount !== manifest.migrationCount ||
    inspection.schemaSha256 !== manifest.schemaSha256
  ) {
    throw new MaintenanceError("backup_mismatch");
  }
  return { inspection, manifest };
}

function resolvedFilePath(value: string, failureCode: MaintenanceFailureCode) {
  if (!value || value === ":memory:") throw new MaintenanceError(failureCode);
  return path.resolve(value);
}

function retainedBackupFileName(now: Date, id: string) {
  if (Number.isNaN(now.getTime()) || !RETAINED_BACKUP_ID_PATTERN.test(id)) {
    throw new MaintenanceError("backup_retention_invalid");
  }
  const timestamp = retainedBackupTimestamp(now);
  return `omnifin-auto-${timestamp}-${id}.sqlite`;
}

function retainedBackupTimestamp(now: Date) {
  return now.toISOString().replaceAll(/[-:.]/g, "");
}

async function readBoundedDirectoryEntries(directory: string, limit: number) {
  const entries: string[] = [];
  const handle = await opendir(directory);
  try {
    while (true) {
      const entry = await handle.read();
      if (!entry) return { entries, exceeded: false };
      if (entries.length >= limit) return { entries, exceeded: true };
      entries.push(entry.name);
    }
  } finally {
    await handle.close();
  }
}

async function applyRetainedBackupLimit(
  backupDirectory: string,
  currentBackupPath: string,
  currentCreatedAt: number,
  retentionCount: number,
  scanLimit: number,
  dependencies: Required<Omit<RetainedBackupDependencies, "beforeBackupPublish">>,
) {
  let scan: Awaited<ReturnType<typeof readBoundedDirectoryEntries>>;
  try {
    scan = await dependencies.readDirectoryEntries(backupDirectory, scanLimit);
  } catch {
    return {
      candidates: 0,
      reason: "retention_scan_failed" as const,
      removed: 0,
      retained: 0,
      state: "attention" as const,
    };
  }
  if (scan.exceeded) {
    return {
      candidates: 0,
      reason: "retention_scan_limit_exceeded" as const,
      removed: 0,
      retained: 0,
      state: "attention" as const,
    };
  }
  const entries = scan.entries;
  const backupFileNames = entries.filter((fileName) => RETAINED_BACKUP_FILE_PATTERN.test(fileName));
  const manifestBackupFileNames = entries
    .filter((fileName) => fileName.endsWith(".manifest.json"))
    .map((fileName) => fileName.slice(0, -".manifest.json".length))
    .filter((fileName) => RETAINED_BACKUP_FILE_PATTERN.test(fileName));
  const fileNames = [...new Set([...backupFileNames, ...manifestBackupFileNames])];
  if (fileNames.length > MAX_RETENTION_CANDIDATES) {
    return {
      candidates: fileNames.length,
      reason: "retention_candidate_limit_exceeded" as const,
      removed: 0,
      retained: fileNames.length,
      state: "attention" as const,
    };
  }
  const backupFileNameSet = new Set(backupFileNames);
  const manifestBackupFileNameSet = new Set(manifestBackupFileNames);
  if (
    fileNames.some(
      (fileName) => !backupFileNameSet.has(fileName) || !manifestBackupFileNameSet.has(fileName),
    )
  ) {
    return {
      candidates: fileNames.length,
      reason: "retention_set_invalid" as const,
      removed: 0,
      retained: fileNames.length,
      state: "attention" as const,
    };
  }
  const candidates: { backupPath: string; createdAt: string }[] = [];
  for (const fileName of fileNames) {
    try {
      const backupPath = path.join(backupDirectory, fileName);
      const verified = await readAndValidateManifest(backupPath);
      if (verified.manifest.retentionManaged !== true) {
        throw new MaintenanceError("backup_manifest_invalid");
      }
      const expectedPrefix = `omnifin-auto-${retainedBackupTimestamp(
        new Date(verified.manifest.createdAt),
      )}-`;
      if (!fileName.startsWith(expectedPrefix)) {
        throw new MaintenanceError("backup_manifest_invalid");
      }
      candidates.push({ backupPath, createdAt: verified.manifest.createdAt });
    } catch {
      return {
        candidates: fileNames.length,
        reason: "retention_set_invalid" as const,
        removed: 0,
        retained: fileNames.length,
        state: "attention" as const,
      };
    }
  }
  candidates.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.backupPath.localeCompare(right.backupPath),
  );
  const retained = candidates.slice(-retentionCount);
  if (!retained.some((candidate) => candidate.backupPath === currentBackupPath)) {
    retained.shift();
    const current = candidates.find((candidate) => candidate.backupPath === currentBackupPath);
    if (!current) {
      return {
        candidates: candidates.length,
        reason: "retention_set_invalid" as const,
        removed: 0,
        retained: candidates.length,
        state: "attention" as const,
      };
    }
    retained.push(current);
  }
  const retainedPaths = new Set(retained.map((candidate) => candidate.backupPath));
  for (const candidate of candidates) {
    if (
      Math.abs(Date.parse(candidate.createdAt) - currentCreatedAt) <= RETENTION_OVERLAP_GRACE_MS
    ) {
      retainedPaths.add(candidate.backupPath);
    }
  }
  const expired = candidates.filter((candidate) => !retainedPaths.has(candidate.backupPath));
  let removed = 0;
  for (const candidate of expired) {
    const token = randomUUID();
    const retiredBackupPath = path.join(
      backupDirectory,
      `.${path.basename(candidate.backupPath)}.${token}.retired`,
    );
    const retiredManifestPath = `${retiredBackupPath}.manifest.json`;
    let backupMoved = false;
    let manifestMoved = false;
    try {
      await dependencies.renameFile(manifestPath(candidate.backupPath), retiredManifestPath);
      manifestMoved = true;
      await dependencies.renameFile(candidate.backupPath, retiredBackupPath);
      backupMoved = true;
      await syncDirectory(backupDirectory);
    } catch {
      let rollbackFailed = false;
      if (backupMoved) {
        try {
          await dependencies.renameFile(retiredBackupPath, candidate.backupPath);
        } catch {
          rollbackFailed = true;
        }
      }
      if (manifestMoved) {
        try {
          await dependencies.renameFile(retiredManifestPath, manifestPath(candidate.backupPath));
        } catch {
          rollbackFailed = true;
        }
      }
      if (backupMoved || manifestMoved) {
        try {
          await syncDirectory(backupDirectory);
        } catch {
          rollbackFailed = true;
        }
      }
      return {
        candidates: candidates.length,
        reason: rollbackFailed
          ? ("retention_rollback_failed" as const)
          : ("retention_delete_failed" as const),
        removed,
        retained: candidates.length - removed - (rollbackFailed ? 1 : 0),
        state: "attention" as const,
        ...(rollbackFailed ? { unavailable: 1 } : {}),
      };
    }
    removed += 1;
    try {
      await dependencies.removeFile(retiredManifestPath);
      await dependencies.removeFile(retiredBackupPath);
      await syncDirectory(backupDirectory);
    } catch {
      return {
        candidates: candidates.length,
        reason: "retention_cleanup_failed" as const,
        removed,
        retained: candidates.length - removed,
        state: "attention" as const,
      };
    }
  }
  const deferred = Math.max(0, retainedPaths.size - retentionCount);
  return {
    candidates: candidates.length,
    ...(deferred > 0 ? { deferred } : {}),
    removed,
    retained: retainedPaths.size,
    state: "ready" as const,
  };
}

async function assertDistinctPaths(...filePaths: string[]) {
  if (new Set(filePaths).size !== filePaths.length) {
    throw new MaintenanceError("backup_path_invalid");
  }
  const parentPaths = await Promise.all(
    filePaths.map((filePath) => realpath(path.dirname(filePath))),
  );
  for (let index = 0; index < filePaths.length; index += 1) {
    filePaths[index] = path.join(parentPaths[index]!, path.basename(filePaths[index]!));
  }
  if (new Set(filePaths).size !== filePaths.length) {
    throw new MaintenanceError("backup_path_invalid");
  }
}

export async function createDatabaseBackup(
  options: BackupOptions,
  dependencies: BackupDependencies = {},
): Promise<BackupResult> {
  const databasePath = resolvedFilePath(options.databasePath, "database_path_invalid");
  const outputPath = resolvedFilePath(options.outputPath, "backup_path_invalid");
  const outputDirectory = path.dirname(outputPath);
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(outputPath)}.${randomUUID()}.partial`,
  );
  const temporaryManifestPath = `${temporaryPath}.manifest.json`;
  let outputCreated = false;
  let manifestCreated = false;
  let sqlite: Database.Database | undefined;
  let sourceSidecarsMayBeGenerated = false;

  try {
    await assertDistinctPaths(databasePath, outputPath);
    await assertPrivateDirectory(path.dirname(databasePath));
    await assertPrivateDirectory(outputDirectory);
    await assertDestinationAvailable(outputPath);
    await assertRegularPrivateFile(databasePath, "database_path_invalid");
    if (options.cleanupGeneratedSourceSidecars) {
      await assertDatabaseQuiescent(databasePath);
      sourceSidecarsMayBeGenerated = true;
    }

    sqlite = new Database(databasePath, { fileMustExist: true, readonly: true });
    sqlite.pragma("busy_timeout = 5000");
    await sqlite.backup(temporaryPath);
    sqlite.close();
    sqlite = undefined;
    if (sourceSidecarsMayBeGenerated) {
      for (const suffix of ["-wal", "-shm"]) await optionalUnlink(`${databasePath}${suffix}`);
      await syncDirectory(path.dirname(databasePath));
    }

    await chmod(temporaryPath, 0o600);
    const inspection = inspectDatabase(temporaryPath);
    const databaseSha256 = await sha256File(temporaryPath);
    const metadata = await stat(temporaryPath);
    const manifest = backupManifestSchema.parse({
      createdAt: (options.now ?? new Date()).toISOString(),
      databaseBytes: metadata.size,
      databaseSha256,
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      imageReference: options.imageReference?.trim() || "unknown",
      migrationCount: inspection.migrationCount,
      ...(options.retentionManaged ? { retentionManaged: true as const } : {}),
      schemaSha256: inspection.schemaSha256,
      sqliteVersion: inspection.sqliteVersion,
    });

    await syncFile(temporaryPath);
    await dependencies.afterDatabaseStage?.();
    await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(temporaryManifestPath);
    await dependencies.afterManifestStage?.();
    await assertDestinationAvailable(outputPath);
    await dependencies.beforeDatabasePublish?.();
    await rename(temporaryPath, outputPath);
    outputCreated = true;
    await dependencies.afterDatabaseRename?.();
    await dependencies.afterDatabasePublish?.();
    await syncDirectory(outputDirectory);
    await dependencies.afterDatabaseSync?.();
    await dependencies.beforeManifestPublish?.();
    await rename(temporaryManifestPath, manifestPath(outputPath));
    manifestCreated = true;
    await dependencies.afterManifestRename?.();
    await dependencies.afterManifestPublish?.();
    await syncDirectory(outputDirectory);
    await dependencies.afterManifestSync?.();

    return {
      bytes: metadata.size,
      databaseSha256,
      fileName: path.basename(outputPath),
      manifestFileName: path.basename(manifestPath(outputPath)),
      migrationCount: inspection.migrationCount,
      schemaSha256: inspection.schemaSha256,
    };
  } catch (error) {
    const primary = wrapMaintenanceError("backup_failed", error);
    const cleanupErrors: unknown[] = [];
    if (sqlite) {
      try {
        sqlite.close();
        sqlite = undefined;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (sourceSidecarsMayBeGenerated) {
      for (const suffix of ["-wal", "-shm"]) {
        try {
          await optionalUnlink(`${databasePath}${suffix}`);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await syncDirectory(path.dirname(databasePath));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    for (const candidate of [
      temporaryManifestPath,
      temporaryPath,
      ...(manifestCreated ? [manifestPath(outputPath)] : []),
      ...(outputCreated ? [outputPath] : []),
    ]) {
      try {
        await optionalUnlink(candidate);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (manifestCreated || outputCreated) {
      try {
        await syncDirectory(outputDirectory);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primary, ...cleanupErrors], "backup_failed");
    }
    throw primary;
  } finally {
    sqlite?.close();
    for (const candidate of [temporaryManifestPath, temporaryPath]) {
      try {
        await optionalUnlink(candidate);
      } catch {
        // The error path already attempted and preserved each independent cleanup failure.
      }
    }
  }
}

export async function createRetainedDatabaseBackup(
  options: RetainedBackupOptions,
  dependencies: RetainedBackupDependencies = {},
): Promise<RetainedBackupResult> {
  if (
    !Number.isInteger(options.retentionCount) ||
    options.retentionCount < MIN_RETAINED_BACKUPS ||
    options.retentionCount > MAX_RETAINED_BACKUPS ||
    (options.scanLimit !== undefined &&
      (!Number.isInteger(options.scanLimit) ||
        options.scanLimit < 1 ||
        options.scanLimit > MAX_RETENTION_DIRECTORY_ENTRIES))
  ) {
    throw new MaintenanceError("backup_retention_invalid");
  }

  const now = options.now ?? new Date();
  const fileName = retainedBackupFileName(now, (options.createId ?? randomUUID)());
  const backupPath = path.join(
    resolvedFilePath(options.backupDirectory, "backup_path_invalid"),
    fileName,
  );
  const backup = await createDatabaseBackup(
    {
      ...(options.cleanupGeneratedSourceSidecars ? { cleanupGeneratedSourceSidecars: true } : {}),
      databasePath: options.databasePath,
      outputPath: backupPath,
      ...(options.imageReference ? { imageReference: options.imageReference } : {}),
      now,
      retentionManaged: true,
    },
    dependencies.beforeBackupPublish
      ? { beforeDatabasePublish: dependencies.beforeBackupPublish }
      : {},
  );
  await verifyDatabaseBackup({ backupPath });

  return {
    backup,
    retention: await applyRetainedBackupLimit(
      path.dirname(backupPath),
      backupPath,
      now.getTime(),
      options.retentionCount,
      options.scanLimit ?? MAX_RETENTION_DIRECTORY_ENTRIES,
      {
        readDirectoryEntries: dependencies.readDirectoryEntries ?? readBoundedDirectoryEntries,
        removeFile: dependencies.removeFile ?? unlink,
        renameFile: dependencies.renameFile ?? rename,
      },
    ),
  };
}

export async function verifyDatabaseBackup(options: VerifyOptions): Promise<BackupResult> {
  const backupPath = resolvedFilePath(options.backupPath, "backup_path_invalid");
  const { inspection, manifest } = await readAndValidateManifest(backupPath);
  return {
    bytes: manifest.databaseBytes,
    databaseSha256: manifest.databaseSha256,
    fileName: path.basename(backupPath),
    manifestFileName: path.basename(manifestPath(backupPath)),
    migrationCount: inspection.migrationCount,
    schemaSha256: inspection.schemaSha256,
  };
}

async function gatewayIsRunning(healthUrl: string | undefined) {
  if (!healthUrl) return false;
  try {
    await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function assertDatabaseQuiescent(databasePath: string) {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await lstat(`${databasePath}${suffix}`);
      throw new MaintenanceError("database_not_quiescent");
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new MaintenanceError("database_not_quiescent", { cause: error });
      }
    }
  }
}

function safeRestoreTime(now: Date | undefined) {
  const value = (now ?? new Date()).getTime();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new MaintenanceError("restore_sanitization_failed");
  }
  return value;
}

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function restoreRootKey(explicitRootKey: Buffer | undefined) {
  if (explicitRootKey) {
    if (explicitRootKey.length !== 32) throw new MaintenanceError("restore_sanitization_failed");
    return explicitRootKey;
  }
  const value = process.env.OMNIFIN_ENCRYPTION_KEY;
  const file = process.env.OMNIFIN_ENCRYPTION_KEY_FILE;
  if ((value && file) || (!value && !file)) return undefined;
  let encoded: string;
  try {
    encoded = value ?? readFileSync(file!, "utf8").trim();
  } catch (error) {
    throw new MaintenanceError("restore_sanitization_failed", { cause: error });
  }
  if (encoded.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(encoded)) {
    throw new MaintenanceError("restore_sanitization_failed");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    decoded.fill(0);
    throw new MaintenanceError("restore_sanitization_failed");
  }
  return decoded;
}

export function resolveRestoreRootKey() {
  const rootKey = restoreRootKey(undefined);
  if (!rootKey) throw new MaintenanceError("restore_sanitization_failed");
  return rootKey;
}

function initializeStagedKeyVerifier(sqlite: Database.Database, rootKey: Buffer) {
  const expected = databaseKeyVerifier(rootKey);
  sqlite.transaction(() => {
    const rows = sqlite
      .prepare("select id, format_version as formatVersion, verifier from database_key_verifiers")
      .all() as { formatVersion: number; id: number; verifier: string }[];
    if (rows.length === 0) {
      sqlite
        .prepare(
          "insert into database_key_verifiers (id, format_version, verifier) values (1, 1, ?)",
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
      throw new MaintenanceError("restore_sanitization_failed");
    }
  })();
}

function migrateStagedRestoreDatabase(
  databasePath: string,
  migrationCount: number,
  explicitRootKey: Buffer | undefined,
) {
  const catalog = readMigrationCatalog();
  if (migrationCount === catalog.length) return;
  const rootKey = restoreRootKey(explicitRootKey);
  if (!rootKey) throw new MaintenanceError("restore_sanitization_failed");
  const ownsRootKey = rootKey !== explicitRootKey;
  let sqlite: Database.Database | undefined;
  try {
    const before = preflightDatabase(databasePath, rootKey, {
      stagingDirectory: path.dirname(databasePath),
    });
    if (before.appliedMigrationCount !== migrationCount || !before.migrationsPending) {
      throw new MaintenanceError("restore_sanitization_failed");
    }
    sqlite = new Database(databasePath, { fileMustExist: true });
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder: migrationDirectory() });
    initializeStagedKeyVerifier(sqlite, rootKey);
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.pragma("journal_mode = DELETE");
    sqlite.close();
    sqlite = undefined;
    const after = preflightDatabase(databasePath, rootKey, {
      stagingDirectory: path.dirname(databasePath),
    });
    if (after.kind !== "current" || after.appliedMigrationCount !== catalog.length) {
      throw new MaintenanceError("restore_sanitization_failed");
    }
  } catch (error) {
    throw wrapMaintenanceError("restore_sanitization_failed", error);
  } finally {
    sqlite?.close();
    if (ownsRootKey) rootKey.fill(0);
  }
}

function expireLastUsedReference(
  sqlite: Database.Database,
  table: string,
  now: number,
  preserveFutureRows = false,
) {
  if (!preserveFutureRows) sqlite.exec(`delete from ${table} where last_used_at >= ${now}`);
  sqlite.exec(
    `update ${table}
     set expires_at = ${now}, updated_at = max(updated_at, ${now})
     where last_used_at < ${now}`,
  );
}

function expireCreatedReference(sqlite: Database.Database, table: string, now: number) {
  sqlite.exec(`delete from ${table} where created_at >= ${now}`);
  sqlite.exec(
    `update ${table}
     set expires_at = ${now}, updated_at = max(updated_at, ${now})
     where created_at < ${now}`,
  );
}

function quoteIdentifier(identifier: string) {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new MaintenanceError("restore_sanitization_failed");
  }
  return `"${identifier}"`;
}

function mergeIdempotencyReceipts(sqlite: Database.Database) {
  const tables = sqlite
    .prepare(
      `select name from rollback_timeline.sqlite_schema
       where type = 'table' and name like '%_operations' order by name`,
    )
    .pluck()
    .all() as string[];
  for (const table of tables) {
    const quotedTable = quoteIdentifier(table);
    const mainExists = sqlite
      .prepare("select 1 from main.sqlite_schema where type = 'table' and name = ?")
      .get(table);
    if (!mainExists) continue;
    const mainColumns = sqlite.pragma(`main.table_info(${quotedTable})`) as { name: string }[];
    const rollbackColumns = sqlite.pragma(`rollback_timeline.table_info(${quotedTable})`) as {
      name: string;
    }[];
    const columns = mainColumns.map(({ name }) => name);
    if (
      !columns.includes("user_id") ||
      !columns.includes("idempotency_key_hash") ||
      columns.length !== rollbackColumns.length ||
      columns.some((column, index) => rollbackColumns[index]?.name !== column)
    ) {
      continue;
    }
    const rows = sqlite
      .prepare(
        `select * from rollback_timeline.${quotedTable}
         where idempotency_key_hash is not null
         order by user_id, idempotency_key_hash`,
      )
      .all() as Record<string, unknown>[];
    const deleteReceipt = sqlite.prepare(
      `delete from main.${quotedTable} where user_id = ? and idempotency_key_hash = ?`,
    );
    const quotedColumns = columns.map(quoteIdentifier).join(", ");
    const insertReceipt = sqlite.prepare(
      `insert into main.${quotedTable} (${quotedColumns})
       values (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      const userId = row.user_id;
      const keyHash = row.idempotency_key_hash;
      if (typeof userId !== "string" || typeof keyHash !== "string") {
        throw new MaintenanceError("restore_sanitization_failed");
      }
      if (!sqlite.prepare("select 1 from main.users where id = ?").get(userId)) continue;
      sqlite.exec("savepoint omnifin_receipt_merge");
      try {
        deleteReceipt.run(userId, keyHash);
        insertReceipt.run(...columns.map((column) => row[column]));
        sqlite.exec("release omnifin_receipt_merge");
      } catch (error) {
        sqlite.exec("rollback to omnifin_receipt_merge");
        sqlite.exec("release omnifin_receipt_merge");
        throw new MaintenanceError("restore_sanitization_failed", { cause: error });
      }
    }
  }
}

function mergeRollbackExternalMutationFacts(sqlite: Database.Database) {
  sqlite.exec(`
    delete from main.download_queue_item_operations as restored
    where exists (
      select 1 from rollback_timeline.download_queue_item_operations current
      where current.id = restored.id
        or (current.bulk_operation_id is not null
          and current.bulk_operation_id = restored.bulk_operation_id
          and current.kind = restored.kind
          and current.item_digest = restored.item_digest)
    );

    insert into main.download_queue_item_operations (
      id, bulk_operation_id, user_id, connector_id, connector_instance_generation,
      connector_config_generation, item_digest, kind, idempotency_key_hash,
      fingerprint_hash, state, failure_code, completed_at, created_at, updated_at
    ) select
      current.id, current.bulk_operation_id, current.user_id, current.connector_id,
      current.connector_instance_generation, current.connector_config_generation,
      current.item_digest, current.kind, current.idempotency_key_hash,
      current.fingerprint_hash, current.state, current.failure_code,
      current.completed_at, current.created_at, current.updated_at
    from rollback_timeline.download_queue_item_operations current
    join main.users user on user.id = current.user_id
    join main.connector_configs connector on connector.id = current.connector_id
    left join main.download_queue_bulk_operations bulk on bulk.id = current.bulk_operation_id
    where current.bulk_operation_id is null or bulk.id is not null;

    delete from main.playback_progress_operations as restored
    where exists (
      select 1 from rollback_timeline.playback_progress_operations current
      where current.playback_session_id = restored.playback_session_id
        and current.session_revision = restored.session_revision
    );

    insert into main.playback_progress_operations (
      id, playback_session_id, session_revision, user_id, connector_id,
      connector_instance_generation, connector_config_generation, position_seconds,
      state, failure_code, completed_at, created_at, updated_at
    ) select
      id, playback_session_id, session_revision, user_id, connector_id,
      connector_instance_generation, connector_config_generation, position_seconds,
      state, failure_code, completed_at, created_at, updated_at
    from rollback_timeline.playback_progress_operations;

    delete from main.external_mutation_dispatches as restored
    where exists (
      select 1 from rollback_timeline.external_mutation_dispatches current
      where current.parent_operation_type = restored.parent_operation_type
        and current.parent_operation_id = restored.parent_operation_id
        and current.kind = restored.kind
    );

    insert into main.external_mutation_dispatches (
      id, kind, parent_operation_type, parent_operation_id, user_id, connector_id,
      connector_instance_generation, connector_config_generation, state,
      encrypted_normalized_request, lease_owner, lease_expires_at,
      dispatch_attempt_count, dispatched_at, reconcile_required_at, uncertain_at,
      completed_at, failure_code, created_at, updated_at
    ) select
      id, kind, parent_operation_type, parent_operation_id, user_id, connector_id,
      connector_instance_generation, connector_config_generation, state,
      encrypted_normalized_request, lease_owner, lease_expires_at,
      dispatch_attempt_count, dispatched_at, reconcile_required_at, uncertain_at,
      completed_at, failure_code, created_at, updated_at
    from rollback_timeline.external_mutation_dispatches;

    delete from main.external_mutation_target_locks as restored
    where exists (
      select 1 from rollback_timeline.external_mutation_target_locks current
      where current.target_scope = restored.target_scope
        and current.target_digest = restored.target_digest
    );

    insert into main.external_mutation_target_locks (
      target_scope, target_digest, owner_dispatch_id, acquired_at
    ) select target_scope, target_digest, owner_dispatch_id, acquired_at
      from rollback_timeline.external_mutation_target_locks;
  `);
}

function mergeRollbackInvitationFacts(sqlite: Database.Database, now: number) {
  sqlite.exec(`
    update main.invitations as restored
    set consumed_at = case
          when current.consumed_at is not null then
            max(restored.created_at, min(current.consumed_at, restored.expires_at - 1))
          when current.revoked_at is not null then null
          when restored.consumed_at is not null then restored.consumed_at
          else null
        end,
        revoked_at = case
          when current.consumed_at is not null then null
          when current.revoked_at is not null then
            max(restored.created_at, min(current.revoked_at, restored.expires_at - 1))
          when restored.consumed_at is not null then null
          when restored.revoked_at is not null then restored.revoked_at
          else max(restored.created_at, min(${now}, restored.expires_at - 1))
        end,
        registration_handoff_hash = null,
        registration_handoff_expires_at = null
    from rollback_timeline.invitations current
    where current.id = restored.id;

    update main.invitations as restored
    set revoked_at = max(restored.created_at, min(${now}, restored.expires_at - 1)),
        registration_handoff_hash = null,
        registration_handoff_expires_at = null
    where restored.consumed_at is null
      and restored.revoked_at is null;
  `);
}

function sanitizeJellyfinActivationOperations(sqlite: Database.Database, now: number) {
  const exists = sqlite
    .prepare(
      "select 1 from main.sqlite_schema where type = 'table' and name = 'jellyfin_activation_operations'",
    )
    .get();
  if (!exists) return;
  const cleanupExists = sqlite
    .prepare(
      "select 1 from main.sqlite_schema where type = 'table' and name = 'jellyfin_activation_cleanup_reservations'",
    )
    .get();
  if (cleanupExists) {
    sqlite.exec(`
      update main.jellyfin_activation_cleanup_reservations
      set state = 'uncertain', updated_at = max(updated_at, ${now})
      where state = 'dispatched';
    `);
  }
  sqlite.exec(`
    update main.jellyfin_activation_operations
    set state = case when state in ('manual_required', 'tombstoned') then state else 'manual_required' end,
        encrypted_stage_artifact = null, artifact_revision = artifact_revision + 1,
        cleanup_eligible = 0,
        lease_owner = null, lease_expires_at = null,
        failure_code = case when state = 'tombstoned' then failure_code else 'restore_sanitized' end,
        manual_required_at = case when state = 'tombstoned' then manual_required_at else max(created_at, ${now}) end,
        tombstoned_at = case when state = 'tombstoned' then tombstoned_at else null end,
        revision = revision + 1, updated_at = max(updated_at, created_at, ${now});
  `);
}

function mergeRollbackJellyfinActivationFacts(sqlite: Database.Database, now: number) {
  const exists = sqlite
    .prepare(
      "select 1 from main.sqlite_schema where type = 'table' and name = 'jellyfin_activation_operations'",
    )
    .get();
  const rollbackExists = sqlite
    .prepare(
      "select 1 from rollback_timeline.sqlite_schema where type = 'table' and name = 'jellyfin_activation_operations'",
    )
    .get();
  if (!exists || !rollbackExists) return;
  const cleanupExists = sqlite
    .prepare(
      "select 1 from main.sqlite_schema where type = 'table' and name = 'jellyfin_activation_cleanup_reservations'",
    )
    .get();
  if (cleanupExists) sqlite.exec("delete from main.jellyfin_activation_cleanup_reservations");
  sqlite.exec(`
    delete from main.jellyfin_activation_operations as collision
    where exists (
      select 1
      from rollback_timeline.jellyfin_activation_operations current
      where current.id = collision.id
         or current.invitation_id = collision.invitation_id
         or current.user_id = collision.user_id
         or current.external_identity_id = collision.external_identity_id
    )
      and not exists (
        select 1 from main.service_identity_links link
        where link.provisioned_by_activation_id = collision.id
      );
    delete from main.jellyfin_activation_operations as restored
    where not exists (select 1 from rollback_timeline.jellyfin_activation_operations current where current.id = restored.id)
      and not exists (select 1 from rollback_timeline.jellyfin_activation_operations current where current.invitation_id = restored.invitation_id)
      and not exists (select 1 from rollback_timeline.jellyfin_activation_operations current where current.user_id = restored.user_id)
      and not exists (select 1 from rollback_timeline.jellyfin_activation_operations current where current.external_identity_id = restored.external_identity_id)
      and not exists (select 1 from main.service_identity_links link where link.provisioned_by_activation_id = restored.id);
    insert into main.jellyfin_activation_operations
      select * from rollback_timeline.jellyfin_activation_operations current
      where exists (select 1 from main.invitations where id = current.invitation_id)
        and exists (select 1 from main.users where id = current.user_id)
        and exists (select 1 from main.external_identities where id = current.external_identity_id and user_id = current.user_id)
        and exists (select 1 from main.connector_configs where id = current.connector_id)
        and not exists (select 1 from main.jellyfin_activation_operations existing where existing.id = current.id or existing.invitation_id = current.invitation_id or existing.user_id = current.user_id or existing.external_identity_id = current.external_identity_id);
  `);
  sanitizeJellyfinActivationOperations(sqlite, now);
}

function provisioningCipher(rootKey: Buffer | undefined) {
  if (!rootKey || rootKey.length !== 32) throw new MaintenanceError("restore_sanitization_failed");
  return new EnvelopeCipher(rootKey);
}

function parseProvisioningPayload(
  cipher: EnvelopeCipher,
  row: {
    connectorId: string;
    connectorRevision: string;
    instanceGeneration: number;
    identityHash: string | null;
    encryptedConfiguration: string;
  },
) {
  try {
    return JSON.parse(
      cipher.decrypt(
        row.encryptedConfiguration,
        `jellyfin_provisioning:${row.connectorId}:${row.connectorRevision}:${row.instanceGeneration}:${row.identityHash ?? "none"}`,
      ),
    ) as unknown;
  } catch (error) {
    throw new MaintenanceError("restore_sanitization_failed", { cause: error });
  }
}

function isClearedProvisioningPayload(
  value: unknown,
): value is { schemaVersion: 2; state: "cleared" } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === 2 &&
    (value as Record<string, unknown>).state === "cleared" &&
    Object.keys(value).length === 2
  );
}

function mergeRollbackJellyfinProvisioningFactsSafe(sqlite: Database.Database, rootKey?: Buffer) {
  const rows = sqlite
    .prepare(
      `select current.connector_id as connectorId,
              current.connector_revision as connectorRevision,
              current.connector_instance_generation as instanceGeneration,
              current.connector_instance_identity_hash as identityHash,
              current.encrypted_configuration as encryptedConfiguration,
              current.revision as revision, current.created_at as createdAt,
              current.updated_at as updatedAt
       from rollback_timeline.jellyfin_provisioning_configs current
       join main.connector_configs restored on restored.id = current.connector_id`,
    )
    .all() as {
    connectorId: string;
    connectorRevision: string;
    instanceGeneration: number;
    identityHash: string | null;
    encryptedConfiguration: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
  }[];
  sqlite.exec("delete from main.jellyfin_provisioning_configs");
  if (rows.length === 0) return;
  const cipher = provisioningCipher(rootKey);
  const insert = sqlite.prepare(
    `insert into main.jellyfin_provisioning_configs (
       connector_id, connector_revision, connector_instance_generation,
       connector_instance_identity_hash, encrypted_configuration, revision,
       created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const payload = parseProvisioningPayload(cipher, row);
    if (!isClearedProvisioningPayload(payload)) continue;
    insert.run(
      row.connectorId,
      row.connectorRevision,
      row.instanceGeneration,
      row.identityHash,
      row.encryptedConfiguration,
      row.revision,
      row.createdAt,
      row.updatedAt,
    );
  }
}

function sanitizeJellyfinProvisioningConfigs(sqlite: Database.Database, rootKey?: Buffer) {
  const rows = sqlite
    .prepare(
      `select provisioning.connector_id as connectorId,
              provisioning.connector_revision as connectorRevision,
              provisioning.connector_instance_generation as instanceGeneration,
              provisioning.connector_instance_identity_hash as identityHash,
              provisioning.encrypted_configuration as encryptedConfiguration,
              provisioning.revision as revision,
              connector.type as type, connector.config_generation as configGeneration,
              connector.instance_generation as connectorInstanceGeneration,
              connector.instance_identity_hash as connectorIdentityHash
       from main.jellyfin_provisioning_configs provisioning
       join main.connector_configs connector on connector.id = provisioning.connector_id`,
    )
    .all() as {
    connectorId: string;
    connectorRevision: string;
    instanceGeneration: number;
    identityHash: string | null;
    encryptedConfiguration: string;
    revision: number;
    type: string;
    configGeneration: number;
    connectorInstanceGeneration: number;
    connectorIdentityHash: string | null;
  }[];
  if (rows.length === 0) return;
  const cipher = provisioningCipher(rootKey);
  const remove = sqlite.prepare(
    "delete from main.jellyfin_provisioning_configs where connector_id = ?",
  );
  const update = sqlite.prepare(
    `update main.jellyfin_provisioning_configs
     set connector_revision = ?, connector_instance_generation = ?,
         connector_instance_identity_hash = ?, encrypted_configuration = ?
     where connector_id = ?`,
  );
  for (const row of rows) {
    const payload = parseProvisioningPayload(cipher, row);
    if (!isClearedProvisioningPayload(payload)) {
      remove.run(row.connectorId);
      continue;
    }
    const connectorRevision = createHash("sha256")
      .update(`${row.type}\0${row.connectorId}\0${row.configGeneration}`, "utf8")
      .digest("base64url");
    const encryptedConfiguration = cipher.encrypt(
      JSON.stringify({ schemaVersion: 2, state: "cleared" }),
      `jellyfin_provisioning:${row.connectorId}:${connectorRevision}:${row.connectorInstanceGeneration}:${row.connectorIdentityHash ?? "none"}`,
    );
    update.run(
      connectorRevision,
      row.connectorInstanceGeneration,
      row.connectorIdentityHash,
      encryptedConfiguration,
      row.connectorId,
    );
  }
}

function mergeRollbackJellyfinProvisioningFacts(sqlite: Database.Database, rootKey?: Buffer) {
  mergeRollbackJellyfinProvisioningFactsSafe(sqlite, rootKey);
}

function mergeRollbackSecurityFacts(sqlite: Database.Database, now: number, rootKey?: Buffer) {
  // The marker is a dependent FK. Clear it before replacing rollback activation rows,
  // then restore only a marker authorized by the selected current timeline.
  const markerColumn = (
    sqlite.pragma("table_info(service_identity_links)") as Array<{ name: string }>
  ).some((column) => column.name === "provisioned_by_activation_id");
  if (markerColumn)
    sqlite.exec("update main.service_identity_links set provisioned_by_activation_id = null");
  const exhaustedRevision = sqlite
    .prepare(
      `select 1 from main.service_identity_links restored
       left join rollback_timeline.service_identity_links current on current.id = restored.id
       where max(restored.revision, coalesce(current.revision, restored.revision)) >= 2147483647
       limit 1`,
    )
    .get();
  if (exhaustedRevision) throw new MaintenanceError("restore_sanitization_failed");

  const exhaustedConnectorGeneration = sqlite
    .prepare(
      `select 1 from main.connector_configs restored
       left join rollback_timeline.connector_configs current on current.id = restored.id
       where max(
           restored.instance_generation,
           coalesce(current.instance_generation, restored.instance_generation)
         ) >= 9007199254740991
         or max(
           restored.config_generation,
           coalesce(current.config_generation, restored.config_generation),
           ${now}
         ) >= 9007199254740991
       limit 1`,
    )
    .get();
  if (exhaustedConnectorGeneration) throw new MaintenanceError("restore_sanitization_failed");

  // Preserve only the current timeline's negative provisioning authority. Credential-bearing
  // configuration is intentionally never imported across the restore boundary.
  mergeRollbackJellyfinProvisioningFacts(sqlite, rootKey);
  mergeRollbackJellyfinActivationFacts(sqlite, now);

  sqlite.exec(`
    update main.users as restored
    set status = case
          when not exists (
            select 1 from rollback_timeline.users current where current.id = restored.id
          ) then 'disabled'
          when exists (
            select 1 from rollback_timeline.users current
            where current.id = restored.id and current.status = 'disabled'
          ) then 'disabled'
          else 'pending_link'
        end,
        updated_at = max(updated_at, ${now})
    where not exists (
      select 1 from rollback_timeline.users current where current.id = restored.id
    ) or exists (
      select 1 from rollback_timeline.users current
      where current.id = restored.id
        and case current.status when 'active' then 0 when 'pending_link' then 1 else 2 end
          > case restored.status when 'active' then 0 when 'pending_link' then 1 else 2 end
    );

    update main.users as restored
    set role = (select current.role from rollback_timeline.users current where current.id = restored.id),
        role_source = (select current.role_source from rollback_timeline.users current where current.id = restored.id),
        updated_at = max(updated_at, ${now})
    where exists (
      select 1 from rollback_timeline.users current
      where current.id = restored.id
        and case current.role
          when 'viewer' then 0 when 'requester' then 1 when 'operator' then 2 else 3 end
          <= case restored.role
          when 'viewer' then 0 when 'requester' then 1 when 'operator' then 2 else 3 end
    );

    update main.oidc_providers as restored
    set enabled = case
          when not exists (
            select 1 from rollback_timeline.oidc_providers current where current.id = restored.id
          ) or exists (
            select 1 from rollback_timeline.oidc_providers current
            where current.id = restored.id and current.enabled = 0
          ) then 0 else enabled end,
        allow_jit_provisioning = case
          when exists (
            select 1 from rollback_timeline.oidc_providers current
            where current.id = restored.id and current.allow_jit_provisioning = 0
          ) then 0 else allow_jit_provisioning end,
        updated_at = max(updated_at, ${now})
    where not exists (
      select 1 from rollback_timeline.oidc_providers current where current.id = restored.id
    ) or exists (
      select 1 from rollback_timeline.oidc_providers current
      where current.id = restored.id
        and (current.enabled = 0 or current.allow_jit_provisioning = 0)
    );

    update main.role_mappings as restored
    set claim_path_json = (select current.claim_path_json from rollback_timeline.role_mappings current
                           where current.id = restored.id),
        operator = (select current.operator from rollback_timeline.role_mappings current
                    where current.id = restored.id),
        values_json = (select current.values_json from rollback_timeline.role_mappings current
                       where current.id = restored.id),
        role = (select current.role from rollback_timeline.role_mappings current
                where current.id = restored.id),
        priority = (select current.priority from rollback_timeline.role_mappings current
                    where current.id = restored.id),
        enabled = (select current.enabled from rollback_timeline.role_mappings current
                   where current.id = restored.id),
        updated_at = max(
          updated_at,
          (select current.updated_at from rollback_timeline.role_mappings current
           where current.id = restored.id),
          ${now}
        )
    where exists (
      select 1 from rollback_timeline.role_mappings current
      join rollback_timeline.oidc_providers provider on provider.id = current.provider_id
      join main.oidc_providers restored_provider on restored_provider.id = provider.id
      where current.id = restored.id and current.provider_id = restored.provider_id
    );

    update main.role_mappings as restored
    set enabled = 0, updated_at = max(updated_at, ${now})
    where exists (
      select 1 from rollback_timeline.oidc_providers current_provider
      where current_provider.id = restored.provider_id
    ) and not exists (
      select 1 from rollback_timeline.role_mappings current where current.id = restored.id
    );

    insert into main.role_mappings (
      id, provider_id, claim_path_json, operator, values_json, role, priority,
      enabled, created_at, updated_at
    ) select current.id, current.provider_id, current.claim_path_json, current.operator,
             current.values_json, current.role, current.priority, current.enabled,
             current.created_at, max(current.updated_at, ${now})
      from rollback_timeline.role_mappings current
      join main.oidc_providers provider on provider.id = current.provider_id
      where not exists (select 1 from main.role_mappings restored where restored.id = current.id);

    delete from main.external_identities as restored
    where exists (
      select 1 from rollback_timeline.oidc_providers current_provider
      where current_provider.id = restored.provider_id
    ) and not exists (
      select 1 from rollback_timeline.external_identities current where current.id = restored.id
    );

    update main.connector_configs as restored
    set instance_generation = max(
          instance_generation,
          coalesce((select current.instance_generation
                    from rollback_timeline.connector_configs current
                    where current.id = restored.id), instance_generation)
        ),
        config_generation = max(
          config_generation,
          coalesce((select current.config_generation
                    from rollback_timeline.connector_configs current
                    where current.id = restored.id), config_generation)
        ),
        instance_identity_hash = null,
        enabled = case
          when not exists (
            select 1 from rollback_timeline.connector_configs current
            where current.id = restored.id
          ) or exists (
            select 1 from rollback_timeline.connector_configs current
            where current.id = restored.id and current.enabled = 0
          ) then 0 else enabled end,
        updated_at = max(updated_at, ${now})
    where not exists (
      select 1 from rollback_timeline.connector_configs current where current.id = restored.id
    ) or exists (
      select 1 from rollback_timeline.connector_configs current
      where current.id = restored.id and (
        current.enabled = 0
        or current.instance_generation > restored.instance_generation
        or current.config_generation > restored.config_generation
      )
    );

    update main.service_identity_links as restored
    set revision = max(
          revision,
          coalesce((select current.revision from rollback_timeline.service_identity_links current
                    where current.id = restored.id), revision)
        ),
        encrypted_access_token = null,
        token_created_at = null,
        last_verified_at = null,
        health_state = case
          when not exists (
            select 1 from rollback_timeline.service_identity_links current
            where current.id = restored.id
          ) or exists (
            select 1 from rollback_timeline.service_identity_links current
            where current.id = restored.id and current.health_state = 'revoked'
          ) then 'revoked'
          else 'relink_required'
        end,
        revoked_at = case
          when not exists (
            select 1 from rollback_timeline.service_identity_links current
            where current.id = restored.id
          ) then max(restored.created_at, ${now})
          when exists (
            select 1 from rollback_timeline.service_identity_links current
            where current.id = restored.id and current.health_state = 'revoked'
          ) then max(
            restored.created_at,
            coalesce((select current.revoked_at from rollback_timeline.service_identity_links current
                      where current.id = restored.id), ${now})
          )
          else null
        end,
        updated_at = max(updated_at, ${now});

    insert or ignore into main.oidc_logout_receipts (
      provider_id, jti_hash, issued_at, expires_at, received_at
    ) select current.provider_id, current.jti_hash, current.issued_at,
             current.expires_at, current.received_at
      from rollback_timeline.oidc_logout_receipts current
      join main.oidc_providers provider on provider.id = current.provider_id;

    insert or ignore into main.session_secret_reservations (
      secret_hash, purpose, origin_session_id, reserved_at
    ) select secret_hash, purpose, origin_session_id, reserved_at
      from rollback_timeline.session_secret_reservations;
  `);
  mergeIdempotencyReceipts(sqlite);
  mergeRollbackExternalMutationFacts(sqlite);
  mergeRollbackInvitationFacts(sqlite, now);
  if (markerColumn)
    sqlite.exec(`
    update main.service_identity_links as restored
    set provisioned_by_activation_id = (
      select current.provisioned_by_activation_id
      from rollback_timeline.service_identity_links current
      join main.jellyfin_activation_operations operation
        on operation.id = current.provisioned_by_activation_id
       and operation.user_id = current.user_id
       and operation.connector_id = current.connector_id
      where current.id = restored.id
    )
    where exists (select 1 from rollback_timeline.service_identity_links current where current.id = restored.id);
  `);
}

function quarantineAuthorityWithoutCurrentTimeline(sqlite: Database.Database, now: number) {
  sqlite.exec(`
    update users set status = 'disabled', updated_at = max(updated_at, ${now});
    update oidc_providers set enabled = 0, updated_at = max(updated_at, ${now});
    update connector_configs set enabled = 0, updated_at = max(updated_at, ${now});
    update service_identity_links
    set encrypted_access_token = null, token_created_at = null, last_verified_at = null,
        health_state = 'revoked', revoked_at = max(created_at, ${now}),
        updated_at = max(updated_at, ${now});
  `);
  sqlite.exec(`
    update invitations
    set revoked_at = max(created_at, min(${now}, expires_at - 1)),
        registration_handoff_hash = null,
        registration_handoff_expires_at = null
    where consumed_at is null and revoked_at is null;
    update invitations
    set registration_handoff_hash = null,
        registration_handoff_expires_at = null
    where consumed_at is not null or revoked_at is not null;
  `);
  sanitizeJellyfinActivationOperations(sqlite, now);
}

function sanitizePendingExternalParent(
  sqlite: Database.Database,
  input: {
    parentOperationType: string;
    pendingState?: "pending" | "running";
    responseColumn?: "encrypted_response" | "response_json";
    startedColumn?: "started_at";
    table: string;
  },
  now: number,
) {
  const table = quoteIdentifier(input.table);
  const pendingState = input.pendingState ?? "pending";
  const responseReset = input.responseColumn
    ? `, ${quoteIdentifier(input.responseColumn)} = null`
    : "";
  const completionFloor = input.startedColumn
    ? `max(created_at, ${quoteIdentifier(input.startedColumn)}, ${now})`
    : `max(created_at, ${now})`;
  sqlite.exec(`
    update ${table} as parent
    set state = case
          when exists (
            select 1 from external_mutation_dispatches dispatch
            where dispatch.parent_operation_type = '${input.parentOperationType}'
              and dispatch.parent_operation_id = parent.id
              and dispatch.state = 'uncertain'
          ) then 'uncertain'
          when exists (
            select 1 from external_mutation_dispatches dispatch
            where dispatch.parent_operation_type = '${input.parentOperationType}'
              and dispatch.parent_operation_id = parent.id
              and dispatch.state = 'reconcile_required'
          ) then 'reconcile_required'
          else 'failed'
        end,
        failure_code = case
          when exists (
            select 1 from external_mutation_dispatches dispatch
            where dispatch.parent_operation_type = '${input.parentOperationType}'
              and dispatch.parent_operation_id = parent.id
              and dispatch.state = 'uncertain'
          ) then 'restore_outcome_uncertain'
          when exists (
            select 1 from external_mutation_dispatches dispatch
            where dispatch.parent_operation_type = '${input.parentOperationType}'
              and dispatch.parent_operation_id = parent.id
              and dispatch.state = 'reconcile_required'
          ) then 'restore_reconcile_required'
          else 'restore_sanitized'
        end,
        completed_at = ${completionFloor},
        updated_at = max(updated_at, ${completionFloor})
        ${responseReset}
    where state = '${pendingState}';
  `);
}

function sanitizeExternalMutationState(sqlite: Database.Database, now: number) {
  sqlite.exec(`
    update external_mutation_dispatches
    set state = 'failed', lease_owner = null, lease_expires_at = null,
        completed_at = max(created_at, ${now}), failure_code = 'restore_sanitized',
        updated_at = max(updated_at, created_at, ${now})
    where state = 'reserved';

    update external_mutation_dispatches
    set state = 'uncertain', uncertain_at = max(dispatched_at, ${now}),
        completed_at = max(dispatched_at, created_at, ${now}),
        failure_code = 'restore_timeline_uncertain',
        updated_at = max(updated_at, dispatched_at, created_at, ${now})
    where state = 'dispatched';
  `);

  for (const input of [
    {
      parentOperationType: "media_request_operation",
      responseColumn: "response_json",
      table: "media_request_operations",
    },
    {
      parentOperationType: "media_issue_operation",
      responseColumn: "response_json",
      table: "media_issue_operations",
    },
    {
      parentOperationType: "subtitle_download_operation",
      responseColumn: "response_json",
      table: "subtitle_download_operations",
    },
    {
      parentOperationType: "library_mutation_operation",
      responseColumn: "response_json",
      table: "library_mutation_operations",
    },
    {
      parentOperationType: "user_media_state_operation",
      responseColumn: "response_json",
      table: "user_media_state_operations",
    },
    {
      parentOperationType: "download_queue_removal_operation",
      responseColumn: "response_json",
      table: "download_queue_removal_operations",
    },
    {
      parentOperationType: "download_queue_item_operation",
      table: "download_queue_item_operations",
    },
    {
      parentOperationType: "acquisition_queue_recovery_operation",
      responseColumn: "response_json",
      table: "acquisition_queue_recovery_operations",
    },
    {
      parentOperationType: "acquisition_search_operation",
      responseColumn: "response_json",
      table: "acquisition_search_operations",
    },
    {
      parentOperationType: "acquisition_grab_operation",
      responseColumn: "response_json",
      table: "acquisition_grab_operations",
    },
    {
      parentOperationType: "saved_list_operation",
      responseColumn: "encrypted_response",
      table: "saved_list_operations",
    },
    {
      parentOperationType: "playback_progress_operation",
      table: "playback_progress_operations",
    },
  ] as const) {
    sanitizePendingExternalParent(sqlite, input, now);
  }
  sanitizePendingExternalParent(
    sqlite,
    {
      parentOperationType: "library_removal_operation",
      pendingState: "running",
      startedColumn: "started_at",
      table: "library_removal_operations",
    },
    now,
  );

  sqlite.exec(`
    delete from external_mutation_target_locks
    where owner_dispatch_id in (
      select id from external_mutation_dispatches where state in ('succeeded', 'failed')
    );
  `);
}

/** Applies the minimum Phase 0 replay-safe restore policy in one SQLite transaction. */
export function sanitizeRestoredDatabase(
  databasePath: string,
  options: {
    auditId?: string;
    failpoint?: (sqlite: Database.Database) => void;
    now?: Date;
    rollbackDatabasePath?: string;
    rootKey?: Buffer;
  } = {},
) {
  const now = safeRestoreTime(options.now);
  const auditId = options.auditId ?? `restore-sanitization-${randomUUID()}`;
  let sqlite: Database.Database | undefined;
  let rollbackStagingDirectory: string | undefined;
  let stagedRollbackPath: string | undefined;
  try {
    if (options.rollbackDatabasePath) {
      rollbackStagingDirectory = mkdtempSync(
        path.join(path.dirname(databasePath), ".omnifin-rollback-merge-"),
      );
      chmodSync(rollbackStagingDirectory, 0o700);
      stagedRollbackPath = path.join(rollbackStagingDirectory, "rollback.sqlite");
      const staged = inspectDatabaseFile(
        options.rollbackDatabasePath,
        {
          retainedCopyPath: stagedRollbackPath,
          stagingDirectory: rollbackStagingDirectory,
        },
        () => undefined,
      );
      if (staged.hadSidecars) throw new MaintenanceError("restore_sanitization_failed");
    }
    sqlite = new Database(databasePath, { fileMustExist: true });
    sqlite.pragma("foreign_keys = ON");
    if (stagedRollbackPath) {
      sqlite.prepare("attach database ? as rollback_timeline").run(stagedRollbackPath);
    }
    options.failpoint?.(sqlite);
    sqlite.transaction(() => {
      if (options.rollbackDatabasePath) mergeRollbackSecurityFacts(sqlite!, now, options.rootKey);
      else quarantineAuthorityWithoutCurrentTimeline(sqlite!, now);
      const exhaustedRevision = sqlite!
        .prepare("select 1 from service_identity_links where revision >= 2147483647 limit 1")
        .get();
      if (exhaustedRevision) throw new MaintenanceError("restore_sanitization_failed");
      const exhaustedConnectorGeneration = sqlite!
        .prepare(
          `select 1 from connector_configs
           where instance_generation >= 9007199254740991
              or max(config_generation, ?) >= 9007199254740991
           limit 1`,
        )
        .get(now);
      if (exhaustedConnectorGeneration) {
        throw new MaintenanceError("restore_sanitization_failed");
      }

      // Ephemeral authentication, aliases, transactions, playback and grants never survive restore.
      sqlite!.exec(`
        delete from session_rotation_aliases;
        delete from media_download_grants;
        delete from playback_asset_handles;
        delete from playback_sessions;
        delete from jellyfin_quick_connect_transactions;
        delete from auth_transactions;
        delete from sessions;
      `);

      // Preserve revoked links as revoked; every other restored link requires an explicit relink.
      sqlite!
        .prepare(
          `update service_identity_links
         set revision = revision + 1,
             encrypted_access_token = null,
             token_created_at = null,
             last_verified_at = null,
             health_state = case when health_state = 'revoked' then 'revoked' else 'relink_required' end,
             updated_at = max(updated_at, ?)`,
        )
        .run(now);
      sqlite!
        .prepare(
          `update connector_configs
         set instance_generation = instance_generation + 1,
             config_generation = max(config_generation, ?) + 1,
             instance_identity_hash = null,
             capability_snapshot_json = '{}', health_state = 'unknown',
              updated_at = max(updated_at, ?)`,
        )
        .run(now, now);
      sanitizeJellyfinProvisioningConfigs(sqlite!, options.rootKey);
      sqlite!
        .prepare(
          `update oidc_providers
         set approved_endpoint_origins_json = '[]',
             discovery_state = 'unchecked', discovery_capabilities_json = '{}',
             discovery_checked_at = null, updated_at = max(updated_at, ?)`,
        )
        .run(now);

      expireLastUsedReference(sqlite!, "media_references", now, true);
      for (const table of [
        "discovery_artwork_references",
        "external_issue_references",
        "saved_targets",
      ]) {
        expireLastUsedReference(sqlite!, table, now);
      }
      for (const table of ["subtitle_searches", "library_artwork_searches"]) {
        expireCreatedReference(sqlite!, table, now);
      }
      sqlite!.exec(
        `delete from library_removal_previews
         where created_at >= ${now} or consumed_at >= ${now};
         update library_removal_previews
         set expires_at = ${now}, updated_at = max(updated_at, ${now})
         where created_at < ${now} and (consumed_at is null or consumed_at < ${now});
         update saved_catalog_items
         set library_reference_id = null, library_reference_user_id = null,
             last_resolved_at = null, updated_at = max(updated_at, ${now});`,
      );

      sanitizeExternalMutationState(sqlite!, now);

      const failPending = (table: string, states = "'pending'") => {
        sqlite!.exec(
          `update ${table}
           set state = 'failed', response_json = null,
               failure_code = 'restore_sanitized',
               completed_at = max(created_at, ${now}),
               updated_at = max(updated_at, created_at, ${now})
           where state in (${states})`,
        );
      };
      for (const table of [
        "subtitle_download_operations",
        "library_mutation_operations",
        "user_media_state_operations",
        "download_queue_removal_operations",
        "media_request_operations",
        "media_issue_operations",
        "acquisition_search_operations",
        "acquisition_queue_recovery_operations",
        "acquisition_grab_operations",
      ]) {
        failPending(table);
      }
      sqlite!.exec(
        `update saved_list_operations
         set state = 'failed', encrypted_response = null,
             failure_code = 'restore_sanitized',
             completed_at = max(created_at, ${now}),
             updated_at = max(updated_at, created_at, ${now})
         where state = 'pending';
         update library_removal_operations
         set state = 'failed', failure_code = 'restore_sanitized',
             completed_at = max(started_at, created_at, ${now}),
             updated_at = max(updated_at, started_at, created_at, ${now})
         where state = 'running';
         update download_queue_bulk_operations
         set state = 'quarantined', response_json = null,
             completed_at = max(created_at, ${now}),
             updated_at = max(updated_at, created_at, ${now})
         where state = 'pending';`,
      );

      sqlite!
        .prepare(
          `insert into audit_events (
           id, event_type, outcome, target_type, metadata_json, created_at
         ) values (?, 'database.restore_sanitized', 'success', 'database', ?, ?)`,
        )
        .run(
          auditId,
          JSON.stringify({
            policy: "phase0-v1",
            rollbackSecurityMerge: options.rollbackDatabasePath
              ? "verified_current_timeline"
              : "authority_quarantined_no_current_timeline",
          }),
          now,
        );
    })();
    if (options.rollbackDatabasePath) sqlite.exec("detach database rollback_timeline");
    const integrity = sqlite.pragma("integrity_check", { simple: true });
    if (integrity !== "ok" || (sqlite.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new MaintenanceError("restore_sanitization_failed");
    }
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.pragma("journal_mode = DELETE");
  } catch (error) {
    throw wrapMaintenanceError("restore_sanitization_failed", error);
  } finally {
    sqlite?.close();
    if (rollbackStagingDirectory) {
      rmSync(rollbackStagingDirectory, { force: true, recursive: true });
    }
  }
}

async function stageSelectedBackup(
  backupPath: string,
  temporaryPath: string,
  selected: Awaited<ReturnType<typeof readAndValidateManifest>>,
  now: Date | undefined,
  rollbackDatabasePath?: string,
  rootKey?: Buffer,
  dependencies: RestoreDependencies = {},
) {
  const resolvedRootKey = restoreRootKey(rootKey);
  const ownsRootKey = resolvedRootKey !== rootKey;
  try {
    await copyFile(backupPath, temporaryPath, constants.COPYFILE_EXCL);
    await chmod(temporaryPath, 0o600);
    const staged = inspectDatabase(temporaryPath);
    const stagedSha256 = await sha256File(temporaryPath);
    if (
      stagedSha256 !== selected.manifest.databaseSha256 ||
      staged.migrationCount !== selected.inspection.migrationCount ||
      staged.schemaSha256 !== selected.inspection.schemaSha256
    ) {
      throw new MaintenanceError("backup_mismatch");
    }
    migrateStagedRestoreDatabase(temporaryPath, staged.migrationCount, resolvedRootKey);
    sanitizeRestoredDatabase(temporaryPath, {
      ...(dependencies.sanitationFailpoint ? { failpoint: dependencies.sanitationFailpoint } : {}),
      ...(now ? { now } : {}),
      ...(rollbackDatabasePath ? { rollbackDatabasePath } : {}),
      ...(resolvedRootKey ? { rootKey: resolvedRootKey } : {}),
    });
    inspectDatabase(temporaryPath);
    await syncFile(temporaryPath);
    return sha256File(temporaryPath);
  } finally {
    if (ownsRootKey) resolvedRootKey?.fill(0);
  }
}

export async function restoreDatabaseBackup(
  options: RestoreOptions,
  dependencies: RestoreDependencies = {},
): Promise<RestoreResult> {
  if (!options.confirmedGatewayStopped) {
    throw new MaintenanceError("restore_confirmation_required");
  }
  const databasePath = resolvedFilePath(options.databasePath, "database_path_invalid");
  const backupPath = resolvedFilePath(options.backupPath, "backup_path_invalid");
  const rollbackOutputPath = resolvedFilePath(options.rollbackOutputPath, "backup_path_invalid");
  const temporaryPath = path.join(
    path.dirname(databasePath),
    `.${path.basename(databasePath)}.${randomUUID()}.restore`,
  );
  let databaseReplaced = false;
  let durabilityAmbiguous = false;
  let retainMaintenanceLock = false;
  let rollback: BackupResult | undefined;
  await assertPrivateDirectory(path.dirname(databasePath));
  const maintenanceLock = await acquireMaintenanceLock(databasePath);

  try {
    if (await gatewayIsRunning(options.gatewayHealthUrl)) {
      throw new MaintenanceError("gateway_still_running");
    }
    await assertDistinctPaths(databasePath, backupPath, rollbackOutputPath);
    const selected = await readAndValidateManifest(backupPath);
    await assertDatabaseQuiescent(databasePath);
    rollback = await createDatabaseBackup({
      cleanupGeneratedSourceSidecars: true,
      databasePath,
      outputPath: rollbackOutputPath,
      ...(options.imageReference ? { imageReference: options.imageReference } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    await verifyDatabaseBackup({ backupPath: rollbackOutputPath });

    const sanitizedDatabaseSha256 = await stageSelectedBackup(
      backupPath,
      temporaryPath,
      selected,
      options.now,
      rollbackOutputPath,
      options.rootKey,
      dependencies,
    );
    await rename(temporaryPath, databasePath);
    databaseReplaced = true;
    try {
      await (dependencies.syncPublishedDirectory ?? syncDirectory)(path.dirname(databasePath));
    } catch (error) {
      durabilityAmbiguous = true;
      throw error;
    }
    await dependencies.afterPublish?.();
    inspectDatabase(databasePath);

    return {
      databaseSha256: sanitizedDatabaseSha256,
      restoredFileName: path.basename(databasePath),
      rollback,
      sanitizedDatabaseSha256,
      sourceDatabaseSha256: selected.manifest.databaseSha256,
    };
  } catch (error) {
    const primary = wrapMaintenanceError("restore_failed", error);
    if (databaseReplaced) {
      try {
        await optionalUnlink(temporaryPath);
        await copyFile(rollbackOutputPath, temporaryPath, constants.COPYFILE_EXCL);
        await chmod(temporaryPath, 0o600);
        const stagedRollback = inspectDatabase(temporaryPath);
        if (
          !rollback ||
          (await sha256File(temporaryPath)) !== rollback.databaseSha256 ||
          stagedRollback.migrationCount !== rollback.migrationCount ||
          stagedRollback.schemaSha256 !== rollback.schemaSha256
        ) {
          throw new MaintenanceError("backup_mismatch");
        }
        await syncFile(temporaryPath);
        await rename(temporaryPath, databasePath);
        await syncDirectory(path.dirname(databasePath));
        inspectDatabase(databasePath);
      } catch (rollbackError) {
        retainMaintenanceLock = true;
        throw new AggregateError([primary, rollbackError], "restore_failed");
      } finally {
        if (durabilityAmbiguous) retainMaintenanceLock = true;
      }
    }
    throw primary;
  } finally {
    try {
      await optionalUnlink(temporaryPath);
    } finally {
      if (retainMaintenanceLock) await maintenanceLock.retain();
      else await maintenanceLock.release();
    }
  }
}

async function assertEmptyRestoreTarget(databasePath: string) {
  const directory = path.dirname(databasePath);
  const scan = await readBoundedDirectoryEntries(directory, 1);
  if (scan.entries.length > 0 || scan.exceeded) {
    throw new MaintenanceError("restore_target_not_empty");
  }
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    databaseMaintenanceLockPath(databasePath),
  ]) {
    try {
      await lstat(candidate);
      throw new MaintenanceError("restore_target_not_empty");
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new MaintenanceError("restore_target_not_empty", { cause: error });
      }
    }
  }
}

export async function restoreDatabaseBackupIntoEmptyTarget(
  options: EmptyRestoreOptions,
  dependencies: RestoreDependencies = {},
): Promise<EmptyRestoreResult> {
  if (!options.confirmedGatewayStopped || !options.confirmedEmptyTarget) {
    throw new MaintenanceError("restore_confirmation_required");
  }
  const databasePath = resolvedFilePath(options.databasePath, "database_path_invalid");
  const backupPath = resolvedFilePath(options.backupPath, "backup_path_invalid");
  const directory = path.dirname(databasePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(databasePath)}.${randomUUID()}.restore-empty`,
  );
  await assertPrivateDirectory(directory);
  await assertEmptyRestoreTarget(databasePath);
  const maintenanceLock = await acquireMaintenanceLock(databasePath);
  let published = false;
  let retainMaintenanceLock = false;
  try {
    if (await gatewayIsRunning(options.gatewayHealthUrl)) {
      throw new MaintenanceError("gateway_still_running");
    }
    await assertDistinctPaths(databasePath, backupPath);
    const selected = await readAndValidateManifest(backupPath);
    const sanitizedDatabaseSha256 = await stageSelectedBackup(
      backupPath,
      temporaryPath,
      selected,
      options.now,
      undefined,
      options.rootKey,
      dependencies,
    );
    await rename(temporaryPath, databasePath);
    published = true;
    try {
      await (dependencies.syncPublishedDirectory ?? syncDirectory)(directory);
    } catch (error) {
      retainMaintenanceLock = true;
      throw error;
    }
    await dependencies.afterPublish?.();
    inspectDatabase(databasePath);
    return {
      databaseSha256: sanitizedDatabaseSha256,
      restoredFileName: path.basename(databasePath),
      sanitizedDatabaseSha256,
      sourceDatabaseSha256: selected.manifest.databaseSha256,
    };
  } catch (error) {
    const primary = wrapMaintenanceError("restore_failed", error);
    if (published && !retainMaintenanceLock) {
      try {
        await unlink(databasePath);
        await syncDirectory(directory);
      } catch (rollbackError) {
        retainMaintenanceLock = true;
        throw new AggregateError([primary, rollbackError], "restore_failed");
      }
    }
    throw primary;
  } finally {
    try {
      await optionalUnlink(temporaryPath);
    } finally {
      if (retainMaintenanceLock) await maintenanceLock.retain();
      else await maintenanceLock.release();
    }
  }
}

export async function clearDatabaseMaintenanceLock(
  options: UnlockOptions,
): Promise<MaintenanceLockResult> {
  if (!options.confirmedGatewayStopped) {
    throw new MaintenanceError("restore_confirmation_required");
  }
  if (await gatewayIsRunning(options.gatewayHealthUrl)) {
    throw new MaintenanceError("gateway_still_running");
  }

  const databasePath = resolvedFilePath(options.databasePath, "database_path_invalid");
  await assertPrivateDirectory(path.dirname(databasePath));
  const lockPath = databaseMaintenanceLockPath(databasePath);
  try {
    await assertRegularPrivateFile(lockPath, "maintenance_lock_missing");
    await unlink(lockPath);
    await syncDirectory(path.dirname(databasePath));
    return { fileName: path.basename(lockPath) };
  } catch (error) {
    throw wrapMaintenanceError("maintenance_lock_missing", error);
  }
}
