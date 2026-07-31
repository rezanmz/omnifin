import { pbkdf2Sync, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

import { applyCompatibilityTargetOverride } from "../compatibility-targets.mjs";

const authentikTarget = applyCompatibilityTargetOverride({
  authentik: {
    image:
      "ghcr.io/goauthentik/server:2026.5.6@sha256:ed120caf710ccf82ef0026f0bc74e51615bc95ebff228a7a2d6fc60c441c3868",
    version: "2026.5.6",
  },
}).authentik;
export const PROVIDER_VALIDATION_MAX_ATTEMPTS = 10;
export const PROVIDER_VALIDATION_MAX_WAIT_MS = 300_000;
const PROVIDER_VALIDATION_JITTER_SECONDS = 6;
const PRIVATE_IPV4_PATTERNS = [/^10\./u, /^192\.168\./u, /^172\.(?:1[6-9]|2\d|3[01])\./u];
const CHECKS = Object.freeze([
  "authorization_code_pkce",
  "immutable_issuer_subject",
  "jit_pending_jellyfin_link",
  "privileged_group_role_mapping",
  "guarded_role_mapping_update",
  "provider_initiated_backchannel_logout",
  "rp_initiated_logout",
  "secret_leak_inspection",
]);

export function isPrivateIpv4(address) {
  return (
    typeof address === "string" && PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(address))
  );
}

export function selectPrivateHost(interfaces = networkInterfaces()) {
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === "IPv4" && entry.internal === false && isPrivateIpv4(entry.address),
    )
    .map((entry) => entry.address)
    .sort();
  if (candidates.length === 0) {
    throw new Error("private_host_unavailable");
  }
  return candidates[0];
}

export function dotenv(values) {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new Error("environment_name_invalid");
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        value.includes("\n") ||
        value.includes("\r") ||
        value.includes("'")
      ) {
        throw new Error("environment_value_invalid");
      }
      return `${name}='${value}'`;
    })
    .join("\n")
    .concat("\n");
}

export function djangoPasswordHash(password, salt = randomBytes(16).toString("base64url")) {
  if (
    typeof password !== "string" ||
    password.length < 16 ||
    Buffer.byteLength(password, "utf8") > 1_024 ||
    typeof salt !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(salt)
  ) {
    throw new Error("password_hash_input_invalid");
  }
  const iterations = 1_000_000;
  const encoded = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64");
  return `pbkdf2_sha256$${iterations}$${salt}$${encoded}`;
}

export function reportFor(checks = CHECKS) {
  if (
    !Array.isArray(checks) ||
    checks.length !== CHECKS.length ||
    checks.some((check, index) => check !== CHECKS[index])
  ) {
    throw new Error("fixture_checks_incomplete");
  }
  return {
    checks: [...CHECKS],
    image: authentikTarget.image,
    mode: "isolated_fixture",
    passed: true,
    schemaVersion: 1,
    service: "authentik",
    upstreamVersion: authentikTarget.version,
  };
}

export function failureReportFor(category) {
  if (typeof category !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(category)) {
    throw new Error("fixture_error_category_invalid");
  }
  return {
    checks: [],
    errorCategory: category,
    image: authentikTarget.image,
    mode: "isolated_fixture",
    passed: false,
    schemaVersion: 1,
    service: "authentik",
    upstreamVersion: authentikTarget.version,
  };
}

export function httpFailureStage(prefix, status) {
  if (
    typeof prefix !== "string" ||
    !/^[a-z][a-z_]{0,95}$/u.test(prefix) ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    throw new Error("http_failure_stage_invalid");
  }
  if (status >= 300 && status < 400) return `${prefix}_redirect`;
  if (status >= 400 && status < 500) return `${prefix}_client_error`;
  if (status >= 500) return `${prefix}_server_error`;
  return `${prefix}_unexpected_status`;
}

export function providerValidationRetryDelay({ attempt, elapsedMs, retryAfterSeconds, status }) {
  if (status !== 503) return null;
  if (
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    !Number.isInteger(elapsedMs) ||
    elapsedMs < 0 ||
    !Number.isInteger(retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    retryAfterSeconds > 60
  ) {
    throw new Error("provider_validation_retry_invalid");
  }
  if (attempt >= PROVIDER_VALIDATION_MAX_ATTEMPTS - 1) return null;
  const delayMs = (retryAfterSeconds + PROVIDER_VALIDATION_JITTER_SECONDS) * 1_000;
  return elapsedMs + delayMs <= PROVIDER_VALIDATION_MAX_WAIT_MS ? delayMs : null;
}

export function secretLeakDetected(logs, secrets) {
  if (!Array.isArray(logs) || !Array.isArray(secrets)) throw new Error("leak_input_invalid");
  return secrets
    .filter((secret) => typeof secret === "string" && secret.length >= 4)
    .some((secret) => logs.some((log) => typeof log === "string" && log.includes(secret)));
}

export const authentikFixture = Object.freeze({
  checks: CHECKS,
  image: authentikTarget.image,
  version: authentikTarget.version,
});
