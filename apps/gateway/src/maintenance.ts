import process from "node:process";
import {
  clearDatabaseMaintenanceLock,
  createDatabaseBackup,
  createRetainedDatabaseBackup,
  MaintenanceError,
  restoreDatabaseBackup,
  restoreDatabaseBackupIntoEmptyTarget,
  verifyDatabaseBackup,
} from "./db/maintenance.js";
import { runDeploymentDoctor } from "./operations/deployment-doctor.js";
import {
  assertOnlyMaintenanceValues,
  assertOnlyMaintenanceFlags,
  parseMaintenanceArguments,
  requireMaintenanceInteger,
  requireMaintenanceValue,
} from "./operations/maintenance-arguments.js";

const USAGE = `Usage:
  omnifin maintenance doctor
  omnifin maintenance backup --output /backups/omnifin.sqlite
  omnifin maintenance backup-retained --retain 14
  omnifin maintenance verify --input /backups/omnifin.sqlite
  omnifin maintenance restore --input /backups/omnifin.sqlite \\
    --rollback-output /backups/pre-restore.sqlite --confirm-gateway-stopped
  omnifin maintenance restore-empty --input /backups/omnifin.sqlite \\
    --confirm-gateway-stopped --confirm-empty-target
  omnifin maintenance unlock --confirm-gateway-stopped
`;

function writeResult(operation: string, result: object, status: "attention" | "ok" = "ok") {
  process.stdout.write(`${JSON.stringify({ operation, status, ...result })}\n`);
}

async function run() {
  const [operation, ...remainingArguments] = process.argv.slice(2);
  if (!operation || operation === "--help" || operation === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const arguments_ = parseMaintenanceArguments(remainingArguments);
  const databasePath = process.env.OMNIFIN_DATABASE_URL ?? "./data/omnifin.db";
  const imageReference = process.env.OMNIFIN_IMAGE_REF;

  if (operation === "doctor") {
    assertOnlyMaintenanceValues(arguments_, []);
    assertOnlyMaintenanceFlags(arguments_, []);
    const report = await runDeploymentDoctor({
      backupDirectory: process.env.OMNIFIN_BACKUP_DIRECTORY ?? "/backups",
      databasePath,
      ...(process.env.OMNIFIN_BASE_URL ? { baseUrl: process.env.OMNIFIN_BASE_URL } : {}),
      ...(process.env.NODE_ENV ? { environment: process.env.NODE_ENV } : {}),
      ...(process.env.OMNIFIN_GATEWAY_HEALTH_URL
        ? { gatewayHealthUrl: process.env.OMNIFIN_GATEWAY_HEALTH_URL }
        : {}),
      ...(process.env.OMNIFIN_GATEWAY_READY_URL
        ? { gatewayReadyUrl: process.env.OMNIFIN_GATEWAY_READY_URL }
        : {}),
      ...(imageReference ? { imageReference } : {}),
    });
    process.stdout.write(
      `${JSON.stringify({
        operation,
        status: report.state === "ready" ? "ok" : "attention",
        ...report,
      })}\n`,
    );
    if (report.state !== "ready") process.exitCode = 78;
    return;
  }

  if (operation === "backup") {
    assertOnlyMaintenanceValues(arguments_, ["--output"]);
    assertOnlyMaintenanceFlags(arguments_, []);
    writeResult(
      operation,
      await createDatabaseBackup({
        databasePath,
        outputPath: requireMaintenanceValue(arguments_, "--output"),
        ...(imageReference ? { imageReference } : {}),
      }),
    );
    return;
  }

  if (operation === "backup-retained") {
    assertOnlyMaintenanceValues(arguments_, ["--retain"]);
    assertOnlyMaintenanceFlags(arguments_, []);
    const result = await createRetainedDatabaseBackup({
      backupDirectory: process.env.OMNIFIN_BACKUP_DIRECTORY ?? "/backups",
      databasePath,
      retentionCount: requireMaintenanceInteger(arguments_, "--retain", {
        maximum: 365,
        minimum: 2,
      }),
      ...(imageReference ? { imageReference } : {}),
    });
    const status = result.retention.state === "ready" ? "ok" : "attention";
    writeResult(operation, result, status);
    if (status === "attention") process.exitCode = 75;
    return;
  }

  if (operation === "verify") {
    assertOnlyMaintenanceValues(arguments_, ["--input"]);
    assertOnlyMaintenanceFlags(arguments_, []);
    writeResult(
      operation,
      await verifyDatabaseBackup({
        backupPath: requireMaintenanceValue(arguments_, "--input"),
      }),
    );
    return;
  }

  if (operation === "restore") {
    assertOnlyMaintenanceValues(arguments_, ["--input", "--rollback-output"]);
    assertOnlyMaintenanceFlags(arguments_, ["--confirm-gateway-stopped"]);
    writeResult(
      operation,
      await restoreDatabaseBackup({
        backupPath: requireMaintenanceValue(arguments_, "--input"),
        confirmedGatewayStopped: arguments_.flags.has("--confirm-gateway-stopped"),
        databasePath,
        rollbackOutputPath: requireMaintenanceValue(arguments_, "--rollback-output"),
        ...(process.env.OMNIFIN_GATEWAY_HEALTH_URL
          ? { gatewayHealthUrl: process.env.OMNIFIN_GATEWAY_HEALTH_URL }
          : {}),
        ...(imageReference ? { imageReference } : {}),
      }),
    );
    return;
  }

  if (operation === "restore-empty") {
    assertOnlyMaintenanceValues(arguments_, ["--input"]);
    assertOnlyMaintenanceFlags(arguments_, ["--confirm-empty-target", "--confirm-gateway-stopped"]);
    writeResult(
      operation,
      await restoreDatabaseBackupIntoEmptyTarget({
        backupPath: requireMaintenanceValue(arguments_, "--input"),
        confirmedEmptyTarget: arguments_.flags.has("--confirm-empty-target"),
        confirmedGatewayStopped: arguments_.flags.has("--confirm-gateway-stopped"),
        databasePath,
        ...(process.env.OMNIFIN_GATEWAY_HEALTH_URL
          ? { gatewayHealthUrl: process.env.OMNIFIN_GATEWAY_HEALTH_URL }
          : {}),
      }),
    );
    return;
  }

  if (operation === "unlock") {
    assertOnlyMaintenanceValues(arguments_, []);
    assertOnlyMaintenanceFlags(arguments_, ["--confirm-gateway-stopped"]);
    writeResult(
      operation,
      await clearDatabaseMaintenanceLock({
        confirmedGatewayStopped: arguments_.flags.has("--confirm-gateway-stopped"),
        databasePath,
        ...(process.env.OMNIFIN_GATEWAY_HEALTH_URL
          ? { gatewayHealthUrl: process.env.OMNIFIN_GATEWAY_HEALTH_URL }
          : {}),
      }),
    );
    return;
  }

  throw new Error("usage");
}

try {
  await run();
} catch (error) {
  if ((error as Error).message === "usage") {
    process.stderr.write(USAGE);
    process.exitCode = 64;
  } else {
    const code = error instanceof MaintenanceError ? error.code : "maintenance_failed";
    process.stderr.write(`${JSON.stringify({ code, status: "error" })}\n`);
    process.exitCode = 70;
  }
}
