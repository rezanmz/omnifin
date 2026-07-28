import { SafeConnectorError } from "../src/http/safe-http-client.js";
import { describe, expect, it } from "vitest";

import { SeerrAdapter } from "../src/adapters/seerr.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

function adapterWithResponses(responses: Response[], apiKey = "fixture-api-key") {
  const mock = createMockTransport(responses);
  const adapter = new SeerrAdapter({
    apiKey,
    baseUrl: "https://seerr.example.test/",
    clock: fixedClock(),
    connectorId: "seerr-main",
    displayName: "Seerr",
    resolveHost: publicResolver,
    transport: mock.transport,
  });
  return { adapter, requests: mock.requests };
}

const credits = {
  cast: [
    { character: "Neo", id: 6384, name: "Keanu Reeves", order: 0, profilePath: "/raw.jpg" },
    { character: "Morpheus", id: 2975, name: "Laurence Fishburne", order: 1 },
  ],
  crew: [
    { department: "Directing", id: 9340, job: "Director", name: "Lana Wachowski" },
    { department: "Writing", id: 9340, job: "Writer", name: "Lana Wachowski" },
    { department: "Production", id: 999, job: "Production Assistant", name: "Private Credit" },
  ],
};

describe("Seerr media details", () => {
  it("advertises detail support only with configured credentials", () => {
    expect(
      new SeerrAdapter({
        apiKey: "fixture-api-key",
        baseUrl: "https://seerr.example.test/",
        connectorId: "seerr-main",
        displayName: "Seerr",
        resolveHost: publicResolver,
      }).capabilities,
    ).toContain("media.detail");
    expect(
      new SeerrAdapter({
        baseUrl: "https://seerr.example.test/",
        connectorId: "seerr-main",
        displayName: "Seerr",
        resolveHost: publicResolver,
      }).capabilities,
    ).not.toContain("media.detail");
  });

  it("normalizes movie details without exposing upstream artwork or media identifiers", async () => {
    const { adapter, requests } = adapterWithResponses([
      jsonResponse({
        backdropPath: "/raw-backdrop.jpg",
        credits,
        genres: [
          { id: 28, name: "Action" },
          { id: 878, name: "Science Fiction" },
        ],
        id: 603,
        mediaInfo: {
          externalServiceId: 7,
          jellyfinMediaId: "private-jellyfin-id",
          serviceUrl: "https://private.invalid",
          status: 5,
        },
        originalTitle: "The Matrix",
        overview: "A hacker discovers that the world he knows is a constructed reality.",
        posterPath: "/raw-poster.jpg",
        releaseDate: "1999-03-30",
        runtime: 136,
        status: "Released",
        tagline: "Free your mind.",
        title: "The Matrix",
        voteAverage: 8.2,
        voteCount: 27_000,
      }),
    ]);

    const result = await adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en-CA" });

    expect(result).toEqual({
      generatedAt: "2026-07-25T12:00:00.000Z",
      item: {
        availability: "available",
        cast: [
          { character: "Neo", name: "Keanu Reeves" },
          { character: "Morpheus", name: "Laurence Fishburne" },
        ],
        crew: [
          { name: "Lana Wachowski", role: "Director" },
          { name: "Lana Wachowski", role: "Writer" },
        ],
        genres: ["Action", "Science Fiction"],
        id: "movie:603",
        kind: "movie",
        originalTitle: "The Matrix",
        overview: "A hacker discovers that the world he knows is a constructed reality.",
        productionStatus: "Released",
        runtimeMinutes: 136,
        source: "seerr",
        tagline: "Free your mind.",
        title: "The Matrix",
        tmdbId: 603,
        voteAverage: 8.2,
        voteCount: 27_000,
        year: 1999,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/raw-|private|jellyfin|serviceUrl/iu);
    expect(requests[0]?.url.pathname).toBe("/api/v1/movie/603");
    expect(requests[0]?.url.searchParams.get("language")).toBe("en-CA");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("fixture-api-key");
  });

  it("normalizes series details and season summaries", async () => {
    const { adapter, requests } = adapterWithResponses([
      jsonResponse({
        credits,
        episodeRunTime: [48, 52],
        firstAirDate: "2008-01-20",
        genres: [{ id: 18, name: "Drama" }],
        id: 1396,
        mediaInfo: { status: 4 },
        name: "Breaking Bad",
        numberOfEpisodes: 62,
        numberOfSeasons: 5,
        originalName: "Breaking Bad",
        overview: "A chemistry teacher turns to manufacturing.",
        seasons: [
          { airDate: "2009-02-17", episodeCount: 7, id: 3627, name: "Specials", seasonNumber: 0 },
          { airDate: "2008-01-20", episodeCount: 7, id: 3572, name: "Season 1", seasonNumber: 1 },
        ],
        status: "Ended",
        tagline: "All bad things must come to an end.",
        voteAverage: 8.9,
        voteCount: 15_000,
      }),
    ]);

    const result = await adapter.detail({ kind: "series", tmdbId: 1396 }, { language: "en" });

    expect(result.item).toMatchObject({
      availability: "partial",
      episodeCount: 62,
      id: "series:1396",
      kind: "series",
      runtimeMinutes: 48,
      seasonCount: 5,
      seasons: [
        { episodeCount: 7, number: 0, title: "Specials", year: 2009 },
        { episodeCount: 7, number: 1, title: "Season 1", year: 2008 },
      ],
      title: "Breaking Bad",
      tmdbId: 1396,
      year: 2008,
    });
    expect(requests[0]?.url.pathname).toBe("/api/v1/tv/1396");
  });

  it("requires credentials and rejects mismatched upstream identities safely", async () => {
    const missing = adapterWithResponses([], "");
    await expect(
      missing.adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en" }),
    ).rejects.toMatchObject({
      code: "configuration_invalid",
    } satisfies Partial<SafeConnectorError>);
    expect(missing.requests).toHaveLength(0);

    const privateValue = "private-upstream-value";
    const mismatched = adapterWithResponses([
      jsonResponse({ id: 604, title: "Wrong title", payload: privateValue }),
    ]);
    let failure: unknown;
    try {
      await mismatched.adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SafeConnectorError);
    expect(failure).toMatchObject({ code: "response_invalid" });
    expect(JSON.stringify(failure)).not.toContain(privateValue);
  });
});
