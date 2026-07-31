import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  connectorFailureCode,
  firstManifestUri,
  hlsSegmentFormat,
  hostContainerUser,
  isLibraryProbePending,
  jellyfinCompatibilityReport,
  jellyfinTarget,
  quickConnectAuthorizationQuery,
  restartPlaybackNegotiation,
  selectConnectorAddress,
  validateImportedItem,
} from "../integration/jellyfin/playback.mjs";

const OLDEST_IMAGE =
  "ghcr.io/jellyfin/jellyfin:10.10.7@sha256:e4d1dc5374344446a3a78e43dd211247f22afba84ea2e5a13cbe1a94e1ff2141";
const LATEST_IMAGE =
  "ghcr.io/jellyfin/jellyfin:10.11.11@sha256:45f648c382a0c8b552582fcea40e95cb17c5d475473a891cba0eb7523fb92112";

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

test("builds a closed compatibility report without retaining supplied secrets", () => {
  const report = jellyfinCompatibilityReport({
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
  });

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
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-access-token|private-quick-connect-secret|private-direct-token|private\/media/u,
  );
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
  assert.ok(workflow.jobs.gate.needs.includes("playback-media-fixture"));
  assert.ok(workflow.jobs.gate.needs.includes("playback-fixture"));
});
