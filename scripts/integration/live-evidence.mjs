import { SERVICES } from "./readiness.mjs";
import { STABLE_ARCHITECTURES, V1_TIER_REQUIREMENTS } from "./release-evidence.mjs";

const sourceShaPattern = /^[0-9a-f]{40}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const safeVersionPattern = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u;

export const LIVE_EVIDENCE_COVERAGE = V1_TIER_REQUIREMENTS[2].coverage;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function requireDate(value, label) {
  if (!datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be an ISO calendar date.`);
  }
  return value;
}

function requireSafeIdentifier(value, label) {
  if (typeof value !== "string" || !safeIdentifierPattern.test(value)) {
    throw new Error(`${label} must be a safe identifier without network or credential syntax.`);
  }
  return value;
}

function requireSafeVersion(value, label) {
  if (typeof value !== "string" || !safeVersionPattern.test(value)) {
    throw new Error(`${label} must be a safe version without network or credential syntax.`);
  }
  return value;
}

function validateCoverage(value) {
  if (
    !Array.isArray(value) ||
    value.length !== LIVE_EVIDENCE_COVERAGE.length ||
    new Set(value).size !== value.length ||
    [...value].sort().join(",") !== [...LIVE_EVIDENCE_COVERAGE].sort().join(",")
  ) {
    throw new Error("Live evidence must verify every documented Tier 2 behavior.");
  }
  return [...LIVE_EVIDENCE_COVERAGE];
}

function validateServices(value) {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [...SERVICES].sort().join(",")) {
    throw new Error("Live evidence must identify every supported upstream service exactly once.");
  }
  const services = {};
  for (const service of SERVICES) {
    const entry = value[service];
    if (!isRecord(entry) || !exactKeys(entry, ["capabilities", "result", "version"])) {
      throw new Error(`Live evidence for ${service} must use the exact service schema.`);
    }
    if (entry.result !== "passed") {
      throw new Error(`Live evidence for ${service} must record a passed result.`);
    }
    if (
      !Array.isArray(entry.capabilities) ||
      entry.capabilities.length === 0 ||
      new Set(entry.capabilities).size !== entry.capabilities.length ||
      entry.capabilities.some(
        (capability) =>
          typeof capability !== "string" || !LIVE_EVIDENCE_COVERAGE.includes(capability),
      )
    ) {
      throw new Error(`Live evidence for ${service} must identify verified Tier 2 capabilities.`);
    }
    services[service] = {
      capabilities: [...entry.capabilities].sort(),
      result: "passed",
      version: requireSafeVersion(entry.version, `Live evidence version for ${service}`),
    };
  }
  return services;
}

export function validateLiveEvidence(value, options) {
  if (!isRecord(options) || !sourceShaPattern.test(options.sourceSha)) {
    throw new Error("Live evidence validation requires an exact source SHA.");
  }
  const today = requireDate(
    options.today ?? new Date().toISOString().slice(0, 10),
    "Validation date",
  );
  const expectedKeys = [
    "architecture",
    "expiresAt",
    "limitations",
    "owner",
    "result",
    "schemaVersion",
    "services",
    "sourceSha",
    "verifiedAt",
    "verifiedCoverage",
  ];
  if (!isRecord(value) || !exactKeys(value, expectedKeys) || value.schemaVersion !== 1) {
    throw new Error("Live evidence must use the exact versioned report schema.");
  }
  if (value.sourceSha !== options.sourceSha) {
    throw new Error("Live evidence sourceSha must match the exact candidate source SHA.");
  }
  if (!STABLE_ARCHITECTURES.includes(value.architecture)) {
    throw new Error("Live evidence architecture must be a supported stable architecture.");
  }
  if (value.result !== "passed") throw new Error("Live evidence result must be passed.");
  const verifiedAt = requireDate(value.verifiedAt, "Live evidence verifiedAt");
  const expiresAt = requireDate(value.expiresAt, "Live evidence expiresAt");
  if (verifiedAt > today) throw new Error("Live evidence cannot be verified in the future.");
  if (expiresAt < verifiedAt || expiresAt < today) {
    throw new Error("Live evidence must be unexpired after its verification date.");
  }
  if (
    Date.parse(`${expiresAt}T00:00:00.000Z`) - Date.parse(`${verifiedAt}T00:00:00.000Z`) >
    30 * 24 * 60 * 60 * 1000
  ) {
    throw new Error("Live evidence expiry must be no more than 30 days after verification.");
  }
  if (
    typeof value.limitations !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 ,;:()_-]{0,511}$/u.test(value.limitations)
  ) {
    throw new Error("Live evidence limitations must be a safe bounded description.");
  }
  return {
    architecture: value.architecture,
    expiresAt,
    limitations: value.limitations,
    owner: requireSafeIdentifier(value.owner, "Live evidence owner"),
    result: "passed",
    schemaVersion: 1,
    services: validateServices(value.services),
    sourceSha: options.sourceSha,
    verifiedAt,
    verifiedCoverage: validateCoverage(value.verifiedCoverage),
  };
}
