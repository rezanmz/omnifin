#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  BazarrAdapter,
  BazarrTargetError,
} from "../../packages/connectors/dist/adapters/bazarr.js";
import { ProwlarrAdapter } from "../../packages/connectors/dist/adapters/prowlarr.js";
import { RadarrAdapter } from "../../packages/connectors/dist/adapters/radarr.js";
import { SonarrAdapter } from "../../packages/connectors/dist/adapters/sonarr.js";
import { parse as parseYaml } from "yaml";

export const SERVARR_SERVICE_IMAGES = Object.freeze({
  bazarr:
    "ghcr.io/linuxserver/bazarr:v1.6.0-ls356@sha256:ab401a0f361cfad328e444838b13d5b334b189d0f556fc91a3623eb581df36df",
  prowlarr:
    "ghcr.io/linuxserver/prowlarr:2.5.2.5491-ls155@sha256:2f3d31307beba3ba2dd226d191f5f5c14ee3b4d8b49277c64683f5ed97083179",
  radarr:
    "ghcr.io/linuxserver/radarr:6.3.0.10514-ls312@sha256:e35056574cdc695a9ee745aa1ecda9eab3842450bf4b7b8471b023790fa3861d",
  sonarr:
    "ghcr.io/linuxserver/sonarr:4.0.19.2979-ls320@sha256:24acea2956a0ccb11f103877d9f4f8576600fb34bff34820ed749c2256dab89f",
});

export const SERVARR_SERVICE_VERSIONS = Object.freeze({
  bazarr: "1.6.0",
  prowlarr: "2.5.2.5491",
  radarr: "6.3.0.10514",
  sonarr: "4.0.19.2979",
});

const SERVICE_PORTS = Object.freeze({ bazarr: 6767, prowlarr: 9696, radarr: 7878, sonarr: 8989 });
const SERVICE_CHECKS = Object.freeze({
  bazarr: ["authentication", "credentialRejection", "emptyLibraryRead", "versionDiscovery"],
  prowlarr: [
    "applicationRead",
    "authentication",
    "credentialRejection",
    "failureRead",
    "indexerRead",
    "systemHealthRead",
    "versionDiscovery",
  ],
  radarr: [
    "authentication",
    "calendarRead",
    "credentialRejection",
    "storageRead",
    "systemHealthRead",
    "versionDiscovery",
  ],
  sonarr: [
    "authentication",
    "calendarRead",
    "credentialRejection",
    "storageRead",
    "systemHealthRead",
    "versionDiscovery",
  ],
});
const SERVICES = Object.freeze(Object.keys(SERVARR_SERVICE_IMAGES));
const SAFE_CONNECTOR_FAILURE_CODES = new Set([
  "configuration_invalid",
  "destination_blocked",
  "invalid_credentials",
  "rate_limited",
  "response_invalid",
  "timeout",
  "unreachable",
  "unsupported_version",
  "upstream_error",
]);
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
const SERVER_READY_TIMEOUT_MS = 120_000;
const PRIVATE_IPV4_PATTERN = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u;
const API_KEY_PATTERN = /^[a-f0-9]{32}$/u;

class ServarrFixtureFailure extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "ServarrFixtureFailure";
    this.code = code;
  }
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

export function validateSanitizedServarrReport(report) {
  const expectedChecks = SERVICE_CHECKS[report?.service] ?? [];
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    sortedKeys(report).join(",") !== "checks,image,schemaVersion,serverVersion,service,status" ||
    report.schemaVersion !== 1 ||
    report.status !== "passed" ||
    !SERVICES.includes(report.service) ||
    report.image !== SERVARR_SERVICE_IMAGES[report.service] ||
    report.serverVersion !== SERVARR_SERVICE_VERSIONS[report.service] ||
    !report.checks ||
    typeof report.checks !== "object" ||
    Array.isArray(report.checks) ||
    sortedKeys(report.checks).join(",") !== [...expectedChecks].sort().join(",") ||
    expectedChecks.some((name) => report.checks[name] !== "passed") ||
    JSON.stringify(report).length > 4_096
  ) {
    throw new ServarrFixtureFailure("report_invalid");
  }
  return structuredClone(report);
}

export function validateSanitizedServarrFailureReport(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    sortedKeys(report).join(",") !== "code,schemaVersion,service,status" ||
    report.schemaVersion !== 1 ||
    report.status !== "failed" ||
    !SERVICES.includes(report.service) ||
    typeof report.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(report.code) ||
    JSON.stringify(report).length > 512
  ) {
    throw new ServarrFixtureFailure("failure_report_invalid");
  }
  return structuredClone(report);
}

export function parseServarrApiKey(configuration) {
  if (typeof configuration !== "string" || configuration.length > MAX_RESPONSE_BYTES) {
    throw new ServarrFixtureFailure("credential_config_invalid");
  }
  const matches = [...configuration.matchAll(/<ApiKey>([^<]+)<\/ApiKey>/giu)].map((match) =>
    match[1]?.trim().toLowerCase(),
  );
  if (matches.length !== 1 || !matches[0] || !API_KEY_PATTERN.test(matches[0])) {
    throw new ServarrFixtureFailure("credential_config_invalid");
  }
  return matches[0];
}

export function parseBazarrApiKey(configuration) {
  if (typeof configuration !== "string" || configuration.length > MAX_RESPONSE_BYTES) {
    throw new ServarrFixtureFailure("credential_config_invalid");
  }
  let parsed;
  try {
    parsed = parseYaml(configuration, { maxAliasCount: 0, prettyErrors: false });
  } catch (error) {
    throw new ServarrFixtureFailure("credential_config_invalid", { cause: error });
  }
  const apiKey = parsed?.auth?.apikey;
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey.toLowerCase())) {
    throw new ServarrFixtureFailure("credential_config_invalid");
  }
  return apiKey.toLowerCase();
}

export function parseContainerState(output) {
  const state = typeof output === "string" ? output.trim() : "";
  if (state === "true:0") return true;
  if (/^false:\d{1,3}$/u.test(state)) throw new ServarrFixtureFailure("container_exited");
  throw new ServarrFixtureFailure("container_state_invalid");
}

export function parseContainerAddress(output) {
  const address = typeof output === "string" ? output.trim() : "";
  if (isIP(address) !== 4 || !PRIVATE_IPV4_PATTERN.test(address)) {
    throw new ServarrFixtureFailure("container_address_invalid");
  }
  return address;
}

export function containerIsolationArguments(uid, gid) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new ServarrFixtureFailure("host_identity_unavailable");
  }
  return [
    "--user",
    `${uid}:${gid}`,
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    `/run:uid=${uid},gid=${gid},exec`,
  ];
}

function repositoryPath(candidate) {
  const path = resolve(REPOSITORY_ROOT, candidate);
  const relativePath = relative(REPOSITORY_ROOT, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new ServarrFixtureFailure("path_invalid");
  }
  return path;
}

function parseArguments(arguments_) {
  const serviceIndex = arguments_.indexOf("--service");
  const outputIndex = arguments_.indexOf("--output");
  if (
    arguments_.length !== 4 ||
    serviceIndex < 0 ||
    outputIndex < 0 ||
    !SERVICES.includes(arguments_[serviceIndex + 1]) ||
    !arguments_[outputIndex + 1]
  ) {
    throw new ServarrFixtureFailure("usage_invalid");
  }
  return {
    outputPath: repositoryPath(arguments_[outputIndex + 1]),
    service: arguments_[serviceIndex + 1],
  };
}

function runDocker(arguments_, timeout = 180_000, failureCode = "container_failed") {
  const execution = spawnSync("docker", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 2 * 1_024 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  if (execution.status !== 0 || execution.error) {
    throw new ServarrFixtureFailure(failureCode, { cause: execution.error });
  }
  return `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`;
}

function bestEffortDocker(arguments_, timeout = 30_000) {
  spawnSync("docker", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1_024,
    stdio: ["ignore", "ignore", "ignore"],
    timeout,
  });
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForResult(operation, timeoutCode) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== null && result !== false) return result;
    } catch {
      // First-run migrations may temporarily leave the service or config unavailable.
    }
    await sleep(500);
  }
  throw new ServarrFixtureFailure(timeoutCode);
}

async function prepareContext(service) {
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), `omnifin-${service}-service-fixture-`)),
  );
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const configDirectory = resolve(temporaryDirectory, "config");
  await mkdir(configDirectory, { mode: 0o700 });
  return {
    configDirectory,
    containerCreated: false,
    containerName: `omnifin-${service}-service-${suffix}`,
    networkCreated: false,
    networkName: `omnifin-${service}-service-network-${suffix}`,
    service,
    temporaryDirectory,
  };
}

function commonContainerArguments(context) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const arguments_ = [
    "run",
    "--detach",
    "--name",
    context.containerName,
    "--network",
    context.networkName,
    ...containerIsolationArguments(uid, gid),
    "--pids-limit",
    "512",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--env",
    "TZ=Etc/UTC",
    "--env",
    "UMASK=077",
    "--env",
    "DOCKER_MODS=",
  ];
  arguments_.push(
    "--mount",
    `type=bind,src=${context.configDirectory},dst=/config`,
    SERVARR_SERVICE_IMAGES[context.service],
  );
  return arguments_;
}

function startContainer(context) {
  runDocker(
    ["network", "create", "--driver", "bridge", "--internal", context.networkName],
    30_000,
    "network_create_failed",
  );
  context.networkCreated = true;
  runDocker(commonContainerArguments(context), 180_000, "container_start_failed");
  context.containerCreated = true;
  parseContainerState(
    runDocker(
      ["inspect", "--format", "{{.State.Running}}:{{.State.ExitCode}}", context.containerName],
      30_000,
      "container_state_failed",
    ),
  );
  if (process.platform === "darwin") {
    return {
      baseUrl: `http://fixture.omnifin.invalid:${SERVICE_PORTS[context.service]}/`,
      resolveHost: async () => [{ address: "10.255.255.254", family: 4 }],
      transport: createContainerLocalTransport(context),
    };
  }
  const address = parseContainerAddress(
    runDocker(
      [
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        context.containerName,
      ],
      30_000,
      "container_address_failed",
    ),
  );
  return { baseUrl: `http://${address}:${SERVICE_PORTS[context.service]}/` };
}

function createContainerLocalTransport(context) {
  return async (url, init) => {
    if (init.signal.aborted) throw new ServarrFixtureFailure("fixture_transport_aborted");
    if (init.body !== undefined) throw new ServarrFixtureFailure("fixture_transport_body_blocked");
    const arguments_ = [
      "exec",
      "--interactive",
      context.containerName,
      "curl",
      "--silent",
      "--show-error",
      "--max-time",
      String(Math.ceil(REQUEST_TIMEOUT_MS / 1_000)),
      "--request",
      init.method,
      "--config",
      "-",
      "--write-out",
      "\n%{http_code}",
    ];
    arguments_.push(
      `http://127.0.0.1:${SERVICE_PORTS[context.service]}${url.pathname}${url.search}`,
    );
    const execution = spawnSync("docker", arguments_, {
      cwd: REPOSITORY_ROOT,
      encoding: null,
      input: createCurlHeaderConfiguration(init.headers),
      maxBuffer: MAX_RESPONSE_BYTES + 1_024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: REQUEST_TIMEOUT_MS + 5_000,
    });
    if (execution.status !== 0 || execution.error || !Buffer.isBuffer(execution.stdout)) {
      throw new ServarrFixtureFailure("fixture_transport_failed", { cause: execution.error });
    }
    const separator = execution.stdout.lastIndexOf(0x0a);
    const statusText = execution.stdout.subarray(separator + 1).toString("ascii");
    if (separator < 0 || !/^\d{3}$/u.test(statusText)) {
      throw new ServarrFixtureFailure("fixture_transport_failed");
    }
    const status = Number(statusText);
    const body = execution.stdout.subarray(0, separator);
    return new Response([204, 205, 304].includes(status) ? null : body, { status });
  };
}

export function createCurlHeaderConfiguration(headers) {
  if (!(headers instanceof Headers)) throw new ServarrFixtureFailure("fixture_headers_invalid");
  return Buffer.from(
    [...headers.entries()]
      .map(([name, value]) => {
        if (/[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(name) || /[\r\n\0]/u.test(value)) {
          throw new ServarrFixtureFailure("fixture_headers_invalid");
        }
        const escaped = `${name}: ${value}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        return `header = "${escaped}"`;
      })
      .join("\n") + "\n",
    "utf8",
  );
}

async function readApiKey(context) {
  const path =
    context.service === "bazarr"
      ? resolve(context.configDirectory, "config/config.yaml")
      : resolve(context.configDirectory, "config.xml");
  const configuration = await readFile(path, "utf8");
  return context.service === "bazarr"
    ? parseBazarrApiKey(configuration)
    : parseServarrApiKey(configuration);
}

function adapterConfig(context, server, apiKey) {
  return {
    apiKey,
    baseUrl: server.baseUrl,
    connectorId: `${context.service}-fixture`,
    displayName: `${context.service} fixture`,
    insecureHttpApproved: true,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...(server.resolveHost ? { resolveHost: server.resolveHost } : {}),
    ...(server.transport ? { transport: server.transport } : {}),
  };
}

function createAdapter(context, server, apiKey) {
  const config = adapterConfig(context, server, apiKey);
  switch (context.service) {
    case "bazarr":
      return new BazarrAdapter(config);
    case "prowlarr":
      return new ProwlarrAdapter(config);
    case "radarr":
      return new RadarrAdapter(config);
    case "sonarr":
      return new SonarrAdapter(config);
    default:
      throw new ServarrFixtureFailure("service_invalid");
  }
}

function connectorFailureCode(stage, error) {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(stage)) {
    throw new ServarrFixtureFailure("diagnostic_stage_invalid");
  }
  const causeCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    SAFE_CONNECTOR_FAILURE_CODES.has(error.code)
      ? error.code
      : null;
  return causeCode ? `${stage}_${causeCode}` : stage;
}

async function connectorOperation(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new ServarrFixtureFailure(connectorFailureCode(stage, error), { cause: error });
  }
}

function assertEmptyArray(value, failureCode) {
  if (!Array.isArray(value) || value.length !== 0) {
    throw new ServarrFixtureFailure(failureCode);
  }
}

async function verifyCredentialRejection(context, server, apiKey) {
  const replacement = apiKey.startsWith("0") ? "1" : "0";
  const health = await createAdapter(context, server, `${replacement}${apiKey.slice(1)}`).probe();
  if (health.status !== "misconfigured" || health.failure?.code !== "invalid_credentials") {
    throw new ServarrFixtureFailure("credential_rejection_invalid");
  }
}

async function verifyRadarrOrSonarr(context, adapter) {
  const systemHealth = await connectorOperation("system_health_read", () =>
    adapter.readSystemHealth(),
  );
  if (!Array.isArray(systemHealth)) throw new ServarrFixtureFailure("system_health_invalid");
  const startAt = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const endAt = new Date("2026-01-08T00:00:00.000Z").toISOString();
  const calendar = await connectorOperation("calendar_read", () =>
    adapter.readAcquisitionCalendar({ endAt, startAt }),
  );
  assertEmptyArray(calendar.events, "calendar_empty_state_invalid");
  if (calendar.truncated !== false) throw new ServarrFixtureFailure("calendar_empty_state_invalid");
  const storage = await connectorOperation("storage_read", () => adapter.readStorageCapacity());
  if (!Array.isArray(storage)) throw new ServarrFixtureFailure("storage_read_invalid");
}

async function verifyProwlarr(adapter) {
  const systemHealth = await connectorOperation("system_health_read", () =>
    adapter.readSystemHealth(),
  );
  if (!Array.isArray(systemHealth)) throw new ServarrFixtureFailure("system_health_invalid");
  const indexers = await connectorOperation("indexer_read", () =>
    adapter.readIndexerIntelligencePage({ limit: 25 }),
  );
  assertEmptyArray(indexers.items, "indexer_empty_state_invalid");
  if (indexers.hasMore || indexers.summary.total !== 0) {
    throw new ServarrFixtureFailure("indexer_empty_state_invalid");
  }
  const applications = await connectorOperation("application_read", () =>
    adapter.readApplicationPage({ limit: 25 }),
  );
  assertEmptyArray(applications.items, "application_empty_state_invalid");
  if (applications.hasMore) throw new ServarrFixtureFailure("application_empty_state_invalid");
  const failures = await connectorOperation("failure_read", () =>
    adapter.readFailurePage({ limit: 25, page: 1 }),
  );
  assertEmptyArray(failures.items, "failure_empty_state_invalid");
  if (failures.hasMore) throw new ServarrFixtureFailure("failure_empty_state_invalid");
}

async function verifyBazarr(adapter) {
  const emptyLibrary = await adapter
    .searchSubtitles({ kind: "movie", title: "Fixture Title", year: 2026 })
    .then(
      () => false,
      (error) => error instanceof BazarrTargetError && error.reason === "not_found",
    );
  if (!emptyLibrary) throw new ServarrFixtureFailure("empty_library_read_invalid");
}

async function runFixture(context, server) {
  const apiKey = await waitForResult(() => readApiKey(context), "credential_config_timeout");
  const adapter = createAdapter(context, server, apiKey);
  const health = await waitForResult(async () => {
    const candidate = await adapter.probe();
    return candidate.status === "healthy" ? candidate : null;
  }, "authentication_start_timeout");
  const version = health.version?.replace(/^v/u, "");
  if (version !== SERVARR_SERVICE_VERSIONS[context.service]) {
    throw new ServarrFixtureFailure("server_version_invalid");
  }
  await connectorOperation("credential_rejection", () =>
    verifyCredentialRejection(context, server, apiKey),
  );
  if (context.service === "bazarr") {
    await connectorOperation("empty_library_read", () => verifyBazarr(adapter));
  } else if (context.service === "prowlarr") {
    await verifyProwlarr(adapter);
  } else {
    await verifyRadarrOrSonarr(context, adapter);
  }
  return validateSanitizedServarrReport({
    checks: Object.fromEntries(SERVICE_CHECKS[context.service].map((name) => [name, "passed"])),
    image: SERVARR_SERVICE_IMAGES[context.service],
    schemaVersion: 1,
    serverVersion: version,
    service: context.service,
    status: "passed",
  });
}

async function writeReport(outputPath, report) {
  const parent = dirname(outputPath);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const canonicalRoot = await realpath(REPOSITORY_ROOT);
  const canonicalParent = await realpath(parent);
  const parentRelative = relative(canonicalRoot, canonicalParent);
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    throw new ServarrFixtureFailure("path_invalid");
  }
  const temporaryPath = resolve(
    parent,
    `.${basename(outputPath)}.${randomBytes(6).toString("hex")}`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function verifyTemporaryContext(context) {
  const metadata = await lstat(context.temporaryDirectory);
  const relativePath = relative(await realpath(tmpdir()), context.temporaryDirectory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    relativePath.startsWith("..") ||
    !basename(context.temporaryDirectory).startsWith(`omnifin-${context.service}-service-fixture-`)
  ) {
    throw new ServarrFixtureFailure("temporary_directory_invalid");
  }
}

async function teardownContext(context, strict) {
  let failure;
  if (context.containerCreated) {
    try {
      runDocker(["rm", "--force", context.containerName], 30_000, "container_teardown_failed");
      context.containerCreated = false;
    } catch (error) {
      failure = error;
      bestEffortDocker(["rm", "--force", context.containerName]);
    }
  } else {
    bestEffortDocker(["rm", "--force", context.containerName]);
  }
  if (context.networkCreated) {
    try {
      runDocker(["network", "rm", context.networkName], 30_000, "network_teardown_failed");
      context.networkCreated = false;
    } catch (error) {
      failure ??= error;
      bestEffortDocker(["network", "rm", context.networkName]);
    }
  }
  await verifyTemporaryContext(context);
  await rm(context.temporaryDirectory, { force: true, recursive: true });
  if (strict && failure) throw failure;
}

async function main(options) {
  const context = await prepareContext(options.service);
  let report;
  let failure;
  try {
    await verifyTemporaryContext(context);
    const server = startContainer(context);
    report = await runFixture(context, server);
  } catch (error) {
    failure = error;
  }
  try {
    await teardownContext(context, failure === undefined);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  await writeReport(options.outputPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    await main(options);
  } catch (error) {
    const candidateCode =
      error instanceof ServarrFixtureFailure ? error.code : "servarr_service_fixture_failed";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(candidateCode)
      ? candidateCode
      : "servarr_service_fixture_failed";
    if (options) {
      try {
        await writeReport(
          options.outputPath,
          validateSanitizedServarrFailureReport({
            code,
            schemaVersion: 1,
            service: options.service,
            status: "failed",
          }),
        );
      } catch {
        // The bounded stderr diagnostic remains available if the evidence path is unavailable.
      }
    }
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 1;
  }
}
