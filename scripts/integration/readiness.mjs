import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICES = Object.freeze([
  "oidc",
  "authentik",
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "bazarr",
  "qbittorrent",
  "sabnzbd",
]);

const readinessStates = new Set(["pending", "ready"]);
const defaultReadinessPath = resolve(fileURLToPath(new URL("readiness.json", import.meta.url)));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateReadinessLedger(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.services)) {
    throw new Error("The integration readiness ledger must use schemaVersion 1.");
  }

  const serviceNames = Object.keys(value.services).sort();
  const expectedNames = [...SERVICES].sort();
  const missing = expectedNames.filter((service) => !serviceNames.includes(service));
  const unexpected = serviceNames.filter((service) => !expectedNames.includes(service));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `The integration readiness ledger has invalid services (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }

  for (const service of SERVICES) {
    const entry = value.services[service];
    if (!isRecord(entry)) {
      throw new Error(`Readiness for ${service} must be an object.`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== "fixture,live") {
      throw new Error(`Readiness for ${service} must contain only fixture and live states.`);
    }
    for (const mode of ["fixture", "live"]) {
      if (!readinessStates.has(entry[mode])) {
        throw new Error(`Readiness for ${service}.${mode} must be pending or ready.`);
      }
    }
  }

  return value;
}

export function readReadinessLedger(path = defaultReadinessPath) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("The integration readiness ledger must be readable JSON.");
  }
  return validateReadinessLedger(value);
}

export function readinessBlock(ledger, service, mode, strict) {
  if (!strict || ledger.services[service][mode] === "ready") return null;
  return {
    service,
    profile: `${mode}-coverage`,
    status: "not_ready",
    errorCategory: "coverage_not_ready",
  };
}
