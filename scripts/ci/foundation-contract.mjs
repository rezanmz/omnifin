#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { validateReadinessLedger } from "../integration/readiness.mjs";
import { coverageForVersion, validateReleaseCoverage } from "../integration/release-coverage.mjs";

export const REQUIRED_PUBLIC_FILES = Object.freeze([
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/compatibility.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/compatibility.yml",
  ".github/workflows/edge.yml",
  ".github/workflows/integration-live.yml",
  ".github/workflows/integration.yml",
  ".github/workflows/publish.yml",
  ".github/workflows/release-please.yml",
  ".github/workflows/security.yml",
  ".release-please-manifest.json",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "apps/gateway/package.json",
  "apps/web/package.json",
  "compose.yaml",
  "docs/architecture.md",
  "docs/deployment.md",
  "docs/development.md",
  "docs/foundation-verification.md",
  "docs/release-process.md",
  "docs/roadmap.md",
  "docs/security-model.md",
  "package.json",
  "packages/connectors/package.json",
  "packages/contracts/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "release-please-config.json",
  "scripts/ci/foundation-contract.mjs",
  "scripts/ci/foundation-contract.test.mjs",
  "scripts/integration/readiness.json",
  "scripts/integration/release-coverage.json",
  "tsconfig.base.json",
  "turbo.json",
]);

export const REQUIRED_ROOT_SCRIPTS = Object.freeze([
  "build",
  "container:smoke",
  "docs:check",
  "format:check",
  "foundation:check",
  "license:check",
  "lint",
  "migration:smoke",
  "security:audit",
  "test",
  "typecheck",
  "verify",
]);

const requiredWorkspacePatterns = ["apps/*", "packages/*"];
const requiredServiceNames = ["gateway", "maintenance", "web"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(root, relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch {
    throw new Error(`${relativePath} must be readable JSON.`);
  }
}

async function readYaml(root, relativePath) {
  const contents = await readFile(path.join(root, relativePath), "utf8");
  const document = parseDocument(contents, {
    merge: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${relativePath} must be valid YAML: ${document.errors[0].message}`);
  }
  return document.toJS({ maxAliasCount: 100 });
}

function requireValue(condition, message, problems) {
  if (!condition) problems.push(message);
}

async function verifyPublicFiles(root, problems) {
  for (const relativePath of REQUIRED_PUBLIC_FILES) {
    const absolutePath = path.join(root, relativePath);
    try {
      const stats = await lstat(absolutePath);
      requireValue(stats.isFile(), `${relativePath} must be a regular file.`, problems);
      requireValue(
        !stats.isSymbolicLink(),
        `${relativePath} must not be a symbolic link.`,
        problems,
      );
      if (stats.isFile()) {
        requireValue(stats.size > 0, `${relativePath} must not be empty.`, problems);
      }
    } catch {
      problems.push(`${relativePath} is required.`);
    }
  }
}

async function verifyWorkspace(root, problems) {
  const packageManifest = await readJson(root, "package.json");
  requireValue(packageManifest.private === true, "package.json must remain private.", problems);
  requireValue(
    packageManifest.license === "AGPL-3.0-only",
    "package.json must declare AGPL-3.0-only.",
    problems,
  );
  requireValue(
    /^pnpm@\d+\.\d+\.\d+$/u.test(packageManifest.packageManager ?? ""),
    "package.json must pin an exact pnpm package manager version.",
    problems,
  );
  requireValue(
    isRecord(packageManifest.engines) && typeof packageManifest.engines.node === "string",
    "package.json must declare the supported Node.js engine.",
    problems,
  );
  requireValue(
    isRecord(packageManifest.scripts),
    "package.json scripts must be an object.",
    problems,
  );
  for (const script of REQUIRED_ROOT_SCRIPTS) {
    requireValue(
      typeof packageManifest.scripts?.[script] === "string" &&
        packageManifest.scripts[script].trim().length > 0,
      `package.json must define ${script}.`,
      problems,
    );
  }
  requireValue(
    packageManifest.scripts?.["foundation:check"] === "node scripts/ci/foundation-contract.mjs",
    "foundation:check must execute the reviewed foundation contract.",
    problems,
  );

  const workspace = await readYaml(root, "pnpm-workspace.yaml");
  requireValue(
    Array.isArray(workspace?.packages) &&
      [...workspace.packages].sort().join(",") === requiredWorkspacePatterns.join(","),
    "pnpm-workspace.yaml must include exactly apps/* and packages/*.",
    problems,
  );

  const compiler = (await readJson(root, "tsconfig.base.json")).compilerOptions;
  requireValue(compiler?.strict === true, "TypeScript strict mode must remain enabled.", problems);
  requireValue(
    compiler?.exactOptionalPropertyTypes === true,
    "TypeScript exactOptionalPropertyTypes must remain enabled.",
    problems,
  );
  requireValue(
    compiler?.noUncheckedIndexedAccess === true,
    "TypeScript noUncheckedIndexedAccess must remain enabled.",
    problems,
  );

  const license = await readFile(path.join(root, "LICENSE"), "utf8");
  requireValue(
    license.includes("GNU AFFERO GENERAL PUBLIC LICENSE") && license.includes("Version 3"),
    "LICENSE must contain the GNU Affero General Public License version 3 text.",
    problems,
  );
}

function verifyHardenedService(serviceName, service, image, problems) {
  requireValue(isRecord(service), `compose.yaml must define ${serviceName}.`, problems);
  if (!isRecord(service)) return;
  requireValue(
    service.image === image,
    `${serviceName} must use the shared immutable image.`,
    problems,
  );
  requireValue(service.init === true, `${serviceName} must run with an init process.`, problems);
  requireValue(
    service.read_only === true,
    `${serviceName} must use a read-only root filesystem.`,
    problems,
  );
  requireValue(
    Array.isArray(service.cap_drop) && service.cap_drop.includes("ALL"),
    `${serviceName} must drop all Linux capabilities.`,
    problems,
  );
  requireValue(
    Array.isArray(service.security_opt) && service.security_opt.includes("no-new-privileges:true"),
    `${serviceName} must prohibit privilege escalation.`,
    problems,
  );
}

async function verifyDeployment(root, problems) {
  const compose = await readYaml(root, "compose.yaml");
  const services = compose?.services;
  requireValue(isRecord(services), "compose.yaml services must be an object.", problems);
  if (!isRecord(services)) return;

  requireValue(
    Object.keys(services).sort().join(",") === requiredServiceNames.join(","),
    "compose.yaml must define exactly gateway, maintenance, and web services.",
    problems,
  );
  const image = services.gateway?.image;
  requireValue(
    typeof image === "string" && image.includes("ghcr.io/rezanmz/omnifin"),
    "compose.yaml must default to the public Omnifin GHCR image.",
    problems,
  );
  for (const serviceName of requiredServiceNames) {
    verifyHardenedService(serviceName, services[serviceName], image, problems);
  }
  requireValue(
    services.gateway?.ports === undefined,
    "The gateway must not publish a host port.",
    problems,
  );
  requireValue(
    Array.isArray(services.web?.ports) &&
      services.web.ports.some((entry) => String(entry).startsWith("127.0.0.1:")),
    "The default web socket must bind to loopback.",
    problems,
  );
  for (const serviceName of ["gateway", "web"]) {
    const healthcheck = services[serviceName]?.healthcheck?.test;
    requireValue(
      Array.isArray(healthcheck) && healthcheck.some((entry) => String(entry).endsWith("/healthz")),
      `${serviceName} must define a container health check.`,
      problems,
    );
  }
  requireValue(
    compose?.secrets?.omnifin_encryption_key?.environment === "OMNIFIN_ENCRYPTION_KEY",
    "Compose must source the encryption key from an explicit secret input.",
    problems,
  );
  requireValue(
    compose?.secrets?.omnifin_recovery_secret?.environment === "OMNIFIN_RECOVERY_SECRET",
    "Compose must source the recovery credential from an explicit secret input.",
    problems,
  );

  const migrations = (await readdir(path.join(root, "apps/gateway/drizzle"))).filter((name) =>
    /^\d{4}_[a-z0-9_]+\.sql$/u.test(name),
  );
  requireValue(
    migrations.length > 0,
    "At least one committed SQL migration is required.",
    problems,
  );
}

async function verifyReleaseBoundary(root, problems) {
  const readiness = validateReadinessLedger(
    await readJson(root, "scripts/integration/readiness.json"),
  );
  const releaseCoverage = validateReleaseCoverage(
    await readJson(root, "scripts/integration/release-coverage.json"),
  );
  let phase0;
  try {
    phase0 = coverageForVersion(releaseCoverage, "0.1.0", readiness);
  } catch (error) {
    problems.push(error.message);
  }
  requireValue(
    phase0?.profile === "phase0",
    "The first public release must select the phase0 coverage profile.",
    problems,
  );
  requireValue(
    phase0?.fixtureServices.length > 0,
    "The phase0 release profile must require deterministic connector fixtures.",
    problems,
  );
  requireValue(
    phase0?.liveServices.length === 0,
    "Phase0 must not claim unverified live-service compatibility.",
    problems,
  );

  const releaseConfiguration = await readJson(root, "release-please-config.json");
  requireValue(
    releaseConfiguration["initial-version"] === "0.1.0",
    "Release Please must preserve the reviewed 0.1.0 initial version.",
    problems,
  );
  requireValue(
    releaseConfiguration["include-v-in-tag"] === true,
    "Release Please tags must retain the v prefix.",
    problems,
  );
  requireValue(
    releaseConfiguration.draft === true,
    "GitHub Releases must remain drafts until artifact verification completes.",
    problems,
  );
}

async function verifyQualityWiring(root, problems) {
  const ci = await readYaml(root, ".github/workflows/ci.yml");
  const qualitySteps = ci?.jobs?.quality?.steps;
  requireValue(Array.isArray(qualitySteps), "CI must define the Quality job.", problems);
  requireValue(
    qualitySteps?.some((step) => step?.run === "pnpm foundation:check"),
    "The CI Quality job must execute pnpm foundation:check.",
    problems,
  );
}

export async function checkFoundationContract({ root = process.cwd() } = {}) {
  const repositoryRoot = path.resolve(root);
  const problems = [];
  await verifyPublicFiles(repositoryRoot, problems);
  await verifyWorkspace(repositoryRoot, problems);
  await verifyDeployment(repositoryRoot, problems);
  await verifyReleaseBoundary(repositoryRoot, problems);
  await verifyQualityWiring(repositoryRoot, problems);

  if (problems.length > 0) {
    throw new Error(
      `The public-project foundation contract is not satisfied:\n${problems
        .map((problem) => `- ${problem}`)
        .join("\n")}`,
    );
  }
  return {
    publicFileCount: REQUIRED_PUBLIC_FILES.length,
    requiredScriptCount: REQUIRED_ROOT_SCRIPTS.length,
    serviceCount: requiredServiceNames.length,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: node scripts/ci/foundation-contract.mjs\n");
    return;
  }
  if (process.argv.length > 2) throw new Error(`Unknown argument: ${process.argv[2]}`);
  const result = await checkFoundationContract();
  process.stdout.write(
    `Verified ${result.publicFileCount} public foundation files, ${result.requiredScriptCount} root checks, and ${result.serviceCount} hardened deployment roles.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
