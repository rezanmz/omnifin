import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  DOWNLOAD_CLIENT_IMAGES,
  containerIsolationArguments,
  createQBittorrentFixture,
  parsePublishedPort,
  readQBittorrentTemporaryPassword,
  readSabnzbdApiKey,
  validateSanitizedReport,
} from "../integration/download-clients.mjs";

const QBITTORRENT_IMAGE_PATTERN =
  /^ghcr\.io\/linuxserver\/qbittorrent:5\.2\.0_v2\.0\.12-ls454@sha256:[a-f0-9]{64}$/u;
const SABNZBD_IMAGE_PATTERN = /^ghcr\.io\/linuxserver\/sabnzbd:5\.0\.4-ls263@sha256:[a-f0-9]{64}$/u;

test("pins exact current download-client images by immutable index digest", () => {
  assert.match(DOWNLOAD_CLIENT_IMAGES.qbittorrent, QBITTORRENT_IMAGE_PATTERN);
  assert.match(DOWNLOAD_CLIENT_IMAGES.sabnzbd, SABNZBD_IMAGE_PATTERN);
});

test("runs LinuxServer fixtures as the host user with a private writable runtime", () => {
  const arguments_ = containerIsolationArguments(1001, 127);

  assert.deepEqual(arguments_, [
    "--user",
    "1001:127",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/run:uid=1001,gid=127,exec",
  ]);
  assert.equal(
    arguments_.some((argument) => argument.startsWith("PUID=")),
    false,
  );
  assert.equal(
    arguments_.some((argument) => argument.startsWith("PGID=")),
    false,
  );
});

test("creates one deterministic, tracker-isolated torrent fixture", () => {
  const first = createQBittorrentFixture();
  const second = createQBittorrentFixture();

  assert.deepEqual(first, second);
  assert.equal(first.fileName, "Omnifin Fixture.bin");
  assert.match(first.infoHash, /^[a-f0-9]{40}$/u);
  assert.equal(first.payload.byteLength, 48);
  assert.equal(first.torrent.subarray(0, 1).toString("utf8"), "d");
  assert.equal(first.torrent.includes(Buffer.from("http://127.0.0.1:1/announce")), true);
  assert.equal(first.torrent.includes(Buffer.from(first.fileName)), true);
});

test("extracts one bounded temporary qBittorrent credential without accepting ambiguity", () => {
  const line =
    "The WebUI administrator password was not set. A temporary password is provided for this session: A9_fixture-Password";
  assert.equal(
    readQBittorrentTemporaryPassword(`startup\n${line}\nready\n`),
    "A9_fixture-Password",
  );
  assert.throws(
    () => readQBittorrentTemporaryPassword(`${line}\n${line.replace("A9_", "B8_")}\n`),
    /credential_log_invalid/u,
  );
  assert.throws(
    () => readQBittorrentTemporaryPassword("temporary password: private\n"),
    /credential_log_invalid/u,
  );
});

test("reads one bounded SABnzbd API key from its private generated configuration", () => {
  assert.equal(
    readSabnzbdApiKey("[misc]\napi_key = 0123456789abcdef0123456789abcdef\nport = 8080\n"),
    "0123456789abcdef0123456789abcdef",
  );
  assert.throws(() => readSabnzbdApiKey("[misc]\napi_key = short\n"), /credential_config_invalid/u);
  assert.throws(
    () =>
      readSabnzbdApiKey(
        "[misc]\napi_key = 0123456789abcdef0123456789abcdef\napi_key = fedcba9876543210fedcba9876543210\n",
      ),
    /credential_config_invalid/u,
  );
});

test("parses only a valid Docker-published port", () => {
  assert.equal(parsePublishedPort("0.0.0.0:49153\n[::]:49153\n"), 49_153);
  assert.equal(parsePublishedPort("127.0.0.1:32768\n"), 32_768);
  assert.throws(() => parsePublishedPort("0.0.0.0:0\n"), /container_port_invalid/u);
  assert.throws(
    () => parsePublishedPort("0.0.0.0:49153\n0.0.0.0:49154\n"),
    /container_port_invalid/u,
  );
});

test("accepts only identifier-free, path-free fixture evidence", () => {
  const report = validateSanitizedReport({
    checks: {
      authentication: "passed",
      credentialRejection: "passed",
      exactPause: "passed",
      exactResume: "passed",
      preserveFilesRemoval: "passed",
      queueRead: "passed",
    },
    image: DOWNLOAD_CLIENT_IMAGES.qbittorrent,
    schemaVersion: 1,
    serverVersion: "5.2.0",
    service: "qbittorrent",
    status: "passed",
  });
  assert.equal(report.status, "passed");

  assert.throws(
    () => validateSanitizedReport({ ...report, externalId: "a".repeat(40) }),
    /report_invalid/u,
  );
  assert.throws(
    () => validateSanitizedReport({ ...report, serverVersion: "5.2.1" }),
    /report_invalid/u,
  );
  assert.throws(
    () =>
      validateSanitizedReport({
        ...report,
        checks: { ...report.checks, path: "/downloads/private" },
      }),
    /report_invalid/u,
  );
});

test("the protected connector aggregate runs both isolated download clients", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/integration.yml", import.meta.url), "utf8"),
  );
  const fixture = workflow.jobs["download-client-fixtures"];
  assert.equal(fixture.name, "Isolated download-client integration (${{ matrix.service }})");
  assert.equal(fixture["timeout-minutes"], 20);
  assert.deepEqual(fixture.strategy.matrix.service, ["qbittorrent", "sabnzbd"]);
  assert.equal(fixture.strategy["fail-fast"], false);
  assert.equal(JSON.stringify(fixture).includes("secrets."), false);
  const build = fixture.steps.find((step) => step.name === "Build download connectors");
  assert.equal(build.run, "pnpm --filter @omnifin/connectors... build");
  const exercise = fixture.steps.find((step) => step.name === "Exercise isolated download queue");
  assert.match(exercise.run, /--service "\$OMNIFIN_DOWNLOAD_CLIENT"/u);
  assert.match(exercise.run, /download-clients\/\$OMNIFIN_DOWNLOAD_CLIENT\/report\.json/u);
  assert.ok(workflow.jobs.gate.needs.includes("download-client-fixtures"));
});
