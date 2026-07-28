#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { JellyfinPlaybackClient } from "../../../packages/connectors/dist/media/jellyfin-playback-client.js";

import { JELLYFIN_FIXTURE_IMAGE } from "../../media/playback-fixture.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const MAX_JSON_BYTES = 4 * 1_024 * 1_024;
const MAX_SEGMENT_BYTES = 8 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 20_000;
const SERVER_READY_TIMEOUT_MS = 90_000;
const LIBRARY_READY_TIMEOUT_MS = 60_000;
const TICKS_PER_SECOND = 10_000_000;
const IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/u;
const PRIVATE_IPV4_PATTERN = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u;

class JellyfinFixtureFailure extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "JellyfinFixtureFailure";
    this.code = code;
  }
}

export function hostContainerUser(uid, gid) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new JellyfinFixtureFailure("host_identity_unavailable");
  }
  return `${uid}:${gid}`;
}

function parseArguments(arguments_) {
  const fixtureIndex = arguments_.indexOf("--fixture");
  const outputIndex = arguments_.indexOf("--output");
  if (
    arguments_.length !== 4 ||
    fixtureIndex < 0 ||
    outputIndex < 0 ||
    !arguments_[fixtureIndex + 1] ||
    !arguments_[outputIndex + 1]
  ) {
    throw new JellyfinFixtureFailure("usage_invalid");
  }
  return {
    fixturePath: repositoryPath(arguments_[fixtureIndex + 1]),
    outputPath: repositoryPath(arguments_[outputIndex + 1]),
  };
}

function repositoryPath(candidate) {
  const path = resolve(REPOSITORY_ROOT, candidate);
  const relativePath = relative(REPOSITORY_ROOT, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new JellyfinFixtureFailure("path_invalid");
  }
  return path;
}

function docker(arguments_, captureOutput = false) {
  try {
    return execFileSync("docker", arguments_, {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 2 * 1_024 * 1_024,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
      timeout: 180_000,
    });
  } catch (error) {
    throw new JellyfinFixtureFailure("container_failed", { cause: error });
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function responseBytes(response, maximumBytes = MAX_JSON_BYTES) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumBytes) throw new JellyfinFixtureFailure("response_invalid");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new JellyfinFixtureFailure("response_invalid");
  return bytes;
}

async function request(baseUrl, path, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        accept: options.accept ?? "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {}),
      },
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new JellyfinFixtureFailure("upstream_unreachable", { cause: error });
  }
  if (!response.ok) throw new JellyfinFixtureFailure("upstream_rejected");
  return { bytes: await responseBytes(response, options.maximumBytes), headers: response.headers };
}

async function requestJson(baseUrl, path, options) {
  const { bytes } = await request(baseUrl, path, options);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new JellyfinFixtureFailure("response_invalid", { cause: error });
  }
}

async function waitForHealthy(baseUrl) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { bytes } = await request(baseUrl, "health", {
        accept: "text/plain",
        maximumBytes: 128,
      });
      if (new TextDecoder().decode(bytes) === "Healthy") return;
    } catch {
      // Jellyfin returns transient 503 responses while migrations and startup tasks run.
    }
    await sleep(500);
  }
  throw new JellyfinFixtureFailure("server_start_timeout");
}

function publishedPort(containerName) {
  const output = docker(["port", containerName, "8096/tcp"], true);
  const match = output.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d{1,5})/u);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new JellyfinFixtureFailure("container_port_invalid");
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
  if (!candidates[0]) throw new JellyfinFixtureFailure("connector_address_unavailable");
  return candidates[0];
}

function startContainer(context) {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    context.containerName,
    "--user",
    context.containerUser,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "512",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
    "--publish",
    "0.0.0.0::8096",
    "--mount",
    `type=bind,src=${context.configDirectory},dst=/config`,
    "--mount",
    `type=bind,src=${context.cacheDirectory},dst=/cache`,
    "--mount",
    `type=bind,src=${context.mediaDirectory},dst=/media,readonly`,
    JELLYFIN_FIXTURE_IMAGE,
  ]);
  const port = publishedPort(context.containerName);
  return {
    connectorUrl: new URL(`http://${context.connectorAddress}:${port}/`),
    loopbackUrl: new URL(`http://127.0.0.1:${port}/`),
  };
}

function stopContainer(containerName) {
  try {
    execFileSync("docker", ["stop", "--time", "15", containerName], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 30_000,
    });
  } catch {
    // A failed or already-exited --rm container has no state left to preserve.
  }
}

async function authenticate(baseUrl, username, password, deviceId) {
  const authentication = await requestJson(baseUrl, "Users/AuthenticateByName", {
    body: { Pw: password, Username: username },
    headers: {
      authorization: `MediaBrowser Client="Omnifin", Device="Integration", DeviceId="${deviceId}", Version="0.1.0"`,
    },
    method: "POST",
  });
  const accessToken = authentication?.AccessToken;
  const userId = authentication?.User?.Id;
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 16 ||
    accessToken.length > 512 ||
    typeof userId !== "string" ||
    !IDENTIFIER_PATTERN.test(userId)
  ) {
    throw new JellyfinFixtureFailure("authentication_invalid");
  }
  return { accessToken, userId };
}

async function initializeServer(baseUrl, username, password, deviceId) {
  await request(baseUrl, "Startup/Configuration", {
    body: {
      MetadataCountryCode: "US",
      PreferredMetadataLanguage: "en",
      ServerName: "Omnifin fixture",
      UICulture: "en-US",
    },
    method: "POST",
  });
  await request(baseUrl, "Startup/User");
  await request(baseUrl, "Startup/User", {
    body: { Name: username, Password: password },
    method: "POST",
  });
  await request(baseUrl, "Startup/RemoteAccess", {
    body: { EnableAutomaticPortMapping: false, EnableRemoteAccess: false },
    method: "POST",
  });
  await request(baseUrl, "Startup/Complete", { method: "POST" });
  return authenticate(baseUrl, username, password, deviceId);
}

function tokenHeaders(accessToken) {
  return { "x-emby-token": accessToken };
}

async function configureFixtureServer(baseUrl, authentication) {
  const headers = tokenHeaders(authentication.accessToken);
  const configuration = await requestJson(baseUrl, "System/Configuration", { headers });
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new JellyfinFixtureFailure("server_configuration_invalid");
  }
  await request(baseUrl, "System/Configuration", {
    body: {
      ...configuration,
      MaxResumePct: 95,
      MinResumeDurationSeconds: 0,
      MinResumePct: 0,
    },
    headers,
    method: "POST",
  });
}

function validateImportedItem(item) {
  if (!item || typeof item !== "object" || !IDENTIFIER_PATTERN.test(item.Id)) {
    throw new JellyfinFixtureFailure("library_item_invalid");
  }
  const streams = Array.isArray(item.MediaStreams) ? item.MediaStreams : [];
  const video = streams.filter((stream) => stream.Type === "Video");
  const audio = streams.filter((stream) => stream.Type === "Audio");
  const subtitles = streams.filter((stream) => stream.Type === "Subtitle");
  if (
    video.length !== 1 ||
    video[0]?.Codec !== "h264" ||
    video[0]?.Width !== 640 ||
    video[0]?.Height !== 360 ||
    audio.map((stream) => stream.Language).join(",") !== "eng,fra" ||
    subtitles.map((stream) => stream.Language).join(",") !== "eng,fra"
  ) {
    throw new JellyfinFixtureFailure("library_streams_invalid");
  }
  return {
    audio,
    id: item.Id,
    subtitles,
  };
}

async function importFixture(baseUrl, authentication) {
  const headers = tokenHeaders(authentication.accessToken);
  const query = new URLSearchParams({
    collectionType: "movies",
    name: "Fixture",
    paths: "/media",
  });
  await request(baseUrl, `Library/VirtualFolders?${query}`, { headers, method: "POST" });
  await request(baseUrl, "Library/Refresh", { headers, method: "POST" });

  const deadline = Date.now() + LIBRARY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const itemQuery = new URLSearchParams({
      Fields: "MediaSources,MediaStreams,UserData",
      IncludeItemTypes: "Movie",
      Recursive: "true",
      UserId: authentication.userId,
    });
    const response = await requestJson(baseUrl, `Items?${itemQuery}`, { headers });
    if (Array.isArray(response?.Items) && response.Items[0]) {
      return validateImportedItem(response.Items[0]);
    }
    await sleep(500);
  }
  throw new JellyfinFixtureFailure("library_scan_timeout");
}

function trackIndex(tracks, language) {
  const index = tracks.find((track) => track.Language === language)?.Index;
  if (!Number.isInteger(index) || index < 0) {
    throw new JellyfinFixtureFailure("track_selection_invalid");
  }
  return index;
}

function playbackClient(context, server, accessToken, deviceId) {
  return new JellyfinPlaybackClient({
    accessToken,
    deviceId,
    metadata: { appVersion: "0.1.0" },
    target: {
      baseUrl: server.connectorUrl.href,
      connectorId: "jellyfin-fixture",
      displayName: "Jellyfin fixture",
      insecureHttpApproved: true,
      maxResponseBytes: MAX_JSON_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  });
}

async function readStream(stream, maximumBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new JellyfinFixtureFailure("stream_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function firstManifestUri(manifest) {
  const uri = manifest
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (!uri || uri.length > 16_384) throw new JellyfinFixtureFailure("manifest_invalid");
  return uri;
}

export function hlsSegmentFormat(bytes) {
  if (bytes.byteLength >= 1 && bytes[0] === 0x47) return "mpegts";
  if (bytes.byteLength >= 8) {
    const boxType = new TextDecoder().decode(bytes.subarray(4, 8));
    if (["ftyp", "styp", "moof"].includes(boxType)) return "fmp4";
  }
  throw new JellyfinFixtureFailure("hls_segment_invalid");
}

async function readFirstHlsSegment(client, initialTarget) {
  let target = initialTarget;
  for (let depth = 0; depth < 3; depth += 1) {
    const manifestResponse = await client.readPlaybackTarget({
      accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
      target,
    });
    const manifest = new TextDecoder().decode(manifestResponse.body);
    if (!manifest.startsWith("#EXTM3U")) throw new JellyfinFixtureFailure("manifest_invalid");
    const uri = firstManifestUri(manifest);
    const nextTarget = client.resolvePlaybackTarget(target, uri);
    if (/\.m3u8(?:$|\?)/iu.test(uri)) {
      target = nextTarget;
      continue;
    }
    const segment = await client.streamPlaybackTarget({
      accept: "video/mp2t, application/octet-stream, */*",
      maxResponseBytes: MAX_SEGMENT_BYTES,
      target: nextTarget,
    });
    const bytes = await readStream(segment.body, MAX_SEGMENT_BYTES);
    if (bytes.byteLength < 1_024) throw new JellyfinFixtureFailure("hls_segment_invalid");
    return {
      bytes: bytes.byteLength,
      format: hlsSegmentFormat(bytes),
      status: segment.status,
    };
  }
  throw new JellyfinFixtureFailure("manifest_invalid");
}

async function verifyPlayback(context, server, authentication, item) {
  const client = playbackClient(context, server, authentication.accessToken, context.deviceId);
  const frenchAudioIndex = trackIndex(item.audio, "fra");
  const englishSubtitleIndex = trackIndex(item.subtitles, "eng");
  const direct = await client.negotiate({
    audioStreamIndex: frenchAudioIndex,
    itemId: item.id,
    maxStreamingBitrate: 20_000_000,
    mode: "direct",
    positionSeconds: 0,
    subtitleStreamIndex: englishSubtitleIndex,
  });
  if (
    direct.delivery !== "direct" ||
    !direct.audioTracks.some((track) => track.language === "fra" && track.selected) ||
    !direct.subtitleTracks.some((track) => track.language === "eng" && track.selected)
  ) {
    throw new JellyfinFixtureFailure("direct_negotiation_invalid");
  }
  const range = await client.readPlaybackTarget({
    accept: "video/mp4, video/*",
    range: "bytes=0-4095",
    target: direct.upstreamTarget,
  });
  if (range.status !== 206 || range.body.byteLength !== 4_096) {
    throw new JellyfinFixtureFailure("direct_range_invalid");
  }

  const transcode = await client.negotiate({
    audioStreamIndex: frenchAudioIndex,
    itemId: item.id,
    maxStreamingBitrate: 500_000,
    mode: "transcode",
    positionSeconds: 4,
    subtitleStreamIndex: null,
  });
  if (
    transcode.delivery !== "hls" ||
    transcode.positionSeconds !== 4 ||
    !transcode.audioTracks.some((track) => track.language === "fra" && track.selected)
  ) {
    throw new JellyfinFixtureFailure("transcode_negotiation_invalid");
  }
  const hls = await readFirstHlsSegment(client, transcode.upstreamTarget);

  const reportingSession = {
    audioStreamIndex: frenchAudioIndex,
    itemId: item.id,
    mediaSourceId: direct.mediaSourceId,
    playMethod: direct.playMethod,
    playSessionId: direct.playSessionId,
    subtitleStreamIndex: englishSubtitleIndex,
  };
  await client.reportPlaybackEvent({
    event: "started",
    positionSeconds: 1,
    session: reportingSession,
  });
  await client.reportPlaybackEvent({
    event: "progress",
    positionSeconds: 5,
    session: reportingSession,
  });
  await client.reportPlaybackEvent({
    event: "stopped",
    positionSeconds: 6,
    session: reportingSession,
  });

  return {
    direct: { bytes: range.body.byteLength, status: range.status },
    hls,
    reportingSession,
    selectedAudio: "fra",
    selectedSubtitle: "eng",
    seekSeconds: transcode.positionSeconds,
  };
}

async function playbackPosition(baseUrl, authentication, itemId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const item = await requestJson(baseUrl, `Users/${authentication.userId}/Items/${itemId}`, {
      headers: tokenHeaders(authentication.accessToken),
    });
    const ticks = item?.UserData?.PlaybackPositionTicks;
    if (Number.isInteger(ticks) && ticks >= 5 * TICKS_PER_SECOND && ticks <= 7 * TICKS_PER_SECOND) {
      return Math.round(ticks / TICKS_PER_SECOND);
    }
    await sleep(250);
  }
  throw new JellyfinFixtureFailure("progress_invalid");
}

async function serverInfo(baseUrl) {
  const info = await requestJson(baseUrl, "System/Info/Public");
  if (info?.Version !== "10.11.11" || typeof info?.Id !== "string") {
    throw new JellyfinFixtureFailure("server_info_invalid");
  }
  return { id: info.Id, version: info.Version };
}

async function prepareContext(fixturePath) {
  const fixtureMetadata = await lstat(fixturePath);
  if (!fixtureMetadata.isFile() || fixtureMetadata.isSymbolicLink()) {
    throw new JellyfinFixtureFailure("fixture_invalid");
  }
  const fixtureSize = (await stat(fixturePath)).size;
  if (fixtureSize < 100_000 || fixtureSize > 12 * 1_024 * 1_024) {
    throw new JellyfinFixtureFailure("fixture_invalid");
  }
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "omnifin-jellyfin-playback-")),
  );
  const context = {
    cacheDirectory: resolve(temporaryDirectory, "cache"),
    configDirectory: resolve(temporaryDirectory, "config"),
    connectorAddress: selectConnectorAddress(),
    containerName: `omnifin-jellyfin-playback-${process.pid}-${randomBytes(4).toString("hex")}`,
    containerUser: hostContainerUser(process.getuid?.(), process.getgid?.()),
    deviceId: `omnifin-integration-${randomUUID()}`,
    mediaDirectory: resolve(temporaryDirectory, "media"),
    temporaryDirectory,
  };
  await Promise.all([
    mkdir(context.cacheDirectory, { mode: 0o700 }),
    mkdir(context.configDirectory, { mode: 0o700 }),
    mkdir(context.mediaDirectory, { mode: 0o700 }),
  ]);
  await cp(fixturePath, resolve(context.mediaDirectory, "Omnifin Fixture.mp4"), {
    errorOnExist: true,
    force: false,
  });
  return context;
}

async function writeReport(outputPath, report) {
  const parent = dirname(outputPath);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const canonicalRoot = await realpath(REPOSITORY_ROOT);
  const canonicalParent = await realpath(parent);
  const parentRelative = relative(canonicalRoot, canonicalParent);
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    throw new JellyfinFixtureFailure("path_invalid");
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

async function main(options) {
  const context = await prepareContext(options.fixturePath);
  const username = `fixture-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(32).toString("base64url");
  let running = false;
  try {
    const firstServer = startContainer(context);
    running = true;
    await waitForHealthy(firstServer.loopbackUrl);
    const firstInfo = await serverInfo(firstServer.loopbackUrl);
    const authentication = await initializeServer(
      firstServer.loopbackUrl,
      username,
      password,
      context.deviceId,
    );
    await configureFixtureServer(firstServer.loopbackUrl, authentication);
    const item = await importFixture(firstServer.loopbackUrl, authentication);
    const playback = await verifyPlayback(context, firstServer, authentication, item);
    const persistedSeconds = await playbackPosition(
      firstServer.loopbackUrl,
      authentication,
      item.id,
    );

    stopContainer(context.containerName);
    running = false;
    const secondServer = startContainer(context);
    running = true;
    await waitForHealthy(secondServer.loopbackUrl);
    const secondInfo = await serverInfo(secondServer.loopbackUrl);
    if (secondInfo.id !== firstInfo.id) throw new JellyfinFixtureFailure("restart_state_invalid");
    const secondAuthentication = await authenticate(
      secondServer.loopbackUrl,
      username,
      password,
      context.deviceId,
    );
    const restartPosition = await playbackPosition(
      secondServer.loopbackUrl,
      secondAuthentication,
      item.id,
    );
    const reconnected = await playbackClient(
      context,
      secondServer,
      secondAuthentication.accessToken,
      context.deviceId,
    ).negotiate({
      audioStreamIndex: null,
      itemId: item.id,
      maxStreamingBitrate: 20_000_000,
      mode: "direct",
      positionSeconds: restartPosition,
      subtitleStreamIndex: null,
    });
    if (reconnected.delivery !== "direct") {
      throw new JellyfinFixtureFailure("restart_playback_invalid");
    }

    const report = {
      checks: {
        directRange: playback.direct,
        hlsTranscode: playback.hls,
        progress: { persistedSeconds, reportedSeconds: 6 },
        reconnect: { delivery: reconnected.delivery, persistedSeconds: restartPosition },
        tracks: {
          audio: playback.selectedAudio,
          subtitle: playback.selectedSubtitle,
        },
        transcodeSeekSeconds: playback.seekSeconds,
      },
      image: JELLYFIN_FIXTURE_IMAGE,
      schemaVersion: 1,
      serverVersion: secondInfo.version,
      status: "passed",
    };
    await writeReport(options.outputPath, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    if (running) stopContainer(context.containerName);
    await rm(context.temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof JellyfinFixtureFailure ? error.code : "jellyfin_fixture_failed";
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 1;
  }
}
