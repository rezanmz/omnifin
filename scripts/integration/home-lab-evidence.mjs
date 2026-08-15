const sourceShaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const architectureValues = new Set(["linux/amd64", "linux/arm64"]);

export const HOME_LAB_EVIDENCE_COVERAGE = Object.freeze([
  "documented-install",
  "tls-reverse-proxy",
  "bootstrap",
  "backup",
  "empty-host-restore",
  "upgrade",
  "rollback",
  "troubleshooting",
  "real-network",
  "sse-media-proxying",
  "recovery-evidence",
  "sanitized-diagnostics",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function requireString(value, label, maximum = 128) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value;
}

function requireSafeIdentifier(value, label) {
  const identifier = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(identifier)) {
    throw new Error(`${label} must be a safe identifier without network or credential syntax.`);
  }
  return identifier;
}

function requireSafeVersion(value, label) {
  const version = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(version)) {
    throw new Error(`${label} must be a safe identifier without network or credential syntax.`);
  }
  return version;
}

function requireDate(value, label) {
  if (!datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be an ISO calendar date.`);
  }
  return value;
}

function validateCoverage(value) {
  if (
    !Array.isArray(value) ||
    value.length !== HOME_LAB_EVIDENCE_COVERAGE.length ||
    new Set(value).size !== value.length ||
    [...value].sort().join(",") !== [...HOME_LAB_EVIDENCE_COVERAGE].sort().join(",")
  ) {
    throw new Error("Home-lab evidence must verify every documented Tier 4 behavior.");
  }
  return [...HOME_LAB_EVIDENCE_COVERAGE];
}

function validateDeployment(value) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["network", "tls", "type"]) ||
    value.type !== "home-lab" ||
    value.network !== "real" ||
    value.tls !== "reverse-proxy"
  ) {
    throw new Error("Home-lab evidence must identify a real network behind a TLS reverse proxy.");
  }
  return { network: "real", tls: "reverse-proxy", type: "home-lab" };
}

function validateUpstream(value) {
  if (!isRecord(value) || !exactKeys(value, ["versions"]) || !isRecord(value.versions)) {
    throw new Error("Home-lab evidence must identify non-empty upstream versions.");
  }
  const entries = Object.entries(value.versions);
  if (entries.length === 0) {
    throw new Error("Home-lab evidence must identify non-empty upstream versions.");
  }
  const versions = {};
  for (const [service, version] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(service)) {
      throw new Error("Home-lab evidence has an invalid upstream service name.");
    }
    versions[service] = requireSafeVersion(
      version,
      `Home-lab evidence upstream version for ${service}`,
    );
  }
  return { versions };
}

function validateArchitecture(value) {
  if (!architectureValues.has(value)) {
    throw new Error("Home-lab evidence architecture must be a supported stable architecture.");
  }
  return value;
}

export function validateHomeLabEvidence(value, options) {
  if (
    !isRecord(options) ||
    !sourceShaPattern.test(options.sourceSha) ||
    !digestPattern.test(options.candidateDigest)
  ) {
    throw new Error(
      "Home-lab evidence validation requires an exact source SHA and candidate digest.",
    );
  }
  const today = requireDate(
    options.today ?? new Date().toISOString().slice(0, 10),
    "Validation date",
  );
  const expectedKeys = [
    "architecture",
    "candidateDigest",
    "deployment",
    "expiresAt",
    "owner",
    "result",
    "schemaVersion",
    "sourceSha",
    "upstream",
    "verifiedAt",
    "verifiedCoverage",
  ];
  if (!isRecord(value) || !exactKeys(value, expectedKeys) || value.schemaVersion !== 1) {
    throw new Error("Home-lab evidence must use the exact versioned report schema.");
  }
  if (value.sourceSha !== options.sourceSha || !sourceShaPattern.test(value.sourceSha)) {
    throw new Error("Home-lab evidence sourceSha must match the exact candidate source SHA.");
  }
  if (
    value.candidateDigest !== options.candidateDigest ||
    !digestPattern.test(value.candidateDigest)
  ) {
    throw new Error("Home-lab evidence candidateDigest must match the exact candidate digest.");
  }
  if (value.result !== "passed") {
    throw new Error("Home-lab evidence result must be passed.");
  }
  const verifiedAt = requireDate(value.verifiedAt, "Home-lab evidence verifiedAt");
  const expiresAt = requireDate(value.expiresAt, "Home-lab evidence expiresAt");
  if (verifiedAt > today) {
    throw new Error("Home-lab evidence cannot be verified in the future.");
  }
  if (expiresAt < verifiedAt || expiresAt < today) {
    throw new Error("Home-lab evidence must be unexpired after its verification date.");
  }
  if (
    Date.parse(`${expiresAt}T00:00:00.000Z`) - Date.parse(`${verifiedAt}T00:00:00.000Z`) >
    30 * 24 * 60 * 60 * 1000
  ) {
    throw new Error("Home-lab evidence expiry must be no more than 30 days after verification.");
  }
  return {
    architecture: validateArchitecture(value.architecture),
    candidateDigest: options.candidateDigest,
    deployment: validateDeployment(value.deployment),
    expiresAt,
    owner: requireSafeIdentifier(value.owner, "Home-lab evidence owner"),
    result: "passed",
    schemaVersion: 1,
    sourceSha: options.sourceSha,
    upstream: validateUpstream(value.upstream),
    verifiedAt,
    verifiedCoverage: validateCoverage(value.verifiedCoverage),
  };
}
