#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { QBittorrentAdapter } from "../../packages/connectors/dist/adapters/qbittorrent.js";
import { SabnzbdAdapter } from "../../packages/connectors/dist/adapters/sabnzbd.js";

export const DOWNLOAD_CLIENT_IMAGES = Object.freeze({
  qbittorrent:
    "ghcr.io/linuxserver/qbittorrent:5.2.0_v2.0.12-ls454@sha256:8bff8880f4e056c068ac6359de4cbcf44fb4811493cf15d83c1341fa05a515c0",
  sabnzbd:
    "ghcr.io/linuxserver/sabnzbd:5.0.4-ls263@sha256:f12cb77b4e16d2d60fc8226e433daf69884e83874d90447c6ff1d57ef4247d6f",
});
const DOWNLOAD_CLIENT_VERSIONS = Object.freeze({
  qbittorrent: "5.2.0",
  sabnzbd: "5.0.4",
});

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
const CHECK_NAMES = [
  "authentication",
  "credentialRejection",
  "exactPause",
  "exactResume",
  "preserveFilesRemoval",
  "queueRead",
];

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
    sortedKeys(report.checks).join(",") !== [...CHECK_NAMES].sort().join(",") ||
    CHECK_NAMES.some((name) => report.checks[name] !== "passed") ||
    JSON.stringify(report).length > 4_096
  ) {
    throw new DownloadFixtureFailure("report_invalid");
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

export function createQBittorrentFixture() {
  const fileName = "Omnifin Fixture.bin";
  const payload = Buffer.from("Omnifin deterministic download-client fixture 1\n", "utf8");
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

export function readQBittorrentTemporaryPassword(logs) {
  if (typeof logs !== "string" || logs.length > 2 * 1_024 * 1_024) {
    throw new DownloadFixtureFailure("credential_log_invalid");
  }
  const matches = [
    ...logs.matchAll(
      /temporary password is provided for this session:\s*([^\s\p{Cc}\p{Cf}]{8,128})/giu,
    ),
  ].map((match) => match[1]);
  if (matches.length !== 1 || !matches[0]) {
    throw new DownloadFixtureFailure("credential_log_invalid");
  }
  return matches[0];
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

export function parsePublishedPort(output) {
  if (typeof output !== "string" || output.length > 16_384) {
    throw new DownloadFixtureFailure("container_port_invalid");
  }
  const ports = new Set(
    [...output.matchAll(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d{1,5})/gu)].map((match) =>
      Number(match[1]),
    ),
  );
  const [port] = ports;
  if (ports.size !== 1 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DownloadFixtureFailure("container_port_invalid");
  }
  return port;
}

export function selectConnectorAddress(interfaces = networkInterfaces()) {
  const candidates = Object.values(interfaces)
    .flat()
    .filter(
      (entry) =>
        entry &&
        entry.family === "IPv4" &&
        !entry.internal &&
        PRIVATE_IPV4_PATTERN.test(entry.address),
    )
    .map((entry) => entry.address)
    .sort();
  if (!candidates[0]) throw new DownloadFixtureFailure("connector_address_unavailable");
  return candidates[0];
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

async function waitForResult(operation, timeoutMs = SERVER_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== null && result !== false) return result;
    } catch {
      // The disposable upstream may reject requests while first-run setup is still in progress.
    }
    await sleep(500);
  }
  throw new DownloadFixtureFailure("server_start_timeout");
}

function publishedPort(containerName, internalPort) {
  return parsePublishedPort(
    runDocker(["port", containerName, `${internalPort}/tcp`], 30_000, "container_port_failed"),
  );
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
    "--tmpfs",
    `/run:uid=${uid},gid=${gid},exec`,
  ];
}

function commonContainerArguments(context, internalPort, image) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return [
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
    "--publish",
    `0.0.0.0::${internalPort}`,
    "--env",
    "TZ=Etc/UTC",
    "--env",
    "UMASK=077",
    "--env",
    "DOCKER_MODS=",
    "--mount",
    `type=bind,src=${context.configDirectory},dst=/config`,
    ...context.mounts,
    image,
  ];
}

function startContainer(context) {
  runDocker(
    ["network", "create", "--driver", "bridge", "--internal", context.networkName],
    30_000,
    "network_create_failed",
  );
  context.networkCreated = true;
  const internalPort = context.service === "qbittorrent" ? 8080 : 8080;
  runDocker(
    commonContainerArguments(context, internalPort, DOWNLOAD_CLIENT_IMAGES[context.service]),
    180_000,
    "container_start_failed",
  );
  const port = publishedPort(context.containerName, internalPort);
  return {
    connectorUrl: new URL(`http://${context.connectorAddress}:${port}/`),
    loopbackUrl: new URL(`http://127.0.0.1:${port}/`),
  };
}

async function prepareContext(service) {
  const connectorAddress = selectConnectorAddress();
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), `omnifin-${service}-fixture-`)),
  );
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const context = {
    configDirectory: resolve(temporaryDirectory, "config"),
    connectorAddress,
    containerName: `omnifin-${service}-${suffix}`,
    mounts: [],
    networkCreated: false,
    networkName: `omnifin-${service}-network-${suffix}`,
    service,
    temporaryDirectory,
  };
  await mkdir(context.configDirectory, { mode: 0o700 });
  if (service === "qbittorrent") {
    context.downloadDirectory = resolve(temporaryDirectory, "downloads");
    await mkdir(context.downloadDirectory, { mode: 0o700 });
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
  return waitForResult(async () => {
    const queue = await connectorOperation("queue_read", () => adapter.readDownloadQueue());
    const item = queue.items.find((candidate) => candidate.externalId === externalId);
    return predicate(item) ? { item, queue } : null;
  }, MUTATION_TIMEOUT_MS);
}

async function qbittorrentLogin(baseUrl, password) {
  const form = new URLSearchParams({ password, username: "admin" });
  const response = await directRequest(baseUrl, "api/v2/auth/login", {
    body: form,
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin: baseUrl.origin,
      referer: `${baseUrl.origin}/`,
    },
    method: "POST",
  });
  const sessionId = response.headers.get("set-cookie")?.match(/(?:^|;\s*)SID=([^;]+)/iu)?.[1];
  if (
    response.body.trim() !== "Ok." ||
    !sessionId ||
    !/^[A-Za-z0-9._~-]{1,512}$/u.test(sessionId)
  ) {
    throw new DownloadFixtureFailure("authentication_invalid");
  }
  return `SID=${sessionId}`;
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
  if (response.body.trim() !== "Ok.") throw new DownloadFixtureFailure("queue_seed_invalid");
}

function qbittorrentAdapter(server, password) {
  return new QBittorrentAdapter({
    baseUrl: server.connectorUrl.href,
    connectorId: "qbittorrent-fixture",
    displayName: "qBittorrent fixture",
    insecureHttpApproved: true,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    password,
    timeoutMs: REQUEST_TIMEOUT_MS,
    username: "admin",
  });
}

async function runQBittorrent(context, server) {
  const password = await waitForResult(async () =>
    readQBittorrentTemporaryPassword(
      runDocker(["logs", context.containerName], 30_000, "container_logs_failed"),
    ),
  );
  const cookie = await waitForResult(() => qbittorrentLogin(server.loopbackUrl, password));
  const fixture = createQBittorrentFixture();
  const preservedBytes = Buffer.alloc(fixture.payload.byteLength, 0x5a);
  const preservedPath = resolve(context.downloadDirectory, fixture.fileName);
  await writeFile(preservedPath, preservedBytes, { flag: "wx", mode: 0o600 });
  await seedQBittorrent(server.loopbackUrl, cookie, fixture);

  const adapter = qbittorrentAdapter(server, password);
  const health = await connectorOperation("authentication", () => adapter.probe());
  const version = assertHealthy(health);
  if (version !== DOWNLOAD_CLIENT_VERSIONS.qbittorrent) {
    throw new DownloadFixtureFailure("server_version_invalid");
  }
  await waitForQueueItem(adapter, fixture.infoHash, (item) => item !== undefined);

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

  const rejected = await qbittorrentAdapter(server, `${password}-wrong`).probe();
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
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, "passed"])),
    image: DOWNLOAD_CLIENT_IMAGES.qbittorrent,
    schemaVersion: 1,
    serverVersion: version,
    service: "qbittorrent",
    status: "passed",
  });
}

function sabnzbdNzb() {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="category">movies</meta></head>
  <file poster="fixture@omnifin.invalid" date="1774648200" subject="&quot;Omnifin Fixture.bin&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="48" number="1">fixture-part@omnifin.invalid</segment></segments>
  </file>
</nzb>
`);
}

async function seedSabnzbd(baseUrl, apiKey) {
  const form = new FormData();
  form.append("apikey", apiKey);
  form.append("mode", "addfile");
  form.append("nzbfile", new Blob([sabnzbdNzb()], { type: "application/x-nzb" }), "fixture.nzb");
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
  await waitForResult(async () => {
    const version = await directJson(server.loopbackUrl, "api?mode=version&output=json");
    return typeof version?.version === "string" ? version.version : null;
  });
  const apiKey = await waitForResult(async () =>
    readSabnzbdApiKey(await readFile(resolve(context.configDirectory, "sabnzbd.ini"), "utf8")),
  );
  const externalId = await seedSabnzbd(server.loopbackUrl, apiKey);
  const adapter = sabnzbdAdapter(server, apiKey);
  const health = await connectorOperation("authentication", () => adapter.probe());
  const version = assertHealthy(health);
  if (version !== DOWNLOAD_CLIENT_VERSIONS.sabnzbd) {
    throw new DownloadFixtureFailure("server_version_invalid");
  }
  await waitForQueueItem(adapter, externalId, (item) => item !== undefined);

  await connectorOperation("exact_pause", () =>
    adapter.updateDownloadQueueItem({ action: "pause", externalId }),
  );
  await waitForQueueItem(adapter, externalId, (item) => item?.state === "paused");
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
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, "passed"])),
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
    const server = startContainer(context);
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
  try {
    await main(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const code =
      error instanceof DownloadFixtureFailure ? error.code : "download_client_fixture_failed";
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 1;
  }
}
