import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  SEERR_CHECK_NAMES,
  SEERR_FIXTURE_SERVER_IMAGE,
  SEERR_SERVICE_IMAGE,
  SEERR_SERVICE_VERSION,
  createSeerrContainerTransport,
  parseSeerrContainerState,
  parseSeerrTransportOutput,
  seerrContainerIsolationArguments,
  seerrDatabaseSeedArguments,
  seerrFixtureServerContainerArguments,
  seerrServiceContainerArguments,
  serializeSeerrContainerRequest,
  validateSanitizedSeerrFailureReport,
  validateSanitizedSeerrReport,
} from "../integration/seerr-service.mjs";
import {
  SEERR_FIXTURE_TMDB_ID,
  handleSeerrMetadataRequest,
  seerrMovieFixture,
} from "../integration/seerr-fixture-server.mjs";

const context = Object.freeze({
  configDirectory: "/tmp/seerr-config",
  containerName: "seerr-fixture",
  environmentPath: "/tmp/seerr.env",
  fixtureServerName: "seerr-metadata",
  networkName: "seerr-network",
  tlsDirectory: "/tmp/seerr-tls",
});

function passingReport() {
  return {
    checks: Object.fromEntries(SEERR_CHECK_NAMES.map((name) => [name, "passed"])),
    image: SEERR_SERVICE_IMAGE,
    schemaVersion: 1,
    serverVersion: SEERR_SERVICE_VERSION,
    service: "seerr",
    status: "passed",
  };
}

function responseRecorder() {
  const result = { body: "", headers: undefined, status: undefined };
  return {
    response: {
      end(body) {
        result.body = body;
      },
      writeHead(status, headers) {
        result.headers = headers;
        result.status = status;
      },
    },
    result,
  };
}

test("pins current official Seerr and fixture images by immutable index digest", () => {
  assert.match(SEERR_SERVICE_IMAGE, /^ghcr\.io\/seerr-team\/seerr:v3\.4\.1@sha256:[a-f0-9]{64}$/u);
  assert.match(
    SEERR_FIXTURE_SERVER_IMAGE,
    /^docker\.io\/library\/node:24\.18\.0-trixie-slim@sha256:[a-f0-9]{64}$/u,
  );
  assert.equal(SEERR_SERVICE_VERSION, "3.4.1");
});

test("runs both services as the host identity without privilege escalation", () => {
  assert.deepEqual(seerrContainerIsolationArguments(1001, 127), [
    "--user",
    "1001:127",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
  ]);
  assert.throws(() => seerrContainerIsolationArguments(-1, 127), /host_identity_unavailable/u);
});

test("keeps Seerr private and passes credentials through an env file", () => {
  const arguments_ = seerrServiceContainerArguments(context);
  assert.deepEqual(arguments_.slice(0, 3), ["run", "--pull", "never"]);
  assert.ok(arguments_.includes("--init"));
  assert.ok(arguments_.includes("--env-file"));
  assert.ok(arguments_.includes(context.environmentPath));
  assert.equal(arguments_.includes("--publish"), false);
  assert.equal(arguments_.includes("-p"), false);
  assert.equal(
    arguments_.some((argument) => argument.startsWith("API_KEY=")),
    false,
  );
  assert.ok(arguments_.includes(SEERR_SERVICE_IMAGE));
  assert.ok(arguments_.some((argument) => argument.includes("seerr-container-request.mjs")));
  assert.ok(arguments_.some((argument) => argument.includes("ca.crt")));
});

test("runs the metadata sidecar read-only under the exact public hostname on the private network", () => {
  const arguments_ = seerrFixtureServerContainerArguments(context);
  assert.ok(arguments_.includes("--read-only"));
  assert.ok(arguments_.includes("--network-alias"));
  assert.ok(arguments_.includes("api.themoviedb.org"));
  assert.ok(arguments_.includes(SEERR_FIXTURE_SERVER_IMAGE));
  assert.equal(arguments_.includes("--publish"), false);
  assert.equal(arguments_.includes("-p"), false);
  assert.equal(
    arguments_.some((argument) => argument.includes("ca.key")),
    false,
  );
});

test("seeds only a stopped local database with no network or secret arguments", () => {
  const arguments_ = seerrDatabaseSeedArguments(context);
  assert.ok(arguments_.includes("none"));
  assert.ok(arguments_.includes("--read-only"));
  assert.ok(arguments_.includes("--entrypoint"));
  assert.ok(arguments_.includes("node"));
  assert.ok(arguments_.some((argument) => argument.includes("seerr-database-seed.mjs")));
  assert.equal(arguments_.includes("--env-file"), false);
  assert.equal(arguments_.includes("--publish"), false);
  assert.equal(arguments_.includes("-p"), false);
  assert.equal(
    arguments_.some((argument) => /api[_-]?key|password|token/iu.test(argument)),
    false,
  );

  const source = readFileSync(
    new URL("../integration/seerr-database-seed.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /PRAGMA table_info\("user"\)/u);
  assert.match(source, /SELECT COUNT\(\*\) AS count FROM "user"/u);
  assert.match(source, /BEGIN IMMEDIATE/u);
  assert.equal(source.includes("fetch("), false);
});

test("uses the supported Docker stop timeout flag", () => {
  const source = readFileSync(new URL("../integration/seerr-service.mjs", import.meta.url), "utf8");

  assert.match(source, /\["stop", "--timeout", "20", context\.containerName\]/u);
  assert.doesNotMatch(source, /\["stop", "--time",/u);
});

test("serves one bounded copyright-free movie only on the exact TMDB route", () => {
  const movie = seerrMovieFixture();
  assert.equal(movie.id, SEERR_FIXTURE_TMDB_ID);
  assert.equal(movie.title, "The Deterministic Horizon");
  assert.deepEqual(movie.credits, { cast: [], crew: [] });
  assert.deepEqual(movie.keywords, { keywords: [] });
  assert.ok(JSON.stringify(movie).length < 4_096);

  const accepted = responseRecorder();
  handleSeerrMetadataRequest(
    {
      headers: { host: "api.themoviedb.org" },
      method: "GET",
      url: `/3/movie/${SEERR_FIXTURE_TMDB_ID}?api_key=fixture&language=en&append_to_response=credits`,
    },
    accepted.response,
  );
  assert.equal(accepted.result.status, 200);
  assert.equal(JSON.parse(accepted.result.body).id, SEERR_FIXTURE_TMDB_ID);

  const rejected = responseRecorder();
  handleSeerrMetadataRequest(
    {
      headers: { host: "api.themoviedb.org" },
      method: "GET",
      url: `/3/movie/${SEERR_FIXTURE_TMDB_ID}?api_key=fixture&language=en&redirect=https://example.test`,
    },
    rejected.response,
  );
  assert.equal(rejected.result.status, 404);

  const source = readFileSync(
    new URL("../integration/seerr-fixture-server.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("request("), false);
});

test("container transport is bounded and reconstructs only a validated response", () => {
  const response = parseSeerrTransportOutput(
    JSON.stringify({
      body: Buffer.from('{"status":"ok"}').toString("base64"),
      headers: [["content-type", "application/json"]],
      status: 200,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.toString("utf8"), '{"status":"ok"}');
  assert.throws(
    () => parseSeerrTransportOutput('{"body":"***","headers":[],"status":200}'),
    /fixture_transport_invalid/u,
  );
  assert.throws(
    () => parseSeerrTransportOutput('{"body":"","headers":[],"status":700}'),
    /fixture_transport_invalid/u,
  );
  assert.throws(
    () =>
      parseSeerrTransportOutput(
        '{"body":"","headers":[["content-type","application/json\\r\\nx-private: value"]],"status":200}',
      ),
    /fixture_transport_invalid/u,
  );

  const source = readFileSync(
    new URL("../integration/seerr-container-request.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /http:\/\/127\.0\.0\.1:5055\//u);
  assert.equal(source.includes("https://"), false);
  assert.match(source, /Buffer\.from\(payload\.body, "base64"\)/u);

  const transportSource = readFileSync(
    new URL("../integration/seerr-service.mjs", import.meta.url),
    "utf8",
  );
  assert.match(transportSource, /Buffer\.from\(init\.body\)\.toString\("base64"\)/u);
  assert.equal(typeof createSeerrContainerTransport, "function");

  const encoded = JSON.parse(
    serializeSeerrContainerRequest(new URL("http://fixture.invalid/api/v1/request"), {
      body: Buffer.from('{"mediaId":2147480003}', "utf8"),
      headers: new Headers({ "content-type": "application/json" }),
      method: "POST",
    }),
  );
  assert.equal(Buffer.from(encoded.body, "base64").toString("utf8"), '{"mediaId":2147480003}');
  assert.equal(encoded.path, "/api/v1/request");
});

test("validates only closed sanitized Seerr reports", () => {
  assert.deepEqual(validateSanitizedSeerrReport(passingReport()), passingReport());
  assert.throws(
    () => validateSanitizedSeerrReport({ ...passingReport(), nativeRequestId: 1 }),
    /report_invalid/u,
  );
  assert.throws(
    () =>
      validateSanitizedSeerrReport({
        ...passingReport(),
        checks: { ...passingReport().checks, authentication: "skipped" },
      }),
    /report_invalid/u,
  );
  assert.deepEqual(
    validateSanitizedSeerrFailureReport({
      code: "request_review_invalid",
      schemaVersion: 1,
      service: "seerr",
      status: "failed",
    }),
    {
      code: "request_review_invalid",
      schemaVersion: 1,
      service: "seerr",
      status: "failed",
    },
  );
});

test("parses only explicit running container state", () => {
  assert.equal(parseSeerrContainerState("true:0\n"), true);
  assert.throws(() => parseSeerrContainerState("false:1"), /container_exited/u);
  assert.throws(() => parseSeerrContainerState("true"), /container_state_invalid/u);
});

test("the protected connector aggregate requires the isolated Seerr mutation", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/integration.yml", import.meta.url), "utf8"),
  );
  const fixture = workflow.jobs["seerr-service-fixture"];
  assert.equal(fixture.name, "Isolated Seerr request integration");
  assert.equal(fixture["timeout-minutes"], 20);
  assert.equal(JSON.stringify(fixture).includes("secrets."), false);
  const build = fixture.steps.find((step) => step.name === "Build Seerr connector");
  assert.equal(build.run, "pnpm --filter @omnifin/connectors... build");
  const exercise = fixture.steps.find(
    (step) => step.name === "Exercise isolated Seerr request mutation",
  );
  assert.match(exercise.run, /pnpm fixture:seerr-service/u);
  assert.match(exercise.run, /artifacts\/integration\/seerr-service\/report\.json/u);
  const diagnostics = fixture.steps.find(
    (step) => step.name === "Report sanitized Seerr fixture failure",
  );
  assert.equal(diagnostics.if, "failure()");
  assert.match(diagnostics.run, /failure_report_invalid/u);
  assert.match(diagnostics.run, /::error title=Seerr fixture::/u);
  assert.ok(workflow.jobs.gate.needs.includes("seerr-service-fixture"));
});
