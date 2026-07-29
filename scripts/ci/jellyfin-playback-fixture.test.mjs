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
  selectConnectorAddress,
  validateImportedItem,
} from "../integration/jellyfin/playback.mjs";

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

test("the protected fixture aggregate runs the real playback connector", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/integration.yml", import.meta.url), "utf8"),
  );
  const fixture = workflow.jobs["playback-fixture"];
  assert.equal(fixture.name, "Isolated Jellyfin playback integration");
  assert.equal(fixture["timeout-minutes"], 20);
  assert.equal(JSON.stringify(fixture).includes("secrets."), false);
  const build = fixture.steps.find((step) => step.name === "Build playback connector");
  assert.equal(build.run, "pnpm --filter @omnifin/connectors... build");
  const playback = fixture.steps.find(
    (step) => step.name === "Exercise isolated Jellyfin playback",
  );
  assert.match(playback.run, /pnpm fixture:jellyfin-playback/u);
  assert.match(playback.run, /artifacts\/integration\/jellyfin-playback\/report\.json/u);
  assert.ok(workflow.jobs.gate.needs.includes("playback-fixture"));
});
