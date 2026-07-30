import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  SERVARR_FIXTURE_SERVER_IMAGE,
  SERVARR_SERVICE_IMAGES,
  SERVARR_SERVICE_VERSIONS,
  configureProwlarrFixtureIndexer,
  containerIsolationArguments,
  createCurlHeaderConfiguration,
  fixtureServerContainerArguments,
  parseBazarrApiKey,
  parseContainerAddress,
  parseContainerState,
  parseServarrApiKey,
  selectQualityProfileId,
  validateSanitizedServarrFailureReport,
  validateSanitizedServarrReport,
} from "../integration/servarr-services.mjs";

const EXPECTED_IMAGE_PATTERNS = Object.freeze({
  bazarr: /^ghcr\.io\/linuxserver\/bazarr:v1\.6\.0-ls356@sha256:[a-f0-9]{64}$/u,
  prowlarr: /^ghcr\.io\/linuxserver\/prowlarr:2\.5\.2\.5491-ls155@sha256:[a-f0-9]{64}$/u,
  radarr: /^ghcr\.io\/linuxserver\/radarr:6\.3\.0\.10514-ls312@sha256:[a-f0-9]{64}$/u,
  sonarr: /^ghcr\.io\/linuxserver\/sonarr:4\.0\.19\.2979-ls320@sha256:[a-f0-9]{64}$/u,
});

const EXPECTED_CHECKS = Object.freeze({
  bazarr: ["authentication", "credentialRejection", "emptyLibraryRead", "versionDiscovery"],
  prowlarr: [
    "applicationRead",
    "authentication",
    "credentialRejection",
    "failureRead",
    "fixtureIndexerProvisioning",
    "indexerRead",
    "indexerSafeTest",
    "systemHealthRead",
    "versionDiscovery",
  ],
  radarr: [
    "authentication",
    "calendarRead",
    "credentialRejection",
    "fixtureTitleProvisioning",
    "monitoringRead",
    "monitoringRestore",
    "monitoringUpdate",
    "storageRead",
    "systemHealthRead",
    "versionDiscovery",
  ],
  sonarr: [
    "authentication",
    "calendarRead",
    "credentialRejection",
    "fixtureTitleProvisioning",
    "monitoringRead",
    "monitoringRestore",
    "monitoringUpdate",
    "storageRead",
    "systemHealthRead",
    "versionDiscovery",
  ],
});

function passingReport(service) {
  return {
    checks: Object.fromEntries(EXPECTED_CHECKS[service].map((name) => [name, "passed"])),
    image: SERVARR_SERVICE_IMAGES[service],
    schemaVersion: 1,
    serverVersion: SERVARR_SERVICE_VERSIONS[service],
    service,
    status: "passed",
  };
}

test("pins exact current service images by immutable index digest", () => {
  assert.deepEqual(Object.keys(SERVARR_SERVICE_IMAGES).sort(), [
    "bazarr",
    "prowlarr",
    "radarr",
    "sonarr",
  ]);
  for (const [service, image] of Object.entries(SERVARR_SERVICE_IMAGES)) {
    assert.match(image, EXPECTED_IMAGE_PATTERNS[service]);
  }
  assert.match(
    SERVARR_FIXTURE_SERVER_IMAGE,
    /^docker\.io\/library\/node:24\.18\.0-trixie-slim@sha256:[a-f0-9]{64}$/u,
  );
});

test("runs LinuxServer fixtures as the host user with a private writable runtime", () => {
  assert.deepEqual(containerIsolationArguments(1001, 127), [
    "--user",
    "1001:127",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/run:uid=1001,gid=127,exec",
  ]);
  assert.throws(() => containerIsolationArguments(-1, 127), /host_identity_unavailable/u);
});

test("runs the mutation sidecar read-only on the internal network without published ports", () => {
  const arguments_ = fixtureServerContainerArguments({
    fixtureServerName: "fixture-server",
    networkName: "fixture-network",
    tlsDirectory: "/tmp/fixture-tls",
  });
  assert.ok(arguments_.includes("--read-only"));
  assert.deepEqual(
    arguments_.slice(arguments_.indexOf("--cap-drop"), arguments_.indexOf("--cap-drop") + 2),
    ["--cap-drop", "ALL"],
  );
  assert.ok(arguments_.includes("--network-alias"));
  assert.ok(arguments_.includes("api.radarr.video"));
  assert.ok(arguments_.includes("skyhook.sonarr.tv"));
  assert.ok(arguments_.includes("fixture-indexer"));
  assert.ok(arguments_.includes(SERVARR_FIXTURE_SERVER_IMAGE));
  assert.ok(arguments_.some((argument) => argument.includes("server.crt")));
  assert.ok(arguments_.some((argument) => argument.includes("server.key")));
  assert.equal(
    arguments_.some((argument) => argument.includes("ca.key")),
    false,
  );
  assert.equal(arguments_.includes("--publish"), false);
  assert.equal(arguments_.includes("-p"), false);
  assert.deepEqual(arguments_.slice(1, 3), ["--pull", "never"]);

  const source = readFileSync(
    new URL("../integration/servarr-fixture-server.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("request("), false);
});

test("accepts only one running state and one private fixture address", () => {
  assert.equal(parseContainerState("true:0\n"), true);
  assert.throws(() => parseContainerState("false:1\n"), /container_exited/u);
  assert.equal(parseContainerAddress("172.18.0.2\n"), "172.18.0.2");
  assert.throws(() => parseContainerAddress("127.0.0.1\n"), /container_address_invalid/u);
  assert.throws(
    () => parseContainerAddress("172.18.0.2 172.18.0.3\n"),
    /container_address_invalid/u,
  );
});

test("reads one bounded API key from Servarr and Bazarr configuration", () => {
  const apiKey = "0123456789abcdef0123456789abcdef";
  assert.equal(parseServarrApiKey(`<Config><ApiKey>${apiKey}</ApiKey></Config>`), apiKey);
  assert.equal(parseBazarrApiKey(`auth:\n  apikey: ${apiKey}\n`), apiKey);
  assert.throws(
    () => parseServarrApiKey(`<ApiKey>${apiKey}</ApiKey><ApiKey>${apiKey}</ApiKey>`),
    /credential_config_invalid/u,
  );
  assert.throws(() => parseBazarrApiKey("auth:\n  apikey: short\n"), /credential_config_invalid/u);
});

test("keeps container-local request headers out of subprocess arguments", () => {
  const configuration = createCurlHeaderConfiguration(
    new Headers({ "X-Api-Key": 'private"value\\suffix' }),
  ).toString("utf8");
  assert.equal(configuration, 'header = "x-api-key: private\\"value\\\\suffix"\n');
  assert.equal(configuration.includes("\r"), false);
  assert.equal(
    createCurlHeaderConfiguration(
      new Headers({ "content-type": "application/json" }),
      '{"monitored":false}',
    ).toString("utf8"),
    'header = "content-type: application/json"\ndata-binary = "{\\"monitored\\":false}"\n',
  );
  assert.throws(
    () => createCurlHeaderConfiguration(new Headers(), "unsafe\nbody"),
    /fixture_body_invalid/u,
  );
});

test("selects one bounded quality profile without publishing its identifier", () => {
  assert.equal(selectQualityProfileId([{ id: 7 }, { id: 2 }]), 2);
  assert.throws(() => selectQualityProfileId([]), /quality_profile_invalid/u);
  assert.throws(() => selectQualityProfileId([{ id: "1" }]), /quality_profile_invalid/u);
});

test("configures only the private Newznab fixture fields", () => {
  const configured = configureProwlarrFixtureIndexer([
    {
      configContract: "NewznabSettings",
      enable: false,
      fields: [
        { name: "baseUrl", value: "https://public.invalid" },
        { name: "apiPath", value: "/public" },
        { name: "apiKey", value: "private" },
        { name: "categories", value: [2000, 5000] },
      ],
      implementation: "Newznab",
      name: "Newznab",
    },
  ]);
  assert.equal(configured.enable, true);
  assert.equal(configured.enableRss, false);
  assert.equal(configured.enableAutomaticSearch, false);
  assert.equal(configured.enableInteractiveSearch, true);
  assert.equal(configured.redirect, true);
  assert.equal(
    configured.fields.find((field) => field.name === "baseUrl").value,
    "http://fixture-indexer:8080",
  );
  assert.equal(configured.fields.find((field) => field.name === "apiPath").value, "/api");
  assert.equal(configured.fields.find((field) => field.name === "apiKey").value, "");
  assert.deepEqual(
    configured.fields.find((field) => field.name === "categories").value,
    [2000, 5000],
  );
  assert.throws(
    () => configureProwlarrFixtureIndexer([{ implementation: "Torznab", fields: [] }]),
    /indexer_schema_invalid/u,
  );
});

test("accepts only closed reports without identifiers, paths, ports, or credentials", () => {
  for (const service of Object.keys(SERVARR_SERVICE_IMAGES)) {
    const report = validateSanitizedServarrReport(passingReport(service));
    assert.equal(report.service, service);
    assert.throws(
      () => validateSanitizedServarrReport({ ...report, apiKey: "a".repeat(32) }),
      /report_invalid/u,
    );
    assert.throws(
      () =>
        validateSanitizedServarrReport({
          ...report,
          checks: { ...report.checks, privatePath: "passed" },
        }),
      /report_invalid/u,
    );
    assert.throws(
      () => validateSanitizedServarrReport({ ...report, serverVersion: "0.0.0" }),
      /report_invalid/u,
    );
  }
});

test("accepts only bounded failure evidence", () => {
  assert.deepEqual(
    validateSanitizedServarrFailureReport({
      code: "calendar_read_response_invalid",
      schemaVersion: 1,
      service: "radarr",
      status: "failed",
    }),
    {
      code: "calendar_read_response_invalid",
      schemaVersion: 1,
      service: "radarr",
      status: "failed",
    },
  );
  assert.throws(
    () =>
      validateSanitizedServarrFailureReport({
        code: "failed: private/path",
        schemaVersion: 1,
        service: "radarr",
        status: "failed",
      }),
    /failure_report_invalid/u,
  );
});

test("the protected connector aggregate runs every isolated service", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/integration.yml", import.meta.url), "utf8"),
  );
  const fixture = workflow.jobs["servarr-service-fixtures"];
  assert.equal(fixture.name, "Isolated service integration (${{ matrix.service }})");
  assert.equal(fixture["timeout-minutes"], 20);
  assert.deepEqual(fixture.strategy.matrix.service, ["radarr", "sonarr", "prowlarr", "bazarr"]);
  assert.equal(fixture.strategy["fail-fast"], false);
  assert.equal(fixture.strategy["max-parallel"], 2);
  assert.equal(JSON.stringify(fixture).includes("secrets."), false);
  const build = fixture.steps.find((step) => step.name === "Build service connectors");
  assert.equal(build.run, "pnpm --filter @omnifin/connectors... build");
  const exercise = fixture.steps.find(
    (step) => step.name === "Exercise isolated service reads and safe mutations",
  );
  assert.match(exercise.run, /--service "\$OMNIFIN_SERVARR_SERVICE"/u);
  assert.match(exercise.run, /servarr-services\/\$OMNIFIN_SERVARR_SERVICE\/report\.json/u);
  const diagnostics = fixture.steps.find(
    (step) => step.name === "Report sanitized fixture failure",
  );
  assert.equal(diagnostics.if, "failure()");
  assert.match(diagnostics.run, /failure_report_invalid/u);
  assert.match(diagnostics.run, /::error title=Service fixture::/u);
  assert.ok(workflow.jobs.gate.needs.includes("servarr-service-fixtures"));
});
