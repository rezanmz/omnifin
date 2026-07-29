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
        relatedVideos: [
          {
            key: "m8e-FF8MsqU",
            name: "The Matrix — official trailer",
            site: "YouTube",
            size: 1080,
            type: "Trailer",
            url: "https://private.invalid/watch",
          },
          {
            key: "private-blooper",
            name: "Outtakes",
            site: "YouTube",
            size: 720,
            type: "Bloopers",
          },
          {
            key: "private-vimeo",
            name: "Alternate provider trailer",
            site: "Vimeo",
            size: 1080,
            type: "Trailer",
            url: "https://private.invalid/vimeo",
          },
        ],
        voteAverage: 8.2,
        voteCount: 27_000,
      }),
      jsonResponse({
        imdb: {
          criticsScore: 8.7,
          criticsScoreCount: 2_100_000,
          title: "The Matrix",
          url: "https://www.imdb.com/title/private",
        },
        rt: {
          audienceRating: "Upright",
          audienceScore: 85,
          criticsRating: "Certified Fresh",
          criticsScore: 83,
          title: "The Matrix",
          url: "https://www.rottentomatoes.com/private",
          year: 1999,
        },
      }),
      jsonResponse({
        page: 1,
        results: [
          {
            id: 604,
            mediaInfo: { status: 2 },
            originalTitle: "The Matrix Reloaded",
            overview: "The signal continues.",
            releaseDate: "2003-05-15",
            title: "The Matrix Reloaded",
            voteAverage: 7.1,
          },
        ],
        totalPages: 1,
        totalResults: 1,
      }),
    ]);

    const result = await adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en-CA" });

    expect(result).toEqual({
      generatedAt: "2026-07-25T12:00:00.000Z",
      item: {
        availability: "available",
        cast: [
          { character: "Neo", name: "Keanu Reeves", personId: 6384 },
          { character: "Morpheus", name: "Laurence Fishburne", personId: 2975 },
        ],
        crew: [
          { name: "Lana Wachowski", personId: 9340, role: "Director" },
          { name: "Lana Wachowski", personId: 9340, role: "Writer" },
        ],
        genres: ["Action", "Science Fiction"],
        id: "movie:603",
        intelligence: {
          ratings: [
            {
              audience: "community",
              label: "TMDB",
              scale: 10,
              sentiment: null,
              source: "tmdb",
              value: 8.2,
              voteCount: 27_000,
            },
            {
              audience: "community",
              label: "IMDb",
              scale: 10,
              sentiment: null,
              source: "imdb",
              value: 8.7,
              voteCount: 2_100_000,
            },
            {
              audience: "critics",
              label: "Tomatometer",
              scale: 100,
              sentiment: "Certified Fresh",
              source: "rotten_tomatoes",
              value: 83,
              voteCount: null,
            },
            {
              audience: "audience",
              label: "RT audience",
              scale: 100,
              sentiment: "Upright",
              source: "rotten_tomatoes",
              value: 85,
              voteCount: null,
            },
          ],
          ratingsState: "ready",
          recommendations: [
            {
              availability: "requested",
              id: "movie:604",
              kind: "movie",
              originalTitle: "The Matrix Reloaded",
              overview: "The signal continues.",
              source: "seerr",
              title: "The Matrix Reloaded",
              tmdbId: 604,
              voteAverage: 7.1,
              year: 2003,
            },
          ],
          recommendationsState: "ready",
          trailers: [
            {
              id: "youtube:m8e-FF8MsqU",
              provider: "youtube",
              resolution: 1080,
              title: "The Matrix — official trailer",
              type: "trailer",
            },
          ],
        },
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
    expect(JSON.stringify(result)).not.toMatch(/raw-|private|jellyfin|serviceUrl|https?:/iu);
    expect(requests[0]?.url.pathname).toBe("/api/v1/movie/603");
    expect(requests[0]?.url.searchParams.get("language")).toBe("en-CA");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("fixture-api-key");
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/movie/603",
      "/api/v1/movie/603/ratingscombined",
      "/api/v1/movie/603/recommendations",
    ]);
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
      jsonResponse({
        audienceRating: "Upright",
        audienceScore: 96,
        criticsRating: "Fresh",
        criticsScore: 96,
      }),
      jsonResponse({ page: 1, results: [], totalPages: 0, totalResults: 0 }),
    ]);

    const result = await adapter.detail({ kind: "series", tmdbId: 1396 }, { language: "en" });

    expect(result.item).toMatchObject({
      availability: "partial",
      episodeCount: 62,
      id: "series:1396",
      intelligence: {
        ratings: expect.arrayContaining([
          expect.objectContaining({ label: "TMDB", value: 8.9 }),
          expect.objectContaining({ label: "Tomatometer", value: 96 }),
        ]),
        ratingsState: "ready",
        recommendations: [],
        recommendationsState: "empty",
        trailers: [],
      },
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

  it("keeps core details usable when optional intelligence is offline", async () => {
    const { adapter } = adapterWithResponses([
      jsonResponse({
        credits,
        genres: [],
        id: 603,
        mediaInfo: null,
        originalTitle: "The Matrix",
        overview: null,
        releaseDate: "1999-03-30",
        runtime: 136,
        status: "Released",
        tagline: null,
        title: "The Matrix",
        voteAverage: 8.2,
        voteCount: 27_000,
      }),
      jsonResponse({ message: "temporarily offline" }, { status: 503 }),
      jsonResponse({ message: "temporarily offline" }, { status: 503 }),
    ]);

    const result = await adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en" });

    expect(result.item.intelligence).toMatchObject({
      ratings: [expect.objectContaining({ label: "TMDB" })],
      ratingsState: "unavailable",
      recommendations: [],
      recommendationsState: "unavailable",
    });
  });

  it("normalizes a person biography and curated credits without upstream identifiers", async () => {
    const { adapter, requests } = adapterWithResponses([
      jsonResponse({
        biography: "An actor known for exacting genre work.",
        birthday: "1964-09-02",
        deathday: null,
        homepage: "https://private.invalid",
        id: 6384,
        imdbId: "nm0000206",
        knownForDepartment: "Acting",
        name: "Keanu Reeves",
        placeOfBirth: "Beirut, Lebanon",
        profilePath: "/private-profile.jpg",
      }),
      jsonResponse({
        cast: [
          {
            adult: false,
            character: "Neo",
            id: 603,
            mediaInfo: { status: 5 },
            mediaType: "movie",
            popularity: 95,
            releaseDate: "1999-03-30",
            title: "The Matrix",
            voteAverage: 8.2,
          },
        ],
        crew: [],
        id: 6384,
      }),
    ]);

    const result = await adapter.personDetail({ tmdbId: 6384 }, { language: "en-CA" });

    expect(result).toEqual({
      generatedAt: "2026-07-25T12:00:00.000Z",
      item: {
        biography: "An actor known for exacting genre work.",
        birthday: "1964-09-02",
        birthplace: "Beirut, Lebanon",
        credits: [
          {
            availability: "available",
            kind: "movie",
            role: "Neo",
            title: "The Matrix",
            tmdbId: 603,
            voteAverage: 8.2,
            year: 1999,
          },
        ],
        creditsState: "ready",
        deathday: null,
        department: "Acting",
        id: "person:6384",
        name: "Keanu Reeves",
        source: "seerr",
        tmdbId: 6384,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|imdb|profile|https?:/iu);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/person/6384",
      "/api/v1/person/6384/combined_credits",
    ]);
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
      jsonResponse({}, { status: 404 }),
      jsonResponse({}, { status: 404 }),
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
