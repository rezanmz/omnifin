#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  CompatibilityReportError,
  canonicalCompatibilityReport,
  failedCompatibilityReport,
} from "./compatibility-report.mjs";
import { COMPATIBILITY_SERVICES, validateCompatibilityTargets } from "./compatibility-targets.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_CAPTURE_BYTES = 1 * 1_024 * 1_024;
const RESOURCE_TYPES = Object.freeze(["container", "network", "volume"]);

class CompatibilityServiceError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "CompatibilityServiceError";
    this.code = code;
  }
}

function repositoryPath(candidate, code) {
  if (typeof candidate !== "string" || candidate.length < 1) {
    throw new CompatibilityServiceError(code);
  }
  const path = resolve(REPOSITORY_ROOT, candidate);
  const relativePath = relative(REPOSITORY_ROOT, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new CompatibilityServiceError(code);
  }
  return path;
}

function argumentValue(arguments_, name) {
  const indexes = arguments_.flatMap((argument, index) => (argument === name ? [index] : []));
  if (indexes.length !== 1 || !arguments_[indexes[0] + 1]) {
    throw new CompatibilityServiceError("usage_invalid");
  }
  return arguments_[indexes[0] + 1];
}

function parseArguments(arguments_) {
  if (![7, 9].includes(arguments_.length) || arguments_[0] !== "run") {
    throw new CompatibilityServiceError("usage_invalid");
  }
  const service = argumentValue(arguments_, "--service");
  if (!COMPATIBILITY_SERVICES.includes(service)) {
    throw new CompatibilityServiceError("compatibility_service_invalid");
  }
  const fixtureIndex = arguments_.indexOf("--fixture");
  if ((service === "jellyfin") !== fixtureIndex >= 0) {
    throw new CompatibilityServiceError("usage_invalid");
  }
  return {
    fixture:
      fixtureIndex < 0
        ? null
        : repositoryPath(argumentValue(arguments_, "--fixture"), "fixture_path_invalid"),
    output: repositoryPath(argumentValue(arguments_, "--output"), "output_path_invalid"),
    service,
    targets: repositoryPath(argumentValue(arguments_, "--targets"), "targets_path_invalid"),
  };
}

function runProcess(command, arguments_, environment = process.env) {
  return spawnSync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...environment,
      CI: "true",
      COMPOSE_ANSI: "never",
      FORCE_COLOR: "0",
      TURBO_TELEMETRY_DISABLED: "1",
    },
    maxBuffer: MAX_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30 * 60_000,
  });
}

function dockerResources(resourceType) {
  const execution = runProcess("docker", [resourceType, "ls", "--quiet"]);
  if (execution.status !== 0 || execution.error || typeof execution.stdout !== "string") {
    throw new CompatibilityServiceError("teardown_check_failed");
  }
  const values = execution.stdout.split(/\r?\n/u).filter(Boolean);
  if (values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value))) {
    throw new CompatibilityServiceError("teardown_check_failed");
  }
  return new Set(values);
}

export function dockerResourceSnapshot() {
  return Object.fromEntries(
    RESOURCE_TYPES.map((resourceType) => [resourceType, dockerResources(resourceType)]),
  );
}

export function teardownMatches(before, after) {
  if (!before || !after) return false;
  return RESOURCE_TYPES.every((resourceType) => {
    const left = before[resourceType];
    const right = after[resourceType];
    return (
      left instanceof Set &&
      right instanceof Set &&
      left.size === right.size &&
      [...left].every((identifier) => right.has(identifier))
    );
  });
}

export function compatibilityHarnessArguments(service, rawOutput, fixture, target) {
  switch (service) {
    case "authentik":
      return ["scripts/integration/authentik/run.mjs", "--skip-build", "--output", rawOutput];
    case "oidc":
      return ["scripts/integration/oidc-provider/run.mjs", "--skip-build", "--output", rawOutput];
    case "jellyfin":
      return [
        "scripts/integration/jellyfin/playback.mjs",
        "--fixture",
        fixture,
        "--output",
        rawOutput,
        "--image",
        target.image,
        "--expected-version",
        target.version,
      ];
    case "seerr":
      return ["scripts/integration/seerr-service.mjs", "--output", rawOutput];
    case "bazarr":
    case "prowlarr":
    case "radarr":
    case "sonarr":
      return [
        "scripts/integration/servarr-services.mjs",
        "--service",
        service,
        "--output",
        rawOutput,
      ];
    case "qbittorrent":
    case "sabnzbd":
      return [
        "scripts/integration/download-clients.mjs",
        "--service",
        service,
        "--output",
        rawOutput,
      ];
    default:
      throw new CompatibilityServiceError("compatibility_service_invalid");
  }
}

async function readJson(path) {
  try {
    const source = await readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_CAPTURE_BYTES) return null;
    return JSON.parse(source);
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const temporary = resolve(parent, `.${basename(path)}.${randomBytes(6).toString("hex")}`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function executeService(options) {
  const targets = validateCompatibilityTargets(await readJson(options.targets));
  const target = targets.targets.find(({ service }) => service === options.service);
  if (!target) throw new CompatibilityServiceError("compatibility_target_missing");
  const rawOutput = resolve(
    dirname(options.output),
    `.${options.service}.fixture.${randomBytes(6).toString("hex")}.json`,
  );
  const rawOutputArgument = relative(REPOSITORY_ROOT, rawOutput);
  if (!rawOutputArgument || rawOutputArgument.startsWith("..") || isAbsolute(rawOutputArgument)) {
    throw new CompatibilityServiceError("output_path_invalid");
  }
  const environment = {
    ...process.env,
    OMNIFIN_COMPATIBILITY_IMAGE: target.image,
    OMNIFIN_COMPATIBILITY_SERVICE: target.service,
    OMNIFIN_COMPATIBILITY_VERSION: target.version,
  };
  let before;
  let execution;
  let teardownPassed = false;
  try {
    before = dockerResourceSnapshot();
    execution = runProcess(
      process.execPath,
      compatibilityHarnessArguments(options.service, rawOutputArgument, options.fixture, target),
      environment,
    );
    teardownPassed = teardownMatches(before, dockerResourceSnapshot());
    const fixtureReport = await readJson(rawOutput);
    let report;
    try {
      report = canonicalCompatibilityReport({
        executionPassed: execution.status === 0 && !execution.error,
        fixtureReport,
        target,
        teardownPassed,
      });
    } catch (error) {
      report = failedCompatibilityReport(
        target,
        error instanceof CompatibilityReportError
          ? error.code
          : "compatibility_fixture_report_invalid",
      );
    }
    await writeJson(options.output, report);
    process.stdout.write(
      `${JSON.stringify({ service: options.service, status: report.status })}\n`,
    );
    if (report.status !== "passed") process.exitCode = 1;
  } finally {
    await rm(rawOutput, { force: true });
  }
}

async function main() {
  await executeService(parseArguments(process.argv.slice(2)));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const code =
      error instanceof CompatibilityServiceError ? error.code : "compatibility_service_failed";
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 1;
  });
}
