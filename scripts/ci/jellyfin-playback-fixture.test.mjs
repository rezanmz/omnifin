import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  connectorFailureCode,
  firstManifestUri,
  hlsSegmentFormat,
  hostContainerUser,
  isLibraryProbePending,
  jellyfinCompatibilityReport,
  jellyfinFailureReport,
  jellyfinTarget,
  JellyfinFixtureFailure,
  preserveFixtureFailure,
  quickConnectAuthorizationQuery,
  restartPlaybackNegotiation,
  selectConnectorAddress,
  startContainerWithRetry,
  validateImportedItem,
  validateLibraryCatalog,
  verifiedQuickConnectSession,
} from "../integration/jellyfin/playback.mjs";

const OLDEST_IMAGE =
  "ghcr.io/jellyfin/jellyfin:10.10.7@sha256:e4d1dc5374344446a3a78e43dd211247f22afba84ea2e5a13cbe1a94e1ff2141";
const LATEST_IMAGE =
  "ghcr.io/jellyfin/jellyfin:10.11.11@sha256:45f648c382a0c8b552582fcea40e95cb17c5d475473a891cba0eb7523fb92112";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("accepts only immutable official Jellyfin images bound to their exact version", () => {
  assert.deepEqual(jellyfinTarget(OLDEST_IMAGE, "10.10.7"), {
    image: OLDEST_IMAGE,
    version: "10.10.7",
  });
  assert.deepEqual(jellyfinTarget(LATEST_IMAGE, "10.11.11"), {
    image: LATEST_IMAGE,
    version: "10.11.11",
  });
  assert.throws(
    () => jellyfinTarget("ghcr.io/jellyfin/jellyfin:latest", "10.11.11"),
    /jellyfin_target_invalid/u,
  );
  assert.throws(() => jellyfinTarget(OLDEST_IMAGE, "10.11.11"), /jellyfin_target_invalid/u);
  assert.throws(
    () =>
      jellyfinTarget(
        "registry.example.test/jellyfin:10.10.7@sha256:e4d1dc5374344446a3a78e43dd211247f22afba84ea2e5a13cbe1a94e1ff2141",
        "10.10.7",
      ),
    /jellyfin_target_invalid/u,
  );
});

test("keeps the disposable Jellyfin server on a private network with deterministic teardown", () => {
  const source = readFileSync(
    new URL("../integration/jellyfin/playback.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /\["network", "create", "--driver", "bridge", context\.networkName\]/u);
  assert.match(source, /"--network",\s*context\.networkName/u);
  assert.match(source, /\["network", "rm", context\.networkName\]/u);
  assert.equal(source.match(/await startContainerWithRetry\(/gu)?.length, 2);
  assert.match(source, /\["container", "rm", "--force", "--volumes", containerName\]/u);
});

test("builds a closed compatibility report without retaining supplied secrets", () => {
  const input = {
    accessToken: "private-access-token",
    identityChecks: {
      invalidPasswordRejected: true,
      mismatchedQuickConnectSecretRejected: true,
      password: true,
      publicInfo: true,
      quickConnect: true,
      secret: "private-quick-connect-secret",
    },
    image: LATEST_IMAGE,
    libraryCatalog: {
      itemCount: 1,
      kind: "movie",
      secret: "private-library-identifier",
      userScoped: true,
    },
    persistedSeconds: 6,
    playback: {
      direct: { bytes: 4_096, status: 206, token: "private-direct-token" },
      hls: { bytes: 8_192, format: "fmp4", status: 200, path: "/private/media" },
      seekSeconds: 4,
      selectedAudio: "fra",
      selectedSubtitle: "eng",
    },
    reconnectDelivery: "direct",
    restartPosition: 6,
    version: "10.11.11",
  };
  const report = jellyfinCompatibilityReport(input);

  assert.deepEqual(Object.keys(report).sort(), [
    "checks",
    "image",
    "schemaVersion",
    "serverVersion",
    "status",
  ]);
  assert.deepEqual(report.checks.identity, {
    invalidPasswordRejected: true,
    mismatchedQuickConnectSecretRejected: true,
    password: true,
    publicInfo: true,
    quickConnect: true,
  });
  assert.deepEqual(report.checks.directRange, { bytes: 4_096, status: 206 });
  assert.deepEqual(report.checks.hlsTranscode, { bytes: 8_192, format: "fmp4", status: 200 });
  assert.deepEqual(report.checks.libraryCatalog, {
    itemCount: 1,
    kind: "movie",
    userScoped: true,
  });
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-access-token|private-quick-connect-secret|private-direct-token|private-library-identifier|private\/media/u,
  );
  assert.throws(
    () =>
      jellyfinCompatibilityReport({
        ...input,
        libraryCatalog: { ...input.libraryCatalog, userScoped: false },
      }),
    /compatibility_report_invalid/u,
  );
});

test("builds a stage-specific failure report without retaining failure causes", () => {
  const primary = new JellyfinFixtureFailure("container_start_failed", {
    cause: new Error("private-container-path /tmp/private-config"),
  });
  const cleanup = new JellyfinFixtureFailure("network_teardown_failed", {
    cause: new Error("private-network-id"),
  });

  const report = jellyfinFailureReport({
    error: preserveFixtureFailure(primary, cleanup),
    image: OLDEST_IMAGE,
    version: "10.10.7",
  });

  assert.deepEqual(report, {
    error: {
      cleanupCode: "network_teardown_failed",
      code: "container_start_failed",
      stage: "container_start",
    },
    image: OLDEST_IMAGE,
    schemaVersion: 1,
    serverVersion: "10.10.7",
    status: "failed",
  });
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-container-path|private-config|private-network-id/u,
  );
});

test("preserves the primary fixture failure and normalizes untrusted diagnostics", () => {
  const primary = new JellyfinFixtureFailure("server_readiness_failed");
  const retained = preserveFixtureFailure(
    primary,
    new JellyfinFixtureFailure("container_teardown_failed"),
  );

  assert.equal(retained, primary);
  assert.equal(retained.code, "server_readiness_failed");
  assert.equal(retained.cleanupCode, "container_teardown_failed");
  assert.deepEqual(
    jellyfinFailureReport({
      error: new JellyfinFixtureFailure("private_access_token"),
      image: LATEST_IMAGE,
      version: "10.11.11",
    }).error,
    { code: "jellyfin_fixture_failed", stage: "exercise" },
  );
  assert.equal(
    preserveFixtureFailure(primary, new Error("private-cleanup-message")).cleanupCode,
    "cleanup_failed",
  );
});

test("maps every Docker lifecycle boundary to a bounded diagnostic stage", () => {
  const expectedStages = new Map([
    ["network_create_failed", "network_create"],
    ["container_start_failed", "container_start"],
    ["container_start_retry_exhausted", "container_start"],
    ["published_port_discovery_failed", "container_start"],
    ["server_readiness_failed", "readiness"],
    ["container_stop_failed", "container_stop"],
    ["container_teardown_failed", "teardown"],
    ["network_teardown_failed", "teardown"],
  ]);

  for (const [code, stage] of expectedStages) {
    assert.deepEqual(
      jellyfinFailureReport({
        error: new JellyfinFixtureFailure(code),
        image: LATEST_IMAGE,
        version: "10.11.11",
      }).error,
      { code, stage },
    );
  }
});

test("recovers one explicitly transient container start after deterministic cleanup", async () => {
  const transient = new JellyfinFixtureFailure("container_start_failed", {
    cause: Object.assign(new Error("private Docker failure"), {
      stderr: "failed to bind host port: address already in use",
    }),
  });
  const events = [];
  let attempts = 0;

  await startContainerWithRetry(
    () => {
      attempts += 1;
      events.push(`start:${attempts}`);
      if (attempts === 1) throw transient;
    },
    () => {
      events.push("cleanup");
    },
    {
      pause: async (milliseconds) => {
        events.push(`pause:${milliseconds}`);
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(events, ["start:1", "cleanup", "pause:250", "start:2"]);
});

test("does not retry a stable container configuration failure", async () => {
  const stable = new JellyfinFixtureFailure("container_start_failed", {
    cause: Object.assign(new Error("private Docker failure"), {
      stderr: "invalid reference format",
    }),
  });
  let attempts = 0;
  let cleanups = 0;
  let pauses = 0;

  await assert.rejects(
    startContainerWithRetry(
      () => {
        attempts += 1;
        throw stable;
      },
      () => {
        cleanups += 1;
      },
      {
        pause: async () => {
          pauses += 1;
        },
      },
    ),
    (error) => error === stable,
  );
  assert.equal(attempts, 1);
  assert.equal(cleanups, 0);
  assert.equal(pauses, 0);
});

test("fails closed with bounded evidence after transient start retry exhaustion", async () => {
  const privateFailure = () =>
    new JellyfinFixtureFailure("container_start_failed", {
      cause: Object.assign(new Error("private-container-name"), {
        stderr: "failed programming external connectivity: resource temporarily unavailable",
      }),
    });
  let attempts = 0;
  let cleanups = 0;

  let exhausted;
  try {
    await startContainerWithRetry(
      () => {
        attempts += 1;
        throw privateFailure();
      },
      () => {
        cleanups += 1;
      },
      { pause: async () => undefined },
    );
  } catch (error) {
    exhausted = error;
  }

  assert.equal(attempts, 2);
  assert.equal(cleanups, 2);
  assert.equal(exhausted?.code, "container_start_retry_exhausted");
  const report = jellyfinFailureReport({
    error: exhausted,
    image: LATEST_IMAGE,
    version: "10.11.11",
  });
  assert.deepEqual(report.error, {
    code: "container_start_retry_exhausted",
    stage: "container_start",
  });
  assert.doesNotMatch(JSON.stringify(report), /private-container-name|external connectivity/u);
});

test("preserves retry exhaustion when final partial-container cleanup fails", async () => {
  const transient = () =>
    new JellyfinFixtureFailure("container_start_failed", {
      cause: Object.assign(new Error("private retry detail"), {
        stderr: "port is already allocated",
      }),
    });
  let attempts = 0;
  let cleanups = 0;

  let retained;
  try {
    await startContainerWithRetry(
      () => {
        attempts += 1;
        throw transient();
      },
      () => {
        cleanups += 1;
        if (cleanups === 2) {
          throw new JellyfinFixtureFailure("container_teardown_failed", {
            cause: new Error("private final cleanup detail"),
          });
        }
      },
      { pause: async () => undefined },
    );
  } catch (error) {
    retained = error;
  }

  assert.equal(attempts, 2);
  assert.equal(cleanups, 2);
  assert.equal(retained?.code, "container_start_retry_exhausted");
  assert.equal(retained?.cleanupCode, "container_teardown_failed");
  assert.doesNotMatch(
    JSON.stringify(
      jellyfinFailureReport({ error: retained, image: LATEST_IMAGE, version: "10.11.11" }),
    ),
    /private retry detail|private final cleanup detail|port is already allocated/u,
  );
});

test("preserves the initial start failure when retry cleanup also fails", async () => {
  const startFailure = new JellyfinFixtureFailure("container_start_failed", {
    cause: Object.assign(new Error("private start detail"), {
      stderr: "port allocation failed",
    }),
  });

  let retained;
  try {
    await startContainerWithRetry(
      () => {
        throw startFailure;
      },
      () => {
        throw new JellyfinFixtureFailure("container_teardown_failed", {
          cause: new Error("private cleanup detail"),
        });
      },
      { pause: async () => undefined },
    );
  } catch (error) {
    retained = error;
  }

  assert.equal(retained, startFailure);
  assert.equal(retained?.cleanupCode, "container_teardown_failed");
  assert.doesNotMatch(
    JSON.stringify(
      jellyfinFailureReport({ error: retained, image: LATEST_IMAGE, version: "10.11.11" }),
    ),
    /private start detail|private cleanup detail|port allocation/u,
  );
});

test("writes a sanitized failure artifact before exiting a failed fixture", () => {
  const artifactDirectory = `artifacts/test/jellyfin-fixture-${randomUUID()}`;
  const output = `${artifactDirectory}/report.json`;
  const execution = spawnSync(
    process.execPath,
    [
      "scripts/integration/jellyfin/playback.mjs",
      "--fixture",
      `${artifactDirectory}/private-missing-fixture.mp4`,
      "--output",
      output,
      "--image",
      LATEST_IMAGE,
      "--expected-version",
      "10.11.11",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );

  try {
    assert.equal(execution.status, 1);
    const report = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, output), "utf8"));
    assert.deepEqual(report, {
      error: { code: "fixture_invalid", stage: "setup" },
      image: LATEST_IMAGE,
      schemaVersion: 1,
      serverVersion: "10.11.11",
      status: "failed",
    });
    assert.doesNotMatch(JSON.stringify(report), /private-missing-fixture|private-cleanup-message/u);
    assert.match(execution.stderr, /"status":"failed"/u);
  } finally {
    rmSync(resolve(REPOSITORY_ROOT, dirname(output)), { force: true, recursive: true });
  }
});

test("binds Quick Connect approval to the exact authenticated Jellyfin user", () => {
  const userId = "a".repeat(32);
  assert.equal(
    quickConnectAuthorizationQuery("123456", userId).toString(),
    `code=123456&userId=${userId}`,
  );
  assert.throws(
    () => quickConnectAuthorizationQuery("12 3456", userId),
    /quick_connect_state_invalid/u,
  );
  assert.throws(
    () => quickConnectAuthorizationQuery("123456", "not-a-user"),
    /quick_connect_state_invalid/u,
  );
});

test("continues with the fresh Quick Connect session for the approved user", () => {
  const userId = "a".repeat(32);
  const serverId = "server-fixture";
  const quickConnect = verifiedQuickConnectSession(
    { accessToken: "password-session-token", userId },
    {
      AccessToken: "quick-connect-session-token",
      ServerId: serverId,
      User: { Id: userId },
    },
    serverId,
  );

  assert.deepEqual(quickConnect, {
    accessToken: "quick-connect-session-token",
    userId,
  });
  assert.throws(
    () =>
      verifiedQuickConnectSession(
        { accessToken: "password-session-token", userId },
        {
          AccessToken: "quick-connect-session-token",
          ServerId: serverId,
          User: { Id: "b".repeat(32) },
        },
        serverId,
      ),
    /quick_connect_identity_mismatch/u,
  );
});

test("emits only allowlisted connector diagnostics", () => {
  assert.equal(
    connectorFailureCode("direct_negotiation", { code: "timeout" }),
    "direct_negotiation_timeout",
  );
  assert.equal(
    connectorFailureCode("direct_negotiation", { code: "secret-value" }),
    "direct_negotiation",
  );
  assert.throws(
    () => connectorFailureCode("invalid stage", { code: "timeout" }),
    /diagnostic_stage_invalid/u,
  );
});

test("runs the rootless fixture container as the invoking host identity", () => {
  assert.equal(hostContainerUser(1_001, 121), "1001:121");
  assert.throws(() => hostContainerUser(undefined, 121), /host_identity_unavailable/u);
  assert.throws(() => hostContainerUser(1_001, -1), /host_identity_unavailable/u);
  assert.throws(() => hostContainerUser(1.5, 121), /host_identity_unavailable/u);
});

test("waits for Jellyfin to finish probing imported media streams", () => {
  let probeError;
  try {
    validateImportedItem({ Id: "a".repeat(32), MediaStreams: [] });
  } catch (error) {
    probeError = error;
  }
  assert.equal(isLibraryProbePending(probeError), true);
  assert.equal(isLibraryProbePending(new Error("unrelated")), false);
});

test("accepts only a normalized user-scoped production catalogue result", () => {
  const expectedItemId = "a".repeat(32);
  assert.deepEqual(
    validateLibraryCatalog(
      {
        items: [
          {
            externalId: expectedItemId,
            kind: "movie",
            runtimeSeconds: 16,
            title: "Omnifin Fixture",
          },
        ],
        nextStartIndex: null,
        truncated: false,
      },
      expectedItemId,
    ),
    { itemCount: 1, kind: "movie", userScoped: true },
  );
  assert.throws(
    () =>
      validateLibraryCatalog(
        {
          items: [
            {
              externalId: "b".repeat(32),
              kind: "movie",
              runtimeSeconds: 16,
              title: "Omnifin Fixture",
            },
          ],
          nextStartIndex: null,
          truncated: false,
        },
        expectedItemId,
      ),
    /library_catalog_invalid/u,
  );
});

test("retries only transient post-restart negotiation failures", async () => {
  let now = 0;
  let attempts = 0;
  const delays = [];
  const expected = { delivery: "direct" };
  const result = await restartPlaybackNegotiation(
    async (signal) => {
      assert.equal(signal instanceof AbortSignal, true);
      assert.equal(signal.aborted, false);
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("partial response"), { code: "response_invalid" });
      }
      if (attempts === 2) throw Object.assign(new Error("request timed out"), { code: "timeout" });
      if (attempts === 3)
        throw Object.assign(new Error("server unavailable"), { code: "unreachable" });
      return expected;
    },
    {
      now: () => now,
      pause: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    },
  );

  assert.equal(result, expected);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [250, 250, 250]);
});

test("fails immediately for stable post-restart negotiation failures", async () => {
  let attempts = 0;
  let pauses = 0;
  const stableFailure = Object.assign(new Error("credentials rejected"), {
    code: "invalid_credentials",
  });

  await assert.rejects(
    restartPlaybackNegotiation(
      async () => {
        attempts += 1;
        throw stableFailure;
      },
      {
        now: () => 0,
        pause: async () => {
          pauses += 1;
        },
      },
    ),
    (error) => error === stableFailure,
  );
  assert.equal(attempts, 1);
  assert.equal(pauses, 0);
});

test("surfaces a persistent invalid response at the readiness deadline", async () => {
  let now = 0;
  let attempts = 0;
  const persistentFailure = Object.assign(new Error("incomplete media source"), {
    code: "response_invalid",
  });

  await assert.rejects(
    restartPlaybackNegotiation(
      async () => {
        attempts += 1;
        throw persistentFailure;
      },
      {
        now: () => now,
        pause: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 500,
      },
    ),
    (error) => error === persistentFailure,
  );
  assert.equal(now, 500);
  assert.equal(attempts, 3);
});

test("selects a private non-loopback connector address deterministically", () => {
  assert.equal(
    selectConnectorAddress({
      en0: [
        { address: "203.0.113.8", family: "IPv4", internal: false },
        { address: "192.168.1.20", family: "IPv4", internal: false },
      ],
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    }),
    "192.168.1.20",
  );
  assert.throws(
    () =>
      selectConnectorAddress({
        en0: [{ address: "203.0.113.8", family: "IPv4", internal: false }],
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      }),
    /connector_address_unavailable/u,
  );
});

test("recognizes MPEG-TS and fragmented MP4 HLS segments", () => {
  assert.equal(hlsSegmentFormat(Uint8Array.from([0x47])), "mpegts");
  assert.equal(hlsSegmentFormat(Uint8Array.from([0, 0, 0, 24, 0x73, 0x74, 0x79, 0x70])), "fmp4");
  assert.throws(() => hlsSegmentFormat(Uint8Array.from([0, 1, 2, 3])), /hls_segment_invalid/u);
});

test("extracts only a bounded URI line from an HLS manifest", () => {
  assert.equal(firstManifestUri("#EXTM3U\n#EXT-X-VERSION:7\nsegment-000.m4s\n"), "segment-000.m4s");
  assert.throws(() => firstManifestUri("#EXTM3U\n#EXT-X-ENDLIST\n"), /manifest_invalid/u);
});

test("the protected fixture aggregate runs the supported Jellyfin version matrix", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/integration.yml", import.meta.url), "utf8"),
  );
  const media = workflow.jobs["playback-media-fixture"];
  assert.equal(media.name, "Generate copyright-free playback fixture");
  assert.equal(JSON.stringify(media).includes("secrets."), false);

  const fixture = workflow.jobs["playback-fixture"];
  assert.equal(fixture.name, "Jellyfin compatibility (${{ matrix.label }})");
  assert.equal(fixture["timeout-minutes"], 20);
  assert.equal(JSON.stringify(fixture).includes("secrets."), false);
  assert.equal(fixture.needs, "playback-media-fixture");
  assert.deepEqual(fixture.strategy.matrix.include, [
    { image: OLDEST_IMAGE, label: "oldest-targeted", version: "10.10.7" },
    { image: LATEST_IMAGE, label: "latest-verified", version: "10.11.11" },
  ]);
  const download = fixture.steps.find((step) => step.name === "Download generated media fixture");
  assert.match(download.uses, /^actions\/download-artifact@[a-f0-9]{40}$/u);
  const build = fixture.steps.find((step) => step.name === "Build playback connector");
  assert.equal(build.run, "pnpm --filter @omnifin/connectors... build");
  const playback = fixture.steps.find(
    (step) => step.name === "Exercise Jellyfin identity and playback compatibility",
  );
  assert.match(playback.run, /pnpm fixture:jellyfin-playback/u);
  assert.match(playback.run, /--image "\$JELLYFIN_IMAGE"/u);
  assert.match(playback.run, /--expected-version "\$JELLYFIN_VERSION"/u);
  assert.match(
    playback.run,
    /artifacts\/integration\/jellyfin-playback\/\$JELLYFIN_LABEL\/report\.json/u,
  );
  const upload = fixture.steps.find((step) => step.name === "Upload sanitized fixture evidence");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.ok(workflow.jobs.gate.needs.includes("playback-media-fixture"));
  assert.ok(workflow.jobs.gate.needs.includes("playback-fixture"));
});
