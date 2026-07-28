import process from "node:process";
import {
  clearDatabaseMaintenanceLock,
  createDatabaseBackup,
  MaintenanceError,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "./db/maintenance.js";

const USAGE = `Usage:
  omnifin maintenance backup --output /backups/omnifin.sqlite
  omnifin maintenance verify --input /backups/omnifin.sqlite
  omnifin maintenance restore --input /backups/omnifin.sqlite \\
    --rollback-output /backups/pre-restore.sqlite --confirm-gateway-stopped
  omnifin maintenance unlock --confirm-gateway-stopped
`;

interface Arguments {
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArguments(arguments_: string[]): Arguments {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--confirm-gateway-stopped") {
      flags.add(argument);
      continue;
    }
    if (argument !== "--input" && argument !== "--output" && argument !== "--rollback-output") {
      throw new Error("usage");
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) throw new Error("usage");
    values.set(argument, value);
    index += 1;
  }

  return { flags, values };
}

function requireValue(arguments_: Arguments, name: string) {
  const value = arguments_.values.get(name);
  if (!value) throw new Error("usage");
  return value;
}

function assertOnlyValues(arguments_: Arguments, allowed: string[]) {
  for (const name of arguments_.values.keys()) {
    if (!allowed.includes(name)) throw new Error("usage");
  }
}

function writeResult(operation: string, result: object) {
  process.stdout.write(`${JSON.stringify({ operation, status: "ok", ...result })}\n`);
}

async function run() {
  const [operation, ...remainingArguments] = process.argv.slice(2);
  if (!operation || operation === "--help" || operation === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const arguments_ = parseArguments(remainingArguments);
  const databasePath = process.env.OMNIFIN_DATABASE_URL ?? "./data/omnifin.db";
  const imageReference = process.env.OMNIFIN_IMAGE_REF;

  if (operation === "backup") {
    assertOnlyValues(arguments_, ["--output"]);
    if (arguments_.flags.size > 0) throw new Error("usage");
    writeResult(
      operation,
      await createDatabaseBackup({
        databasePath,
        outputPath: requireValue(arguments_, "--output"),
        ...(imageReference ? { imageReference } : {}),
      }),
    );
    return;
  }

  if (operation === "verify") {
    assertOnlyValues(arguments_, ["--input"]);
    if (arguments_.flags.size > 0) throw new Error("usage");
    writeResult(
      operation,
      await verifyDatabaseBackup({ backupPath: requireValue(arguments_, "--input") }),
    );
    return;
  }

  if (operation === "restore") {
    assertOnlyValues(arguments_, ["--input", "--rollback-output"]);
    writeResult(
      operation,
      await restoreDatabaseBackup({
        backupPath: requireValue(arguments_, "--input"),
        confirmedGatewayStopped: arguments_.flags.has("--confirm-gateway-stopped"),
        databasePath,
        rollbackOutputPath: requireValue(arguments_, "--rollback-output"),
        ...(process.env.OMNIFIN_GATEWAY_HEALTH_URL
          ? { gatewayHealthUrl: process.env.OMNIFIN_GATEWAY_HEALTH_URL }
          : {}),
        ...(imageReference ? { imageReference } : {}),
      }),
    );
    return;
  }

  if (operation === "unlock") {
    assertOnlyValues(arguments_, []);
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
