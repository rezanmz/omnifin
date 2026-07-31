#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  COMPATIBILITY_SERVICES,
  COMPATIBILITY_TARGET_DEFINITIONS,
  validateCompatibilityTarget,
  validateCompatibilityTargets,
} from "./compatibility-targets.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const ERROR_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,95}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_REPORT_BYTES = 64 * 1_024;

export class CompatibilityReportError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "CompatibilityReportError";
    this.code = code;
  }
}

export const COMPATIBILITY_CHECKS = Object.freeze({
  authentik: Object.freeze([
    "authorization_code_pkce",
    "immutable_issuer_subject",
    "jit_pending_jellyfin_link",
    "privileged_group_role_mapping",
    "guarded_role_mapping_update",
    "provider_initiated_backchannel_logout",
    "rp_initiated_logout",
    "secret_leak_inspection",
  ]),
  bazarr: Object.freeze([
    "authentication",
    "credentialRejection",
    "emptyLibraryRead",
    "fixtureMediaProvisioning",
    "subtitleArtifact",
    "subtitleDownload",
    "subtitleSearch",
    "versionDiscovery",
  ]),
  jellyfin: Object.freeze([
    "direct_range",
    "hls_transcode",
    "identity_invalid_password",
    "identity_mismatched_quick_connect_secret",
    "identity_password",
    "identity_public_info",
    "identity_quick_connect",
    "progress_persistence",
    "restart_reconnect",
    "track_audio",
    "track_subtitle",
  ]),
  oidc: Object.freeze([
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
  ]),
  prowlarr: Object.freeze([
    "applicationRead",
    "authentication",
    "credentialRejection",
    "failureRead",
    "fixtureIndexerProvisioning",
    "indexerRead",
    "indexerSafeTest",
    "systemHealthRead",
    "versionDiscovery",
  ]),
  qbittorrent: Object.freeze([
    "authentication",
    "credentialRejection",
    "exactPause",
    "exactPromotion",
    "exactResume",
    "preserveFilesRemoval",
    "queueRead",
  ]),
  radarr: Object.freeze([
    "authentication",
    "calendarRead",
    "credentialRejection",
    "fixtureTitleProvisioning",
    "monitoringRead",
    "monitoringRestore",
    "monitoringUpdate",
    "storageRead",
    "systemHealthRead",
    "versionDiscovery",
  ]),
  sabnzbd: Object.freeze([
    "authentication",
    "credentialRejection",
    "exactPause",
    "exactPromotion",
    "exactResume",
    "preserveFilesRemoval",
    "queueRead",
  ]),
  seerr: Object.freeze([
    "authentication",
    "credentialRejection",
    "delegatedIdentity",
    "duplicateRejection",
    "pendingRequestCreation",
    "requestDecline",
    "requestReview",
    "versionDiscovery",
  ]),
  sonarr: Object.freeze([
    "authentication",
    "calendarRead",
    "credentialRejection",
    "fixtureTitleProvisioning",
    "monitoringRead",
    "monitoringRestore",
    "monitoringUpdate",
    "storageRead",
    "systemHealthRead",
    "versionDiscovery",
  ]),
});

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

function hasExactChecks(checks, expected) {
  return (
    checks &&
    typeof checks === "object" &&
    !Array.isArray(checks) &&
    sortedKeys(checks) === [...expected].sort().join(",") &&
    expected.every((name) => checks[name] === "passed")
  );
}

function validateIdentityFixture(fixtureReport, target) {
  const expected = COMPATIBILITY_CHECKS[target.service];
  return (
    sortedKeys(fixtureReport) ===
      "checks,image,mode,passed,schemaVersion,service,upstreamVersion" &&
    fixtureReport.schemaVersion === 1 &&
    fixtureReport.mode === "isolated_fixture" &&
    fixtureReport.passed === true &&
    fixtureReport.service === target.service &&
    fixtureReport.image === target.image &&
    fixtureReport.upstreamVersion === target.version &&
    Array.isArray(fixtureReport.checks) &&
    fixtureReport.checks.length === expected.length &&
    fixtureReport.checks.every((check, index) => check === expected[index])
  );
}

function validateJellyfinFixture(fixtureReport, target) {
  const checks = fixtureReport.checks;
  const identity = checks?.identity;
  return (
    sortedKeys(fixtureReport) === "checks,image,schemaVersion,serverVersion,status" &&
    fixtureReport.schemaVersion === 1 &&
    fixtureReport.status === "passed" &&
    fixtureReport.image === target.image &&
    fixtureReport.serverVersion === target.version &&
    checks &&
    typeof checks === "object" &&
    !Array.isArray(checks) &&
    sortedKeys(checks) ===
      "directRange,hlsTranscode,identity,progress,reconnect,tracks,transcodeSeekSeconds" &&
    Number.isSafeInteger(checks.directRange?.bytes) &&
    checks.directRange.bytes > 0 &&
    checks.directRange.bytes <= 8 * 1_024 * 1_024 &&
    checks.directRange.status === 206 &&
    Number.isSafeInteger(checks.hlsTranscode?.bytes) &&
    checks.hlsTranscode.bytes > 0 &&
    checks.hlsTranscode.bytes <= 8 * 1_024 * 1_024 &&
    checks.hlsTranscode.status === 200 &&
    checks.hlsTranscode.format === "fmp4" &&
    identity &&
    sortedKeys(identity) ===
      "invalidPasswordRejected,mismatchedQuickConnectSecretRejected,password,publicInfo,quickConnect" &&
    Object.values(identity).every((value) => value === true) &&
    checks.progress?.persistedSeconds === 6 &&
    checks.progress?.reportedSeconds === 6 &&
    checks.reconnect?.delivery === "direct" &&
    checks.reconnect?.persistedSeconds === 6 &&
    typeof checks.tracks?.audio === "string" &&
    checks.tracks.audio.length >= 2 &&
    checks.tracks.audio.length <= 16 &&
    typeof checks.tracks?.subtitle === "string" &&
    checks.tracks.subtitle.length >= 2 &&
    checks.tracks.subtitle.length <= 16 &&
    checks.transcodeSeekSeconds === 4
  );
}

function validateMappedFixture(fixtureReport, target) {
  return (
    sortedKeys(fixtureReport) === "checks,image,schemaVersion,serverVersion,service,status" &&
    fixtureReport.schemaVersion === 1 &&
    fixtureReport.status === "passed" &&
    fixtureReport.service === target.service &&
    fixtureReport.image === target.image &&
    fixtureReport.serverVersion === target.version &&
    hasExactChecks(fixtureReport.checks, COMPATIBILITY_CHECKS[target.service])
  );
}

function fixturePassed(fixtureReport, target) {
  if (
    !fixtureReport ||
    typeof fixtureReport !== "object" ||
    Array.isArray(fixtureReport) ||
    JSON.stringify(fixtureReport).length > MAX_REPORT_BYTES
  ) {
    return false;
  }
  if (["authentik", "oidc"].includes(target.service)) {
    return validateIdentityFixture(fixtureReport, target);
  }
  if (target.service === "jellyfin") return validateJellyfinFixture(fixtureReport, target);
  return validateMappedFixture(fixtureReport, target);
}

function failureCategory(fixtureReport, fallback) {
  for (const value of [fixtureReport?.errorCategory, fixtureReport?.code]) {
    if (typeof value === "string" && ERROR_CATEGORY_PATTERN.test(value)) return value;
  }
  return fallback;
}

export function failedCompatibilityReport(targetInput, errorCategory) {
  const target = validateCompatibilityTarget(targetInput);
  if (!ERROR_CATEGORY_PATTERN.test(errorCategory)) {
    throw new CompatibilityReportError("compatibility_error_category_invalid");
  }
  return {
    checks: [],
    errorCategory,
    image: target.image,
    schemaVersion: 1,
    service: target.service,
    status: "failed",
    upstreamVersion: target.version,
  };
}

export function canonicalCompatibilityReport({
  executionPassed,
  fixtureReport,
  target: targetInput,
  teardownPassed,
}) {
  const target = validateCompatibilityTarget(targetInput);
  if (executionPassed !== true || teardownPassed !== true) {
    return failedCompatibilityReport(
      target,
      teardownPassed === true
        ? failureCategory(fixtureReport, "fixture_failed")
        : "teardown_incomplete",
    );
  }
  if (!fixturePassed(fixtureReport, target)) {
    throw new CompatibilityReportError("compatibility_fixture_report_invalid");
  }
  return {
    checks: [...COMPATIBILITY_CHECKS[target.service]],
    image: target.image,
    schemaVersion: 1,
    service: target.service,
    status: "passed",
    upstreamVersion: target.version,
  };
}

export function validateServiceCompatibilityReport(report, targetInput) {
  const target = validateCompatibilityTarget(targetInput);
  const common =
    report &&
    typeof report === "object" &&
    !Array.isArray(report) &&
    report.schemaVersion === 1 &&
    report.service === target.service &&
    report.image === target.image &&
    report.upstreamVersion === target.version &&
    Array.isArray(report.checks) &&
    JSON.stringify(report).length <= 8_192;
  if (!common) throw new CompatibilityReportError("compatibility_service_report_invalid");
  if (report.status === "passed") {
    if (
      sortedKeys(report) !== "checks,image,schemaVersion,service,status,upstreamVersion" ||
      report.checks.length !== COMPATIBILITY_CHECKS[target.service].length ||
      report.checks.some((check, index) => check !== COMPATIBILITY_CHECKS[target.service][index])
    ) {
      throw new CompatibilityReportError("compatibility_service_report_invalid");
    }
  } else if (
    report.status !== "failed" ||
    sortedKeys(report) !==
      "checks,errorCategory,image,schemaVersion,service,status,upstreamVersion" ||
    report.checks.length !== 0 ||
    typeof report.errorCategory !== "string" ||
    !ERROR_CATEGORY_PATTERN.test(report.errorCategory)
  ) {
    throw new CompatibilityReportError("compatibility_service_report_invalid");
  }
  return structuredClone(report);
}

export function aggregateCompatibilityReports({ commit, reports, targets, verifiedAt }) {
  const targetReport = validateCompatibilityTargets(targets);
  if (
    !COMMIT_PATTERN.test(commit) ||
    typeof verifiedAt !== "string" ||
    Number.isNaN(Date.parse(verifiedAt)) ||
    new Date(verifiedAt).toISOString() !== verifiedAt ||
    !Array.isArray(reports)
  ) {
    throw new CompatibilityReportError("compatibility_aggregate_invalid");
  }
  const byService = new Map();
  for (const report of reports) {
    if (report && typeof report === "object" && typeof report.service === "string") {
      if (byService.has(report.service)) {
        throw new CompatibilityReportError("compatibility_report_duplicate");
      }
      byService.set(report.service, report);
    }
  }
  const services = targetReport.targets.map((target) => {
    const report = byService.get(target.service);
    if (!report) throw new CompatibilityReportError("compatibility_report_missing");
    return validateServiceCompatibilityReport(report, target);
  });
  if (byService.size !== services.length) {
    throw new CompatibilityReportError("compatibility_report_unknown");
  }
  return validateAggregateCompatibilityReport({
    commit,
    schemaVersion: 1,
    services,
    status: services.every(({ status }) => status === "passed") ? "passed" : "failed",
    verifiedAt,
  });
}

export function validateAggregateCompatibilityReport(report) {
  const servicesValid =
    Array.isArray(report?.services) &&
    report.services.length === COMPATIBILITY_SERVICES.length &&
    report.services.every((service, index) => {
      const definition = COMPATIBILITY_TARGET_DEFINITIONS[index];
      if (!definition || service?.service !== definition.service) return false;
      try {
        validateServiceCompatibilityReport(service, {
          image: service.image,
          service: definition.service,
          source: `${definition.repository}:${definition.alias}`,
          version: service.upstreamVersion,
        });
        return true;
      } catch {
        return false;
      }
    });
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    sortedKeys(report) !== "commit,schemaVersion,services,status,verifiedAt" ||
    report.schemaVersion !== 1 ||
    !COMMIT_PATTERN.test(report.commit) ||
    typeof report.verifiedAt !== "string" ||
    Number.isNaN(Date.parse(report.verifiedAt)) ||
    new Date(report.verifiedAt).toISOString() !== report.verifiedAt ||
    !["failed", "passed"].includes(report.status) ||
    !servicesValid ||
    (report.status === "passed") !== report.services.every(({ status }) => status === "passed") ||
    JSON.stringify(report).length > MAX_REPORT_BYTES
  ) {
    throw new CompatibilityReportError("compatibility_aggregate_invalid");
  }
  return structuredClone(report);
}

function repositoryPath(candidate, code) {
  if (typeof candidate !== "string" || candidate.length < 1) {
    throw new CompatibilityReportError(code);
  }
  const path = resolve(REPOSITORY_ROOT, candidate);
  const relativePath = relative(REPOSITORY_ROOT, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new CompatibilityReportError(code);
  }
  return path;
}

async function readJson(path, code) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new CompatibilityReportError(code, { cause: error });
  }
  if (Buffer.byteLength(source, "utf8") > MAX_REPORT_BYTES) {
    throw new CompatibilityReportError(code);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new CompatibilityReportError(code, { cause: error });
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

function argumentValue(arguments_, name) {
  const indexes = arguments_.flatMap((argument, index) => (argument === name ? [index] : []));
  if (indexes.length !== 1 || !arguments_[indexes[0] + 1]) {
    throw new CompatibilityReportError("usage_invalid");
  }
  return arguments_[indexes[0] + 1];
}

function parseArguments(arguments_) {
  if (arguments_.length !== 9 || arguments_[0] !== "aggregate") {
    throw new CompatibilityReportError("usage_invalid");
  }
  return {
    commit: argumentValue(arguments_, "--commit"),
    output: repositoryPath(argumentValue(arguments_, "--output"), "output_path_invalid"),
    reports: repositoryPath(argumentValue(arguments_, "--reports"), "reports_path_invalid"),
    targets: repositoryPath(argumentValue(arguments_, "--targets"), "targets_path_invalid"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const targets = validateCompatibilityTargets(
    await readJson(options.targets, "compatibility_targets_invalid"),
  );
  const reports = [];
  for (const target of targets.targets) {
    try {
      const report = await readJson(
        join(options.reports, `${target.service}.json`),
        "compatibility_report_missing",
      );
      reports.push(validateServiceCompatibilityReport(report, target));
    } catch (error) {
      reports.push(
        failedCompatibilityReport(
          target,
          error instanceof CompatibilityReportError ? error.code : "compatibility_report_invalid",
        ),
      );
    }
  }
  const aggregate = aggregateCompatibilityReports({
    commit: options.commit,
    reports,
    targets,
    verifiedAt: new Date().toISOString(),
  });
  await writeJson(options.output, aggregate);
  process.stdout.write(`${JSON.stringify({ status: aggregate.status })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const code =
      error instanceof CompatibilityReportError ? error.code : "compatibility_aggregate_failed";
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 1;
  });
}
