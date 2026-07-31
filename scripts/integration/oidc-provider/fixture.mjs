import { networkInterfaces } from "node:os";

import { applyCompatibilityTargetOverride } from "../compatibility-targets.mjs";

const oidcProviderTarget = applyCompatibilityTargetOverride({
  oidc: {
    image:
      "ghcr.io/dexidp/dex:v2.45.1@sha256:8499afd690c437f52301efd2b05b2455da5bd2dfc20332cd697dc9937f808462",
    version: "2.45.1",
  },
}).oidc;
const PRIVATE_IPV4_PATTERNS = [/^10\./u, /^192\.168\./u, /^172\.(?:1[6-9]|2\d|3[01])\./u];
const CHECKS = Object.freeze([
  "authorization_code_pkce",
  "state_nonce_validation",
  "strict_issuer_and_standard_claims",
  "immutable_issuer_subject",
  "jit_viewer_pending_jellyfin_link",
  "explicit_group_role_mapping",
  "guarded_role_mapping_update",
  "optional_logout_capability_negotiation",
  "local_logout_fallback",
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
  if (candidates.length === 0) throw new Error("private_host_unavailable");
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

export function renderConfig(template, values) {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== "string" || value.length === 0) {
      throw new Error("provider_config_value_invalid");
    }
    const placeholder = `__${name}__`;
    if (!rendered.includes(placeholder)) throw new Error("provider_config_placeholder_missing");
    rendered = rendered.replaceAll(placeholder, JSON.stringify(value));
  }
  if (/__[A-Z][A-Z0-9_]*__/u.test(rendered)) {
    throw new Error("provider_config_incomplete");
  }
  return rendered;
}

export function secretLeakDetected(logs, secrets) {
  if (!Array.isArray(logs) || !Array.isArray(secrets)) throw new Error("leak_input_invalid");
  return secrets
    .filter((secret) => typeof secret === "string" && secret.length >= 4)
    .some((secret) => logs.some((log) => typeof log === "string" && log.includes(secret)));
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
    image: oidcProviderTarget.image,
    mode: "isolated_fixture",
    passed: true,
    schemaVersion: 1,
    service: "oidc",
    upstreamVersion: oidcProviderTarget.version,
  };
}

export function failureReportFor(category) {
  if (typeof category !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(category)) {
    throw new Error("fixture_error_category_invalid");
  }
  return {
    checks: [],
    errorCategory: category,
    image: oidcProviderTarget.image,
    mode: "isolated_fixture",
    passed: false,
    schemaVersion: 1,
    service: "oidc",
    upstreamVersion: oidcProviderTarget.version,
  };
}

export const oidcProviderFixture = Object.freeze({
  checks: CHECKS,
  image: oidcProviderTarget.image,
  version: oidcProviderTarget.version,
});
