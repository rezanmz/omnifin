import { describe, expect, it, vi } from "vitest";

import {
  createHlsPlayerHandle,
  matchEngineAudioTrack,
  type HlsAudioTrackSummary,
} from "./player-engine";

const tracks: HlsAudioTrackSummary[] = [
  { channels: "6", id: 1, lang: "eng", name: "English 5.1" },
  { channels: "2", id: 3, lang: "spa", name: "Español" },
  { id: 5, lang: "eng", name: "English Commentary" },
];

describe("matchEngineAudioTrack", () => {
  it("prefers an exact language and name match", () => {
    expect(matchEngineAudioTrack({ language: "eng", title: "English 5.1" }, tracks)).toMatchObject({
      id: 1,
    });
  });

  it("falls back to a language match when names differ", () => {
    expect(matchEngineAudioTrack({ language: "spa", title: "Spanish" }, tracks)).toMatchObject({
      id: 3,
    });
  });

  it("matches language and name case-insensitively", () => {
    expect(matchEngineAudioTrack({ language: "ENG", title: "ENGLISH 5.1" }, tracks)).toMatchObject({
      id: 1,
    });
    expect(matchEngineAudioTrack({ language: "Esp", title: "ESPAÑOL" }, tracks)).toMatchObject({
      id: 3,
    });
  });

  it("matches by name only when the target has no language", () => {
    expect(matchEngineAudioTrack({ language: null, title: "Español" }, tracks)).toMatchObject({
      id: 3,
    });
  });

  it("returns null when nothing matches", () => {
    expect(matchEngineAudioTrack({ language: "deu", title: "Deutsch" }, tracks)).toBeNull();
    expect(matchEngineAudioTrack({ language: null, title: "Unknown" }, tracks)).toBeNull();
    expect(matchEngineAudioTrack({ language: "eng", title: null }, tracks)).toMatchObject({
      id: 1,
    });
  });
});

describe("createHlsPlayerHandle network recovery", () => {
  it("emits a typed error payload instead of positional recovery arguments", () => {
    const player = createHlsPlayerHandle(document.createElement("video"), TestHls as never);
    const hls = TestHls.instances.at(-1)!;
    const events: unknown[] = [];
    player.on("error", (event) => events.push(event));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      hls.emitError({
        details: "fragLoadError",
        fatal: true,
        response: { code: 503 },
        type: "networkError",
      });
    }

    expect(events[0]).toMatchObject({
      error: { code: 503, message: "fragLoadError" },
      recovery: {
        kind: "hls_network_resource_load_exhausted",
        sessionRecoveryEligible: true,
      },
    });
  });

  it("reports an exhausted transient resource failure through the optional error signal", () => {
    const player = createHlsPlayerHandle(document.createElement("video"), TestHls as never);
    const hls = TestHls.instances.at(-1)!;
    const errors: unknown[][] = [];
    player.on("error", (...args) => errors.push(args));

    hls.emitError({
      details: "fragLoadError",
      fatal: true,
      response: { code: 503 },
      type: "networkError",
    });
    hls.emitError({
      details: "fragLoadError",
      fatal: true,
      response: { code: 503 },
      type: "networkError",
    });
    hls.emitError({
      details: "fragLoadError",
      fatal: true,
      response: { code: 503 },
      type: "networkError",
    });

    expect(hls.startLoad).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toMatchObject({
      recovery: {
        kind: "hls_network_resource_load_exhausted",
        sessionRecoveryEligible: true,
        stage: "fragment",
        status: 503,
      },
    });
  });

  it.each([
    ["manifestLoadError", "manifest"],
    ["levelLoadTimeout", "level"],
    ["audioTrackLoadError", "audio_track"],
    ["subtitleTrackLoadTimeout", "subtitle_track"],
    ["fragLoadError", "fragment"],
    ["keyLoadTimeout", "key"],
  ])("recognizes the %s resource stage", (details, stage) => {
    const player = createHlsPlayerHandle(document.createElement("video"), TestHls as never);
    const hls = TestHls.instances.at(-1)!;
    const errors: unknown[][] = [];
    player.on("error", (...args) => errors.push(args));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      hls.emitError({ details, fatal: true, response: { code: 404 }, type: "networkError" });
    }

    expect(hls.startLoad).toHaveBeenCalledTimes(2);
    expect(errors[0]?.[0]).toMatchObject({ recovery: { stage, status: 404 } });
  });

  it.each([null, 0, 404, 408, 410, 500, 503, 599])(
    "accepts transient status %s without exposing request data",
    (status) => {
      const player = createHlsPlayerHandle(document.createElement("video"), TestHls as never);
      const hls = TestHls.instances.at(-1)!;
      const errors: unknown[][] = [];
      player.on("error", (...args) => errors.push(args));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        hls.emitError({
          details: "manifestLoadError",
          fatal: true,
          response:
            status === null
              ? undefined
              : { code: status, body: "secret-body", url: "https://secret.example" },
          type: "networkError",
          url: "https://secret.example/path?token=secret",
        });
      }

      const signal = (errors[0]?.[0] as { recovery?: unknown } | undefined)?.recovery;
      expect(signal).toMatchObject({ sessionRecoveryEligible: true, status });
      expect(JSON.stringify(signal)).not.toContain("secret");
    },
  );

  it.each([400, 401, 403, 429, 499])("excludes non-transient HTTP status %s", (status) => {
    const player = createHlsPlayerHandle(document.createElement("video"), TestHls as never);
    const hls = TestHls.instances.at(-1)!;
    const errors: unknown[][] = [];
    player.on("error", (...args) => errors.push(args));

    hls.emitError({
      details: "manifestLoadError",
      fatal: true,
      response: { code: status },
      type: "networkError",
    });

    expect(hls.startLoad).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect((errors[0]?.[0] as { recovery?: unknown } | undefined)?.recovery).toBeNull();
  });

  it.each([
    ["manifestParsingError", "networkError"],
    ["fragParsingError", "networkError"],
    ["fragLoadError", "mediaError"],
    ["fragLoadError", "otherNetworkError"],
  ])("excludes non-resource failure %s (%s)", (details, type) => {
    const player = createHlsPlayerHandle(document.createElement("video"), TestHls as never);
    const hls = TestHls.instances.at(-1)!;
    const errors: unknown[][] = [];
    player.on("error", (...args) => errors.push(args));

    hls.emitError({ details, fatal: true, response: { code: 503 }, type });

    expect(hls.startLoad).not.toHaveBeenCalled();
    expect(errors).toHaveLength(type === "mediaError" ? 0 : 1);
    if (errors.length > 0) {
      expect((errors[0]?.[0] as { recovery?: unknown } | undefined)?.recovery).toBeNull();
    }
  });
});

class TestHls {
  static readonly ErrorTypes = { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
  static readonly Events = { ERROR: "error" };
  static readonly instances: TestHls[] = [];

  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  readonly recoverMediaError = vi.fn();
  readonly startLoad = vi.fn();

  constructor() {
    TestHls.instances.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    this.handlers.set(event, listener);
  }

  emitError(data: unknown) {
    this.handlers.get("error")?.("error", data);
  }

  destroy() {}
  attachMedia() {}
  loadSource() {}
}
