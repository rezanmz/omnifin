#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DATABASE_PATH = "/backups/rollback.sqlite";
const PROVIDER_ID = "oidc-upgrade-rehearsal";
const SUCCESS_OUTPUT = '{"operation":"rollback_quarantine_raw_verify","status":"ok"}';
const CIPHERTEXT_MAX_LENGTH = 8_192;

export function verifyQuarantinedRollback(databasePath = DATABASE_PATH) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
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
           allow_jit_provisioning as allowJitProvisioning,
           enabled
         from oidc_providers`,
      )
      .all();
    if (providers.length !== 1) return false;
    const [provider] = providers;
    if (
      provider.id !== PROVIDER_ID ||
      provider.slug !== "upgrade-rehearsal" ||
      provider.clientId !== "omnifin-upgrade-rehearsal" ||
      provider.tokenEndpointAuthMethod !== "client_secret_basic" ||
      typeof provider.encryptedClientSecret !== "string" ||
      provider.encryptedClientSecret.length < 1 ||
      provider.encryptedClientSecret.length > CIPHERTEXT_MAX_LENGTH ||
      provider.approvedEndpointOriginsJson !== "[]" ||
      provider.discoveryState !== "unchecked" ||
      provider.discoveryCapabilitiesJson !== "{}" ||
      provider.discoveryCheckedAt !== null ||
      provider.allowJitProvisioning !== 0 ||
      provider.enabled !== 1
    ) {
      return false;
    }
    const transactions = database
      .prepare("select count(*) as count from auth_transactions where provider_id = ?")
      .get(PROVIDER_ID);
    return transactions?.count === 0;
  } finally {
    database.close();
  }
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  try {
    if (!verifyQuarantinedRollback()) process.exitCode = 1;
    else process.stdout.write(`${SUCCESS_OUTPUT}\n`);
  } catch {
    process.exitCode = 1;
  }
}
