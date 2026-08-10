#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PUBLIC_ORIGIN = "https://omnifin.example";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 1_048_576;
const ROLLBACK_PROBE_MAX_BYTES = 512;
const IMAGE_PATTERN = /^ghcr\.io\/rezanmz\/omnifin@(sha256:[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PRIVATE_IPV4_PATTERN = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u;
export const V0131_ROLLBACK_DIGEST =
  "sha256:deae382a5c09560322eb5146764393bd0155c314087768426b757ca0c6fbff11";
export const ROLLBACK_V0131_EXCEPTION_CHECK = "rollback_v0131_quarantine_exception_verified";
const REQUIRED_CHECKS = Object.freeze([
  "previous_runtime_verified",
  "previous_state_seeded",
  "backup_verified",
  "candidate_runtime_verified",
  "candidate_state_verified",
  "candidate_backup_verified",
  "rollback_backup_verified",
  "rollback_state_verified",
]);
const LEGACY_REQUIRED_CHECKS = Object.freeze([
  ...REQUIRED_CHECKS.slice(0, -1),
  ROLLBACK_V0131_EXCEPTION_CHECK,
  REQUIRED_CHECKS.at(-1),
]);
const ALLOWED_CHECKS = new Set([...REQUIRED_CHECKS, ROLLBACK_V0131_EXCEPTION_CHECK]);

class RehearsalFailure extends Error {
  constructor(operation, options) {
    super(operation, options);
    this.name = "RehearsalFailure";
    this.operation = operation;
  }
}

export function immutableOmnifinImage(value) {
  const match = typeof value === "string" ? value.match(IMAGE_PATTERN) : null;
  if (!match) throw new RehearsalFailure("image_reference_invalid");
  return { digest: match[1], reference: value };
}

function closedState(value, name) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.migrationCount) ||
    value.migrationCount < 0 ||
    typeof value.schemaSha256 !== "string" ||
    !SHA256_PATTERN.test(value.schemaSha256)
  ) {
    throw new RehearsalFailure(`${name}_evidence_invalid`);
  }
  return {
    migrationCount: value.migrationCount,
    schemaSha256: value.schemaSha256,
  };
}

export function usesV0131RollbackCompatibility(digest) {
  return digest === V0131_ROLLBACK_DIGEST;
}

function requiredChecksForDigest(digest) {
  return usesV0131RollbackCompatibility(digest) ? LEGACY_REQUIRED_CHECKS : REQUIRED_CHECKS;
}

function closedChecks(checks, previousDigest) {
  const requiredChecks = requiredChecksForDigest(previousDigest);
  if (
    !Array.isArray(checks) ||
    checks.length !== requiredChecks.length ||
    checks.some((check, index) => check !== requiredChecks[index])
  ) {
    throw new RehearsalFailure("rehearsal_checks_invalid");
  }
  return [...checks];
}

export function upgradeRehearsalReport(input) {
  const previousImage = immutableOmnifinImage(input.previous?.image);
  const candidateImage = immutableOmnifinImage(input.candidate?.image);
  if (previousImage.digest === candidateImage.digest) {
    throw new RehearsalFailure("release_digest_unchanged");
  }
  const previous = closedState(input.previous, "previous");
  const candidate = closedState(input.candidate, "candidate");
  const rollback = closedState(input.rollback, "rollback");
  if (
    candidate.migrationCount < previous.migrationCount ||
    rollback.migrationCount !== previous.migrationCount ||
    rollback.schemaSha256 !== previous.schemaSha256
  ) {
    throw new RehearsalFailure("migration_evidence_invalid");
  }
  return {
    candidate: { digest: candidateImage.digest, ...candidate },
    checks: closedChecks(input.checks, previousImage.digest),
    previous: { digest: previousImage.digest, ...previous },
    rollback,
    schemaVersion: 1,
    status: "passed",
  };
}

function initialReleaseReport(candidateImage) {
  return {
    candidateDigest: candidateImage.digest,
    checks: ["initial_release_exception"],
    reason: "no_previous_stable_release",
    schemaVersion: 1,
    status: "not_applicable",
  };
}

export function failedUpgradeRehearsalReport(error, images, checks) {
  const errorCategory =
    error instanceof RehearsalFailure && /^[a-z][a-z0-9_]{0,63}$/u.test(error.operation)
      ? error.operation
      : "release_rehearsal_failed";
  return {
    candidateDigest: images.candidate.digest,
    checks: checks.filter(
      (check) =>
        ALLOWED_CHECKS.has(check) &&
        (usesV0131RollbackCompatibility(images.previous?.digest) ||
          check !== ROLLBACK_V0131_EXCEPTION_CHECK),
    ),
    errorCategory,
    ...(images.previous ? { previousDigest: images.previous.digest } : {}),
    schemaVersion: 1,
    status: "failed",
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/release/upgrade-rehearsal.mjs --candidate-image <digest> --previous-image <digest> --output <path>",
    "  node scripts/release/upgrade-rehearsal.mjs --candidate-image <digest> --initial-release --output <path>",
  ].join("\n");
}

function parseArguments(arguments_) {
  const values = new Map();
  let initialRelease = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--initial-release") {
      if (initialRelease) throw new RehearsalFailure("usage_invalid");
      initialRelease = true;
      continue;
    }
    if (!["--candidate-image", "--previous-image", "--output"].includes(argument)) {
      throw new RehearsalFailure("usage_invalid");
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) {
      throw new RehearsalFailure("usage_invalid");
    }
    values.set(argument, value);
    index += 1;
  }
  const candidate = immutableOmnifinImage(values.get("--candidate-image"));
  const previousValue = values.get("--previous-image");
  if (initialRelease === Boolean(previousValue) || !values.get("--output")) {
    throw new RehearsalFailure("usage_invalid");
  }
  const previous = previousValue ? immutableOmnifinImage(previousValue) : null;
  if (previous?.digest === candidate.digest) {
    throw new RehearsalFailure("release_digest_unchanged");
  }
  return {
    candidate,
    initialRelease,
    outputPath: repositoryPath(values.get("--output")),
    previous,
  };
}

function repositoryPath(value) {
  const path = resolve(REPOSITORY_ROOT, value);
  const child = relative(REPOSITORY_ROOT, path);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new RehearsalFailure("output_path_invalid");
  }
  return path;
}

function docker(arguments_, operation, options = {}) {
  try {
    return execFileSync("docker", arguments_, {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1_024 * 1_024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 180_000,
    }).trim();
  } catch (error) {
    throw new RehearsalFailure(operation, { cause: error });
  }
}

function inspectImage(image, label) {
  docker(["image", "inspect", image.reference], `${label}_image_inspection`);
  const runtimeUser = docker(
    ["image", "inspect", "--format", "{{.Config.User}}", image.reference],
    `${label}_runtime_user`,
  );
  const entrypoint = docker(
    ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", image.reference],
    `${label}_entrypoint`,
  );
  let entrypointParts;
  try {
    entrypointParts = JSON.parse(entrypoint);
  } catch (error) {
    throw new RehearsalFailure(`${label}_runtime_contract_invalid`, { cause: error });
  }
  if (
    runtimeUser !== "65532:65532" ||
    !Array.isArray(entrypointParts) ||
    entrypointParts.length !== 2 ||
    entrypointParts[0] !== "/nodejs/bin/node" ||
    entrypointParts[1] !== "/opt/omnifin/bin/entrypoint.mjs"
  ) {
    throw new RehearsalFailure(`${label}_runtime_contract_invalid`);
  }
  return { nodeEntrypoint: entrypointParts[0] };
}

async function waitForHealthy(container, operation) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const health = docker(
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        container,
      ],
      operation,
    );
    if (health === "healthy") return;
    if (health === "unhealthy" || health === "none") throw new RehearsalFailure(operation);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new RehearsalFailure(operation);
}

export function runningContainerState(value, operation) {
  const state = typeof value === "string" ? value.trim() : "";
  if (state === "true:0") return true;
  if (/^false:\d{1,3}$/u.test(state)) throw new RehearsalFailure(`${operation}_exited`);
  throw new RehearsalFailure(`${operation}_invalid`);
}

export function privateContainerAddress(value, operation) {
  const address = typeof value === "string" ? value.trim() : "";
  if (isIP(address) !== 4 || !PRIVATE_IPV4_PATTERN.test(address)) {
    throw new RehearsalFailure(`${operation}_invalid`);
  }
  return address;
}

function privateGatewayUrl(container, operation) {
  runningContainerState(
    docker(
      ["container", "inspect", "--format", "{{.State.Running}}:{{.State.ExitCode}}", container],
      `${operation}_state_inspect`,
    ),
    `${operation}_state`,
  );
  const address = privateContainerAddress(
    docker(
      [
        "container",
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        container,
      ],
      `${operation}_address_inspect`,
    ),
    `${operation}_address`,
  );
  return new URL(`http://${address}:4000/`);
}

function startGateway(resources, image, label) {
  const gatewayRuntimeArguments = [
    "--volume",
    `${resources.backupVolume}:/backups`,
    "--env",
    "OMNIFIN_BACKUP_DIRECTORY=/backups",
    "--env",
    `OMNIFIN_IMAGE_REF=${image.reference}`,
  ];
  const name = `${resources.prefix}-${label}`;
  resources.containers.add(name);
  docker(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      resources.network,
      "--network-alias",
      "gateway",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "768m",
      "--cpus",
      "2",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
      "--volume",
      `${resources.dataVolume}:/data`,
      "--volume",
      `${resources.encryptionFile}:/run/secrets/omnifin_encryption_key:ro`,
      "--volume",
      `${resources.recoveryFile}:/run/secrets/omnifin_recovery_secret:ro`,
      "--env",
      "NODE_ENV=production",
      "--env",
      `OMNIFIN_BASE_URL=${PUBLIC_ORIGIN}`,
      "--env",
      "OMNIFIN_DATABASE_URL=/data/omnifin.db",
      "--env",
      "OMNIFIN_ENCRYPTION_KEY_FILE=/run/secrets/omnifin_encryption_key",
      "--env",
      "OMNIFIN_RECOVERY_SECRET_FILE=/run/secrets/omnifin_recovery_secret",
      "--env",
      "OMNIFIN_SECURE_COOKIES=true",
      ...gatewayRuntimeArguments,
      image.reference,
      "gateway",
    ],
    `${label}_gateway_start`,
  );
  return { name, url: privateGatewayUrl(name, `${label}_gateway`) };
}

function stopGateway(resources, gateway, label) {
  docker(["container", "stop", "--time", "15", gateway.name], `${label}_gateway_stop`);
  docker(["container", "rm", gateway.name], `${label}_gateway_remove`);
  resources.containers.delete(gateway.name);
}

async function requestJson(baseUrl, path, operation, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        accept: "application/json",
        origin: PUBLIC_ORIGIN,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.csrfToken ? { "x-omnifin-csrf": options.csrfToken } : {}),
      },
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RehearsalFailure(operation, { cause: error });
  }
  if (response.status !== (options.expectedStatus ?? 200)) {
    throw new RehearsalFailure(operation);
  }
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > RESPONSE_MAX_BYTES) throw new RehearsalFailure(operation);
  const text = await response.text();
  if (Buffer.byteLength(text) > RESPONSE_MAX_BYTES) throw new RehearsalFailure(operation);
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new RehearsalFailure(operation, { cause: error });
  }
  return { body, headers: response.headers, status: response.status };
}

async function recoverySession(gatewayUrl, recoverySecret, label) {
  const response = await requestJson(gatewayUrl, "v1/auth/recovery/session", `${label}_recovery`, {
    body: { secret: recoverySecret },
    method: "POST",
  });
  const csrfToken = response.body?.csrfToken;
  const principal = response.body?.principal;
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0];
  if (
    !SESSION_VALUE_PATTERN.test(csrfToken ?? "") ||
    !cookie.startsWith("__Host-omnifin_session=") ||
    !principal ||
    principal.accountState !== "recovery" ||
    principal.authenticationMethod?.kind !== "recovery"
  ) {
    throw new RehearsalFailure(`${label}_recovery_invalid`);
  }
  return { cookie, csrfToken };
}

export function validateV0131RollbackAdminError(response) {
  if (
    !response ||
    response.status !== 503 ||
    !response.body ||
    typeof response.body !== "object" ||
    Array.isArray(response.body) ||
    !response.body.error ||
    typeof response.body.error !== "object" ||
    Array.isArray(response.body.error) ||
    response.body.error.code !== "oidc_provider_configuration_unavailable"
  ) {
    throw new RehearsalFailure("rollback_v0131_admin_error_invalid");
  }
  return true;
}

async function seedProvider(gatewayUrl, recoverySecret) {
  const session = await recoverySession(gatewayUrl, recoverySecret, "previous");
  const response = await requestJson(
    gatewayUrl,
    "v1/admin/auth/oidc/providers",
    "previous_provider_create",
    {
      body: {
        allowJitProvisioning: false,
        approvedEndpointOrigins: ["https://identity-upgrade.example.test"],
        clientId: "omnifin-upgrade-rehearsal",
        clientSecret: randomBytes(32).toString("base64url"),
        displayName: "Upgrade rehearsal identity",
        enabled: true,
        idTokenSigningAlg: "RS256",
        issuer: "https://identity-upgrade.example.test/application/o/omnifin/",
        scopes: ["openid", "profile", "email"],
        slug: "upgrade-rehearsal",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      expectedStatus: 201,
      method: "POST",
    },
  );
  if (
    response.body?.slug !== "upgrade-rehearsal" ||
    response.body.clientSecretConfigured !== true
  ) {
    throw new RehearsalFailure("previous_provider_create_invalid");
  }
}

async function verifyProvider(gatewayUrl, recoverySecret, label) {
  const session = await recoverySession(gatewayUrl, recoverySecret, label);
  const response = await requestJson(
    gatewayUrl,
    "v1/admin/auth/oidc/providers",
    `${label}_provider_read`,
    { cookie: session.cookie },
  );
  const providers = response.body?.providers;
  if (
    !Array.isArray(providers) ||
    providers.length !== 1 ||
    providers[0]?.slug !== "upgrade-rehearsal" ||
    providers[0]?.clientSecretConfigured !== true
  ) {
    throw new RehearsalFailure(`${label}_provider_state_invalid`);
  }
}

async function verifyRollbackProvider(gatewayUrl, recoverySecret) {
  const session = await recoverySession(gatewayUrl, recoverySecret, "rollback");
  const response = await requestJson(
    gatewayUrl,
    "v1/admin/auth/oidc/providers",
    "rollback_provider_read",
    { cookie: session.cookie },
  );
  const providers = response.body?.providers;
  const provider = providers?.[0];
  if (
    !Array.isArray(providers) ||
    providers.length !== 1 ||
    provider?.id !== "oidc-upgrade-rehearsal" ||
    provider?.slug !== "upgrade-rehearsal" ||
    provider?.clientId !== "omnifin-upgrade-rehearsal" ||
    !Array.isArray(provider?.approvedEndpointOrigins) ||
    provider.approvedEndpointOrigins.length !== 0 ||
    provider?.discoveryState !== "unchecked" ||
    provider?.clientSecretConfigured !== true
  ) {
    throw new RehearsalFailure("rollback_provider_state_invalid");
  }
}

async function verifyV0131RollbackAdminError(gatewayUrl, recoverySecret) {
  const session = await recoverySession(gatewayUrl, recoverySecret, "rollback_v0131");
  const response = await requestJson(
    gatewayUrl,
    "v1/admin/auth/oidc/providers",
    "rollback_v0131_admin",
    { cookie: session.cookie, expectedStatus: 503 },
  );
  validateV0131RollbackAdminError(response);
}

async function verifyRollbackPublicQuarantine(gatewayUrl) {
  const response = await requestJson(gatewayUrl, "v1/auth/providers", "rollback_public_providers");
  const providers = response.body?.providers;
  if (
    !Array.isArray(providers) ||
    providers.length !== 1 ||
    providers[0]?.id !== "oidc-upgrade-rehearsal" ||
    providers[0]?.kind !== "oidc" ||
    providers[0]?.state !== "unavailable"
  ) {
    throw new RehearsalFailure("rollback_public_provider_invalid");
  }
}

async function requestRedirect(baseUrl, path, operation, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      headers: {
        accept: "text/plain",
        origin: PUBLIC_ORIGIN,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RehearsalFailure(operation, { cause: error });
  }
  if (response.status !== 303) throw new RehearsalFailure(operation);
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > RESPONSE_MAX_BYTES) throw new RehearsalFailure(operation);
  const text = await response.text();
  if (Buffer.byteLength(text) > RESPONSE_MAX_BYTES) throw new RehearsalFailure(operation);
  if (response.headers.get("location") !== "/login?authError=provider_unavailable") {
    throw new RehearsalFailure(operation);
  }
}

async function verifyRollbackOidcStart(gatewayUrl) {
  await requestRedirect(
    gatewayUrl,
    "v1/auth/oidc/oidc-upgrade-rehearsal/start",
    "rollback_oidc_start",
    { cookie: `__Host-omnifin_oidc_binding=${"A".repeat(43)}` },
  );
}

function maintenanceArguments(resources, image, name) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    resources.network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "768m",
    "--cpus",
    "2",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
    "--volume",
    `${resources.dataVolume}:/data`,
    "--volume",
    `${resources.backupVolume}:/backups`,
    "--env",
    "OMNIFIN_DATABASE_URL=/data/omnifin.db",
    "--env",
    "OMNIFIN_GATEWAY_HEALTH_URL=http://gateway:4000/healthz",
    "--env",
    `OMNIFIN_IMAGE_REF=${image.reference}`,
    image.reference,
    "maintenance",
  ];
}

function runMaintenance(resources, image, label, arguments_, operation) {
  const name = `${resources.prefix}-maintenance-${label}`;
  resources.containers.add(name);
  const output = docker(
    [...maintenanceArguments(resources, image, name), ...arguments_],
    operation,
  );
  resources.containers.delete(name);
  return output;
}

function maintenanceResult(output, expectedOperation, operation) {
  let result;
  try {
    result = JSON.parse(output);
  } catch (error) {
    throw new RehearsalFailure(operation, { cause: error });
  }
  if (result?.operation !== expectedOperation || result.status !== "ok") {
    throw new RehearsalFailure(operation);
  }
  return result;
}

function maintenanceSnapshot(resources, image, fileName, label) {
  const backup = maintenanceResult(
    runMaintenance(
      resources,
      image,
      `${label}-backup`,
      ["backup", "--output", `/backups/${fileName}`],
      `${label}_backup`,
    ),
    "backup",
    `${label}_backup_result`,
  );
  const verified = maintenanceResult(
    runMaintenance(
      resources,
      image,
      `${label}-backup-verify`,
      ["verify", "--input", `/backups/${fileName}`],
      `${label}_backup_verify`,
    ),
    "verify",
    `${label}_backup_verify_result`,
  );
  const closed = closedState(verified, `${label}_backup`);
  if (
    typeof verified.databaseSha256 !== "string" ||
    !SHA256_PATTERN.test(verified.databaseSha256) ||
    backup.databaseSha256 !== verified.databaseSha256 ||
    backup.schemaSha256 !== verified.schemaSha256 ||
    backup.migrationCount !== verified.migrationCount
  ) {
    throw new RehearsalFailure(`${label}_backup_mismatch`);
  }
  return { ...closed, databaseSha256: verified.databaseSha256 };
}

const ROLLBACK_PROBE_SUCCESS_OUTPUT = `${JSON.stringify({
  operation: "rollback_quarantine_raw_verify",
  status: "ok",
})}\n`;
const ROLLBACK_PROBE_CATEGORIES = new Set([
  "probe_database",
  "probe_identity",
  "probe_discovery",
  "probe_timestamp",
  "probe_transaction",
]);

function rollbackProbeFailureOperation(category) {
  return `rollback_v0131_${category}`;
}

export function classifyV0131RollbackProbeResult(status, stdout) {
  if (status === 125) return "rollback_v0131_probe_container";
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > ROLLBACK_PROBE_MAX_BYTES) {
    return "rollback_v0131_probe_invalid";
  }
  if (status === 0) {
    return stdout === ROLLBACK_PROBE_SUCCESS_OUTPUT ? null : "rollback_v0131_probe_invalid";
  }
  if (status !== 1) return "rollback_v0131_probe_invalid";

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return "rollback_v0131_probe_invalid";
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getPrototypeOf(result) !== Object.prototype ||
    Object.keys(result).join(",") !== "operation,status,category" ||
    result.operation !== "rollback_quarantine_raw_verify" ||
    result.status !== "failed" ||
    !ROLLBACK_PROBE_CATEGORIES.has(result.category) ||
    stdout !== `${JSON.stringify(result)}\n`
  ) {
    return "rollback_v0131_probe_invalid";
  }
  return rollbackProbeFailureOperation(result.category);
}

function runV0131RollbackProbe(resources, image, nodeEntrypoint) {
  const name = `${resources.prefix}-rollback-v0131-probe`;
  const probePath = join(REPOSITORY_ROOT, "scripts/release/verify-v0131-quarantined-rollback.mjs");
  resources.containers.add(name);
  try {
    let result;
    try {
      result = {
        status: 0,
        stdout: execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            name,
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "64",
            "--memory",
            "256m",
            "--cpus",
            "1",
            "--volume",
            `${resources.backupVolume}:/backups:ro`,
            "--volume",
            `${probePath}:/opt/omnifin/bin/verify-v0131-quarantined-rollback.mjs:ro`,
            "--entrypoint",
            nodeEntrypoint,
            image.reference,
            "/opt/omnifin/bin/verify-v0131-quarantined-rollback.mjs",
          ],
          {
            cwd: REPOSITORY_ROOT,
            encoding: "utf8",
            maxBuffer: ROLLBACK_PROBE_MAX_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 180_000,
          },
        ),
      };
    } catch (error) {
      result = {
        status: error?.status,
        stdout:
          typeof error?.stdout === "string"
            ? error.stdout
            : Buffer.isBuffer(error?.stdout)
              ? error.stdout.toString("utf8")
              : "",
      };
    }
    const operation = classifyV0131RollbackProbeResult(result.status, result.stdout);
    if (operation) throw new RehearsalFailure(operation);
  } catch (error) {
    try {
      docker(["container", "rm", "--force", name], "rollback_v0131_probe_cleanup");
    } catch {
      // The --rm run normally already removed the container.
    }
    resources.containers.delete(name);
    if (error instanceof RehearsalFailure) {
      const failure = error;
      throw failure;
    }
    throw new RehearsalFailure("rollback_v0131_probe_invalid");
  } finally {
    resources.containers.delete(name);
  }
}

export function validatePreviousRestoreEvidence(restored, previous, rollback) {
  const digestFields = [
    previous?.databaseSha256,
    restored?.databaseSha256,
    restored?.sanitizedDatabaseSha256,
    restored?.sourceDatabaseSha256,
    restored?.rollback?.databaseSha256,
    restored?.rollback?.schemaSha256,
    rollback?.databaseSha256,
    rollback?.schemaSha256,
  ];
  const migrationCounts = [restored?.rollback?.migrationCount, rollback?.migrationCount];
  if (
    digestFields.some((digest) => typeof digest !== "string" || !SHA256_PATTERN.test(digest)) ||
    migrationCounts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    restored.sourceDatabaseSha256 !== previous.databaseSha256 ||
    restored.databaseSha256 !== restored.sanitizedDatabaseSha256 ||
    restored.sanitizedDatabaseSha256 === previous.databaseSha256 ||
    restored.rollback.databaseSha256 !== rollback.databaseSha256 ||
    restored.rollback.schemaSha256 !== rollback.schemaSha256 ||
    restored.rollback.migrationCount !== rollback.migrationCount
  ) {
    throw new RehearsalFailure("previous_restore_invalid");
  }
  return true;
}

function restorePreviousState(resources, priorImage, previous) {
  const restored = maintenanceResult(
    runMaintenance(
      resources,
      priorImage,
      "previous-restore",
      [
        "restore",
        "--input",
        "/backups/previous.sqlite",
        "--rollback-output",
        "/backups/candidate-pre-rollback.sqlite",
        "--confirm-gateway-stopped",
      ],
      "previous_restore",
    ),
    "restore",
    "previous_restore_result",
  );
  const rollback = maintenanceResult(
    runMaintenance(
      resources,
      priorImage,
      "candidate-rollback-backup-verify",
      ["verify", "--input", "/backups/candidate-pre-rollback.sqlite"],
      "candidate_rollback_backup_verify",
    ),
    "verify",
    "candidate_rollback_backup_verify_result",
  );
  validatePreviousRestoreEvidence(restored, previous, rollback);
  return closedState(rollback, "candidate_rollback_backup");
}

async function writeReport(outputPath, report) {
  const parent = dirname(outputPath);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const root = await realpath(REPOSITORY_ROOT);
  const canonicalParent = await realpath(parent);
  const child = relative(root, canonicalParent);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new RehearsalFailure("output_path_invalid");
  }
  const temporaryPath = resolve(
    parent,
    `.${basename(outputPath)}.${randomBytes(6).toString("hex")}`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function cleanupResources(resources) {
  let cleanupError = null;
  for (const container of [...resources.containers].reverse()) {
    try {
      docker(["container", "rm", "--force", container], "cleanup_container");
    } catch (error) {
      cleanupError ??= error;
    }
  }
  for (const [kind, name, created] of [
    ["network", resources.network, resources.networkCreated],
    ["volume", resources.dataVolume, resources.dataVolumeCreated],
    ["volume", resources.backupVolume, resources.backupVolumeCreated],
  ]) {
    if (!created) continue;
    try {
      docker([kind, "rm", name], `cleanup_${kind}`);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    await rm(resources.temporaryDirectory, { force: true, recursive: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw new RehearsalFailure("cleanup_failed", { cause: cleanupError });
}

async function createResources() {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "omnifin-upgrade-rehearsal-")),
  );
  const resources = {
    backupVolume: `omnifin-upgrade-backups-${suffix}`,
    backupVolumeCreated: false,
    containers: new Set(),
    dataVolume: `omnifin-upgrade-data-${suffix}`,
    dataVolumeCreated: false,
    encryptionFile: join(temporaryDirectory, "encryption-key"),
    network: `omnifin-upgrade-network-${suffix}`,
    networkCreated: false,
    prefix: `omnifin-upgrade-${suffix}`,
    recoveryFile: join(temporaryDirectory, "recovery-secret"),
    recoverySecret: randomBytes(48).toString("base64"),
    temporaryDirectory,
  };
  try {
    await Promise.all([
      writeFile(resources.encryptionFile, randomBytes(32).toString("base64"), { mode: 0o444 }),
      writeFile(resources.recoveryFile, resources.recoverySecret, { mode: 0o444 }),
    ]);
    docker(["network", "create", "--internal", resources.network], "network_create");
    resources.networkCreated = true;
    docker(["volume", "create", resources.dataVolume], "data_volume_create");
    resources.dataVolumeCreated = true;
    docker(["volume", "create", resources.backupVolume], "backup_volume_create");
    resources.backupVolumeCreated = true;
    return resources;
  } catch (error) {
    try {
      await cleanupResources(resources);
    } catch (cleanupError) {
      throw new RehearsalFailure("cleanup_failed", { cause: cleanupError });
    }
    throw error;
  }
}

async function exercise(options, checks) {
  const previousRuntime = inspectImage(options.previous, "previous");
  inspectImage(options.candidate, "candidate");
  const resources = await createResources();
  let result;
  let executionError = null;
  try {
    const previousGateway = startGateway(resources, options.previous, "previous");
    await waitForHealthy(previousGateway.name, "previous_gateway_health");
    checks.push("previous_runtime_verified");
    await seedProvider(previousGateway.url, resources.recoverySecret);
    await verifyProvider(previousGateway.url, resources.recoverySecret, "previous_seeded");
    checks.push("previous_state_seeded");
    const previous = maintenanceSnapshot(
      resources,
      options.previous,
      "previous.sqlite",
      "previous",
    );
    checks.push("backup_verified");
    stopGateway(resources, previousGateway, "previous");

    const candidateGateway = startGateway(resources, options.candidate, "candidate");
    await waitForHealthy(candidateGateway.name, "candidate_gateway_health");
    checks.push("candidate_runtime_verified");
    await verifyProvider(candidateGateway.url, resources.recoverySecret, "candidate");
    checks.push("candidate_state_verified");
    const candidate = maintenanceSnapshot(
      resources,
      options.candidate,
      "candidate.sqlite",
      "candidate",
    );
    checks.push("candidate_backup_verified");
    stopGateway(resources, candidateGateway, "candidate");

    const candidateRollback = restorePreviousState(resources, options.previous, previous);
    if (
      candidateRollback.migrationCount !== candidate.migrationCount ||
      candidateRollback.schemaSha256 !== candidate.schemaSha256
    ) {
      throw new RehearsalFailure("candidate_rollback_backup_mismatch");
    }
    checks.push("rollback_backup_verified");
    const rollbackGateway = startGateway(resources, options.previous, "rollback");
    await waitForHealthy(rollbackGateway.name, "rollback_gateway_health");
    if (usesV0131RollbackCompatibility(options.previous.digest)) {
      await verifyV0131RollbackAdminError(rollbackGateway.url, resources.recoverySecret);
    } else {
      await verifyRollbackProvider(rollbackGateway.url, resources.recoverySecret);
    }
    await verifyRollbackPublicQuarantine(rollbackGateway.url);
    await verifyRollbackOidcStart(rollbackGateway.url);
    const rollback = maintenanceSnapshot(
      resources,
      options.previous,
      "rollback.sqlite",
      "rollback",
    );
    if (usesV0131RollbackCompatibility(options.previous.digest)) {
      runV0131RollbackProbe(resources, options.previous, previousRuntime.nodeEntrypoint);
      checks.push(ROLLBACK_V0131_EXCEPTION_CHECK);
    }
    checks.push("rollback_state_verified");
    stopGateway(resources, rollbackGateway, "rollback");

    result = upgradeRehearsalReport({
      candidate: { image: options.candidate.reference, ...candidate },
      checks,
      previous: { image: options.previous.reference, ...previous },
      rollback,
    });
  } catch (error) {
    executionError = error;
  }
  try {
    await cleanupResources(resources);
  } catch (error) {
    executionError ??= error;
  }
  if (executionError) throw executionError;
  return result;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (_error) {
    process.stderr.write(
      `${JSON.stringify({ errorCategory: "usage_invalid", status: "failed" })}\n`,
    );
    process.stderr.write(`${usage()}\n`);
    return 64;
  }
  const checks = [];
  let report;
  let exitCode = 0;
  try {
    if (options.initialRelease) {
      inspectImage(options.candidate, "candidate");
      report = initialReleaseReport(options.candidate);
    } else {
      report = await exercise(options, checks);
    }
  } catch (error) {
    report = failedUpgradeRehearsalReport(error, options, checks);
    exitCode = 1;
  }
  try {
    await writeReport(options.outputPath, report);
  } catch {
    process.stderr.write(
      `${JSON.stringify({ errorCategory: "report_write_failed", status: "failed" })}\n`,
    );
    return 1;
  }
  const output = `${JSON.stringify(report)}\n`;
  if (exitCode === 0) process.stdout.write(output);
  else process.stderr.write(output);
  return exitCode;
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) process.exitCode = await main();
