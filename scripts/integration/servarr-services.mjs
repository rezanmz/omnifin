#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  acquirePinnedDockerImage,
  DockerImagePullError,
  DOCKER_LOCAL_IMAGE_ARGUMENTS,
} from "./docker-runtime.mjs";
import { applyCompatibilityTargetOverride } from "./compatibility-targets.mjs";
import { COMPATIBILITY_CHECKS } from "./compatibility-checks.mjs";
import { FIXTURE_MOVIE_TMDB_ID, FIXTURE_SERIES_TVDB_ID } from "./servarr-fixture-server.mjs";

export const SERVARR_FIXTURE_SERVER_IMAGE =
  "docker.io/library/node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573";

const servarrTargets = applyCompatibilityTargetOverride({
  bazarr: {
    image:
      "ghcr.io/linuxserver/bazarr:v1.6.0-ls356@sha256:ab401a0f361cfad328e444838b13d5b334b189d0f556fc91a3623eb581df36df",
    version: "1.6.0",
  },
  prowlarr: {
    image:
      "ghcr.io/linuxserver/prowlarr:2.5.2.5491-ls155@sha256:2f3d31307beba3ba2dd226d191f5f5c14ee3b4d8b49277c64683f5ed97083179",
    version: "2.5.2.5491",
  },
  radarr: {
    image:
      "ghcr.io/linuxserver/radarr:6.3.0.10514-ls312@sha256:e35056574cdc695a9ee745aa1ecda9eab3842450bf4b7b8471b023790fa3861d",
    version: "6.3.0.10514",
  },
  sonarr: {
    image:
      "ghcr.io/linuxserver/sonarr:4.0.19.2979-ls320@sha256:24acea2956a0ccb11f103877d9f4f8576600fb34bff34820ed749c2256dab89f",
    version: "4.0.19.2979",
  },
});

export const SERVARR_SERVICE_IMAGES = Object.freeze(
  Object.fromEntries(
    Object.entries(servarrTargets).map(([service, target]) => [service, target.image]),
  ),
);

export const SERVARR_SERVICE_VERSIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(servarrTargets).map(([service, target]) => [service, target.version]),
  ),
);

const SERVICE_PORTS = Object.freeze({ bazarr: 6767, prowlarr: 9696, radarr: 7878, sonarr: 8989 });
const SERVICE_CHECKS = Object.freeze(
  Object.fromEntries(
    Object.keys(servarrTargets).map((service) => [service, COMPATIBILITY_CHECKS[service]]),
  ),
);
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
const BAZARR_ARTIFACT_TIMEOUT_MS = 30_000;
const SONARR_MONITORING_READBACK_ATTEMPTS = 20;
const SONARR_MONITORING_READBACK_INTERVAL_MS = 250;
const PRIVATE_IPV4_PATTERN = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u;
const API_KEY_PATTERN = /^[a-f0-9]{32}$/u;
const SIDECAR_FIXTURE_SERVICES = new Set(["prowlarr", "radarr", "sonarr"]);
const BAZARR_FIXTURE_MEDIA_NAME = "fixture-media.mkv";
const BAZARR_FIXTURE_SOURCE_NAME = "fixture-source.srt";
const BAZARR_FIXTURE_TITLE = "The Deterministic Meridian";
const BAZARR_FIXTURE_YEAR = 2026;
const BAZARR_SUBTITLE_MARKER = "Deterministic subtitle evidence.";
const BAZARR_SUBTITLE_SOURCE = `1
00:00:00,000 --> 00:00:01,500
${BAZARR_SUBTITLE_MARKER}
`;
const BAZARR_SEED_SCRIPT = `
import sqlite3

payload = __OMNIFIN_BAZARR_FIXTURE_PAYLOAD__
expected_keys = ["mediaPath", "profileItems", "profileName", "title", "year"]
if sorted(payload.keys()) != expected_keys:
    raise ValueError("payload_invalid")
if payload["mediaPath"] != "/data/fixture-media.mkv" or payload["year"] != 2026:
    raise ValueError("payload_invalid")

database = sqlite3.connect("/config/db/bazarr.db", timeout=10)
database.execute("PRAGMA busy_timeout = 10000")
with database:
    database.execute("DELETE FROM table_movies")
    database.execute("DELETE FROM table_languages_profiles")
    database.execute(
        """INSERT INTO table_languages_profiles
        (profileId, cutoff, originalFormat, items, name, mustContain, mustNotContain, tag)
        VALUES (1, NULL, 0, ?, ?, '[]', '[]', NULL)""",
        (payload["profileItems"], payload["profileName"]),
    )
    database.execute(
        """INSERT INTO table_movies
        (radarrId, path, profileId, title, sortTitle, tmdbId, year, monitored,
         audio_language, alternativeTitles, tags, sceneName, movie_file_id)
        VALUES (1, ?, 1, ?, ?, '9000001', ?, 'True', '[]', '[]', '[]', NULL, 1)""",
        (payload["mediaPath"], payload["title"], payload["title"], str(payload["year"])),
    )
database.close()
`;

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

export function configureBazarrFixtureSettings(configuration) {
  parseBazarrApiKey(configuration);
  let parsed;
  try {
    parsed = parseYaml(configuration, { maxAliasCount: 0, prettyErrors: false });
  } catch (error) {
    throw new ServarrFixtureFailure("credential_config_invalid", { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !parsed.general ||
    typeof parsed.general !== "object" ||
    Array.isArray(parsed.general) ||
    !parsed.embeddedsubtitles ||
    typeof parsed.embeddedsubtitles !== "object" ||
    Array.isArray(parsed.embeddedsubtitles)
  ) {
    throw new ServarrFixtureFailure("credential_config_invalid");
  }
  parsed.general.enabled_providers = ["embeddedsubtitles"];
  parsed.general.use_radarr = true;
  parsed.embeddedsubtitles.included_codecs = ["subrip"];
  parsed.embeddedsubtitles.timeout = 30;
  const output = stringifyYaml(parsed, { lineWidth: 0 });
  if (Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ServarrFixtureFailure("credential_config_invalid");
  }
  return output;
}

export function bazarrSeedPayload() {
  return {
    mediaPath: `/data/${BAZARR_FIXTURE_MEDIA_NAME}`,
    profileItems: JSON.stringify([
      {
        audio_exclude: "False",
        audio_only_include: "False",
        forced: "False",
        hi: "False",
        id: 1,
        language: "en",
      },
    ]),
    profileName: "Deterministic English fixture",
    title: BAZARR_FIXTURE_TITLE,
    year: BAZARR_FIXTURE_YEAR,
  };
}

export function bazarrDatabaseSeedArguments(containerName) {
  if (typeof containerName !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(containerName)) {
    throw new ServarrFixtureFailure("container_name_invalid");
  }
  return ["exec", "--interactive", containerName, "python3", "-"];
}

function bazarrDatabaseSeedProgram() {
  return BAZARR_SEED_SCRIPT.replace(
    "__OMNIFIN_BAZARR_FIXTURE_PAYLOAD__",
    JSON.stringify(bazarrSeedPayload()),
  );
}

export function validateBazarrSubtitleArtifact(entries, content) {
  if (
    !Array.isArray(entries) ||
    entries.length !== 2 ||
    entries.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length < 1 ||
        entry.length > 180 ||
        entry.includes("/") ||
        entry.includes("\\") ||
        /[\p{Cc}\p{Cf}]/u.test(entry),
    ) ||
    !entries.includes(BAZARR_FIXTURE_MEDIA_NAME)
  ) {
    throw new ServarrFixtureFailure("subtitle_directory_invalid");
  }
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") < 32 ||
    Buffer.byteLength(content, "utf8") > 64 * 1_024
  ) {
    throw new ServarrFixtureFailure("subtitle_content_invalid");
  }
  if (!content.includes(BAZARR_SUBTITLE_MARKER)) {
    throw new ServarrFixtureFailure("subtitle_marker_invalid");
  }
  const subtitles = entries.filter((entry) => entry.toLowerCase().endsWith(".srt"));
  if (subtitles.length !== 1 || subtitles[0] === BAZARR_FIXTURE_SOURCE_NAME) {
    throw new ServarrFixtureFailure("subtitle_artifact_count_invalid");
  }
  return subtitles[0];
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
    "--cap-drop",
    "ALL",
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

function runDockerWithInput(arguments_, input, timeout, failureCode) {
  if (
    typeof input !== "string" ||
    Buffer.byteLength(input, "utf8") < 1 ||
    Buffer.byteLength(input, "utf8") > 8 * 1_024
  ) {
    throw new ServarrFixtureFailure("fixture_input_invalid");
  }
  const execution = spawnSync("docker", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1_024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
  });
  if (execution.status !== 0 || execution.error) {
    throw new ServarrFixtureFailure(failureCode, { cause: execution.error });
  }
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
  const dataDirectory = resolve(temporaryDirectory, "data");
  const tlsDirectory = resolve(temporaryDirectory, "tls");
  await Promise.all(
    [configDirectory, dataDirectory, tlsDirectory].map((directory) =>
      mkdir(directory, { mode: 0o700 }),
    ),
  );
  return {
    configDirectory,
    containerCreated: false,
    containerName: `omnifin-${service}-service-${suffix}`,
    dataDirectory,
    fixtureServerCreated: false,
    fixtureServerName: `omnifin-${service}-fixture-server-${suffix}`,
    networkCreated: false,
    networkName: `omnifin-${service}-service-network-${suffix}`,
    service,
    temporaryDirectory,
    tlsDirectory,
  };
}

function runOpenSsl(arguments_, failureCode) {
  const execution = spawnSync("openssl", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (execution.status !== 0 || execution.error) {
    throw new ServarrFixtureFailure(failureCode, { cause: execution.error });
  }
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
      "subjectAltName=DNS:api.radarr.video,DNS:services.sonarr.tv,DNS:skyhook.sonarr.tv,DNS:thexem.info",
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
      "/CN=Omnifin isolated fixture CA",
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
      "/CN=api.radarr.video",
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

export function fixtureServerContainerArguments(context) {
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
    "api.radarr.video",
    "--network-alias",
    "skyhook.sonarr.tv",
    "--network-alias",
    "services.sonarr.tv",
    "--network-alias",
    "thexem.info",
    "--network-alias",
    "fixture-indexer.omnifin.invalid",
    ...containerIsolationArguments(uid, gid),
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
    `type=bind,src=${repositoryPath("scripts/integration/servarr-fixture-server.mjs")},dst=/fixture/servarr-fixture-server.mjs,readonly`,
    "--mount",
    `type=bind,src=${resolve(context.tlsDirectory, "server.crt")},dst=/fixture-tls/server.crt,readonly`,
    "--mount",
    `type=bind,src=${resolve(context.tlsDirectory, "server.key")},dst=/fixture-tls/server.key,readonly`,
    SERVARR_FIXTURE_SERVER_IMAGE,
    "node",
    "/fixture/servarr-fixture-server.mjs",
  ];
}

export function serviceContainerArguments(context) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const arguments_ = [
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
  ];
  arguments_.push("--mount", `type=bind,src=${context.configDirectory},dst=/config`);
  if (["bazarr", "radarr", "sonarr"].includes(context.service)) {
    arguments_.push("--mount", `type=bind,src=${context.dataDirectory},dst=/data`);
  }
  if (context.service === "radarr" || context.service === "sonarr") {
    arguments_.push(
      "--env",
      "SSL_CERT_FILE=/fixture-tls/ca.crt",
      "--mount",
      `type=bind,src=${resolve(context.tlsDirectory, "ca.crt")},dst=/fixture-tls/ca.crt,readonly`,
    );
  }
  arguments_.push(SERVARR_SERVICE_IMAGES[context.service]);
  return arguments_;
}

async function acquireFixtureImage(image) {
  try {
    await acquirePinnedDockerImage(image);
  } catch (error) {
    if (error instanceof DockerImagePullError) {
      throw new ServarrFixtureFailure(error.code);
    }
    throw error;
  }
}

async function startContainer(context) {
  await acquireFixtureImage(SERVARR_SERVICE_IMAGES[context.service]);
  if (SIDECAR_FIXTURE_SERVICES.has(context.service)) {
    await acquireFixtureImage(SERVARR_FIXTURE_SERVER_IMAGE);
    await createFixtureCertificates(context);
  }
  runDocker(
    ["network", "create", "--driver", "bridge", "--internal", context.networkName],
    30_000,
    "network_create_failed",
  );
  context.networkCreated = true;
  if (SIDECAR_FIXTURE_SERVICES.has(context.service)) {
    runDocker(fixtureServerContainerArguments(context), 60_000, "fixture_server_start_failed");
    context.fixtureServerCreated = true;
    parseContainerState(
      runDocker(
        [
          "inspect",
          "--format",
          "{{.State.Running}}:{{.State.ExitCode}}",
          context.fixtureServerName,
        ],
        30_000,
        "fixture_server_state_failed",
      ),
    );
  }
  runDocker(serviceContainerArguments(context), 180_000, "container_start_failed");
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

export function bazarrMediaGenerationArguments(containerName) {
  if (typeof containerName !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(containerName)) {
    throw new ServarrFixtureFailure("container_name_invalid");
  }
  return [
    "exec",
    containerName,
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:r=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=mono:sample_rate=48000",
    "-i",
    `/data/${BAZARR_FIXTURE_SOURCE_NAME}`,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map",
    "2:s:0",
    "-c:v",
    "mpeg4",
    "-q:v",
    "31",
    "-c:a",
    "aac",
    "-b:a",
    "32k",
    "-c:s",
    "srt",
    "-metadata:s:s:0",
    "language=eng",
    "-shortest",
    `/data/${BAZARR_FIXTURE_MEDIA_NAME}`,
  ];
}

async function provisionBazarrFixture(context) {
  const sourcePath = resolve(context.dataDirectory, BAZARR_FIXTURE_SOURCE_NAME);
  const mediaPath = resolve(context.dataDirectory, BAZARR_FIXTURE_MEDIA_NAME);
  await writeFile(sourcePath, BAZARR_SUBTITLE_SOURCE, { flag: "wx", mode: 0o600 });
  runDocker(
    bazarrMediaGenerationArguments(context.containerName),
    180_000,
    "bazarr_media_generation_failed",
  );
  await rm(sourcePath);
  const mediaMetadata = await lstat(mediaPath);
  if (
    !mediaMetadata.isFile() ||
    mediaMetadata.isSymbolicLink() ||
    mediaMetadata.size < 1_024 ||
    mediaMetadata.size > 8 * 1_024 * 1_024
  ) {
    throw new ServarrFixtureFailure("bazarr_media_generation_invalid");
  }

  const configurationPath = resolve(context.configDirectory, "config/config.yaml");
  const configuration = configureBazarrFixtureSettings(await readFile(configurationPath, "utf8"));
  const temporaryConfigurationPath = resolve(
    dirname(configurationPath),
    ".config.yaml.omnifin-fixture",
  );
  await writeFile(temporaryConfigurationPath, configuration, { flag: "wx", mode: 0o600 });
  await rename(temporaryConfigurationPath, configurationPath);

  runDockerWithInput(
    bazarrDatabaseSeedArguments(context.containerName),
    bazarrDatabaseSeedProgram(),
    30_000,
    "bazarr_database_seed_failed",
  );
  const restartedContainer = runDocker(
    ["restart", context.containerName],
    180_000,
    "bazarr_container_restart_failed",
  ).trim();
  if (restartedContainer !== context.containerName) {
    throw new ServarrFixtureFailure("bazarr_container_restart_failed");
  }
  parseContainerState(
    runDocker(
      ["inspect", "--format", "{{.State.Running}}:{{.State.ExitCode}}", context.containerName],
      30_000,
      "container_state_failed",
    ),
  );
}

function createContainerLocalTransport(context) {
  return async (url, init) => {
    if (init.signal?.aborted) throw new ServarrFixtureFailure("fixture_transport_aborted");
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
      input: createCurlHeaderConfiguration(init.headers, init.body),
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

export function createCurlHeaderConfiguration(headers, body) {
  if (!(headers instanceof Headers)) throw new ServarrFixtureFailure("fixture_headers_invalid");
  if (body instanceof Uint8Array) body = new TextDecoder().decode(body);
  if (
    body !== undefined &&
    (typeof body !== "string" ||
      Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES ||
      /[\r\n\0]/u.test(body))
  ) {
    throw new ServarrFixtureFailure("fixture_body_invalid");
  }
  const lines = [...headers.entries()].map(([name, value]) => {
    if (/[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(name) || /[\r\n\0]/u.test(value)) {
      throw new ServarrFixtureFailure("fixture_headers_invalid");
    }
    const escaped = `${name}: ${value}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `header = "${escaped}"`;
  });
  if (body !== undefined) {
    const escapedBody = body.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    lines.push(`data-binary = "${escapedBody}"`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
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

function boundedJson(value, failureCode) {
  if (
    value === null ||
    typeof value !== "object" ||
    JSON.stringify(value).length > MAX_RESPONSE_BYTES
  ) {
    throw new ServarrFixtureFailure(failureCode);
  }
  return value;
}

async function fixtureApiJson(context, server, apiKey, path, options = {}) {
  const stage = options.stage ?? "fixture_api";
  if (!/^[a-z][a-z0-9_]{0,39}$/u.test(stage)) {
    throw new ServarrFixtureFailure("fixture_api_stage_invalid");
  }
  if (!/^\/api\/v[13]\/[A-Za-z0-9?&=/_-]{1,240}$/u.test(path)) {
    throw new ServarrFixtureFailure("fixture_api_path_invalid");
  }
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = new Headers({ accept: "application/json", "X-Api-Key": apiKey });
  if (body !== undefined) headers.set("content-type", "application/json");
  const init = {
    ...(body === undefined ? {} : { body }),
    headers,
    method: options.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  let response;
  try {
    const url = new URL(path, server.baseUrl);
    response = server.transport ? await server.transport(url, init) : await fetch(url, init);
  } catch (error) {
    throw new ServarrFixtureFailure(`${stage}_transport_failed`, { cause: error });
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : 0;
    throw new ServarrFixtureFailure(`${stage}_http_${status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new ServarrFixtureFailure(`${stage}_response_invalid`);
  }
  try {
    return boundedJson(JSON.parse(new TextDecoder().decode(bytes)), `${stage}_response_invalid`);
  } catch (error) {
    if (error instanceof ServarrFixtureFailure) throw error;
    throw new ServarrFixtureFailure(`${stage}_response_invalid`, { cause: error });
  }
}

export function selectQualityProfileId(profiles) {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 256) {
    throw new ServarrFixtureFailure("quality_profile_invalid");
  }
  const identifiers = profiles
    .map((profile) => profile?.id)
    .filter((identifier) => Number.isInteger(identifier) && identifier > 0)
    .sort((left, right) => left - right);
  if (identifiers.length === 0) throw new ServarrFixtureFailure("quality_profile_invalid");
  return identifiers[0];
}

export function selectAppProfileId(profiles) {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 256) {
    throw new ServarrFixtureFailure("app_profile_invalid");
  }
  const identifiers = profiles
    .map((profile) => profile?.id)
    .filter((identifier) => Number.isInteger(identifier) && identifier > 0)
    .sort((left, right) => left - right);
  if (identifiers.length === 0) throw new ServarrFixtureFailure("app_profile_invalid");
  return identifiers[0];
}

export function configureProwlarrFixtureIndexer(templates, appProfileId) {
  if (!Array.isArray(templates) || templates.length < 1 || templates.length > 512) {
    throw new ServarrFixtureFailure("indexer_schema_invalid");
  }
  if (!Number.isInteger(appProfileId) || appProfileId < 1) {
    throw new ServarrFixtureFailure("app_profile_invalid");
  }
  const template = templates.find(
    (candidate) =>
      candidate?.implementation === "Newznab" && candidate.configContract === "NewznabSettings",
  );
  if (!template || !Array.isArray(template.fields) || template.fields.length > 256) {
    throw new ServarrFixtureFailure("indexer_schema_invalid");
  }
  const requiredFields = new Set(["apiPath", "baseUrl"]);
  const fields = template.fields.map((field) => {
    if (!field || typeof field !== "object" || typeof field.name !== "string") {
      throw new ServarrFixtureFailure("indexer_schema_invalid");
    }
    if (field.name === "baseUrl") {
      requiredFields.delete(field.name);
      return { ...field, value: "http://fixture-indexer.omnifin.invalid:8080" };
    }
    if (field.name === "apiPath") {
      requiredFields.delete(field.name);
      return { ...field, value: "/api" };
    }
    if (field.name === "apiKey") return { ...field, value: "" };
    return structuredClone(field);
  });
  if (requiredFields.size > 0) throw new ServarrFixtureFailure("indexer_schema_invalid");
  return {
    ...structuredClone(template),
    appProfileId,
    enable: true,
    enableAutomaticSearch: false,
    enableInteractiveSearch: true,
    enableRss: false,
    fields,
    id: 0,
    name: "Omnifin deterministic fixture indexer",
    redirect: true,
  };
}

function validateProvisionedMedia(resource, context) {
  const upstreamId = context.service === "radarr" ? resource?.tmdbId : resource?.tvdbId;
  const expectedUpstreamId =
    context.service === "radarr" ? FIXTURE_MOVIE_TMDB_ID : FIXTURE_SERIES_TVDB_ID;
  if (
    !resource ||
    typeof resource !== "object" ||
    !Number.isInteger(resource.id) ||
    resource.id < 1 ||
    upstreamId !== expectedUpstreamId ||
    resource.monitored !== true
  ) {
    throw new ServarrFixtureFailure("fixture_title_provisioning_invalid");
  }
  return resource.id;
}

async function provisionMediaFixture(context, server, apiKey) {
  const qualityProfiles = await fixtureApiJson(context, server, apiKey, "/api/v3/qualityprofile", {
    stage: "quality_profile_read",
  });
  const qualityProfileId = selectQualityProfileId(qualityProfiles);
  await fixtureApiJson(context, server, apiKey, "/api/v3/rootfolder", {
    body: { path: "/data" },
    method: "POST",
    stage: "root_folder_provisioning",
  });
  const isMovie = context.service === "radarr";
  const resource = await fixtureApiJson(
    context,
    server,
    apiKey,
    isMovie ? "/api/v3/movie" : "/api/v3/series",
    {
      body: isMovie
        ? {
            addOptions: { searchForMovie: false },
            minimumAvailability: "released",
            monitored: true,
            qualityProfileId,
            rootFolderPath: "/data",
            tags: [],
            title: "The Deterministic Meridian",
            tmdbId: FIXTURE_MOVIE_TMDB_ID,
          }
        : {
            addOptions: {
              monitor: "all",
              searchForCutoffUnmetEpisodes: false,
              searchForMissingEpisodes: false,
            },
            monitored: true,
            monitorNewItems: "all",
            qualityProfileId,
            rootFolderPath: "/data",
            seasonFolder: true,
            seriesType: "standard",
            tags: [],
            title: "The Deterministic Signal",
            tvdbId: FIXTURE_SERIES_TVDB_ID,
          },
      method: "POST",
      stage: "fixture_title_create",
    },
  );
  return validateProvisionedMedia(resource, context);
}

async function provisionProwlarrFixture(context, server, apiKey) {
  const [templates, profiles] = await Promise.all([
    fixtureApiJson(context, server, apiKey, "/api/v1/indexer/schema", {
      stage: "indexer_schema_read",
    }),
    fixtureApiJson(context, server, apiKey, "/api/v1/appprofile", {
      stage: "app_profile_read",
    }),
  ]);
  const configured = configureProwlarrFixtureIndexer(templates, selectAppProfileId(profiles));
  const resource = await fixtureApiJson(context, server, apiKey, "/api/v1/indexer?forceSave=true", {
    body: configured,
    method: "POST",
    stage: "fixture_indexer_create",
  });
  if (
    !resource ||
    typeof resource !== "object" ||
    !Number.isInteger(resource.id) ||
    resource.id < 1 ||
    resource.name !== configured.name
  ) {
    throw new ServarrFixtureFailure("fixture_indexer_provisioning_invalid");
  }
  return resource.id;
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

function assertMonitoringState(state, context, mediaId, monitored, failureCode) {
  const expectedKind = context.service === "radarr" ? "movie" : "series";
  if (
    state?.monitored !== monitored ||
    state?.target?.kind !== expectedKind ||
    state.target.mediaId !== mediaId ||
    state.target.service !== context.service
  ) {
    throw new ServarrFixtureFailure(failureCode);
  }
}

export async function readMonitoringStateWithReadback(
  readState,
  monitored,
  {
    attempts = SONARR_MONITORING_READBACK_ATTEMPTS,
    intervalMs = SONARR_MONITORING_READBACK_INTERVAL_MS,
    wait = sleep,
  } = {},
) {
  if (
    typeof readState !== "function" ||
    typeof monitored !== "boolean" ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > SONARR_MONITORING_READBACK_ATTEMPTS ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0 ||
    intervalMs > 1_000 ||
    typeof wait !== "function"
  ) {
    throw new ServarrFixtureFailure("monitoring_readback_policy_invalid");
  }
  let state;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await readState();
    if (state?.monitored === monitored) return state;
    if (attempt < attempts - 1) await wait(intervalMs);
  }
  return state;
}

export async function verifyMonitoringMutation(context, adapter, mediaId, options = {}) {
  const target = { mediaId, service: context.service };
  const readbackOptions = {
    attempts:
      context.service === "sonarr" ? (options.attempts ?? SONARR_MONITORING_READBACK_ATTEMPTS) : 1,
    intervalMs: options.intervalMs ?? SONARR_MONITORING_READBACK_INTERVAL_MS,
    wait: options.wait ?? sleep,
  };
  let updateAttempted = false;
  let updateConfirmed = false;
  try {
    const initial = await connectorOperation("monitoring_read", () =>
      adapter.readAcquisitionMonitoring(target),
    );
    assertMonitoringState(initial, context, mediaId, true, "monitoring_read_invalid");
    updateAttempted = true;
    const updated = await connectorOperation("monitoring_update", () =>
      adapter.updateAcquisitionMonitoring({
        ...target,
        expectedMonitored: true,
        monitored: false,
      }),
    );
    assertMonitoringState(updated, context, mediaId, false, "monitoring_update_invalid");
    updateConfirmed = true;
    const fresh = await connectorOperation("monitoring_fresh_read", () =>
      readMonitoringStateWithReadback(
        () => adapter.readAcquisitionMonitoring(target),
        false,
        readbackOptions,
      ),
    );
    assertMonitoringState(fresh, context, mediaId, false, "monitoring_fresh_read_invalid");
  } finally {
    let restoreRequired = updateConfirmed;
    if (!restoreRequired) {
      const current = await connectorOperation("monitoring_restore_probe", () =>
        readMonitoringStateWithReadback(
          () => adapter.readAcquisitionMonitoring(target),
          false,
          updateAttempted ? readbackOptions : { ...readbackOptions, attempts: 1 },
        ),
      );
      if (typeof current?.monitored !== "boolean") {
        throw new ServarrFixtureFailure("monitoring_restore_probe_invalid");
      }
      assertMonitoringState(
        current,
        context,
        mediaId,
        current.monitored,
        "monitoring_restore_probe_invalid",
      );
      restoreRequired = !current.monitored;
    }
    if (restoreRequired) {
      const restored = await connectorOperation("monitoring_restore", () =>
        adapter.updateAcquisitionMonitoring({
          ...target,
          expectedMonitored: false,
          monitored: true,
        }),
      );
      assertMonitoringState(restored, context, mediaId, true, "monitoring_restore_invalid");
    }
    const finalState = await connectorOperation("monitoring_restore_read", () =>
      readMonitoringStateWithReadback(
        () => adapter.readAcquisitionMonitoring(target),
        true,
        readbackOptions,
      ),
    );
    assertMonitoringState(finalState, context, mediaId, true, "monitoring_restore_read_invalid");
  }
}

async function verifyQueueMutationBoundary(context, adapter, mediaId) {
  const target = { mediaId, service: context.service };
  const initial = await connectorOperation("queue_read", () =>
    adapter.readAcquisitionQueue(target),
  );
  assertEmptyArray(initial, "queue_empty_state_invalid");
  let rejected = false;
  try {
    await adapter.removeAndBlocklistAcquisitionQueueItem(2_147_483_647);
  } catch (error) {
    rejected =
      error?.code === "upstream_error" &&
      error?.operation === "acquisition.queue.remove_and_blocklist" &&
      error?.status === 404;
  }
  if (!rejected) throw new ServarrFixtureFailure("queue_mutation_guard_invalid");
  const finalQueue = await connectorOperation("queue_restore_read", () =>
    adapter.readAcquisitionQueue(target),
  );
  assertEmptyArray(finalQueue, "queue_restore_invalid");
}

async function verifyRadarrOrSonarr(context, server, apiKey, adapter) {
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
  const mediaId = await provisionMediaFixture(context, server, apiKey);
  await verifyMonitoringMutation(context, adapter, mediaId);
  await verifyQueueMutationBoundary(context, adapter, mediaId);
}

async function verifyProwlarr(context, server, apiKey, adapter) {
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
  const indexerId = await provisionProwlarrFixture(context, server, apiKey);
  const provisioned = await connectorOperation("indexer_provisioned_read", () =>
    adapter.readIndexerIntelligencePage({ limit: 25 }),
  );
  if (
    provisioned.items.length !== 1 ||
    provisioned.items[0]?.id !== indexerId ||
    provisioned.summary.total !== 1
  ) {
    throw new ServarrFixtureFailure("indexer_provisioned_read_invalid");
  }
  const result = await connectorOperation("indexer_safe_test", () =>
    adapter.testIndexer(indexerId),
  );
  if (result.indexerId !== indexerId || result.outcome !== "passed") {
    throw new ServarrFixtureFailure("indexer_safe_test_invalid");
  }
}

async function waitForBazarrSubtitleArtifact(context) {
  const deadline = Date.now() + BAZARR_ARTIFACT_TIMEOUT_MS;
  let failureCode = "subtitle_artifact_missing";
  while (Date.now() < deadline) {
    const entries = await readdir(context.dataDirectory);
    const subtitleNames = entries.filter((entry) => entry.toLowerCase().endsWith(".srt"));
    if (subtitleNames.length === 0) {
      failureCode = "subtitle_artifact_missing";
      await sleep(250);
      continue;
    }
    if (subtitleNames.length !== 1 || !subtitleNames[0]) {
      failureCode = "subtitle_artifact_count_invalid";
      await sleep(250);
      continue;
    }
    let subtitleFile;
    try {
      const subtitlePath = resolve(context.dataDirectory, subtitleNames[0]);
      subtitleFile = await open(
        subtitlePath,
        fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW,
      );
      const subtitleMetadata = await subtitleFile.stat();
      if (!subtitleMetadata.isFile() || subtitleMetadata.size > 64 * 1_024) {
        throw new ServarrFixtureFailure("subtitle_artifact_metadata_invalid");
      }
      if (subtitleMetadata.size < 32) {
        throw new ServarrFixtureFailure("subtitle_content_invalid");
      }
      validateBazarrSubtitleArtifact(entries, await subtitleFile.readFile("utf8"));
      return;
    } catch (error) {
      failureCode =
        error instanceof ServarrFixtureFailure ? error.code : "subtitle_artifact_read_invalid";
      await sleep(250);
    } finally {
      await subtitleFile?.close();
    }
  }
  throw new ServarrFixtureFailure(failureCode);
}

async function verifyBazarr(context, adapter) {
  const emptyLibrary = await adapter
    .searchSubtitles({ kind: "movie", title: BAZARR_FIXTURE_TITLE, year: BAZARR_FIXTURE_YEAR })
    .then(
      () => false,
      (error) => error instanceof BazarrTargetError && error.reason === "not_found",
    );
  if (!emptyLibrary) throw new ServarrFixtureFailure("empty_library_read_invalid");

  await connectorOperation("fixture_media_provisioning", () => provisionBazarrFixture(context));
  await waitForResult(async () => {
    const health = await adapter.probe();
    return health.status === "healthy" ? health : null;
  }, "bazarr_restart_timeout");
  const result = await connectorOperation("subtitle_search", () =>
    adapter.searchSubtitles({
      kind: "movie",
      title: BAZARR_FIXTURE_TITLE,
      year: BAZARR_FIXTURE_YEAR,
    }),
  );
  const candidate = result.candidates[0];
  if (result.target.kind !== "movie" || result.target.radarrId !== 1) {
    throw new ServarrFixtureFailure("subtitle_target_invalid");
  }
  if (result.candidates.length !== 1 || !candidate) {
    throw new ServarrFixtureFailure("subtitle_candidate_count_invalid");
  }
  if (candidate.provider !== "embeddedsubtitles") {
    throw new ServarrFixtureFailure("subtitle_provider_invalid");
  }
  if (!new Set(["en", "eng", "english"]).has(candidate.language.toLocaleLowerCase("en-US"))) {
    throw new ServarrFixtureFailure("subtitle_language_invalid");
  }
  await connectorOperation("subtitle_download", () =>
    adapter.downloadSubtitle(result.target, candidate),
  );
  await waitForBazarrSubtitleArtifact(context);
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
    await verifyBazarr(context, adapter);
  } else if (context.service === "prowlarr") {
    await verifyProwlarr(context, server, apiKey, adapter);
  } else {
    await verifyRadarrOrSonarr(context, server, apiKey, adapter);
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
  if (context.fixtureServerCreated) {
    try {
      runDocker(
        ["rm", "--force", context.fixtureServerName],
        30_000,
        "fixture_server_teardown_failed",
      );
      context.fixtureServerCreated = false;
    } catch (error) {
      failure ??= error;
      bestEffortDocker(["rm", "--force", context.fixtureServerName]);
    }
  } else {
    bestEffortDocker(["rm", "--force", context.fixtureServerName]);
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
    const server = await startContainer(context);
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
