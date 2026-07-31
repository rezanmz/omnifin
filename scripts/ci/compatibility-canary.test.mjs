import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  COMPATIBILITY_SERVICES,
  COMPATIBILITY_TARGET_DEFINITIONS,
  applyCompatibilityTargetOverride,
  resolveCompatibilityTargets,
  validateCompatibilityTargets,
} from "../integration/compatibility-targets.mjs";
import {
  COMPATIBILITY_CHECKS,
  aggregateCompatibilityReports,
  canonicalCompatibilityReport,
  validateAggregateCompatibilityReport,
} from "../integration/compatibility-report.mjs";
import { teardownMatches } from "../integration/compatibility-service.mjs";

const DIGESTS = Object.fromEntries(
  COMPATIBILITY_SERVICES.map((service, index) => [
    service,
    `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
  ]),
);

const TAGS = Object.freeze({
  authentik: "2026.5.6",
  bazarr: "v1.6.0-ls356",
  jellyfin: "10.11.11",
  oidc: "v2.45.1",
  prowlarr: "2.5.2.5491-ls155",
  qbittorrent: "5.2.0_v2.0.12-ls454",
  radarr: "6.3.0.10514-ls312",
  sabnzbd: "5.0.4-ls263",
  seerr: "v3.4.1",
  sonarr: "4.0.19.2979-ls320",
});

function definitionFor(service) {
  const definition = COMPATIBILITY_TARGET_DEFINITIONS.find(
    (candidate) => candidate.service === service,
  );
  assert.ok(definition);
  return definition;
}

function successfulResolver(arguments_) {
  if (arguments_[0] === "repo" && arguments_[1] === "tags") {
    const definition = COMPATIBILITY_TARGET_DEFINITIONS.find(
      (candidate) => candidate.repository === arguments_[2],
    );
    assert.ok(definition);
    return {
      status: 0,
      stderr: "",
      stdout: `${TAGS[definition.service]}\nlatest\nrelease-candidate\n`,
    };
  }
  if (arguments_[0] === "resolve") {
    const definition = COMPATIBILITY_TARGET_DEFINITIONS.find((candidate) =>
      arguments_[1].startsWith(`${candidate.repository}:`),
    );
    assert.ok(definition);
    return { status: 0, stderr: "", stdout: `${DIGESTS[definition.service]}\n` };
  }
  assert.fail(`Unexpected ORAS arguments: ${arguments_.join(" ")}`);
}

function passingFixtureReport(target) {
  if (["authentik", "oidc"].includes(target.service)) {
    return {
      checks: [...COMPATIBILITY_CHECKS[target.service]],
      image: target.image,
      mode: "isolated_fixture",
      passed: true,
      schemaVersion: 1,
      service: target.service,
      upstreamVersion: target.version,
    };
  }
  if (target.service === "jellyfin") {
    return {
      checks: {
        directRange: { bytes: 4_096, status: 206 },
        hlsTranscode: { bytes: 8_192, format: "fmp4", status: 200 },
        identity: {
          invalidPasswordRejected: true,
          mismatchedQuickConnectSecretRejected: true,
          password: true,
          publicInfo: true,
          quickConnect: true,
        },
        progress: { persistedSeconds: 6, reportedSeconds: 6 },
        reconnect: { delivery: "direct", persistedSeconds: 6 },
        tracks: { audio: "fra", subtitle: "eng" },
        transcodeSeekSeconds: 4,
      },
      image: target.image,
      schemaVersion: 1,
      serverVersion: target.version,
      status: "passed",
    };
  }
  return {
    checks: Object.fromEntries(
      COMPATIBILITY_CHECKS[target.service].map((check) => [check, "passed"]),
    ),
    image: target.image,
    schemaVersion: 1,
    serverVersion: target.version,
    service: target.service,
    status: "passed",
  };
}

test("defines exactly the public latest-stable upstream repositories", () => {
  assert.deepEqual(COMPATIBILITY_SERVICES, [
    "authentik",
    "bazarr",
    "jellyfin",
    "oidc",
    "prowlarr",
    "qbittorrent",
    "radarr",
    "sabnzbd",
    "seerr",
    "sonarr",
  ]);
  assert.deepEqual(COMPATIBILITY_TARGET_DEFINITIONS, [
    { repository: "ghcr.io/goauthentik/server", service: "authentik" },
    { repository: "ghcr.io/linuxserver/bazarr", service: "bazarr" },
    { repository: "ghcr.io/jellyfin/jellyfin", service: "jellyfin" },
    { repository: "ghcr.io/dexidp/dex", service: "oidc" },
    {
      repository: "ghcr.io/linuxserver/prowlarr",
      service: "prowlarr",
    },
    {
      repository: "ghcr.io/linuxserver/qbittorrent",
      service: "qbittorrent",
    },
    { repository: "ghcr.io/linuxserver/radarr", service: "radarr" },
    { repository: "ghcr.io/linuxserver/sabnzbd", service: "sabnzbd" },
    { repository: "ghcr.io/seerr-team/seerr", service: "seerr" },
    { repository: "ghcr.io/linuxserver/sonarr", service: "sonarr" },
  ]);
});

test("resolves newest stable version tags to immutable digests", () => {
  const report = resolveCompatibilityTargets({
    execute: successfulResolver,
    now: () => new Date("2026-07-31T14:00:00.000Z"),
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.resolvedAt, "2026-07-31T14:00:00.000Z");
  assert.equal(report.targets.length, COMPATIBILITY_SERVICES.length);
  for (const target of report.targets) {
    const definition = definitionFor(target.service);
    assert.equal(
      target.image,
      `${definition.repository}:${TAGS[target.service]}@${DIGESTS[target.service]}`,
    );
    assert.equal(target.source, `${definition.repository}:${TAGS[target.service]}`);
    assert.match(target.version, /^(?:\d+\.)+\d+$/u);
  }
  assert.deepEqual(validateCompatibilityTargets(report), report);
});

test("fails closed when a repository has no stable version tag", () => {
  assert.throws(
    () =>
      resolveCompatibilityTargets({
        execute(arguments_) {
          if (
            arguments_[0] === "repo" &&
            arguments_[1] === "tags" &&
            arguments_[2] === "ghcr.io/goauthentik/server"
          ) {
            return { status: 0, stderr: "", stdout: "latest\nrelease-candidate\n" };
          }
          const execution = successfulResolver(arguments_);
          return execution;
        },
      }),
    (error) => error.code === "stable_tag_unresolved" && error.service === "authentik",
  );
});

test("accepts only complete, matching compatibility target overrides", () => {
  const fallback = {
    radarr: {
      image: `ghcr.io/linuxserver/radarr:6.3.0.10514-ls312@sha256:${"a".repeat(64)}`,
      version: "6.3.0.10514",
    },
    sonarr: {
      image: `ghcr.io/linuxserver/sonarr:4.0.19.2979-ls320@sha256:${"b".repeat(64)}`,
      version: "4.0.19.2979",
    },
  };
  const image = `ghcr.io/linuxserver/radarr:6.4.1.11000-ls320@sha256:${"c".repeat(64)}`;
  assert.deepEqual(
    applyCompatibilityTargetOverride(fallback, {
      OMNIFIN_COMPATIBILITY_IMAGE: image,
      OMNIFIN_COMPATIBILITY_SERVICE: "radarr",
      OMNIFIN_COMPATIBILITY_VERSION: "6.4.1.11000",
    }),
    { ...fallback, radarr: { image, version: "6.4.1.11000" } },
  );

  for (const environment of [
    { OMNIFIN_COMPATIBILITY_IMAGE: image },
    {
      OMNIFIN_COMPATIBILITY_IMAGE: "ghcr.io/linuxserver/radarr:latest",
      OMNIFIN_COMPATIBILITY_SERVICE: "radarr",
      OMNIFIN_COMPATIBILITY_VERSION: "6.4.1.11000",
    },
    {
      OMNIFIN_COMPATIBILITY_IMAGE: image,
      OMNIFIN_COMPATIBILITY_SERVICE: "sonarr",
      OMNIFIN_COMPATIBILITY_VERSION: "6.4.1.11000",
    },
  ]) {
    assert.throws(
      () => applyCompatibilityTargetOverride(fallback, environment),
      /compatibility_target_invalid/u,
    );
  }
});

test("normalizes passing fixture evidence into a closed service report", () => {
  const target = resolveCompatibilityTargets({ execute: successfulResolver }).targets.find(
    ({ service }) => service === "seerr",
  );
  assert.ok(target);
  const report = canonicalCompatibilityReport({
    executionPassed: true,
    fixtureReport: passingFixtureReport(target),
    target,
    teardownPassed: true,
  });

  assert.deepEqual(Object.keys(report).sort(), [
    "checks",
    "image",
    "schemaVersion",
    "service",
    "status",
    "upstreamVersion",
  ]);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.checks, COMPATIBILITY_CHECKS.seerr);
  assert.doesNotMatch(JSON.stringify(report), /private-token|localhost|\/tmp\//u);
});

test("reduces failed fixture output to a bounded category", () => {
  const target = resolveCompatibilityTargets({ execute: successfulResolver }).targets[0];
  const report = canonicalCompatibilityReport({
    executionPassed: false,
    fixtureReport: {
      errorCategory: "provider_start_failed",
      privatePath: "/tmp/private",
      token: "private-token",
    },
    target,
    teardownPassed: true,
  });

  assert.deepEqual(report, {
    checks: [],
    errorCategory: "provider_start_failed",
    image: target.image,
    schemaVersion: 1,
    service: target.service,
    status: "failed",
    upstreamVersion: target.version,
  });
  assert.doesNotMatch(JSON.stringify(report), /private|token|path/iu);
});

test("requires deterministic container, network, and volume teardown", () => {
  const before = {
    container: new Set(["a".repeat(12)]),
    network: new Set(["b".repeat(12)]),
    volume: new Set(["fixture-cache"]),
  };
  assert.equal(
    teardownMatches(before, {
      container: new Set(before.container),
      network: new Set(before.network),
      volume: new Set(before.volume),
    }),
    true,
  );
  assert.equal(
    teardownMatches(before, {
      container: new Set([...before.container, "c".repeat(12)]),
      network: new Set(before.network),
      volume: new Set(before.volume),
    }),
    false,
  );
});

test("aggregates exactly one sanitized report for every resolved service", () => {
  const targets = resolveCompatibilityTargets({ execute: successfulResolver });
  const reports = targets.targets.map((target) =>
    canonicalCompatibilityReport({
      executionPassed: true,
      fixtureReport: passingFixtureReport(target),
      target,
      teardownPassed: true,
    }),
  );
  const aggregate = aggregateCompatibilityReports({
    commit: "a".repeat(40),
    reports,
    targets,
    verifiedAt: "2026-07-31T14:30:00.000Z",
  });

  assert.equal(aggregate.status, "passed");
  assert.equal(aggregate.services.length, COMPATIBILITY_SERVICES.length);
  assert.deepEqual(validateAggregateCompatibilityReport(aggregate), aggregate);
  assert.throws(
    () => aggregateCompatibilityReports({ ...aggregate, reports: reports.slice(1), targets }),
    /compatibility_report_missing/u,
  );

  const injected = structuredClone(aggregate);
  injected.services[0].token = "private-token";
  assert.throws(
    () => validateAggregateCompatibilityReport(injected),
    /compatibility_aggregate_invalid/u,
  );
});

test("runs the self-contained canary with minimal permissions and no configured secrets", () => {
  const source = readFileSync(
    new URL("../../.github/workflows/compatibility.yml", import.meta.url),
    "utf8",
  );
  const workflow = parseYaml(source);
  const jobs = workflow.jobs;

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(workflow.on.schedule);
  assert.notEqual(workflow.on.workflow_dispatch, undefined);
  assert.equal(jobs.resolve.name, "Resolve latest stable upstream images");
  assert.deepEqual(jobs.media.needs, ["resolve"]);
  assert.equal(jobs.canary.strategy["fail-fast"], false);
  assert.ok(jobs.canary.strategy["max-parallel"] <= 3);
  assert.deepEqual(jobs.canary.strategy.matrix.include.map(({ service }) => service).sort(), [
    ...COMPATIBILITY_SERVICES,
  ]);
  assert.deepEqual(jobs.issues.permissions, { contents: "read", issues: "write" });
  assert.match(jobs.issues.if, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(source, /oras-project\/setup-oras@[a-f0-9]{40}/u);
  assert.match(source, /compatibility-targets\.mjs resolve/u);
  assert.match(source, /compatibility-service\.mjs/u);
  assert.match(source, /compatibility-report\.mjs aggregate/u);
  assert.doesNotMatch(source, /secrets\.|vars\.|OMNIFIN_LIVE_INTEGRATION_ENABLED/u);

  const isolationSource = [
    "scripts/integration/download-clients.mjs",
    "scripts/integration/seerr-service.mjs",
    "scripts/integration/servarr-services.mjs",
    "scripts/integration/authentik/compose.yaml",
    "scripts/integration/oidc-provider/compose.yaml",
  ]
    .map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"))
    .join("\n");
  assert.match(isolationSource, /--internal/u);

  const actions = [...source.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)].map(
    (match) => match[1],
  );
  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /@[a-f0-9]{40}$/u);
});
