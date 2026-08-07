import { describe, expect, it } from "vitest";

import {
  matchesPlaybackSourceReference,
  playbackSourceReferenceId,
} from "../src/media/playback-source-reference.js";

const mediaReferenceId = `media_${"m".repeat(22)}`;

describe("playback source references", () => {
  it("is deterministic only for the same key, title, and private source", () => {
    const key = Buffer.alloc(32, 1);
    const reference = playbackSourceReferenceId(key, mediaReferenceId, "private-source-1");

    expect(reference).toMatch(/^source_[A-Za-z0-9_-]{22}$/u);
    expect(playbackSourceReferenceId(key, mediaReferenceId, "private-source-1")).toBe(reference);
    expect(playbackSourceReferenceId(key, mediaReferenceId, "private-source-2")).not.toBe(
      reference,
    );
    expect(
      playbackSourceReferenceId(Buffer.alloc(32, 2), mediaReferenceId, "private-source-1"),
    ).not.toBe(reference);
  });

  it("fails closed for a different title, malformed reference, or invalid private source", () => {
    const key = Buffer.alloc(32, 1);
    const reference = playbackSourceReferenceId(key, mediaReferenceId, "private-source-1");

    expect(
      matchesPlaybackSourceReference(key, mediaReferenceId, reference, "private-source-1"),
    ).toBe(true);
    expect(
      matchesPlaybackSourceReference(key, `media_${"n".repeat(22)}`, reference, "private-source-1"),
    ).toBe(false);
    expect(
      matchesPlaybackSourceReference(key, mediaReferenceId, "private-source-1", "private-source-1"),
    ).toBe(false);
    expect(
      matchesPlaybackSourceReference(key, mediaReferenceId, reference, "/private/movie.mkv"),
    ).toBe(false);
    expect(() => playbackSourceReferenceId(key, "invalid-media", "private-source-1")).toThrow(
      TypeError,
    );
  });
});
