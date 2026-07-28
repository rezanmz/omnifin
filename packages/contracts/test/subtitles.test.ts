import { describe, expect, it } from "vitest";

import { subtitleDownloadResponseSchema, subtitleSearchResponseSchema } from "../src/subtitles.js";

const searchId = `subtitle_search_${"s".repeat(22)}`;
const resultId = `subtitle_result_${"r".repeat(22)}`;

function response() {
  return {
    expiresAt: "2026-07-28T12:20:00.000Z",
    generatedAt: "2026-07-28T12:00:00.000Z",
    media: {
      episodeNumber: 3,
      kind: "episode" as const,
      seasonNumber: 2,
      title: "Northern Lights",
      year: 2026,
    },
    results: [
      {
        dontMatches: ["release_group"],
        forced: false,
        hearingImpaired: true,
        id: resultId,
        language: "English",
        matches: ["series", "season", "episode"],
        originalFormat: false,
        provider: "OpenSubtitles.com",
        releaseNames: ["Northern.Lights.S02E03.1080p.WEB-DL"],
        score: 96.5,
        uploader: "caption-curator",
      },
    ],
    searchId,
  };
}

describe("subtitle operation contracts", () => {
  it("accepts normalized candidates without exposing Bazarr internals", () => {
    const parsed = subtitleSearchResponseSchema.parse(response());

    expect(parsed.results[0]).toMatchObject({
      hearingImpaired: true,
      score: 96.5,
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /(?:radarrid|seriesid|episodeid|subtitleToken|url)/iu,
    );
  });

  it("supports movie targets and an empty result set", () => {
    expect(
      subtitleSearchResponseSchema.parse({
        ...response(),
        media: { kind: "movie", title: "Ember Coast", year: null },
        results: [],
      }),
    ).toMatchObject({ media: { kind: "movie" }, results: [] });
  });

  it("rejects expired searches, duplicate opaque ids, and control characters", () => {
    expect(() =>
      subtitleSearchResponseSchema.parse({
        ...response(),
        expiresAt: response().generatedAt,
      }),
    ).toThrow();
    expect(() =>
      subtitleSearchResponseSchema.parse({
        ...response(),
        results: [response().results[0], response().results[0]],
      }),
    ).toThrow();
    expect(() =>
      subtitleSearchResponseSchema.parse({
        ...response(),
        results: [{ ...response().results[0], provider: "visible\u0000hidden" }],
      }),
    ).toThrow();
  });

  it("reports queued downloads as accepted without claiming completion", () => {
    expect(
      subtitleDownloadResponseSchema.parse({
        acceptedAt: "2026-07-28T12:02:00.000Z",
        resultId,
        searchId,
        status: "accepted",
      }),
    ).toEqual({
      acceptedAt: "2026-07-28T12:02:00.000Z",
      resultId,
      searchId,
      status: "accepted",
    });
  });
});
