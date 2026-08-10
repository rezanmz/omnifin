#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DATABASE_PATH = "/backups/rollback.sqlite";
const PROVIDER_ID = "oidc-upgrade-rehearsal";
const CIPHERTEXT_MAX_LENGTH = 8_192;
const TIMESTAMP_MAX = 8_640_000_000_000_000;
const FAILURE_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const ROLLBACK_PROBE_CATEGORIES = Object.freeze([
  "probe_database",
  "probe_identity",
  "probe_discovery",
  "probe_timestamp",
  "probe_transaction",
]);

export function immutableDatabaseUrl(databasePath) {
  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set("immutable", "1");
  return databaseUrl;
}

function isValidTimestamp(value) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= TIMESTAMP_MAX &&
    new Date(value).getTime() === value
  );
}

function isValidFailureCapabilities(value) {
  if (typeof value !== "string") return false;
  let capabilities;
  try {
    capabilities = JSON.parse(value);
  } catch {
    return false;
  }
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities) ||
    Object.getPrototypeOf(capabilities) !== Object.prototype ||
    Object.keys(capabilities).sort().join(",") !== "configurationFingerprint,schemaVersion"
  ) {
    return false;
  }
  return (
    capabilities.schemaVersion === 1 &&
    typeof capabilities.configurationFingerprint === "string" &&
    FAILURE_FINGERPRINT_PATTERN.test(capabilities.configurationFingerprint)
  );
}

export function classifyQuarantinedRollback(databasePath = DATABASE_PATH) {
  try {
    const databaseUrl = immutableDatabaseUrl(databasePath);
    const database = new DatabaseSync(databaseUrl, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const providers = database
        .prepare(
          `select
             id,
             slug,
             client_id as clientId,
             token_endpoint_auth_method as tokenEndpointAuthMethod,
             encrypted_client_secret as encryptedClientSecret,
             approved_endpoint_origins_json as approvedEndpointOriginsJson,
             discovery_state as discoveryState,
             discovery_capabilities_json as discoveryCapabilitiesJson,
             discovery_checked_at as discoveryCheckedAt,
             created_at as createdAt,
             allow_jit_provisioning as allowJitProvisioning,
             enabled
           from oidc_providers`,
        )
        .all();
      if (providers.length !== 1) return "probe_database";

      const [provider] = providers;
      if (
        provider.id !== PROVIDER_ID ||
        provider.slug !== "upgrade-rehearsal" ||
        provider.clientId !== "omnifin-upgrade-rehearsal" ||
        provider.tokenEndpointAuthMethod !== "client_secret_basic" ||
        typeof provider.encryptedClientSecret !== "string" ||
        provider.encryptedClientSecret.length < 1 ||
        provider.encryptedClientSecret.length > CIPHERTEXT_MAX_LENGTH ||
        provider.allowJitProvisioning !== 0 ||
        provider.enabled !== 1
      ) {
        return "probe_identity";
      }
      if (
        provider.approvedEndpointOriginsJson !== "[]" ||
        provider.discoveryState !== "failed" ||
        !isValidFailureCapabilities(provider.discoveryCapabilitiesJson)
      ) {
        return "probe_discovery";
      }
      if (
        !isValidTimestamp(provider.createdAt) ||
        !isValidTimestamp(provider.discoveryCheckedAt) ||
        provider.discoveryCheckedAt < provider.createdAt
      ) {
        return "probe_timestamp";
      }

      let transactions;
      try {
        transactions = database
          .prepare("select count(*) as count from auth_transactions where provider_id = ?")
          .get(PROVIDER_ID);
      } catch {
        return "probe_database";
      }
      if (transactions?.count !== 0) return "probe_transaction";
      return null;
    } finally {
      database.close();
    }
  } catch {
    return "probe_database";
  }
}

export function verifyQuarantinedRollback(databasePath = DATABASE_PATH) {
  return classifyQuarantinedRollback(databasePath) === null;
}

const SUCCESS_OUTPUT = '{"operation":"rollback_quarantine_raw_verify","status":"ok"}';

function failureOutput(category) {
  return JSON.stringify({
    operation: "rollback_quarantine_raw_verify",
    status: "failed",
    category,
  });
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  try {
    const category = classifyQuarantinedRollback();
    if (category === null) process.stdout.write(`${SUCCESS_OUTPUT}\n`);
    else process.stdout.write(`${failureOutput(category)}\n`);
    if (category !== null) process.exitCode = 1;
  } catch {
    process.stdout.write(`${failureOutput("probe_database")}\n`);
    process.exitCode = 1;
  }
}
