import { pbkdf2Sync, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

const AUTHENTIK_VERSION = "2026.5.6";
const PRIVATE_IPV4_PATTERNS = [/^10\./u, /^192\.168\./u, /^172\.(?:1[6-9]|2\d|3[01])\./u];
const CHECKS = Object.freeze([
  "authorization_code_pkce",
  "immutable_issuer_subject",
  "jit_pending_jellyfin_link",
  "privileged_group_role_mapping",
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
    mode: "isolated_fixture",
    passed: true,
    schemaVersion: 1,
    service: "authentik",
    upstreamVersion: AUTHENTIK_VERSION,
  };
}

export function secretLeakDetected(logs, secrets) {
  if (!Array.isArray(logs) || !Array.isArray(secrets)) throw new Error("leak_input_invalid");
  return secrets
    .filter((secret) => typeof secret === "string" && secret.length >= 4)
    .some((secret) => logs.some((log) => typeof log === "string" && log.includes(secret)));
}

export const authentikFixture = Object.freeze({
  checks: CHECKS,
  version: AUTHENTIK_VERSION,
});
