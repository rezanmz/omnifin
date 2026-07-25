#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readReadinessLedger, SERVICES } from "./readiness.mjs";

export const RELEASE_PROFILES = Object.freeze([
  "phase0",
  "phase1",
  "phase2",
  "phase3",
  "phase4",
  "phase5",
  "v1",
]);

const defaultCoveragePath = fileURLToPath(new URL("release-coverage.json", import.meta.url));
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validateServiceList(value, label) {
  if (!Array.isArray(value) || value.some((service) => !SERVICES.includes(service))) {
    throw new Error(`${label} must contain only known services.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicate services.`);
  }
  return SERVICES.filter((service) => value.includes(service));
}

export function validateReleaseCoverage(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !exactKeys(value, ["schemaVersion", "selectedProfile", "profiles"]) ||
    !isRecord(value.profiles)
  ) {
    throw new Error("Release coverage must use the exact schemaVersion 1 shape.");
  }
  if (!RELEASE_PROFILES.includes(value.selectedProfile)) {
    throw new Error("Release coverage must select one known profile.");
  }
  if (!exactKeys(value.profiles, RELEASE_PROFILES)) {
    throw new Error("Release coverage must define every known profile and no others.");
  }

  const normalizedProfiles = {};
  let previousFixture = new Set();
  let previousLive = new Set();
  for (const profile of RELEASE_PROFILES) {
    const entry = value.profiles[profile];
    if (!isRecord(entry) || !exactKeys(entry, ["fixture", "live"])) {
      throw new Error(`Release profile ${profile} must contain only fixture and live lists.`);
    }
    const fixture = validateServiceList(entry.fixture, `${profile}.fixture`);
    const live = validateServiceList(entry.live, `${profile}.live`);
    if (
      [...previousFixture].some((service) => !fixture.includes(service)) ||
      [...previousLive].some((service) => !live.includes(service))
    ) {
      throw new Error(`Release profile ${profile} must include all earlier coverage.`);
    }
    normalizedProfiles[profile] = { fixture, live };
    previousFixture = new Set(fixture);
    previousLive = new Set(live);
  }

  for (const mode of ["fixture", "live"]) {
    if (normalizedProfiles.v1[mode].length !== SERVICES.length) {
      throw new Error(`The v1 release profile must require every ${mode} service.`);
    }
  }

  return {
    schemaVersion: 1,
    selectedProfile: value.selectedProfile,
    profiles: normalizedProfiles,
  };
}

export async function readReleaseCoverage(path = defaultCoveragePath) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Release coverage must be readable JSON.");
  }
  return validateReleaseCoverage(value);
}

export function coverageForVersion(coverage, version, readiness) {
  const match = version.match(stableVersionPattern);
  if (!match) throw new Error("Release coverage requires a stable SemVer version.");
  const profile = coverage.selectedProfile;
  if (match[1] !== "0" && profile !== "v1") {
    throw new Error("Version 1.0.0 and later require the full v1 release profile.");
  }
  const selected = coverage.profiles[profile];
  for (const mode of ["fixture", "live"]) {
    const pending = selected[mode].filter(
      (service) => readiness.services[service][mode] !== "ready",
    );
    if (pending.length > 0) {
      throw new Error(`${profile}.${mode} requires pending coverage: ${pending.join(", ")}.`);
    }
  }
  return {
    profile,
    fixtureServices: [...selected.fixture],
    liveServices: [...selected.live],
  };
}

function parseArguments(arguments_) {
  const options = { githubOutput: null, version: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--version") {
      options.version = arguments_[++index];
      if (!options.version || options.version.startsWith("--")) {
        throw new Error("--version requires a value.");
      }
    } else if (argument === "--github-output") {
      options.githubOutput = arguments_[++index];
      if (!options.githubOutput || options.githubOutput.startsWith("--")) {
        throw new Error("--github-output requires a path.");
      }
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.version) throw new Error("--version is required.");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/integration/release-coverage.mjs --version <stable-semver> [--github-output <path>]\n",
    );
    return;
  }
  const coverage = coverageForVersion(
    await readReleaseCoverage(),
    options.version,
    readReadinessLedger(),
  );
  if (options.githubOutput) {
    await appendFile(
      resolve(options.githubOutput),
      [
        `profile=${coverage.profile}`,
        `fixture_services=${JSON.stringify(coverage.fixtureServices)}`,
        `live_services=${JSON.stringify(coverage.liveServices)}`,
        `live_required=${coverage.liveServices.length > 0}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  process.stdout.write(`${JSON.stringify(coverage)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
