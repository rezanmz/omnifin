#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readReadinessLedger } from "./readiness.mjs";
import { coverageForVersion, readReleaseCoverage } from "./release-coverage.mjs";
import { runIntegration } from "./run.mjs";

const sourceShaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function parseArguments(arguments_) {
  const options = {
    candidateDigest: null,
    mode: null,
    output: null,
    sourceSha: null,
    version: null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--candidate-digest") {
      options.candidateDigest = arguments_[++index];
      if (!options.candidateDigest || !digestPattern.test(options.candidateDigest)) {
        throw new Error("--candidate-digest must be an exact SHA-256 digest.");
      }
    } else if (argument === "--source-sha") {
      options.sourceSha = arguments_[++index];
      if (!options.sourceSha || !sourceShaPattern.test(options.sourceSha)) {
        throw new Error("--source-sha must be an exact Git commit SHA.");
      }
    } else if (argument === "--version") {
      options.version = arguments_[++index];
      if (!options.version || options.version.startsWith("--")) {
        throw new Error("--version requires a value.");
      }
    } else if (argument === "--mode") {
      options.mode = arguments_[++index];
      if (!options.mode || options.mode.startsWith("--")) {
        throw new Error("--mode requires a value.");
      }
    } else if (argument === "--output") {
      options.output = arguments_[++index];
      if (!options.output || options.output.startsWith("--")) {
        throw new Error("--output requires a path.");
      }
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.version) throw new Error("--version is required.");
  if (!["fixture", "live"].includes(options.mode)) {
    throw new Error("--mode must be fixture or live.");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/integration/release-gate.mjs --version <stable-semver> --mode <fixture|live> [--candidate-digest <sha256:digest> --source-sha <commit-sha>] [--output <path>]\n",
    );
    return 0;
  }
  const readiness = readReadinessLedger();
  const coverage = coverageForVersion(await readReleaseCoverage(), options.version, readiness);
  const services = options.mode === "fixture" ? coverage.fixtureServices : coverage.liveServices;
  return runIntegration({
    candidateDigest: options.candidateDigest,
    mode: options.mode,
    output: options.output,
    readiness,
    releaseProfile: coverage.profile,
    services,
    sourceSha: options.sourceSha,
    strict: true,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
