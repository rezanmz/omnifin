#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLiveProbe } from "./live-probes.mjs";
import { readReadinessLedger, readinessBlock, SERVICES } from "./readiness.mjs";

export { SERVICES } from "./readiness.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MAX_FAILED_TEST_FILES = 16;
const TEST_FILE_BASENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,143}\.(?:test|spec)\.(?:ts|tsx)$/u;
const connectorPatterns = {
  jellyfin: "^'jellyfin' adapter\\b",
  seerr: "^(?:'seerr' adapter|Seerr discovery|Seerr media requests)\\b",
  radarr: "^(?:'radarr' adapter|Servarr acquisition)\\b",
  sonarr: "^(?:'sonarr' adapter|Servarr acquisition)\\b",
  prowlarr: "^(?:'prowlarr' adapter|Prowlarr indexer intelligence)\\b",
  bazarr: "^'bazarr' adapter\\b",
  qbittorrent: "^(?:qBittorrent adapter|qBittorrent download queue)\\b",
  sabnzbd: "^(?:'sabnzbd' adapter|SABnzbd download queue)\\b",
};
const connectorChecks = {
  jellyfin: ["public_health", "version_discovery"],
  seerr: [
    "authentication_header",
    "health_normalization",
    "identity_delegation",
    "request_creation",
    "response_normalization",
    "secret_isolation",
    "version_discovery",
  ],
  radarr: [
    "acquisition_search",
    "authentication_header",
    "exact_target_validation",
    "health_normalization",
    "monitoring_read",
    "monitoring_update",
    "safe_mutation_shape",
    "secret_isolation",
    "version_discovery",
  ],
  sonarr: [
    "acquisition_search",
    "authentication_header",
    "exact_target_validation",
    "health_normalization",
    "monitoring_read",
    "monitoring_update",
    "safe_mutation_shape",
    "secret_isolation",
    "version_discovery",
  ],
  prowlarr: [
    "application_sync",
    "authentication_header",
    "failure_history",
    "health_normalization",
    "indexer_inventory",
    "safe_test",
    "secret_isolation",
    "statistics",
    "version_discovery",
  ],
  bazarr: ["authentication_header", "health_normalization", "version_discovery"],
  qbittorrent: [
    "authentication",
    "credential_rejection",
    "exact_target_validation",
    "queue_read",
    "safe_mutation_shape",
    "secret_isolation",
    "version_compatible_mutation",
    "version_discovery",
  ],
  sabnzbd: [
    "authentication",
    "exact_target_validation",
    "health_normalization",
    "queue_read",
    "safe_mutation_shape",
    "secret_isolation",
    "version_discovery",
  ],
};

export function fixtureChecksFor(service) {
  return connectorChecks[service] ? [...connectorChecks[service]] : null;
}

function usage() {
  return [
    "Usage: node scripts/integration/run.mjs (--all | --service <name> [...]) [options]",
    "",
    "Options:",
    "  --mode <fixture|live>  Contract fixture tests or configured upstream probes (default: fixture)",
    "  --output <path>        Also write the sanitized JSON report to a file",
    "  --strict               Treat missing/unconfigured coverage as a failure",
    "  --help                 Show this help",
    "",
    `Services: ${SERVICES.join(", ")}`,
  ].join("\n");
}

export function parseArguments(arguments_) {
  const options = { all: false, mode: "fixture", output: null, services: [], strict: false };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--all") options.all = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--service") options.services.push(arguments_[++index]);
    else if (argument === "--mode") options.mode = arguments_[++index];
    else if (argument === "--output") options.output = arguments_[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (
    (options.all && options.services.length > 0) ||
    (!options.all && options.services.length === 0)
  ) {
    throw new Error("Select either --all or at least one --service.");
  }
  if (!["fixture", "live"].includes(options.mode))
    throw new Error("--mode must be fixture or live.");
  if (options.services.some((service) => !SERVICES.includes(service))) {
    throw new Error("An unknown integration service was requested.");
  }
  options.services = options.all
    ? [...SERVICES]
    : SERVICES.filter((service) => options.services.includes(service));
  return options;
}

function discoverTests(directory, namePattern) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discoverTests(path, namePattern));
    else if (/\.(?:test|spec)\.tsx?$/u.test(entry.name) && namePattern.test(entry.name))
      files.push(path);
  }
  return files.sort();
}

function vitestArguments(packageName, files, reportPath, testNamePattern) {
  const arguments_ = [
    "--filter",
    packageName,
    "exec",
    "vitest",
    "run",
    ...files,
    "--reporter=json",
    "--outputFile",
    reportPath,
  ];
  if (testNamePattern) arguments_.push("--testNamePattern", testNamePattern);
  return arguments_;
}

export function workspaceBuildArguments(packageName) {
  return ["--filter", `${packageName}^...`, "build"];
}

function spawnOptions() {
  return {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    maxBuffer: 2 * 1_024 * 1_024,
  };
}

function runVitest(packageName, files, testNamePattern) {
  const reportDirectory = mkdtempSync(join(tmpdir(), "omnifin-fixture-"));
  const reportPath = join(reportDirectory, "vitest.json");
  try {
    const dependencyBuild = spawnSync("pnpm", workspaceBuildArguments(packageName), spawnOptions());
    if (dependencyBuild.status !== 0) {
      return { errorCategory: "fixture_dependency_build_failed", passed: false };
    }
    const execution = spawnSync(
      "pnpm",
      vitestArguments(packageName, files, reportPath, testNamePattern),
      spawnOptions(),
    );
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined;
    const summary = vitestExecutionSummary(execution, report);
    return {
      ...summary,
      ...(summary.passed ? {} : { errorCategory: "fixture_contract_failed" }),
    };
  } finally {
    rmSync(reportDirectory, { force: true, recursive: true });
  }
}

export function vitestExecutionSummary(execution, reporterOutput = execution.stdout) {
  if (typeof reporterOutput !== "string") return { passed: false };
  let report;
  try {
    report = JSON.parse(reporterOutput);
  } catch {
    return { passed: false };
  }
  const counts = [
    report.numTotalTests,
    report.numPassedTests,
    report.numFailedTests,
    report.numPendingTests,
  ];
  const passed =
    execution.status === 0 &&
    counts.every((count) => Number.isInteger(count) && count >= 0) &&
    report.success === true &&
    report.numPassedTests >= 1 &&
    report.numFailedTests === 0 &&
    report.numTotalTests >= report.numPassedTests + report.numFailedTests + report.numPendingTests;
  if (passed || !Array.isArray(report.testResults)) return { passed };

  const failedTestFiles = [
    ...new Set(
      report.testResults
        .filter(
          (result) =>
            result !== null &&
            typeof result === "object" &&
            result.status === "failed" &&
            typeof result.name === "string",
        )
        .map((result) => basename(result.name))
        .filter((name) => TEST_FILE_BASENAME_PATTERN.test(name)),
    ),
  ]
    .sort()
    .slice(0, MAX_FAILED_TEST_FILES);
  return {
    passed: false,
    ...(failedTestFiles.length === 0 ? {} : { failedTestFiles }),
  };
}

export function vitestExecutionPassed(execution, reporterOutput = execution.stdout) {
  return vitestExecutionSummary(execution, reporterOutput).passed;
}

export function nodeTestExecutionPassed(execution) {
  if (execution.status !== 0 || typeof execution.stdout !== "string") return false;
  const summary = new Map(
    [...execution.stdout.matchAll(/^# (tests|pass|fail|cancelled) (\d+)$/gmu)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
  return (
    (summary.get("tests") ?? 0) >= 1 &&
    (summary.get("pass") ?? 0) >= 1 &&
    summary.get("fail") === 0 &&
    summary.get("cancelled") === 0
  );
}

function runNodeTest(file) {
  const execution = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", file],
    spawnOptions(),
  );
  return {
    errorCategory: "fixture_contract_failed",
    passed: nodeTestExecutionPassed(execution),
  };
}

function runFixture(service) {
  if (service === "authentik") {
    const testFile = join(root, "scripts/integration/authentik-fixture.test.mjs");
    if (!existsSync(testFile)) {
      return { service, profile: "fixture-contract", status: "not_implemented" };
    }
    const execution = runNodeTest(testFile);
    return {
      service,
      profile: "fixture-contract",
      status: execution.passed ? "passed" : "failed",
      checks: ["authentication_harness_contract"],
      ...(execution.passed ? {} : { errorCategory: execution.errorCategory }),
    };
  }

  if (service === "oidc") {
    const absoluteFiles = discoverTests(join(root, "apps/gateway/test"), /(?:oidc|openid)/iu);
    if (absoluteFiles.length === 0) {
      return { service, profile: "fixture-contract", status: "not_implemented" };
    }
    const files = absoluteFiles.map((file) => relative(join(root, "apps/gateway"), file));
    const execution = runVitest("@omnifin/gateway", files);
    return {
      service,
      profile: "fixture-contract",
      status: execution.passed ? "passed" : "failed",
      checks: ["authentication_contract"],
      ...(execution.passed
        ? {}
        : {
            errorCategory: execution.errorCategory ?? "fixture_contract_failed",
            ...(execution.failedTestFiles ? { failedTestFiles: execution.failedTestFiles } : {}),
          }),
    };
  }

  const testFiles = [join(root, "packages/connectors/test/adapters.test.ts")];
  if (service === "seerr") {
    testFiles.push(
      join(root, "packages/connectors/test/seerr-discovery.test.ts"),
      join(root, "packages/connectors/test/seerr-requests.test.ts"),
    );
  }
  if (service === "prowlarr") {
    testFiles.push(join(root, "packages/connectors/test/prowlarr-intelligence.test.ts"));
  }
  if (service === "radarr" || service === "sonarr") {
    testFiles.push(join(root, "packages/connectors/test/servarr-acquisition.test.ts"));
  }
  if (testFiles.some((file) => !existsSync(file)) || !connectorPatterns[service]) {
    return { service, profile: "fixture-contract", status: "not_implemented" };
  }
  const execution = runVitest(
    "@omnifin/connectors",
    testFiles.map((file) => relative(join(root, "packages/connectors"), file)),
    connectorPatterns[service],
  );
  return {
    service,
    profile: "fixture-contract",
    status: execution.passed ? "passed" : "failed",
    checks: fixtureChecksFor(service),
    ...(execution.passed
      ? {}
      : {
          errorCategory: execution.errorCategory ?? "fixture_contract_failed",
          ...(execution.failedTestFiles ? { failedTestFiles: execution.failedTestFiles } : {}),
        }),
  };
}

function summarize(results) {
  const summary = { passed: 0, failed: 0, notConfigured: 0, notImplemented: 0, notReady: 0 };
  for (const result of results) {
    if (result.status === "passed") summary.passed += 1;
    else if (result.status === "failed") summary.failed += 1;
    else if (result.status === "not_configured") summary.notConfigured += 1;
    else if (result.status === "not_implemented") summary.notImplemented += 1;
    else if (result.status === "not_ready") summary.notReady += 1;
  }
  return summary;
}

export async function runIntegration(options) {
  const readiness = options.readiness ?? readReadinessLedger();
  const results = [];
  for (const service of options.services) {
    const blocked = readinessBlock(readiness, service, options.mode, options.strict);
    results.push(
      blocked ?? (options.mode === "live" ? await runLiveProbe(service) : runFixture(service)),
    );
  }
  const report = {
    schemaVersion: 1,
    mode: options.mode,
    ...(options.releaseProfile ? { releaseProfile: options.releaseProfile } : {}),
    summary: summarize(results),
    results,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (options.output) {
    const outputPath = resolve(options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  }

  const incomplete =
    report.summary.notConfigured + report.summary.notImplemented + report.summary.notReady;
  return report.summary.failed > 0 || (options.strict && incomplete > 0) ? 1 : 0;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 64;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  return runIntegration(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
