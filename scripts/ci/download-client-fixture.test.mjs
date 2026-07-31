import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  DOWNLOAD_CLIENT_IMAGES,
  containerIsolationArguments,
  createQBittorrentAuthenticationFixture,
  createQBittorrentFixture,
  parseContainerAddress,
  parseContainerState,
  readSabnzbdApiKey,
  serviceEnvironmentArguments,
  validateQBittorrentAddResponse,
  validateSanitizedFailureReport,
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
    "--cap-drop",
    "ALL",
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

test("accepts only one private container address from the isolated network", () => {
  assert.equal(parseContainerAddress("172.18.0.2\n"), "172.18.0.2");
  assert.equal(parseContainerAddress("10.20.0.4\n"), "10.20.0.4");
  assert.throws(() => parseContainerAddress("127.0.0.1\n"), /container_address_invalid/u);
  assert.throws(
    () => parseContainerAddress("172.18.0.2 172.18.0.3\n"),
    /container_address_invalid/u,
  );
});

test("accepts only a running disposable container state", () => {
  assert.equal(parseContainerState("true:0\n"), true);
  assert.throws(() => parseContainerState("false:1\n"), /container_exited/u);
  assert.throws(() => parseContainerState("private diagnostics\n"), /container_state_invalid/u);
});

test("passes qBittorrent's documented internal service ports explicitly", () => {
  assert.deepEqual(serviceEnvironmentArguments("qbittorrent"), [
    "--env",
    "WEBUI_PORT=8080",
    "--env",
    "TORRENTING_PORT=6881",
  ]);
  assert.deepEqual(serviceEnvironmentArguments("sabnzbd"), []);
  assert.throws(() => serviceEnvironmentArguments("other"), /service_invalid/u);
});

test("creates deterministic, distinct, tracker-isolated torrent fixtures", () => {
  const first = createQBittorrentFixture();
  const second = createQBittorrentFixture();

  assert.deepEqual(first, second);
  assert.equal(first.fileName, "Omnifin Fixture.bin");
  assert.match(first.infoHash, /^[a-f0-9]{40}$/u);
  assert.equal(first.payload.byteLength, 48);
  assert.equal(first.torrent.subarray(0, 1).toString("utf8"), "d");
  assert.equal(first.torrent.includes(Buffer.from("http://127.0.0.1:1/announce")), true);
  assert.equal(first.torrent.includes(Buffer.from(first.fileName)), true);
  const anchor = createQBittorrentFixture("anchor");
  assert.notEqual(anchor.infoHash, first.infoHash);
  assert.equal(anchor.fileName, "Omnifin Queue Anchor.bin");
  assert.throws(() => createQBittorrentFixture("other"), /torrent_fixture_invalid/u);
});

test("accepts only qBittorrent's legacy or exact current add response", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(validateQBittorrentAddResponse(200, "Ok.", hash), true);
  assert.equal(
    validateQBittorrentAddResponse(
      200,
      JSON.stringify({
        added_torrent_ids: [hash],
        failure_count: 0,
        pending_count: 0,
        success_count: 1,
      }),
      hash,
    ),
    true,
  );
  assert.equal(
    validateQBittorrentAddResponse(
      200,
      JSON.stringify({
        added_torrent_ids: ["f".repeat(40)],
        failure_count: 0,
        pending_count: 0,
        success_count: 1,
      }),
      hash,
    ),
    false,
  );
  assert.equal(validateQBittorrentAddResponse(204, "", hash), false);
});

test("creates a qBittorrent credential using its exact bounded PBKDF2 format", () => {
  const password = "fixture-password-23456789";
  const salt = Buffer.alloc(16, 0x2a);
  const fixture = createQBittorrentAuthenticationFixture(password, salt);
  const encoded = fixture.configuration.match(
    /WebUI\\Password_PBKDF2="@ByteArray\(([^:]+):([^\)]+)\)"/u,
  );

  assert.equal(fixture.username, "omnifin-fixture");
  assert.equal(fixture.password, password);
  assert.equal(fixture.configuration.includes(password), false);
  assert.equal(fixture.configuration.includes("[LegalNotice]\nAccepted=true"), true);
  assert.deepEqual(Buffer.from(encoded?.[1] ?? "", "base64"), salt);
  assert.deepEqual(
    Buffer.from(encoded?.[2] ?? "", "base64"),
    pbkdf2Sync(password, salt, 100_000, 64, "sha512"),
  );
  assert.throws(
    () => createQBittorrentAuthenticationFixture("unsafe password", salt),
    /credential_fixture_invalid/u,
  );
  assert.throws(
    () => createQBittorrentAuthenticationFixture(password, Buffer.alloc(15)),
    /credential_fixture_invalid/u,
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

test("accepts only identifier-free, path-free fixture evidence", () => {
  const report = validateSanitizedReport({
    checks: {
      authentication: "passed",
      credentialRejection: "passed",
      exactPause: "passed",
      exactPromotion: "passed",
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

test("accepts only bounded failure evidence without upstream details", () => {
  const report = validateSanitizedFailureReport({
    code: "exact_resume_upstream_error",
    schemaVersion: 1,
    service: "qbittorrent",
    status: "failed",
  });
  assert.deepEqual(report, {
    code: "exact_resume_upstream_error",
    schemaVersion: 1,
    service: "qbittorrent",
    status: "failed",
  });

  assert.throws(
    () => validateSanitizedFailureReport({ ...report, path: "/downloads/private" }),
    /failure_report_invalid/u,
  );
  assert.throws(
    () => validateSanitizedFailureReport({ ...report, code: "password=private" }),
    /failure_report_invalid/u,
  );
  assert.equal(
    validateSanitizedFailureReport({ ...report, code: "authentication_cookie_invalid" }).code,
    "authentication_cookie_invalid",
  );
  assert.equal(
    validateSanitizedFailureReport({ ...report, code: "authentication_rejected" }).code,
    "authentication_rejected",
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
  const diagnostics = fixture.steps.find(
    (step) => step.name === "Report sanitized fixture failure",
  );
  assert.equal(diagnostics.if, "failure()");
  assert.match(diagnostics.run, /failure_report_invalid/u);
  assert.match(diagnostics.run, /::error title=Download client fixture::/u);
  assert.ok(workflow.jobs.gate.needs.includes("download-client-fixtures"));
});
