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
          url: "https://www.imdb.com/title/tt0133093/",
        },
        rt: {
          audienceRating: "Upright",
          audienceScore: 85,
          criticsRating: "Certified Fresh",
          criticsScore: 83,
          title: "The Matrix",
          url: "https://www.rottentomatoes.com/m/the_matrix",
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

    expect(result.response).toEqual({
      generatedAt: "2026-07-25T12:00:00.000Z",
      item: {
        artwork: { backdropPath: null, posterPath: null },
        availability: "available",
        cast: [
          { character: "Neo", name: "Keanu Reeves", personId: 6384, profilePath: null },
          {
            character: "Morpheus",
            name: "Laurence Fishburne",
            personId: 2975,
            profilePath: null,
          },
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
              providerReference: { identifier: 603, mediaKind: "movie", provider: "tmdb" },
              scale: 10,
              sentiment: null,
              source: "tmdb",
              value: 8.2,
              voteCount: 27_000,
            },
            {
              audience: "community",
              label: "IMDb",
              providerReference: {
                identifier: "tt0133093",
                mediaKind: "movie",
                provider: "imdb",
              },
              scale: 10,
              sentiment: null,
              source: "imdb",
              value: 8.7,
              voteCount: 2_100_000,
            },
            {
              audience: "critics",
              label: "Tomatometer",
              providerReference: {
                identifier: "the_matrix",
                mediaKind: "movie",
                provider: "rotten_tomatoes",
              },
              scale: 100,
              sentiment: "Certified Fresh",
              source: "rotten_tomatoes",
              value: 83,
              voteCount: null,
            },
            {
              audience: "audience",
              label: "RT audience",
              providerReference: {
                identifier: "the_matrix",
                mediaKind: "movie",
                provider: "rotten_tomatoes",
              },
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
    expect(JSON.stringify(result.response)).not.toMatch(
      /raw-|private|jellyfin|serviceUrl|https?:/iu,
    );
    expect(result.artwork).toEqual({
      backdropPath: "/raw-backdrop.jpg",
      castProfilePaths: ["/raw.jpg", null],
      posterPath: "/raw-poster.jpg",
    });
    expect(requests[0]?.url.pathname).toBe("/api/v1/movie/603");
    expect(requests[0]?.url.searchParams.get("language")).toBe("en-CA");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("fixture-api-key");
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/movie/603",
      "/api/v1/movie/603/ratingscombined",
      "/api/v1/movie/603/recommendations",
    ]);
  });

  it("keeps ratings non-interactive when upstream destinations are not canonical", async () => {
    const { adapter } = adapterWithResponses([
      jsonResponse({
        credits: { cast: [], crew: [] },
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
      jsonResponse({
        imdb: {
          criticsScore: 8.7,
          criticsScoreCount: 2_100_000,
          url: "https://www.imdb.com.evil.invalid/title/tt0133093",
        },
        rt: {
          criticsRating: "Fresh",
          criticsScore: 83,
          url: "https://www.rottentomatoes.com/m/the_matrix?token=private",
        },
      }),
      jsonResponse({ page: 1, results: [], totalPages: 0, totalResults: 0 }),
    ]);

    const result = await adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en" });

    expect(result.response.item.intelligence.ratings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "TMDB", providerReference: expect.any(Object) }),
        expect.objectContaining({ label: "IMDb", providerReference: null }),
        expect.objectContaining({ label: "Tomatometer", providerReference: null }),
      ]),
    );
    expect(JSON.stringify(result.response)).not.toContain("evil.invalid");
    expect(JSON.stringify(result.response)).not.toContain("token");
  });

  it("retains movie details while truncating an oversized related-video collection", async () => {
    const relatedVideos = Array.from({ length: 159 }, (_, index) => ({
      key: `bounded-video-${String(index).padStart(3, "0")}`,
      name: `Trailer ${index + 1}`,
      site: "YouTube",
      size: 1_080,
      type: "Trailer",
    }));
    const { adapter } = adapterWithResponses([
      jsonResponse({
        credits: { cast: [], crew: [] },
        genres: [],
        id: 603,
        mediaInfo: null,
        originalTitle: "The Matrix",
        overview: "A valid title with an unusually large related-video collection.",
        releaseDate: "1999-03-30",
        relatedVideos,
        runtime: 136,
        status: "Released",
        tagline: null,
        title: "The Matrix",
        voteAverage: 8.2,
        voteCount: 27_000,
      }),
      jsonResponse({}),
      jsonResponse({ page: 1, results: [], totalPages: 0, totalResults: 0 }),
    ]);

    const result = await adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en" });

    expect(result.response.item.title).toBe("The Matrix");
    expect(result.response.item.intelligence.trailers).toHaveLength(6);
    expect(result.response.item.intelligence.trailers.map(({ id }) => id)).toEqual(
      relatedVideos.slice(0, 6).map(({ key }) => `youtube:${key}`),
    );
    expect(JSON.stringify(result)).not.toContain("bounded-video-100");
  });

  it("discards malformed optional video entries without losing valid title details", async () => {
    const baseDetail = {
      credits: { cast: [], crew: [] },
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
    };
    const validVideos = Array.from({ length: 100 }, (_, index) => ({
      key: `valid-${index}`,
      name: `Trailer ${index}`,
      site: "YouTube",
      type: "Trailer",
    }));
    const overflow = adapterWithResponses([
      jsonResponse({ ...baseDetail, relatedVideos: [...validVideos, { private: true }] }),
      jsonResponse({}),
      jsonResponse({ page: 1, results: [], totalPages: 0, totalResults: 0 }),
    ]).adapter;
    const retained = adapterWithResponses([
      jsonResponse({ ...baseDetail, relatedVideos: [{ private: true }, ...validVideos] }),
    ]).adapter;

    await expect(
      overflow.detail({ kind: "movie", tmdbId: 603 }, { language: "en" }),
    ).resolves.toMatchObject({ response: { item: { title: "The Matrix" } } });
    await expect(
      retained.detail({ kind: "movie", tmdbId: 603 }, { language: "en" }),
    ).resolves.toMatchObject({ response: { item: { title: "The Matrix" } } });
  });

  it("bounds and sanitizes optional credits and genres before public validation", async () => {
    const cast = Array.from({ length: 240 }, (_, index) => ({
      character: `Character ${index}`,
      id: index + 1,
      name: `Performer ${index}`,
      order: index,
      profilePath: `/profile-${index}.jpg`,
    }));
    const { adapter } = adapterWithResponses([
      jsonResponse({
        backdropPath: "/title-backdrop.jpg",
        credits: { cast: [{ private: true }, ...cast], crew: [{ private: true }] },
        genres: [
          { private: true },
          ...Array.from({ length: 120 }, (_, id) => ({ id: id + 1, name: `Genre ${id}` })),
        ],
        id: 603,
        mediaInfo: null,
        originalTitle: "The Matrix",
        overview: "Core title details remain available.",
        posterPath: "/title-poster.jpg",
        releaseDate: "1999-03-30",
        runtime: 136,
        status: "Released",
        tagline: null,
        title: "The Matrix",
        voteAverage: 8.2,
        voteCount: 27_000,
      }),
      jsonResponse({}),
      jsonResponse({ page: 1, results: [{ private: true }], totalPages: 1, totalResults: 1 }),
    ]);

    const result = await adapter.detail({ kind: "movie", tmdbId: 603 }, { language: "en" });

    expect(result.response.item).toMatchObject({ title: "The Matrix" });
    expect(result.response.item.cast).toHaveLength(12);
    expect(result.response.item.genres).toHaveLength(20);
    expect(result.response.item.intelligence.recommendations).toEqual([]);
    expect(result.artwork).toMatchObject({
      backdropPath: "/title-backdrop.jpg",
      posterPath: "/title-poster.jpg",
    });
    expect(result.artwork.castProfilePaths).toHaveLength(12);
    expect(JSON.stringify(result.response)).not.toContain("private");
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
        url: "https://www.rottentomatoes.com/tv/breaking_bad",
      }),
      jsonResponse({ page: 1, results: [], totalPages: 0, totalResults: 0 }),
    ]);

    const result = await adapter.detail({ kind: "series", tmdbId: 1396 }, { language: "en" });

    expect(result.response.item).toMatchObject({
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

    expect(result.response.item.intelligence).toMatchObject({
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

    expect(result.response).toEqual({
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
        creditsTotal: 1,
        deathday: null,
        department: "Acting",
        id: "person:6384",
        name: "Keanu Reeves",
        profilePath: null,
        source: "seerr",
        tmdbId: 6384,
      },
    });
    expect(JSON.stringify(result.response)).not.toMatch(/private|imdb|https?:/iu);
    expect(result.profilePath).toBe("/private-profile.jpg");
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/person/6384",
      "/api/v1/person/6384/combined_credits",
    ]);
  });

  it("returns bounded person-credit pages with stable normalized totals", async () => {
    const { adapter, requests } = adapterWithResponses([
      jsonResponse({
        cast: Array.from({ length: 30 }, (_, index) => ({
          adult: false,
          character: `Role ${index + 1}`,
          id: 1_000 + index,
          mediaInfo: index % 2 === 0 ? { status: 5 } : null,
          mediaType: index % 3 === 0 ? "tv" : "movie",
          name: index % 3 === 0 ? `Series ${index + 1}` : null,
          popularity: 100 - index,
          releaseDate: index % 3 === 0 ? null : `20${String(index).padStart(2, "0")}-01-01`,
          title: index % 3 === 0 ? null : `Movie ${index + 1}`,
          voteAverage: 7,
        })),
        crew: [],
        id: 6384,
      }),
    ]);

    const result = await adapter.personCredits({ tmdbId: 6384 }, { language: "en", page: 2 });

    expect(result).toMatchObject({
      page: 2,
      pageSize: 24,
      totalPages: 2,
      totalResults: 30,
    });
    expect(result.items).toHaveLength(6);
    expect(result.items[0]).toMatchObject({ role: "Role 25", tmdbId: 1024 });
    expect(requests[0]?.url.pathname).toBe("/api/v1/person/6384/combined_credits");
    expect(requests[0]?.url.searchParams.get("language")).toBe("en");
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
