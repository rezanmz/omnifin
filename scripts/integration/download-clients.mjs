#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  QBittorrentAdapter,
  isQBittorrentLoginResponseAccepted,
  readQBittorrentSessionCookie,
} from "../../packages/connectors/dist/adapters/qbittorrent.js";
import { SabnzbdAdapter } from "../../packages/connectors/dist/adapters/sabnzbd.js";
import {
  acquirePinnedDockerImage,
  DockerImagePullError,
  DOCKER_LOCAL_IMAGE_ARGUMENTS,
} from "./docker-runtime.mjs";
import { COMPATIBILITY_CHECKS } from "./compatibility-checks.mjs";
import { applyCompatibilityTargetOverride } from "./compatibility-targets.mjs";

const downloadClientTargets = applyCompatibilityTargetOverride({
  qbittorrent: {
    image:
      "ghcr.io/linuxserver/qbittorrent:5.2.0_v2.0.12-ls454@sha256:8bff8880f4e056c068ac6359de4cbcf44fb4811493cf15d83c1341fa05a515c0",
    version: "5.2.0",
  },
  sabnzbd: {
    image:
      "ghcr.io/linuxserver/sabnzbd:5.0.4-ls263@sha256:f12cb77b4e16d2d60fc8226e433daf69884e83874d90447c6ff1d57ef4247d6f",
    version: "5.0.4",
  },
});

export const DOWNLOAD_CLIENT_IMAGES = Object.freeze(
  Object.fromEntries(
    Object.entries(downloadClientTargets).map(([service, target]) => [service, target.image]),
  ),
);
const DOWNLOAD_CLIENT_VERSIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(downloadClientTargets).map(([service, target]) => [service, target.version]),
  ),
);

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const REQUEST_TIMEOUT_MS = 15_000;
const SERVER_READY_TIMEOUT_MS = 90_000;
const MUTATION_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const PRIVATE_IPV4_PATTERN = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u;
const SERVICES = ["qbittorrent", "sabnzbd"];
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
const QBITTORRENT_AUTH_DIAGNOSTIC_CODES = new Set([
  "authentication_cookie_invalid",
  "authentication_rejected",
  "upstream_rejected",
  "upstream_response_invalid",
  "upstream_unreachable",
]);

class DownloadFixtureFailure extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "DownloadFixtureFailure";
    this.code = code;
  }
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

export function validateSanitizedReport(report) {
  const expectedChecks = COMPATIBILITY_CHECKS[report?.service] ?? [];
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    sortedKeys(report).join(",") !== "checks,image,schemaVersion,serverVersion,service,status" ||
    report.schemaVersion !== 1 ||
    report.status !== "passed" ||
    !SERVICES.includes(report.service) ||
    report.image !== DOWNLOAD_CLIENT_IMAGES[report.service] ||
    report.serverVersion !== DOWNLOAD_CLIENT_VERSIONS[report.service] ||
    !report.checks ||
    typeof report.checks !== "object" ||
    Array.isArray(report.checks) ||
    sortedKeys(report.checks).join(",") !== [...expectedChecks].sort().join(",") ||
    expectedChecks.some((name) => report.checks[name] !== "passed") ||
    JSON.stringify(report).length > 4_096
  ) {
    throw new DownloadFixtureFailure("report_invalid");
  }
  return structuredClone(report);
}

export function validateSanitizedFailureReport(report) {
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
    throw new DownloadFixtureFailure("failure_report_invalid");
  }
  return structuredClone(report);
}

function bencode(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.byteLength}:`), value]);
  }
  if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
  if (Number.isSafeInteger(value) && value >= 0) return Buffer.from(`i${value}e`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      Buffer.from(left).compare(Buffer.from(right)),
    );
    return Buffer.concat([
      Buffer.from("d"),
      ...entries.flatMap(([key, entry]) => [bencode(key), bencode(entry)]),
      Buffer.from("e"),
    ]);
  }
  throw new DownloadFixtureFailure("torrent_fixture_invalid");
}

export function createQBittorrentFixture(kind = "primary") {
  if (kind !== "primary" && kind !== "anchor") {
    throw new DownloadFixtureFailure("torrent_fixture_invalid");
  }
  const fileName = kind === "primary" ? "Omnifin Fixture.bin" : "Omnifin Queue Anchor.bin";
  const payload = Buffer.from(
    kind === "primary"
      ? "Omnifin deterministic download-client fixture 1\n"
      : "Omnifin deterministic download-client queue anchor\n",
    "utf8",
  );
  const info = bencode({
    length: payload.byteLength,
    name: fileName,
    "piece length": 16_384,
    pieces: createHash("sha1").update(payload).digest(),
  });
  const torrent = Buffer.concat([
    Buffer.from("d8:announce"),
    bencode("http://127.0.0.1:1/announce"),
    Buffer.from("4:info"),
    info,
    Buffer.from("e"),
  ]);
  return {
    fileName,
    infoHash: createHash("sha1").update(info).digest("hex"),
    payload,
    torrent,
  };
}

export function createQBittorrentAuthenticationFixture(
  password = randomBytes(24).toString("base64url"),
  salt = randomBytes(16),
) {
  if (
    !/^[A-Za-z0-9._~-]{16,128}$/u.test(password) ||
    !Buffer.isBuffer(salt) ||
    salt.length !== 16
  ) {
    throw new DownloadFixtureFailure("credential_fixture_invalid");
  }
  const username = "omnifin-fixture";
  const passwordHash = pbkdf2Sync(password, salt, 100_000, 64, "sha512");
  const encodedHash = `${salt.toString("base64")}:${passwordHash.toString("base64")}`;
  return {
    configuration: `[LegalNotice]\nAccepted=true\n\n[Preferences]\nWebUI\\Password_PBKDF2="@ByteArray(${encodedHash})"\nWebUI\\Username=${username}\n`,
    password,
    username,
  };
}

export function validateQBittorrentAddResponse(status, body, expectedInfoHash) {
  if (
    !/^[a-f0-9]{40}$/u.test(expectedInfoHash) ||
    typeof body !== "string" ||
    body.length > 4_096
  ) {
    return false;
  }
  if (status === 200 && body.trim() === "Ok.") return true;
  if (status !== 200) return false;
  let response;
  try {
    response = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    sortedKeys(response).join(",") ===
      "added_torrent_ids,failure_count,pending_count,success_count" &&
    response.failure_count === 0 &&
    response.pending_count === 0 &&
    response.success_count === 1 &&
    Array.isArray(response.added_torrent_ids) &&
    response.added_torrent_ids.length === 1 &&
    response.added_torrent_ids[0] === expectedInfoHash
  );
}

export function readSabnzbdApiKey(configuration) {
  if (typeof configuration !== "string" || configuration.length > 2 * 1_024 * 1_024) {
    throw new DownloadFixtureFailure("credential_config_invalid");
  }
  const matches = [...configuration.matchAll(/^api_key\s*=\s*([a-f0-9]{32})\s*$/gimu)].map(
    (match) => match[1]?.toLowerCase(),
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new DownloadFixtureFailure("credential_config_invalid");
  }
  return matches[0];
}

export function parseContainerState(output) {
  const state = typeof output === "string" ? output.trim() : "";
  if (state === "true:0") return true;
  if (/^false:\d{1,3}$/u.test(state)) {
    throw new DownloadFixtureFailure("container_exited");
  }
  throw new DownloadFixtureFailure("container_state_invalid");
}

export function parseContainerAddress(output) {
  const address = typeof output === "string" ? output.trim() : "";
  if (isIP(address) !== 4 || !PRIVATE_IPV4_PATTERN.test(address)) {
    throw new DownloadFixtureFailure("container_address_invalid");
  }
  return address;
}

function repositoryPath(candidate) {
  const path = resolve(REPOSITORY_ROOT, candidate);
  const relativePath = relative(REPOSITORY_ROOT, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DownloadFixtureFailure("path_invalid");
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
    throw new DownloadFixtureFailure("usage_invalid");
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
    throw new DownloadFixtureFailure(failureCode, { cause: execution.error });
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

async function boundedResponse(response) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new DownloadFixtureFailure("upstream_response_invalid");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new DownloadFixtureFailure("upstream_response_invalid");
  }
  return new TextDecoder().decode(bytes);
}

async function directRequest(baseUrl, path, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      body: options.body,
      headers: options.headers,
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DownloadFixtureFailure("upstream_unreachable", { cause: error });
  }
  const body = await boundedResponse(response);
  if (!response.ok) throw new DownloadFixtureFailure("upstream_rejected");
  return { body, headers: response.headers, status: response.status };
}

async function directJson(baseUrl, path, options) {
  const response = await directRequest(baseUrl, path, options);
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new DownloadFixtureFailure("upstream_response_invalid", { cause: error });
  }
}

async function waitForResult(
  operation,
  timeoutMs = SERVER_READY_TIMEOUT_MS,
  timeoutCode = "server_start_timeout",
  retainedFailureCodes,
) {
  const deadline = Date.now() + timeoutMs;
  let retainedFailure;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== null && result !== false) return result;
    } catch (error) {
      // The disposable upstream may reject requests while first-run setup is still in progress.
      if (error instanceof DownloadFixtureFailure && retainedFailureCodes?.has(error.code)) {
        retainedFailure = error;
      }
    }
    await sleep(500);
  }
  if (retainedFailure) throw retainedFailure;
  throw new DownloadFixtureFailure(timeoutCode);
}

export function containerIsolationArguments(uid, gid) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new DownloadFixtureFailure("host_identity_unavailable");
  }
  return [
    "--user",
    `${uid}:${gid}`,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    `/run:uid=${uid},gid=${gid},exec`,
  ];
}

export function serviceEnvironmentArguments(service) {
  if (!SERVICES.includes(service)) throw new DownloadFixtureFailure("service_invalid");
  return service === "qbittorrent"
    ? ["--env", "WEBUI_PORT=8080", "--env", "TORRENTING_PORT=6881"]
    : [];
}

function commonContainerArguments(context, image) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return [
    "run",
    ...DOCKER_LOCAL_IMAGE_ARGUMENTS,
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
    ...serviceEnvironmentArguments(context.service),
    "--mount",
    `type=bind,src=${context.configDirectory},dst=/config`,
    ...context.mounts,
    image,
  ];
}

async function startContainer(context) {
  try {
    await acquirePinnedDockerImage(DOWNLOAD_CLIENT_IMAGES[context.service]);
  } catch (error) {
    if (error instanceof DockerImagePullError) {
      throw new DownloadFixtureFailure(error.code);
    }
    throw error;
  }
  runDocker(
    ["network", "create", "--driver", "bridge", "--internal", context.networkName],
    30_000,
    "network_create_failed",
  );
  context.networkCreated = true;
  runDocker(
    commonContainerArguments(context, DOWNLOAD_CLIENT_IMAGES[context.service]),
    180_000,
    "container_start_failed",
  );
  parseContainerState(
    runDocker(
      ["inspect", "--format", "{{.State.Running}}:{{.State.ExitCode}}", context.containerName],
      30_000,
      "container_state_failed",
    ),
  );
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
  const url = new URL(`http://${address}:8080/`);
  return {
    connectorUrl: url,
    directUrl: url,
  };
}

async function prepareContext(service) {
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), `omnifin-${service}-fixture-`)),
  );
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const context = {
    configDirectory: resolve(temporaryDirectory, "config"),
    containerName: `omnifin-${service}-${suffix}`,
    mounts: [],
    networkCreated: false,
    networkName: `omnifin-${service}-network-${suffix}`,
    service,
    temporaryDirectory,
  };
  await mkdir(context.configDirectory, { mode: 0o700 });
  if (service === "qbittorrent") {
    const authentication = createQBittorrentAuthenticationFixture();
    const qbittorrentConfigDirectory = resolve(context.configDirectory, "qBittorrent");
    context.downloadDirectory = resolve(temporaryDirectory, "downloads");
    context.qbittorrentCredentials = {
      password: authentication.password,
      username: authentication.username,
    };
    await Promise.all([
      mkdir(context.downloadDirectory, { mode: 0o700 }),
      mkdir(qbittorrentConfigDirectory, { mode: 0o700 }),
    ]);
    await writeFile(
      resolve(qbittorrentConfigDirectory, "qBittorrent.conf"),
      authentication.configuration,
      { flag: "wx", mode: 0o600 },
    );
    context.mounts.push("--mount", `type=bind,src=${context.downloadDirectory},dst=/downloads`);
  } else {
    context.downloadDirectory = resolve(temporaryDirectory, "downloads");
    context.incompleteDirectory = resolve(temporaryDirectory, "incomplete-downloads");
    await Promise.all([
      mkdir(context.downloadDirectory, { mode: 0o700 }),
      mkdir(context.incompleteDirectory, { mode: 0o700 }),
    ]);
    context.mounts.push(
      "--mount",
      `type=bind,src=${context.downloadDirectory},dst=/downloads`,
      "--mount",
      `type=bind,src=${context.incompleteDirectory},dst=/incomplete-downloads`,
    );
  }
  return context;
}

function connectorFailureCode(stage, error) {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(stage)) {
    throw new DownloadFixtureFailure("diagnostic_stage_invalid");
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
    throw new DownloadFixtureFailure(connectorFailureCode(stage, error), { cause: error });
  }
}

function assertHealthy(health) {
  if (health.status !== "healthy" || !health.version) {
    throw new DownloadFixtureFailure("authentication_invalid");
  }
  return health.version.replace(/^v/u, "");
}

async function waitForQueueItem(adapter, externalId, predicate) {
  return waitForResult(
    async () => {
      const queue = await connectorOperation("queue_read", () => adapter.readDownloadQueue());
      const item = queue.items.find((candidate) => candidate.externalId === externalId);
      return predicate(item) ? { item, queue } : null;
    },
    MUTATION_TIMEOUT_MS,
    "queue_state_timeout",
  );
}

async function verifyCoordinatedPauseResume(adapter, externalIds) {
  if (
    !Array.isArray(externalIds) ||
    externalIds.length !== 2 ||
    externalIds.some((externalId) => typeof externalId !== "string" || externalId.length === 0) ||
    new Set(externalIds).size !== externalIds.length
  ) {
    throw new DownloadFixtureFailure("coordinated_targets_invalid");
  }
  await connectorOperation("coordinated_resume", () =>
    Promise.all(
      externalIds.map((externalId) =>
        adapter.updateDownloadQueueItem({ action: "resume", externalId }),
      ),
    ),
  );
  await Promise.all(
    externalIds.map((externalId) =>
      waitForQueueItem(
        adapter,
        externalId,
        (item) => item !== undefined && item.state !== "paused",
      ),
    ),
  );
  await connectorOperation("coordinated_pause", () =>
    Promise.all(
      externalIds.map((externalId) =>
        adapter.updateDownloadQueueItem({ action: "pause", externalId }),
      ),
    ),
  );
  await Promise.all(
    externalIds.map((externalId) =>
      waitForQueueItem(adapter, externalId, (item) => item?.state === "paused"),
    ),
  );
}

async function qbittorrentLogin(baseUrl, credentials) {
  const form = new URLSearchParams(credentials);
  const response = await directRequest(baseUrl, "api/v2/auth/login", {
    body: form,
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin: baseUrl.origin,
      referer: `${baseUrl.origin}/`,
    },
    method: "POST",
  });
  const cookie = readQBittorrentSessionCookie(response.headers.get("set-cookie"));
  if (!isQBittorrentLoginResponseAccepted(response.status, response.body)) {
    throw new DownloadFixtureFailure("authentication_rejected");
  }
  if (!cookie) throw new DownloadFixtureFailure("authentication_cookie_invalid");
  return cookie;
}

async function seedQBittorrent(baseUrl, cookie, fixture) {
  const form = new FormData();
  form.append("autoTMM", "false");
  form.append("root_folder", "false");
  form.append("savepath", "/downloads");
  form.append("stopped", "true");
  form.append(
    "torrents",
    new Blob([fixture.torrent], { type: "application/x-bittorrent" }),
    "fixture.torrent",
  );
  const response = await directRequest(baseUrl, "api/v2/torrents/add", {
    body: form,
    headers: {
      cookie,
      origin: baseUrl.origin,
      referer: `${baseUrl.origin}/`,
    },
    method: "POST",
  });
  if (!validateQBittorrentAddResponse(response.status, response.body, fixture.infoHash)) {
    throw new DownloadFixtureFailure("queue_seed_invalid");
  }
}

async function enableQBittorrentQueueing(baseUrl, cookie) {
  await directRequest(baseUrl, "api/v2/app/setPreferences", {
    body: new URLSearchParams({ json: JSON.stringify({ queueing_enabled: true }) }),
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      cookie,
      origin: baseUrl.origin,
      referer: `${baseUrl.origin}/`,
    },
    method: "POST",
  });
}

function qbittorrentAdapter(server, credentials) {
  return new QBittorrentAdapter({
    baseUrl: server.connectorUrl.href,
    connectorId: "qbittorrent-fixture",
    displayName: "qBittorrent fixture",
    insecureHttpApproved: true,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    password: credentials.password,
    timeoutMs: REQUEST_TIMEOUT_MS,
    username: credentials.username,
  });
}

async function runQBittorrent(context, server) {
  const credentials = context.qbittorrentCredentials;
  if (!credentials) throw new DownloadFixtureFailure("credential_fixture_invalid");
  const cookie = await waitForResult(
    () => qbittorrentLogin(server.directUrl, credentials),
    SERVER_READY_TIMEOUT_MS,
    "authentication_start_timeout",
    QBITTORRENT_AUTH_DIAGNOSTIC_CODES,
  );
  await enableQBittorrentQueueing(server.directUrl, cookie);
  const fixture = createQBittorrentFixture();
  const queueAnchor = createQBittorrentFixture("anchor");
  const preservedBytes = Buffer.alloc(fixture.payload.byteLength, 0x5a);
  const preservedPath = resolve(context.downloadDirectory, fixture.fileName);
  await writeFile(preservedPath, preservedBytes, { flag: "wx", mode: 0o600 });
  await seedQBittorrent(server.directUrl, cookie, queueAnchor);
  await seedQBittorrent(server.directUrl, cookie, fixture);

  const adapter = qbittorrentAdapter(server, credentials);
  const health = await connectorOperation("authentication", () => adapter.probe());
  const version = assertHealthy(health);
  if (version !== DOWNLOAD_CLIENT_VERSIONS.qbittorrent) {
    throw new DownloadFixtureFailure("server_version_invalid");
  }
  await waitForQueueItem(
    adapter,
    fixture.infoHash,
    (item) => item !== undefined && item.queuePosition !== null && item.queuePosition > 0,
  );

  await connectorOperation("exact_promotion", () =>
    adapter.promoteDownloadQueueItem({ externalId: fixture.infoHash }),
  );
  await waitForQueueItem(adapter, fixture.infoHash, (item) => item?.queuePosition === 0);

  await connectorOperation("exact_resume", () =>
    adapter.updateDownloadQueueItem({ action: "resume", externalId: fixture.infoHash }),
  );
  await waitForQueueItem(
    adapter,
    fixture.infoHash,
    (item) => item !== undefined && item.state !== "paused",
  );
  await connectorOperation("exact_pause", () =>
    adapter.updateDownloadQueueItem({ action: "pause", externalId: fixture.infoHash }),
  );
  await waitForQueueItem(adapter, fixture.infoHash, (item) => item?.state === "paused");
  await verifyCoordinatedPauseResume(adapter, [fixture.infoHash, queueAnchor.infoHash]);

  const rejected = await qbittorrentAdapter(server, {
    ...credentials,
    password: `${credentials.password}-wrong`,
  }).probe();
  if (rejected.status !== "misconfigured" || rejected.failure?.code !== "invalid_credentials") {
    throw new DownloadFixtureFailure("credential_rejection_invalid");
  }

  await connectorOperation("preserve_files_removal", () =>
    adapter.removeDownloadQueueItem({ externalId: fixture.infoHash }),
  );
  await waitForQueueItem(adapter, fixture.infoHash, (item) => item === undefined);
  if (!(await readFile(preservedPath)).equals(preservedBytes)) {
    throw new DownloadFixtureFailure("preserved_content_invalid");
  }

  return validateSanitizedReport({
    checks: Object.fromEntries(COMPATIBILITY_CHECKS.qbittorrent.map((name) => [name, "passed"])),
    image: DOWNLOAD_CLIENT_IMAGES.qbittorrent,
    schemaVersion: 1,
    serverVersion: version,
    service: "qbittorrent",
    status: "passed",
  });
}

function sabnzbdNzb(kind) {
  if (kind !== "primary" && kind !== "anchor") {
    throw new DownloadFixtureFailure("nzb_fixture_invalid");
  }
  const suffix = kind === "primary" ? "primary" : "anchor";
  const subject = kind === "primary" ? "Omnifin Fixture.bin" : "Omnifin Queue Anchor.bin";
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="category">movies</meta></head>
  <file poster="fixture@omnifin.invalid" date="1774648200" subject="&quot;${subject}&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="48" number="1">fixture-${suffix}@omnifin.invalid</segment></segments>
  </file>
</nzb>
`);
}

async function seedSabnzbd(baseUrl, apiKey, kind) {
  const form = new FormData();
  form.append("apikey", apiKey);
  form.append("mode", "addfile");
  form.append(
    "nzbfile",
    new Blob([sabnzbdNzb(kind)], { type: "application/x-nzb" }),
    `${kind}.nzb`,
  );
  form.append("output", "json");
  const response = await directJson(baseUrl, "api", { body: form, method: "POST" });
  const ids = response?.nzo_ids;
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string") {
    throw new DownloadFixtureFailure("queue_seed_invalid");
  }
  return ids[0];
}

function sabnzbdAdapter(server, apiKey) {
  return new SabnzbdAdapter({
    apiKey,
    baseUrl: server.connectorUrl.href,
    connectorId: "sabnzbd-fixture",
    displayName: "SABnzbd fixture",
    insecureHttpApproved: true,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

async function runSabnzbd(context, server) {
  await waitForResult(
    async () => {
      const version = await directJson(server.directUrl, "api?mode=version&output=json");
      return typeof version?.version === "string" ? version.version : null;
    },
    SERVER_READY_TIMEOUT_MS,
    "service_start_timeout",
  );
  const apiKey = await waitForResult(
    async () =>
      readSabnzbdApiKey(await readFile(resolve(context.configDirectory, "sabnzbd.ini"), "utf8")),
    SERVER_READY_TIMEOUT_MS,
    "credential_config_timeout",
  );
  const anchorExternalId = await seedSabnzbd(server.directUrl, apiKey, "anchor");
  const externalId = await seedSabnzbd(server.directUrl, apiKey, "primary");
  const adapter = sabnzbdAdapter(server, apiKey);
  const health = await connectorOperation("authentication", () => adapter.probe());
  const version = assertHealthy(health);
  if (version !== DOWNLOAD_CLIENT_VERSIONS.sabnzbd) {
    throw new DownloadFixtureFailure("server_version_invalid");
  }
  await waitForQueueItem(
    adapter,
    externalId,
    (item) => item !== undefined && item.queuePosition > 0,
  );

  await connectorOperation("exact_promotion", () =>
    adapter.promoteDownloadQueueItem({ externalId }),
  );
  await waitForQueueItem(adapter, externalId, (item) => item?.queuePosition === 0);

  await connectorOperation("exact_pause", () =>
    adapter.updateDownloadQueueItem({ action: "pause", externalId }),
  );
  await waitForQueueItem(adapter, externalId, (item) => item?.state === "paused");
  await verifyCoordinatedPauseResume(adapter, [externalId, anchorExternalId]);
  await connectorOperation("exact_resume", () =>
    adapter.updateDownloadQueueItem({ action: "resume", externalId }),
  );
  await waitForQueueItem(
    adapter,
    externalId,
    (item) => item !== undefined && item.state !== "paused",
  );
  await connectorOperation("exact_pause", () =>
    adapter.updateDownloadQueueItem({ action: "pause", externalId }),
  );
  await waitForQueueItem(adapter, externalId, (item) => item?.state === "paused");

  const invalidApiKey = `${apiKey.startsWith("0") ? "1" : "0"}${apiKey.slice(1)}`;
  const rejected = await sabnzbdAdapter(server, invalidApiKey)
    .readDownloadQueue()
    .then(
      () => false,
      (error) =>
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "invalid_credentials",
    );
  if (!rejected) throw new DownloadFixtureFailure("credential_rejection_invalid");

  const preservedBytes = Buffer.from("Omnifin content-preservation marker\n", "utf8");
  const preservedPath = resolve(context.downloadDirectory, "fixture-preserved.bin");
  await writeFile(preservedPath, preservedBytes, { flag: "wx", mode: 0o600 });
  await connectorOperation("preserve_files_removal", () =>
    adapter.removeDownloadQueueItem({ externalId }),
  );
  await waitForQueueItem(adapter, externalId, (item) => item === undefined);
  if (!(await readFile(preservedPath)).equals(preservedBytes)) {
    throw new DownloadFixtureFailure("preserved_content_invalid");
  }

  return validateSanitizedReport({
    checks: Object.fromEntries(COMPATIBILITY_CHECKS.sabnzbd.map((name) => [name, "passed"])),
    image: DOWNLOAD_CLIENT_IMAGES.sabnzbd,
    schemaVersion: 1,
    serverVersion: version,
    service: "sabnzbd",
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
    throw new DownloadFixtureFailure("path_invalid");
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
  const size = (await stat(context.temporaryDirectory)).size;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !Number.isSafeInteger(size)) {
    throw new DownloadFixtureFailure("temporary_directory_invalid");
  }
}

async function main(options) {
  const context = await prepareContext(options.service);
  try {
    await verifyTemporaryContext(context);
    const server = await startContainer(context);
    const report =
      options.service === "qbittorrent"
        ? await runQBittorrent(context, server)
        : await runSabnzbd(context, server);
    await writeReport(options.outputPath, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    bestEffortDocker(["stop", "--time", "15", context.containerName]);
    bestEffortDocker(["rm", "--force", context.containerName]);
    if (context.networkCreated) {
      bestEffortDocker(["network", "rm", context.networkName]);
      context.networkCreated = false;
    }
    await rm(context.temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    await main(options);
  } catch (error) {
    const candidateCode =
      error instanceof DownloadFixtureFailure ? error.code : "download_client_fixture_failed";
    const code = /^[a-z][a-z0-9_]{0,63}$/u.test(candidateCode)
      ? candidateCode
      : "download_client_fixture_failed";
    if (options) {
      try {
        await writeReport(
          options.outputPath,
          validateSanitizedFailureReport({
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
