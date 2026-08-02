import Database from "better-sqlite3";
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
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { databaseMaintenanceLockPath } from "./maintenance-lock.js";

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

const backupManifestSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    databaseBytes: z.number().int().nonnegative(),
    databaseSha256: z.string().regex(/^[0-9a-f]{64}$/),
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    imageReference: z.string().min(1).max(512),
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
  | "restore_failed";

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
  databasePath: string;
  imageReference?: string;
  now?: Date;
  outputPath: string;
  retentionManaged?: boolean;
}

interface RetainedBackupOptions {
  backupDirectory: string;
  createId?: () => string;
  databasePath: string;
  imageReference?: string;
  now?: Date;
  retentionCount: number;
  scanLimit?: number;
}

interface RetainedBackupDependencies {
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
  rollbackOutputPath: string;
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

  return async () => {
    await handle?.close();
    await optionalUnlink(lockPath);
    await syncDirectory(path.dirname(databasePath));
  };
}

function inspectDatabase(databasePath: string): DatabaseInspection {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(databasePath, { fileMustExist: true, readonly: true });
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
  } catch (error) {
    throw wrapMaintenanceError("backup_integrity_failed", error);
  } finally {
    sqlite?.close();
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
  dependencies: Required<RetainedBackupDependencies>,
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

export async function createDatabaseBackup(options: BackupOptions): Promise<BackupResult> {
  const databasePath = resolvedFilePath(options.databasePath, "database_path_invalid");
  const outputPath = resolvedFilePath(options.outputPath, "backup_path_invalid");
  const outputDirectory = path.dirname(outputPath);
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(outputPath)}.${randomUUID()}.partial`,
  );
  let outputCreated = false;
  let manifestCreated = false;
  let sqlite: Database.Database | undefined;

  try {
    await assertDistinctPaths(databasePath, outputPath);
    await assertPrivateDirectory(path.dirname(databasePath));
    await assertPrivateDirectory(outputDirectory);
    await assertDestinationAvailable(outputPath);
    await assertRegularPrivateFile(databasePath, "database_path_invalid");

    sqlite = new Database(databasePath, { fileMustExist: true, readonly: true });
    sqlite.pragma("busy_timeout = 5000");
    await sqlite.backup(temporaryPath);
    sqlite.close();
    sqlite = undefined;

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
    await copyFile(temporaryPath, outputPath, constants.COPYFILE_EXCL);
    outputCreated = true;
    await chmod(outputPath, 0o600);
    await syncFile(outputPath);
    await writeFile(manifestPath(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    manifestCreated = true;
    await syncFile(manifestPath(outputPath));
    await syncDirectory(outputDirectory);

    return {
      bytes: metadata.size,
      databaseSha256,
      fileName: path.basename(outputPath),
      manifestFileName: path.basename(manifestPath(outputPath)),
      migrationCount: inspection.migrationCount,
      schemaSha256: inspection.schemaSha256,
    };
  } catch (error) {
    if (manifestCreated) await optionalUnlink(manifestPath(outputPath));
    if (outputCreated) await optionalUnlink(outputPath);
    throw wrapMaintenanceError("backup_failed", error);
  } finally {
    sqlite?.close();
    await optionalUnlink(temporaryPath);
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
  const backup = await createDatabaseBackup({
    databasePath: options.databasePath,
    outputPath: backupPath,
    ...(options.imageReference ? { imageReference: options.imageReference } : {}),
    now,
    retentionManaged: true,
  });
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

export async function restoreDatabaseBackup(options: RestoreOptions): Promise<RestoreResult> {
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
  await assertPrivateDirectory(path.dirname(databasePath));
  const releaseMaintenanceLock = await acquireMaintenanceLock(databasePath);

  try {
    if (await gatewayIsRunning(options.gatewayHealthUrl)) {
      throw new MaintenanceError("gateway_still_running");
    }
    await assertDistinctPaths(databasePath, backupPath, rollbackOutputPath);
    const selected = await readAndValidateManifest(backupPath);
    await assertDatabaseQuiescent(databasePath);
    const rollback = await createDatabaseBackup({
      databasePath,
      outputPath: rollbackOutputPath,
      ...(options.imageReference ? { imageReference: options.imageReference } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

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
    await syncFile(temporaryPath);
    await rename(temporaryPath, databasePath);
    databaseReplaced = true;
    await syncDirectory(path.dirname(databasePath));

    const restored = inspectDatabase(databasePath);
    if (
      restored.migrationCount !== selected.inspection.migrationCount ||
      restored.schemaSha256 !== selected.inspection.schemaSha256
    ) {
      throw new MaintenanceError("restore_failed");
    }

    return {
      databaseSha256: selected.manifest.databaseSha256,
      restoredFileName: path.basename(databasePath),
      rollback,
    };
  } catch (error) {
    if (databaseReplaced) {
      try {
        await copyFile(rollbackOutputPath, temporaryPath, constants.COPYFILE_EXCL);
        await chmod(temporaryPath, 0o600);
        inspectDatabase(temporaryPath);
        await syncFile(temporaryPath);
        await rename(temporaryPath, databasePath);
        await syncDirectory(path.dirname(databasePath));
      } catch (rollbackError) {
        throw new AggregateError(
          [wrapMaintenanceError("restore_failed", error), rollbackError],
          "restore_failed",
        );
      }
    }
    throw wrapMaintenanceError("restore_failed", error);
  } finally {
    await optionalUnlink(temporaryPath);
    await releaseMaintenanceLock();
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
