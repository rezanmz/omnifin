#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { SeerrAdapter } from "../../packages/connectors/dist/adapters/seerr.js";
import {
  acquirePinnedDockerImage,
  DockerImagePullError,
  DOCKER_LOCAL_IMAGE_ARGUMENTS,
} from "./docker-runtime.mjs";
import { SEERR_FIXTURE_TMDB_ID } from "./seerr-fixture-server.mjs";

export const SEERR_SERVICE_IMAGE =
  "ghcr.io/seerr-team/seerr:v3.4.1@sha256:f4768de5f616248d723e05891f3345a1402123775d03bf0890dbfedc0831bda1";
export const SEERR_FIXTURE_SERVER_IMAGE =
  "docker.io/library/node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573";
export const SEERR_SERVICE_VERSION = "3.4.1";
export const SEERR_CHECK_NAMES = Object.freeze([
  "authentication",
  "credentialRejection",
  "delegatedIdentity",
  "duplicateRejection",
  "pendingRequestCreation",
  "requestDecline",
  "requestReview",
  "versionDiscovery",
]);

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_TRANSPORT_BODY_BYTES = 1 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
const SERVER_READY_TIMEOUT_MS = 120_000;
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

class SeerrFixtureFailure extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "SeerrFixtureFailure";
    this.code = code;
  }
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

export function validateSanitizedSeerrReport(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    sortedKeys(report).join(",") !== "checks,image,schemaVersion,serverVersion,service,status" ||
    report.schemaVersion !== 1 ||
    report.status !== "passed" ||
    report.service !== "seerr" ||
    report.image !== SEERR_SERVICE_IMAGE ||
    report.serverVersion !== SEERR_SERVICE_VERSION ||
    !report.checks ||
    typeof report.checks !== "object" ||
    Array.isArray(report.checks) ||
    sortedKeys(report.checks).join(",") !== [...SEERR_CHECK_NAMES].sort().join(",") ||
    SEERR_CHECK_NAMES.some((name) => report.checks[name] !== "passed") ||
    JSON.stringify(report).length > 4_096
  ) {
    throw new SeerrFixtureFailure("report_invalid");
  }
  return structuredClone(report);
}

export function validateSanitizedSeerrFailureReport(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    sortedKeys(report).join(",") !== "code,schemaVersion,service,status" ||
    report.schemaVersion !== 1 ||
    report.status !== "failed" ||
    report.service !== "seerr" ||
    typeof report.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(report.code) ||
    JSON.stringify(report).length > 512
  ) {
    throw new SeerrFixtureFailure("failure_report_invalid");
  }
  return structuredClone(report);
}

function repositoryPath(candidate) {
  const path = resolve(REPOSITORY_ROOT, candidate);
  const relativePath = relative(REPOSITORY_ROOT, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new SeerrFixtureFailure("path_invalid");
  }
  return path;
}

function parseArguments(arguments_) {
  const outputIndex = arguments_.indexOf("--output");
  if (arguments_.length !== 2 || outputIndex !== 0 || !arguments_[1]) {
    throw new SeerrFixtureFailure("usage_invalid");
  }
  return { outputPath: repositoryPath(arguments_[1]) };
}

function runProcess(command, arguments_, timeout, failureCode, options = {}) {
  const execution = spawnSync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 2 * 1_024 * 1_024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout,
  });
  if (execution.status !== 0 || execution.error) {
    throw new SeerrFixtureFailure(failureCode, { cause: execution.error });
  }
  return `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`;
}

function runDocker(arguments_, timeout = 180_000, failureCode = "container_failed") {
  return runProcess("docker", arguments_, timeout, failureCode);
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

function runOpenSsl(arguments_, failureCode) {
  runProcess("openssl", arguments_, 30_000, failureCode);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function parseSeerrContainerState(output) {
  const state = typeof output === "string" ? output.trim() : "";
  if (state === "true:0") return true;
  if (/^false:\d{1,3}$/u.test(state)) throw new SeerrFixtureFailure("container_exited");
  throw new SeerrFixtureFailure("container_state_invalid");
}

export function seerrContainerIsolationArguments(uid, gid) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new SeerrFixtureFailure("host_identity_unavailable");
  }
  return ["--user", `${uid}:${gid}`, "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
}

export function seerrFixtureServerContainerArguments(context) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return [
    "run",
    ...DOCKER_LOCAL_IMAGE_ARGUMENTS,
    "--detach",
    "--name",
    context.fixtureServerName,
    "--network",
    context.networkName,
    "--network-alias",
    "api.themoviedb.org",
    ...seerrContainerIsolationArguments(uid, gid),
    "--read-only",
    "--pids-limit",
    "64",
    "--memory",
    "192m",
    "--cpus",
    "0.5",
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--mount",
    `type=bind,src=${repositoryPath("scripts/integration/seerr-fixture-server.mjs")},dst=/fixture/seerr-fixture-server.mjs,readonly`,
    "--mount",
    `type=bind,src=${resolve(context.tlsDirectory, "server.crt")},dst=/fixture-tls/server.crt,readonly`,
    "--mount",
    `type=bind,src=${resolve(context.tlsDirectory, "server.key")},dst=/fixture-tls/server.key,readonly`,
    SEERR_FIXTURE_SERVER_IMAGE,
    "node",
    "/fixture/seerr-fixture-server.mjs",
  ];
}

export function seerrServiceContainerArguments(context) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return [
    "run",
    ...DOCKER_LOCAL_IMAGE_ARGUMENTS,
    "--detach",
    "--init",
    "--name",
    context.containerName,
    "--network",
    context.networkName,
    ...seerrContainerIsolationArguments(uid, gid),
    "--pids-limit",
    "512",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--env-file",
    context.environmentPath,
    "--mount",
    `type=bind,src=${context.configDirectory},dst=/app/config`,
    "--mount",
    `type=bind,src=${resolve(context.tlsDirectory, "ca.crt")},dst=/fixture-tls/ca.crt,readonly`,
    "--mount",
    `type=bind,src=${repositoryPath("scripts/integration/seerr-container-request.mjs")},dst=/fixture/seerr-container-request.mjs,readonly`,
    SEERR_SERVICE_IMAGE,
  ];
}

export function seerrDatabaseSeedArguments(context) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return [
    "run",
    ...DOCKER_LOCAL_IMAGE_ARGUMENTS,
    "--rm",
    "--network",
    "none",
    ...seerrContainerIsolationArguments(uid, gid),
    "--read-only",
    "--tmpfs",
    `/tmp:uid=${uid},gid=${gid}`,
    "--workdir",
    "/app",
    "--mount",
    `type=bind,src=${context.configDirectory},dst=/app/config`,
    "--mount",
    `type=bind,src=${repositoryPath("scripts/integration/seerr-database-seed.mjs")},dst=/fixture/seerr-database-seed.mjs,readonly`,
    "--entrypoint",
    "node",
    SEERR_SERVICE_IMAGE,
    "/fixture/seerr-database-seed.mjs",
  ];
}

async function prepareContext() {
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "omnifin-seerr-service-fixture-")),
  );
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const context = {
    apiKey: randomBytes(32).toString("hex"),
    configDirectory: resolve(temporaryDirectory, "config"),
    containerCreated: false,
    containerName: `omnifin-seerr-${suffix}`,
    environmentPath: resolve(temporaryDirectory, "seerr.env"),
    fixtureServerCreated: false,
    fixtureServerName: `omnifin-seerr-metadata-${suffix}`,
    networkCreated: false,
    networkName: `omnifin-seerr-network-${suffix}`,
    temporaryDirectory,
    tlsDirectory: resolve(temporaryDirectory, "tls"),
  };
  await Promise.all(
    [context.configDirectory, context.tlsDirectory].map((directory) =>
      mkdir(directory, { mode: 0o700 }),
    ),
  );
  await writeFile(
    context.environmentPath,
    [
      `API_KEY=${context.apiKey}`,
      "LOG_LEVEL=error",
      "NODE_EXTRA_CA_CERTS=/fixture-tls/ca.crt",
      "PORT=5055",
      "TZ=Etc/UTC",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  return context;
}

async function createFixtureCertificates(context) {
  const caCertificate = resolve(context.tlsDirectory, "ca.crt");
  const caKey = resolve(context.tlsDirectory, "ca.key");
  const serverCertificate = resolve(context.tlsDirectory, "server.crt");
  const serverRequest = resolve(context.tlsDirectory, "server.csr");
  const serverExtensions = resolve(context.tlsDirectory, "server.ext");
  const serverKey = resolve(context.tlsDirectory, "server.key");
  await writeFile(
    serverExtensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:api.themoviedb.org",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  runOpenSsl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      "/CN=Omnifin isolated Seerr fixture CA",
      "-keyout",
      caKey,
      "-out",
      caCertificate,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    "fixture_ca_generation_failed",
  );
  runOpenSsl(
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=api.themoviedb.org",
      "-keyout",
      serverKey,
      "-out",
      serverRequest,
    ],
    "fixture_certificate_request_failed",
  );
  runOpenSsl(
    [
      "x509",
      "-req",
      "-in",
      serverRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverCertificate,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      serverExtensions,
    ],
    "fixture_certificate_generation_failed",
  );
}

async function acquireFixtureImage(image) {
  try {
    await acquirePinnedDockerImage(image);
  } catch (error) {
    if (error instanceof DockerImagePullError) throw new SeerrFixtureFailure(error.code);
    throw error;
  }
}

function containerIsReady(containerName) {
  const execution = spawnSync(
    "docker",
    [
      "exec",
      containerName,
      "wget",
      "--quiet",
      "--output-document=-",
      "--timeout=5",
      "http://127.0.0.1:5055/api/v1/settings/public",
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    },
  );
  if (execution.status !== 0 || execution.error || typeof execution.stdout !== "string")
    return false;
  try {
    const response = JSON.parse(execution.stdout);
    return response && typeof response === "object" && !Array.isArray(response);
  } catch {
    return false;
  }
}

async function waitForContainer(context, failureCode) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (containerIsReady(context.containerName)) return;
    await sleep(500);
  }
  throw new SeerrFixtureFailure(failureCode);
}

async function startFixture(context) {
  await Promise.all([
    acquireFixtureImage(SEERR_SERVICE_IMAGE),
    acquireFixtureImage(SEERR_FIXTURE_SERVER_IMAGE),
  ]);
  await createFixtureCertificates(context);
  runDocker(
    ["network", "create", "--driver", "bridge", "--internal", context.networkName],
    30_000,
    "network_create_failed",
  );
  context.networkCreated = true;
  runDocker(seerrFixtureServerContainerArguments(context), 60_000, "fixture_server_start_failed");
  context.fixtureServerCreated = true;
  parseSeerrContainerState(
    runDocker(
      ["inspect", "--format", "{{.State.Running}}:{{.State.ExitCode}}", context.fixtureServerName],
      30_000,
      "fixture_server_state_failed",
    ),
  );
  runDocker(seerrServiceContainerArguments(context), 180_000, "container_start_failed");
  context.containerCreated = true;
  await waitForContainer(context, "initial_migration_timeout");
  const stopped = runDocker(
    ["stop", "--timeout", "20", context.containerName],
    60_000,
    "container_stop_failed",
  ).trim();
  if (stopped !== context.containerName) throw new SeerrFixtureFailure("container_stop_failed");
  const seedResult = runDocker(
    seerrDatabaseSeedArguments(context),
    60_000,
    "database_seed_failed",
  ).trim();
  if (!seedResult.startsWith('{"status":"ok"}')) {
    throw new SeerrFixtureFailure("database_seed_invalid");
  }
  const started = runDocker(
    ["start", context.containerName],
    60_000,
    "container_restart_failed",
  ).trim();
  if (started !== context.containerName) throw new SeerrFixtureFailure("container_restart_failed");
  await waitForContainer(context, "service_start_timeout");
}

export function parseSeerrTransportOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new SeerrFixtureFailure("fixture_transport_invalid", { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Number.isInteger(parsed.status) ||
    parsed.status < 100 ||
    parsed.status > 599 ||
    typeof parsed.body !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(parsed.body) ||
    !Array.isArray(parsed.headers) ||
    parsed.headers.length > 64 ||
    parsed.headers.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string" ||
        entry[0].length > 128 ||
        entry[1].length > 8_192 ||
        /[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(entry[0]) ||
        /[\r\n\0]/u.test(entry[1]),
    )
  ) {
    throw new SeerrFixtureFailure("fixture_transport_invalid");
  }
  const body = Buffer.from(parsed.body, "base64");
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new SeerrFixtureFailure("fixture_transport_invalid");
  }
  return { body, headers: parsed.headers, status: parsed.status };
}

export function serializeSeerrContainerRequest(url, init) {
  if (init.body !== undefined && !(init.body instanceof Uint8Array)) {
    throw new SeerrFixtureFailure("fixture_transport_invalid");
  }
  if (init.body && init.body.byteLength > MAX_TRANSPORT_BODY_BYTES) {
    throw new SeerrFixtureFailure("fixture_transport_invalid");
  }
  const payload = JSON.stringify({
    body: init.body === undefined ? null : Buffer.from(init.body).toString("base64"),
    headers: [...init.headers.entries()],
    method: init.method,
    path: `${url.pathname}${url.search}`,
  });
  if (Buffer.byteLength(payload, "utf8") > MAX_RESPONSE_BYTES) {
    throw new SeerrFixtureFailure("fixture_transport_invalid");
  }
  return payload;
}

export function createSeerrContainerTransport(context) {
  return async (url, init) => {
    if (init.signal?.aborted) throw new SeerrFixtureFailure("fixture_transport_aborted");
    const payload = serializeSeerrContainerRequest(url, init);
    const execution = spawnSync(
      "docker",
      [
        "exec",
        "--interactive",
        context.containerName,
        "node",
        "/fixture/seerr-container-request.mjs",
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        input: payload,
        maxBuffer: 3 * 1_024 * 1_024,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: REQUEST_TIMEOUT_MS + 5_000,
      },
    );
    if (execution.status !== 0 || execution.error || typeof execution.stdout !== "string") {
      throw new SeerrFixtureFailure("fixture_transport_failed", { cause: execution.error });
    }
    const response = parseSeerrTransportOutput(execution.stdout);
    return new Response([204, 205, 304].includes(response.status) ? null : response.body, {
      headers: response.headers,
      status: response.status,
    });
  };
}

function adapter(context, apiKey = context.apiKey) {
  return new SeerrAdapter({
    apiKey,
    baseUrl: "http://fixture.omnifin.invalid:5055/",
    connectorId: "seerr-fixture",
    displayName: "Seerr fixture",
    insecureHttpApproved: true,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    resolveHost: async () => [{ address: "10.255.255.254", family: 4 }],
    timeoutMs: REQUEST_TIMEOUT_MS,
    transport: createSeerrContainerTransport(context),
  });
}

function connectorFailureCode(stage, error) {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(stage)) {
    throw new SeerrFixtureFailure("diagnostic_stage_invalid");
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
    throw new SeerrFixtureFailure(connectorFailureCode(stage, error), { cause: error });
  }
}

async function verifyCredentialRejection(context) {
  const replacement = context.apiKey.startsWith("0") ? "1" : "0";
  const invalidKey = `${replacement}${context.apiKey.slice(1)}`;
  const rejected = await adapter(context, invalidKey)
    .resolveUser({
      jellyfinUserId: "fixture-requester-id",
      jellyfinUsername: "fixture-requester",
    })
    .then(
      () => false,
      (error) =>
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "invalid_credentials",
    );
  if (!rejected) throw new SeerrFixtureFailure("credential_rejection_invalid");
}

async function runFixture(context) {
  const connector = adapter(context);
  const health = await connectorOperation("authentication", () => connector.probe());
  const version = health.version?.replace(/^v/u, "");
  if (health.status !== "healthy" || version !== SEERR_SERVICE_VERSION) {
    throw new SeerrFixtureFailure("server_version_invalid");
  }
  await connectorOperation("credential_rejection", () => verifyCredentialRejection(context));
  const userId = await connectorOperation("delegated_identity", () =>
    connector.resolveUser({
      jellyfinUserId: "fixture-requester-id",
      jellyfinUsername: "fixture-requester",
    }),
  );
  if (userId !== 2) throw new SeerrFixtureFailure("delegated_identity_invalid");

  const created = await connectorOperation("pending_request_creation", () =>
    connector.createMediaRequest(
      { is4k: false, kind: "movie", tmdbId: SEERR_FIXTURE_TMDB_ID },
      userId,
    ),
  );
  if (
    created.kind !== "movie" ||
    created.tmdbId !== SEERR_FIXTURE_TMDB_ID ||
    created.status !== "pending" ||
    !/^request:[1-9][0-9]*$/u.test(created.id)
  ) {
    throw new SeerrFixtureFailure("pending_request_invalid");
  }

  const duplicateRejected = await connector
    .createMediaRequest({ is4k: false, kind: "movie", tmdbId: SEERR_FIXTURE_TMDB_ID }, userId)
    .then(
      () => false,
      (error) =>
        error &&
        typeof error === "object" &&
        "reason" in error &&
        error.reason === "request_conflict",
    );
  if (!duplicateRejected) throw new SeerrFixtureFailure("duplicate_rejection_invalid");

  const pending = await connectorOperation("request_review", () =>
    connector.listMediaRequests({ cursor: null, limit: 25, status: "pending" }),
  );
  const pendingMatch = pending.items.filter((item) => item.id === created.id);
  if (
    pendingMatch.length !== 1 ||
    pendingMatch[0]?.status !== "pending" ||
    pendingMatch[0]?.tmdbId !== SEERR_FIXTURE_TMDB_ID ||
    pendingMatch[0]?.requestedBy !== "fixture-requester"
  ) {
    throw new SeerrFixtureFailure("request_review_invalid");
  }

  const declined = await connectorOperation("request_decline", () =>
    connector.reviewMediaRequest(created.id, { decision: "decline" }),
  );
  if (declined.id !== created.id || declined.status !== "declined") {
    throw new SeerrFixtureFailure("request_decline_invalid");
  }
  const finalPage = await connectorOperation("request_decline_read", () =>
    connector.listMediaRequests({ cursor: null, limit: 25, status: "all" }),
  );
  const finalMatch = finalPage.items.filter((item) => item.id === created.id);
  if (finalMatch.length !== 1 || finalMatch[0]?.status !== "declined") {
    throw new SeerrFixtureFailure("request_decline_read_invalid");
  }

  return validateSanitizedSeerrReport({
    checks: Object.fromEntries(SEERR_CHECK_NAMES.map((name) => [name, "passed"])),
    image: SEERR_SERVICE_IMAGE,
    schemaVersion: 1,
    serverVersion: version,
    service: "seerr",
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
    throw new SeerrFixtureFailure("path_invalid");
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
    !basename(context.temporaryDirectory).startsWith("omnifin-seerr-service-fixture-")
  ) {
    throw new SeerrFixtureFailure("temporary_directory_invalid");
  }
}

async function teardownContext(context, strict) {
  let failure;
  for (const [createdKey, containerName, failureCode] of [
    ["containerCreated", context.containerName, "container_teardown_failed"],
    ["fixtureServerCreated", context.fixtureServerName, "fixture_server_teardown_failed"],
  ]) {
    if (context[createdKey]) {
      try {
        runDocker(["rm", "--force", containerName], 30_000, failureCode);
        context[createdKey] = false;
      } catch (error) {
        failure ??= error;
        bestEffortDocker(["rm", "--force", containerName]);
      }
    } else {
      bestEffortDocker(["rm", "--force", containerName]);
    }
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
  const context = await prepareContext();
  let report;
  let failure;
  try {
    await verifyTemporaryContext(context);
    await startFixture(context);
    report = await runFixture(context);
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
      error instanceof SeerrFixtureFailure ? error.code : "seerr_service_fixture_failed";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(candidateCode)
      ? candidateCode
      : "seerr_service_fixture_failed";
    if (options) {
      try {
        await writeReport(
          options.outputPath,
          validateSanitizedSeerrFailureReport({
            code,
            schemaVersion: 1,
            service: "seerr",
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
