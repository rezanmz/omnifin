#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_REGISTRY_OUTPUT_BYTES = 1 * 1_024 * 1_024;
const TARGET_KEYS = "image,service,source,version";

export class CompatibilityTargetError extends Error {
  constructor(code, { cause, service } = {}) {
    super(code, { cause });
    this.name = "CompatibilityTargetError";
    this.code = code;
    this.service =
      typeof service === "string" && /^[a-z][a-z0-9_]{0,31}$/u.test(service) ? service : null;
  }
}

export const COMPATIBILITY_TARGET_DEFINITIONS = Object.freeze([
  Object.freeze({
    repository: "ghcr.io/goauthentik/server",
    service: "authentik",
  }),
  Object.freeze({ repository: "ghcr.io/linuxserver/bazarr", service: "bazarr" }),
  Object.freeze({
    repository: "ghcr.io/jellyfin/jellyfin",
    service: "jellyfin",
  }),
  Object.freeze({ repository: "ghcr.io/dexidp/dex", service: "oidc" }),
  Object.freeze({
    repository: "ghcr.io/linuxserver/prowlarr",
    service: "prowlarr",
  }),
  Object.freeze({
    repository: "ghcr.io/linuxserver/qbittorrent",
    service: "qbittorrent",
  }),
  Object.freeze({ repository: "ghcr.io/linuxserver/radarr", service: "radarr" }),
  Object.freeze({
    repository: "ghcr.io/linuxserver/sabnzbd",
    service: "sabnzbd",
  }),
  Object.freeze({ repository: "ghcr.io/seerr-team/seerr", service: "seerr" }),
  Object.freeze({ repository: "ghcr.io/linuxserver/sonarr", service: "sonarr" }),
]);

export const COMPATIBILITY_SERVICES = Object.freeze(
  COMPATIBILITY_TARGET_DEFINITIONS.map(({ service }) => service),
);

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

function definitionFor(service) {
  const definition = COMPATIBILITY_TARGET_DEFINITIONS.find(
    (candidate) => candidate.service === service,
  );
  if (!definition) throw new CompatibilityTargetError("compatibility_service_invalid");
  return definition;
}

function numericOrder(version, suffix = 0) {
  const components = version.split(".").map(Number);
  if (
    components.length < 3 ||
    components.length > 4 ||
    components.some((component) => !Number.isSafeInteger(component) || component < 0)
  ) {
    return null;
  }
  return [...components, suffix];
}

export function stableTag(service, tag) {
  if (typeof tag !== "string" || tag.length < 1 || tag.length > 128) return null;
  let match;
  switch (service) {
    case "authentik":
      match = tag.match(/^(\d{4}\.\d{1,2}\.\d{1,3})$/u);
      break;
    case "bazarr":
      match = tag.match(/^v(\d+\.\d+\.\d+)-ls(\d+)$/u);
      break;
    case "jellyfin":
      match = tag.match(/^(\d+\.\d+\.\d+)$/u);
      break;
    case "oidc":
    case "seerr":
      match = tag.match(/^v(\d+\.\d+\.\d+)$/u);
      break;
    case "prowlarr":
    case "radarr":
    case "sonarr":
      match = tag.match(/^(\d+\.\d+\.\d+\.\d+)-ls(\d+)$/u);
      break;
    case "qbittorrent":
      match = tag.match(/^(\d+\.\d+\.\d+)_v\d+\.\d+\.\d+-ls(\d+)$/u);
      break;
    case "sabnzbd":
      match = tag.match(/^(\d+\.\d+\.\d+)-ls(\d+)$/u);
      break;
    default:
      return null;
  }
  if (!match) return null;
  const suffix = match[2] === undefined ? 0 : Number(match[2]);
  const order = numericOrder(match[1], suffix);
  if (!order || !Number.isSafeInteger(suffix) || suffix < 0) return null;
  return Object.freeze({ order: Object.freeze(order), tag, version: match[1] });
}

function compareOrders(left, right) {
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function defaultExecute(arguments_) {
  return spawnSync("oras", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: MAX_REGISTRY_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function successfulOutput(execution, code) {
  if (
    !execution ||
    execution.status !== 0 ||
    execution.error ||
    typeof execution.stdout !== "string" ||
    Buffer.byteLength(execution.stdout, "utf8") > MAX_REGISTRY_OUTPUT_BYTES
  ) {
    throw new CompatibilityTargetError(code);
  }
  return execution.stdout;
}

function resolvedDigest(execute, reference) {
  const output = successfulOutput(execute(["resolve", reference]), "registry_resolution_failed");
  const digest = output.trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new CompatibilityTargetError("registry_digest_invalid");
  }
  return digest;
}

function repositoryTags(execute, definition) {
  const output = successfulOutput(
    execute(["repo", "tags", definition.repository]),
    "registry_tags_failed",
  );
  const lines = output.split(/\r?\n/u).filter(Boolean);
  if (lines.length < 1 || lines.length > 100_000) {
    throw new CompatibilityTargetError("registry_tags_invalid");
  }
  const candidates = lines
    .map((tag) => stableTag(definition.service, tag))
    .filter(Boolean)
    .sort((left, right) => compareOrders(left.order, right.order));
  if (candidates.length < 1) throw new CompatibilityTargetError("stable_tag_unresolved");
  return candidates;
}

function targetForDefinition(definition, execute) {
  const [candidate] = repositoryTags(execute, definition);
  const source = `${definition.repository}:${candidate.tag}`;
  const digest = resolvedDigest(execute, source);
  return {
    image: `${source}@${digest}`,
    service: definition.service,
    source,
    version: candidate.version,
  };
}

export function resolveCompatibilityTargets({
  execute = defaultExecute,
  now = () => new Date(),
} = {}) {
  if (typeof execute !== "function" || typeof now !== "function") {
    throw new CompatibilityTargetError("resolver_policy_invalid");
  }
  const resolvedAt = now().toISOString();
  const report = {
    resolvedAt,
    schemaVersion: 1,
    targets: COMPATIBILITY_TARGET_DEFINITIONS.map((definition) => {
      try {
        return targetForDefinition(definition, execute);
      } catch (error) {
        throw new CompatibilityTargetError(
          error instanceof CompatibilityTargetError ? error.code : "registry_resolution_failed",
          { cause: error, service: definition.service },
        );
      }
    }),
  };
  return validateCompatibilityTargets(report);
}

function parsedImageTarget(service, image, version) {
  const definition = definitionFor(service);
  if (typeof image !== "string" || typeof version !== "string") {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  const prefix = `${definition.repository}:`;
  if (!image.startsWith(prefix)) {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  const separator = image.lastIndexOf("@");
  if (separator <= prefix.length || !DIGEST_PATTERN.test(image.slice(separator + 1))) {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  const selected = stableTag(service, image.slice(prefix.length, separator));
  if (!selected || selected.version !== version) {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  return { image, version };
}

export function validateCompatibilityTarget(target) {
  if (
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    sortedKeys(target) !== TARGET_KEYS ||
    typeof target.service !== "string"
  ) {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  parsedImageTarget(target.service, target.image, target.version);
  if (target.source !== target.image.slice(0, target.image.lastIndexOf("@"))) {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  return structuredClone(target);
}

export function validateCompatibilityTargets(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    sortedKeys(report) !== "resolvedAt,schemaVersion,targets" ||
    report.schemaVersion !== 1 ||
    typeof report.resolvedAt !== "string" ||
    Number.isNaN(Date.parse(report.resolvedAt)) ||
    new Date(report.resolvedAt).toISOString() !== report.resolvedAt ||
    !Array.isArray(report.targets) ||
    report.targets.length !== COMPATIBILITY_SERVICES.length
  ) {
    throw new CompatibilityTargetError("compatibility_targets_invalid");
  }
  for (const [index, target] of report.targets.entries()) {
    const service = COMPATIBILITY_SERVICES[index];
    if (target?.service !== service) {
      throw new CompatibilityTargetError("compatibility_targets_invalid");
    }
    validateCompatibilityTarget(target);
  }
  if (JSON.stringify(report).length > 16_384) {
    throw new CompatibilityTargetError("compatibility_targets_invalid");
  }
  return structuredClone(report);
}

export function applyCompatibilityTargetOverride(defaultTargets, environment = process.env) {
  if (
    !defaultTargets ||
    typeof defaultTargets !== "object" ||
    Array.isArray(defaultTargets) ||
    !environment ||
    typeof environment !== "object"
  ) {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  const selected = Object.fromEntries(
    Object.entries(defaultTargets).map(([service, target]) => [
      service,
      parsedImageTarget(service, target?.image, target?.version),
    ]),
  );
  const override = {
    image: environment.OMNIFIN_COMPATIBILITY_IMAGE,
    service: environment.OMNIFIN_COMPATIBILITY_SERVICE,
    version: environment.OMNIFIN_COMPATIBILITY_VERSION,
  };
  const supplied = Object.values(override).filter((value) => value !== undefined).length;
  if (supplied === 0) return selected;
  if (
    supplied !== 3 ||
    typeof override.service !== "string" ||
    !Object.hasOwn(selected, override.service)
  ) {
    throw new CompatibilityTargetError("compatibility_target_invalid");
  }
  selected[override.service] = parsedImageTarget(
    override.service,
    override.image,
    override.version,
  );
  return selected;
}

function repositoryPath(candidate) {
  if (typeof candidate !== "string" || candidate.length < 1) {
    throw new CompatibilityTargetError("output_path_invalid");
  }
  const path = resolve(REPOSITORY_ROOT, candidate);
  const relativePath = relative(REPOSITORY_ROOT, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new CompatibilityTargetError("output_path_invalid");
  }
  return path;
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

function parseArguments(arguments_) {
  if (arguments_.length !== 3 || arguments_[0] !== "resolve" || arguments_[1] !== "--output") {
    throw new CompatibilityTargetError("usage_invalid");
  }
  return { output: repositoryPath(arguments_[2]) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await writeJson(options.output, resolveCompatibilityTargets());
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const code =
      error instanceof CompatibilityTargetError ? error.code : "compatibility_resolution_failed";
    const service = error instanceof CompatibilityTargetError ? error.service : null;
    process.stderr.write(`${JSON.stringify({ code, service, status: "failed" })}\n`);
    process.exitCode = 1;
  });
}
