#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { JellyfinAuthenticationClient } from "../../../packages/connectors/dist/auth/jellyfin-authentication-client.js";
import { JellyfinPlaybackClient } from "../../../packages/connectors/dist/media/jellyfin-playback-client.js";

import { JELLYFIN_FIXTURE_IMAGE } from "../../media/playback-fixture.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const MAX_JSON_BYTES = 4 * 1_024 * 1_024;
const MAX_SEGMENT_BYTES = 8 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 20_000;
const SERVER_READY_TIMEOUT_MS = 90_000;
const LIBRARY_READY_TIMEOUT_MS = 60_000;
const RESTART_NEGOTIATION_READY_TIMEOUT_MS = 10_000;
const RESTART_NEGOTIATION_RETRY_INTERVAL_MS = 250;
const TICKS_PER_SECOND = 10_000_000;
const IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/u;
const JELLYFIN_IMAGE_PATTERN =
  /^ghcr\.io\/jellyfin\/jellyfin:((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2})@sha256:[a-f0-9]{64}$/u;
const PRIVATE_IPV4_PATTERN = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u;
const SAFE_CONNECTOR_FAILURE_CODES = new Set([
  "configuration_invalid",
  "destination_blocked",
  "invalid_credentials",
  "playback_unavailable",
  "rate_limited",
  "response_invalid",
  "timeout",
  "unreachable",
  "unsupported_version",
  "upstream_error",
]);
const TRANSIENT_RESTART_NEGOTIATION_CODES = new Set(["response_invalid", "timeout", "unreachable"]);

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

export function connectorFailureCode(stage, error) {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(stage)) {
    throw new JellyfinFixtureFailure("diagnostic_stage_invalid");
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
    throw new JellyfinFixtureFailure(connectorFailureCode(stage, error), { cause: error });
  }
}

function isTransientRestartNegotiationFailure(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    TRANSIENT_RESTART_NEGOTIATION_CODES.has(error.code)
  );
}

export async function restartPlaybackNegotiation(operation, options = {}) {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? sleep;
  const timeoutMs = options.timeoutMs ?? RESTART_NEGOTIATION_READY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new JellyfinFixtureFailure("restart_retry_policy_invalid");
  }
  const deadline = now() + timeoutMs;

  while (true) {
    try {
      const attemptSignal = AbortSignal.timeout(Math.max(1, deadline - now()));
      return await operation(attemptSignal);
    } catch (error) {
      const remainingMs = deadline - now();
      if (!isTransientRestartNegotiationFailure(error) || remainingMs <= 0) throw error;
      await pause(Math.min(RESTART_NEGOTIATION_RETRY_INTERVAL_MS, remainingMs));
    }
  }
}

export function jellyfinTarget(image, expectedVersion) {
  if (typeof image !== "string" || typeof expectedVersion !== "string") {
    throw new JellyfinFixtureFailure("jellyfin_target_invalid");
  }
  const match = image.match(JELLYFIN_IMAGE_PATTERN);
  if (!match || match[1] !== expectedVersion) {
    throw new JellyfinFixtureFailure("jellyfin_target_invalid");
  }
  return { image, version: expectedVersion };
}

export function jellyfinCompatibilityReport(input) {
  const target = jellyfinTarget(input.image, input.version);
  const identity = {
    invalidPasswordRejected: input.identityChecks?.invalidPasswordRejected === true,
    mismatchedQuickConnectSecretRejected:
      input.identityChecks?.mismatchedQuickConnectSecretRejected === true,
    password: input.identityChecks?.password === true,
    publicInfo: input.identityChecks?.publicInfo === true,
    quickConnect: input.identityChecks?.quickConnect === true,
  };
  if (Object.values(identity).some((passed) => !passed)) {
    throw new JellyfinFixtureFailure("compatibility_report_invalid");
  }
  return {
    checks: {
      directRange: {
        bytes: input.playback.direct.bytes,
        status: input.playback.direct.status,
      },
      hlsTranscode: {
        bytes: input.playback.hls.bytes,
        format: input.playback.hls.format,
        status: input.playback.hls.status,
      },
      identity,
      progress: {
        persistedSeconds: input.persistedSeconds,
        reportedSeconds: 6,
      },
      reconnect: {
        delivery: input.reconnectDelivery,
        persistedSeconds: input.restartPosition,
      },
      tracks: {
        audio: input.playback.selectedAudio,
        subtitle: input.playback.selectedSubtitle,
      },
      transcodeSeekSeconds: input.playback.seekSeconds,
    },
    image: target.image,
    schemaVersion: 1,
    serverVersion: target.version,
    status: "passed",
  };
}

export function quickConnectAuthorizationQuery(code, userId) {
  if (!/^\d{6}$/u.test(code) || !IDENTIFIER_PATTERN.test(userId)) {
    throw new JellyfinFixtureFailure("quick_connect_state_invalid");
  }
  return new URLSearchParams({ code, userId });
}

function argumentValue(arguments_, name) {
  const indexes = arguments_.flatMap((argument, index) => (argument === name ? [index] : []));
  if (indexes.length !== 1 || !arguments_[indexes[0] + 1]) {
    throw new JellyfinFixtureFailure("usage_invalid");
  }
  return arguments_[indexes[0] + 1];
}

function parseArguments(arguments_) {
  const fixtureIndex = arguments_.indexOf("--fixture");
  const outputIndex = arguments_.indexOf("--output");
  if (![4, 8].includes(arguments_.length) || fixtureIndex < 0 || outputIndex < 0) {
    throw new JellyfinFixtureFailure("usage_invalid");
  }
  const fixturePath = argumentValue(arguments_, "--fixture");
  const outputPath = argumentValue(arguments_, "--output");
  const target =
    arguments_.length === 4
      ? jellyfinTarget(JELLYFIN_FIXTURE_IMAGE, "10.11.11")
      : jellyfinTarget(
          argumentValue(arguments_, "--image"),
          argumentValue(arguments_, "--expected-version"),
        );
  return {
    fixturePath: repositoryPath(fixturePath),
    outputPath: repositoryPath(outputPath),
    target,
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
    context.target.image,
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

export function validateImportedItem(item) {
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

export function isLibraryProbePending(error) {
  return error instanceof JellyfinFixtureFailure && error.code === "library_streams_invalid";
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
  let lastProbeFailure;
  while (Date.now() < deadline) {
    const itemQuery = new URLSearchParams({
      Fields: "MediaSources,MediaStreams,UserData",
      IncludeItemTypes: "Movie",
      Recursive: "true",
      UserId: authentication.userId,
    });
    const response = await requestJson(baseUrl, `Items?${itemQuery}`, { headers });
    if (Array.isArray(response?.Items) && response.Items[0]) {
      try {
        return validateImportedItem(response.Items[0]);
      } catch (error) {
        if (!isLibraryProbePending(error)) throw error;
        lastProbeFailure = error;
      }
    }
    await sleep(500);
  }
  if (lastProbeFailure) throw lastProbeFailure;
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

function authenticationClient(context, server) {
  return new JellyfinAuthenticationClient(
    {
      baseUrl: server.connectorUrl.href,
      insecureHttpApproved: true,
      maxResponseBytes: MAX_JSON_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
    { appVersion: "0.1.0" },
  );
}

function authenticationResult(result, expectedServerId) {
  if (
    typeof result?.AccessToken !== "string" ||
    result.AccessToken.length < 16 ||
    result.AccessToken.length > 512 ||
    !IDENTIFIER_PATTERN.test(result?.User?.Id ?? "") ||
    result.ServerId !== expectedServerId
  ) {
    throw new JellyfinFixtureFailure("authentication_invalid");
  }
  return { accessToken: result.AccessToken, userId: result.User.Id };
}

async function rejectsQuickConnectSecret(client, context, secret) {
  try {
    const result = await client.pollQuickConnect({
      deviceId: context.deviceId,
      secret,
    });
    return result.Authenticated === false;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      ["invalid_credentials", "upstream_error"].includes(error.code)
    );
  }
}

async function verifyIdentity(context, server, adminAuthentication, username, password, serverId) {
  const client = authenticationClient(context, server);
  const info = await connectorOperation("identity_public_info", () => client.getPublicSystemInfo());
  if (info.Id !== serverId || info.Version !== context.target.version) {
    throw new JellyfinFixtureFailure("identity_public_info_invalid");
  }

  const passwordResult = await connectorOperation("password_authentication", () =>
    client.authenticateByName({
      deviceId: context.deviceId,
      password,
      username,
    }),
  );
  const passwordAuthentication = authenticationResult(passwordResult, serverId);
  let invalidPasswordRejected = false;
  try {
    await client.authenticateByName({
      deviceId: `${context.deviceId}-invalid`,
      password: `${password}-invalid`,
      username,
    });
  } catch (error) {
    invalidPasswordRejected =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "invalid_credentials";
  }
  if (!invalidPasswordRejected) {
    throw new JellyfinFixtureFailure("invalid_password_accepted");
  }

  const quickConnectEnabled = await connectorOperation("quick_connect_capability", () =>
    client.quickConnectEnabled({ deviceId: context.deviceId }),
  );
  if (!quickConnectEnabled) throw new JellyfinFixtureFailure("quick_connect_disabled");
  const quickConnect = await connectorOperation("quick_connect_initiate", () =>
    client.initiateQuickConnect({ deviceId: context.deviceId }),
  );
  if (
    quickConnect.Authenticated ||
    !(await rejectsQuickConnectSecret(client, context, `${quickConnect.Secret}-mismatch`))
  ) {
    throw new JellyfinFixtureFailure("quick_connect_state_invalid");
  }
  const authorizationQuery = quickConnectAuthorizationQuery(
    quickConnect.Code,
    adminAuthentication.userId,
  );
  const authorized = await connectorOperation("quick_connect_authorize", () =>
    requestJson(server.loopbackUrl, `QuickConnect/Authorize?${authorizationQuery}`, {
      headers: tokenHeaders(adminAuthentication.accessToken),
      method: "POST",
    }),
  );
  if (authorized !== true) throw new JellyfinFixtureFailure("quick_connect_state_invalid");
  const approved = await connectorOperation("quick_connect_poll", () =>
    client.pollQuickConnect({
      deviceId: context.deviceId,
      secret: quickConnect.Secret,
    }),
  );
  if (
    !approved.Authenticated ||
    approved.Code !== quickConnect.Code ||
    approved.Secret !== quickConnect.Secret
  ) {
    throw new JellyfinFixtureFailure("quick_connect_state_invalid");
  }
  const quickConnectResult = await connectorOperation("quick_connect_authentication", () =>
    client.authenticateWithQuickConnect({
      deviceId: context.deviceId,
      secret: quickConnect.Secret,
    }),
  );
  authenticationResult(quickConnectResult, serverId);

  return {
    authentication: passwordAuthentication,
    checks: {
      invalidPasswordRejected: true,
      mismatchedQuickConnectSecretRejected: true,
      password: true,
      publicInfo: true,
      quickConnect: true,
    },
  };
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
    const manifestResponse = await connectorOperation("hls_manifest_read", () =>
      client.readPlaybackTarget({
        accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        target,
      }),
    );
    const manifest = new TextDecoder().decode(manifestResponse.body);
    if (!manifest.startsWith("#EXTM3U")) throw new JellyfinFixtureFailure("manifest_invalid");
    const uri = firstManifestUri(manifest);
    const nextTarget = await connectorOperation("hls_manifest_target", () =>
      client.resolvePlaybackTarget(target, uri),
    );
    if (/\.m3u8(?:$|\?)/iu.test(uri)) {
      target = nextTarget;
      continue;
    }
    const segment = await connectorOperation("hls_segment_open", () =>
      client.streamPlaybackTarget({
        accept: "video/mp2t, application/octet-stream, */*",
        maxResponseBytes: MAX_SEGMENT_BYTES,
        target: nextTarget,
      }),
    );
    const bytes = await connectorOperation("hls_segment_read", () =>
      readStream(segment.body, MAX_SEGMENT_BYTES),
    );
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
  const direct = await connectorOperation("direct_negotiation", () =>
    client.negotiate({
      audioStreamIndex: frenchAudioIndex,
      itemId: item.id,
      maxStreamingBitrate: 20_000_000,
      mode: "direct",
      positionSeconds: 0,
      subtitleStreamIndex: englishSubtitleIndex,
    }),
  );
  if (
    direct.delivery !== "direct" ||
    !direct.audioTracks.some((track) => track.language === "fra" && track.selected) ||
    !direct.subtitleTracks.some((track) => track.language === "eng" && track.selected)
  ) {
    throw new JellyfinFixtureFailure("direct_negotiation_invalid");
  }
  const range = await connectorOperation("direct_range", () =>
    client.readPlaybackTarget({
      accept: "video/mp4, video/*",
      range: "bytes=0-4095",
      target: direct.upstreamTarget,
    }),
  );
  if (range.status !== 206 || range.body.byteLength !== 4_096) {
    throw new JellyfinFixtureFailure("direct_range_invalid");
  }

  const transcode = await connectorOperation("transcode_negotiation", () =>
    client.negotiate({
      audioStreamIndex: frenchAudioIndex,
      itemId: item.id,
      maxStreamingBitrate: 500_000,
      mode: "transcode",
      positionSeconds: 4,
      subtitleStreamIndex: null,
    }),
  );
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
  for (const [event, positionSeconds] of [
    ["started", 1],
    ["progress", 5],
    ["stopped", 6],
  ]) {
    await connectorOperation(`playback_report_${event}`, () =>
      client.reportPlaybackEvent({
        event,
        positionSeconds,
        session: reportingSession,
      }),
    );
  }

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

async function serverInfo(baseUrl, expectedVersion) {
  const info = await requestJson(baseUrl, "System/Info/Public");
  if (info?.Version !== expectedVersion || typeof info?.Id !== "string") {
    throw new JellyfinFixtureFailure("server_info_invalid");
  }
  return { id: info.Id, version: info.Version };
}

async function prepareContext(fixturePath, target) {
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
    target,
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
  const context = await prepareContext(options.fixturePath, options.target);
  const username = `fixture-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(32).toString("base64url");
  let running = false;
  try {
    const firstServer = startContainer(context);
    running = true;
    await waitForHealthy(firstServer.loopbackUrl);
    const firstInfo = await serverInfo(firstServer.loopbackUrl, context.target.version);
    const adminAuthentication = await initializeServer(
      firstServer.loopbackUrl,
      username,
      password,
      context.deviceId,
    );
    const identity = await verifyIdentity(
      context,
      firstServer,
      adminAuthentication,
      username,
      password,
      firstInfo.id,
    );
    const authentication = identity.authentication;
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
    const secondInfo = await serverInfo(secondServer.loopbackUrl, context.target.version);
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
    const reconnectClient = playbackClient(
      context,
      secondServer,
      secondAuthentication.accessToken,
      context.deviceId,
    );
    const reconnected = await connectorOperation("restart_negotiation", () =>
      restartPlaybackNegotiation((signal) =>
        reconnectClient.negotiate(
          {
            audioStreamIndex: null,
            itemId: item.id,
            maxStreamingBitrate: 20_000_000,
            mode: "direct",
            positionSeconds: restartPosition,
            subtitleStreamIndex: null,
          },
          signal,
        ),
      ),
    );
    if (reconnected.delivery !== "direct") {
      throw new JellyfinFixtureFailure("restart_playback_invalid");
    }

    const report = jellyfinCompatibilityReport({
      identityChecks: identity.checks,
      image: context.target.image,
      persistedSeconds,
      playback,
      reconnectDelivery: reconnected.delivery,
      restartPosition,
      version: secondInfo.version,
    });
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
