import { describe, expect, it } from "vitest";

import { resolveSubtitleTier } from "./player-subtitles";

describe("resolveSubtitleTier", () => {
  it("renders reliable masked-WebVTT codecs natively", () => {
    for (const codec of ["srt", "subrip", "vtt", "webvtt"]) {
      expect(resolveSubtitleTier({ codec, delivery: "external" })).toBe("native");
    }
  });

  it("burns in codecs whose Stream.vtt conversion is unreliable or unavailable", () => {
    for (const codec of ["ass", "ssa", "sami", "smi", "mov_text", "pgssub", "dvdsub"]) {
      expect(resolveSubtitleTier({ codec, delivery: "external" })).toBe("burn-in");
    }
  });

  it("burns in HLS-manifest subtitle tracks regardless of codec", () => {
    expect(resolveSubtitleTier({ codec: "webvtt", delivery: "hls" })).toBe("burn-in");
    expect(resolveSubtitleTier({ codec: null, delivery: "hls" })).toBe("burn-in");
  });

  it("fails closed for unknown or missing codecs", () => {
    expect(resolveSubtitleTier({ codec: "pgs", delivery: "external" })).toBe("burn-in");
    expect(resolveSubtitleTier({ codec: null, delivery: "external" })).toBe("burn-in");
  });

  it("normalizes codec casing before resolving", () => {
    expect(resolveSubtitleTier({ codec: "SRT", delivery: "external" })).toBe("native");
    expect(resolveSubtitleTier({ codec: "WebVTT", delivery: "video" })).toBe("native");
    expect(resolveSubtitleTier({ codec: "ASS", delivery: "video" })).toBe("burn-in");
  });
});
