import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  open,
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

const backupManifestSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    databaseBytes: z.number().int().nonnegative(),
    databaseSha256: z.string().regex(/^[0-9a-f]{64}$/),
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    imageReference: z.string().min(1).max(512),
    migrationCount: z.number().int().nonnegative(),
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
    await readAndValidateManifest(backupPath);
    await assertDatabaseQuiescent(databasePath);
    const rollback = await createDatabaseBackup({
      databasePath,
      outputPath: rollbackOutputPath,
      ...(options.imageReference ? { imageReference: options.imageReference } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

    await copyFile(backupPath, temporaryPath, constants.COPYFILE_EXCL);
    await chmod(temporaryPath, 0o600);
    inspectDatabase(temporaryPath);
    await syncFile(temporaryPath);
    await rename(temporaryPath, databasePath);
    databaseReplaced = true;
    await syncDirectory(path.dirname(databasePath));

    const restored = inspectDatabase(databasePath);
    const selected = await readAndValidateManifest(backupPath);
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
