import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";
import {
  JELLYFIN_FIXTURE_IMAGE,
  validateFixtureProbe,
  validateSeekProbe,
} from "../media/playback-fixture.mjs";

const sourceProbe = {
  format: { duration: "12.000000" },
  streams: [
    {
      avg_frame_rate: "24/1",
      codec_name: "h264",
      codec_type: "video",
      height: 360,
      width: 640,
    },
    { codec_name: "aac", codec_type: "audio", tags: { language: "eng" } },
    { codec_name: "aac", codec_type: "audio", tags: { language: "fra" } },
    { codec_name: "mov_text", codec_type: "subtitle", tags: { language: "eng" } },
    { codec_name: "mov_text", codec_type: "subtitle", tags: { language: "fra" } },
  ],
};

test("the generated media contract requires both audio and subtitle languages", () => {
  assert.deepEqual(validateFixtureProbe(sourceProbe), {
    audioLanguages: ["eng", "fra"],
    durationSeconds: 12,
    subtitleLanguages: ["eng", "fra"],
    video: { codec: "h264", frameRate: "24/1", height: 360, width: 640 },
  });
  assert.throws(
    () => validateFixtureProbe({ ...sourceProbe, streams: sourceProbe.streams.slice(0, 4) }),
    /fixture_subtitle_invalid/u,
  );
});

test("the seek transcode contract requires alternate audio and reduced geometry", () => {
  assert.deepEqual(
    validateSeekProbe({
      format: { duration: "2.000000" },
      streams: [
        { codec_name: "h264", codec_type: "video", height: 180, width: 320 },
        { codec_name: "aac", codec_type: "audio", tags: { language: "fra" } },
      ],
    }),
    { audioLanguage: "fra", durationSeconds: 2, height: 180, width: 320 },
  );
});

test("the fixture workflow uses the immutable official Jellyfin image", () => {
  assert.match(
    JELLYFIN_FIXTURE_IMAGE,
    /^ghcr\.io\/jellyfin\/jellyfin:10\.11\.11@sha256:[0-9a-f]{64}$/u,
  );
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/integration.yml", import.meta.url), "utf8"),
  );
  const fixture = workflow.jobs["playback-media-fixture"];
  assert.equal(fixture.name, "Generate copyright-free playback fixture");
  assert.ok(workflow.jobs.gate.needs.includes("playback-media-fixture"));
  const imagePull = fixture.steps.find(
    (step) => step.name === "Pull immutable Jellyfin media runtime",
  );
  assert.equal(imagePull["timeout-minutes"], 10);
  assert.equal(imagePull.run.replace(/\s+/gu, " ").trim(), `docker pull ${JELLYFIN_FIXTURE_IMAGE}`);
  const generation = fixture.steps.find((step) => step.name === "Generate and transcode media");
  assert.equal(generation.run, "pnpm fixture:media --output artifacts/media/playback-fixture");
  const report = fixture.steps.find((step) => step.name === "Retain generated media report");
  assert.equal(report.with.path, "artifacts/media/playback-fixture/playback-fixture-report.json");
  assert.equal(report.with["if-no-files-found"], "error");
  const media = fixture.steps.find((step) => step.name === "Upload generated media fixture");
  assert.equal(media.with.path, "artifacts/media/playback-fixture");
  assert.equal(media.with["retention-days"], 1);
});
