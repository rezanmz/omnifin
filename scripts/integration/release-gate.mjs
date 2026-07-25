#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readReadinessLedger } from "./readiness.mjs";
import { coverageForVersion, readReleaseCoverage } from "./release-coverage.mjs";
import { runIntegration } from "./run.mjs";

function parseArguments(arguments_) {
  const options = { mode: null, output: null, version: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--version") {
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
      "Usage: node scripts/integration/release-gate.mjs --version <stable-semver> --mode <fixture|live> [--output <path>]\n",
    );
    return 0;
  }
  const readiness = readReadinessLedger();
  const coverage = coverageForVersion(await readReleaseCoverage(), options.version, readiness);
  const services = options.mode === "fixture" ? coverage.fixtureServices : coverage.liveServices;
  return runIntegration({
    mode: options.mode,
    output: options.output,
    readiness,
    releaseProfile: coverage.profile,
    services,
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
