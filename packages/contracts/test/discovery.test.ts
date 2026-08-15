import { describe, expect, it } from "vitest";

import {
  discoveryBrowseQueryJsonSchema,
  discoveryBrowseQuerySchema,
  discoveryBrowseResponseJsonSchema,
  discoveryBrowseResponseSchema,
  discoveryFeedQueryJsonSchema,
  discoveryFeedQuerySchema,
  discoveryFeedResponseJsonSchema,
  discoveryFeedResponseSchema,
  discoveryMediaDetailParamsSchema,
  discoveryMediaDetailParamsJsonSchema,
  discoveryMediaDetailQuerySchema,
  discoveryMediaDetailQueryJsonSchema,
  discoveryMediaDetailResponseJsonSchema,
  discoveryMediaDetailResponseSchema,
  discoveryPersonDetailParamsJsonSchema,
  discoveryPersonDetailParamsSchema,
  discoveryPersonDetailQueryJsonSchema,
  discoveryPersonDetailResponseJsonSchema,
  discoveryPersonDetailResponseSchema,
  discoveryPersonCreditsQueryJsonSchema,
  discoveryPersonCreditsQuerySchema,
  discoveryPersonCreditsResponseJsonSchema,
  discoveryPersonCreditsResponseSchema,
  discoverySearchQueryJsonSchema,
  discoverySearchQuerySchema,
  discoverySearchResponseJsonSchema,
  discoverySearchResponseSchema,
} from "../src/discovery.js";

const movie = {
  availability: "available",
  id: "movie:550",
  kind: "movie",
  mediaRecordState: "present",
  originalTitle: "Fight Club",
  overview: "An insomniac and a soap maker form an underground club.",
  source: "seerr",
  title: "Fight Club",
  tmdbId: 550,
  voteAverage: 8.4,
  year: 1999,
} as const;

describe("discovery contracts", () => {
  it("requires the bounded media-record provenance on every media shape", () => {
    for (const mediaRecordState of ["present", "absent", "unknown"] as const) {
      expect(
        discoverySearchResponseSchema.safeParse({
          generatedAt: "2026-07-27T05:00:00.000Z",
          items: [{ ...movie, mediaRecordState }],
          page: 1,
          query: "fight",
          totalPages: 1,
          totalResults: 1,
        }).success,
      ).toBe(true);
    }
    expect(
      discoverySearchResponseSchema.safeParse({
        generatedAt: "2026-07-27T05:00:00.000Z",
        items: [{ ...movie, mediaRecordState: undefined }],
        page: 1,
        query: "fight",
        totalPages: 1,
        totalResults: 1,
      }).success,
    ).toBe(false);
    expect(
      discoverySearchResponseSchema.safeParse({
        generatedAt: "2026-07-27T05:00:00.000Z",
        items: [{ ...movie, mediaRecordState: "invalid" }],
        page: 1,
        query: "fight",
        totalPages: 1,
        totalResults: 1,
      }).success,
    ).toBe(false);
  });

  it("normalizes a bounded browse query and rejects incompatible criteria", () => {
    expect(
      discoveryBrowseQuerySchema.parse({
        availability: "requestable",
        genre: "science-fiction",
        kind: "movie",
        locale: "en-CA",
        minimumRating: "7.5",
        minimumVotes: "250",
        originalLanguage: "ja",
        page: "3",
        runtimeMax: "150",
        sort: "rating",
        yearFrom: "1990",
        yearTo: "2026",
      }),
    ).toEqual({
      availability: "requestable",
      genre: "science-fiction",
      kind: "movie",
      locale: "en-CA",
      minimumRating: 7.5,
      minimumVotes: 250,
      originalLanguage: "ja",
      page: 3,
      runtimeMax: 150,
      sort: "rating",
      yearFrom: 1990,
      yearTo: 2026,
    });
    expect(
      discoveryBrowseQuerySchema.safeParse({
        genre: "science-fiction",
        kind: "series",
      }).success,
    ).toBe(false);
    expect(
      discoveryBrowseQuerySchema.safeParse({ kind: "movie", yearFrom: 2027, yearTo: 1990 }).success,
    ).toBe(false);
    expect(
      discoveryBrowseQuerySchema.safeParse({ kind: "movie", upstream: "private" }).success,
    ).toBe(false);
    expect(
      discoveryBrowseQuerySchema.safeParse({
        genre: "drama",
        kind: "movie",
        query: "arrival",
      }).success,
    ).toBe(false);
  });

  it("keeps paginated browse results normalized and artwork opaque", () => {
    const criteria = discoveryBrowseQuerySchema.parse({ kind: "movie", page: 2 });
    const response = discoveryBrowseResponseSchema.parse({
      criteria,
      generatedAt: "2026-08-03T10:00:00.000Z",
      items: [
        {
          ...movie,
          artwork: {
            backdropPath: null,
            posterPath: "/v1/discovery/artwork/discovery_art_abcdefghijklmnopqrstuv",
          },
        },
      ],
      page: 2,
      totalPages: 12,
      totalResults: 231,
    });
    expect(response.items[0]?.kind).toBe("movie");
    expect(JSON.stringify(response)).not.toContain("tmdb.org");
    expect(
      discoveryBrowseResponseSchema.safeParse({
        ...response,
        items: [{ ...response.items[0], kind: "series" }],
      }).success,
    ).toBe(false);
    expect(discoveryBrowseQuerySchema.safeParse({ kind: "movie", page: 501 }).success).toBe(false);
    expect(discoveryBrowseResponseSchema.safeParse({ ...response, totalPages: 501 }).success).toBe(
      false,
    );
  });

  it("exports closed browse schemas for the HTTP boundary", () => {
    expect(discoveryBrowseQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryBrowseResponseJsonSchema).not.toHaveProperty("$schema");
    expect(JSON.stringify(discoveryBrowseQueryJsonSchema)).toContain("additionalProperties");
  });

  it("normalizes a complete bounded discovery feed with opaque artwork", () => {
    const item = {
      ...movie,
      artwork: {
        backdropPath: "/v1/discovery/artwork/discovery_art_abcdefghijklmnopqrstuv",
        posterPath: "/v1/discovery/artwork/discovery_art_zyxwvutsrqponmlkjihgfe",
      },
    } as const;
    const response = discoveryFeedResponseSchema.parse({
      failures: [],
      generatedAt: "2026-07-30T05:00:00.000Z",
      rails: [
        { failure: null, items: [item], kind: "trending", totalResults: 20, truncated: true },
        {
          failure: null,
          items: [{ ...item, id: "movie:551", tmdbId: 551 }],
          kind: "popular_movies",
          totalResults: 1,
          truncated: false,
        },
        {
          failure: null,
          items: [
            {
              ...item,
              id: "series:1399",
              kind: "series",
              tmdbId: 1399,
            },
          ],
          kind: "popular_series",
          totalResults: 1,
          truncated: false,
        },
        { failure: null, items: [], kind: "upcoming", totalResults: 0, truncated: false },
      ],
      state: "complete",
    });

    expect(discoveryFeedQuerySchema.parse({ language: "en-CA" })).toEqual({ language: "en-CA" });
    expect(response.rails[0]?.items[0]?.artwork.posterPath).toMatch(
      /^\/v1\/discovery\/artwork\/discovery_art_/u,
    );
    expect(JSON.stringify(response)).not.toContain("tmdb.org");
  });

  it("requires feed state and failures to match all four rails", () => {
    const failure = {
      code: "timeout",
      message: "Discovery did not respond before the deadline.",
      occurredAt: "2026-07-30T05:00:00.000Z",
      operation: "discovery.feed.trending",
      retryable: true,
      service: "seerr",
    } as const;
    const rails = [
      { failure, items: [], kind: "trending", totalResults: 0, truncated: false },
      { failure: null, items: [], kind: "popular_movies", totalResults: 0, truncated: false },
      { failure: null, items: [], kind: "popular_series", totalResults: 0, truncated: false },
      { failure: null, items: [], kind: "upcoming", totalResults: 0, truncated: false },
    ] as const;

    expect(
      discoveryFeedResponseSchema.parse({
        failures: [failure],
        generatedAt: "2026-07-30T05:00:00.000Z",
        rails,
        state: "degraded",
      }).state,
    ).toBe("degraded");
    expect(
      discoveryFeedResponseSchema.safeParse({
        failures: [],
        generatedAt: "2026-07-30T05:00:00.000Z",
        rails,
        state: "empty",
      }).success,
    ).toBe(false);
    expect(
      discoveryFeedResponseSchema.safeParse({
        failures: [failure],
        generatedAt: "2026-07-30T05:00:00.000Z",
        rails: rails.map((rail) => ({ ...rail, kind: "trending" })),
        state: "degraded",
      }).success,
    ).toBe(false);
  });

  it("rejects raw discovery artwork and inconsistent rail metadata", () => {
    const item = {
      ...movie,
      artwork: { backdropPath: null, posterPath: "https://image.tmdb.org/private.jpg" },
    };
    expect(
      discoveryFeedResponseSchema.safeParse({
        failures: [],
        generatedAt: "2026-07-30T05:00:00.000Z",
        rails: [
          { failure: null, items: [item], kind: "trending", totalResults: 1, truncated: false },
          { failure: null, items: [], kind: "popular_movies", totalResults: 0, truncated: false },
          { failure: null, items: [], kind: "popular_series", totalResults: 0, truncated: false },
          { failure: null, items: [], kind: "upcoming", totalResults: 0, truncated: false },
        ],
        state: "complete",
      }).success,
    ).toBe(false);
  });

  it("normalizes and bounds media-detail route input", () => {
    expect(discoveryMediaDetailParamsSchema.parse({ kind: "series", tmdbId: "1399" })).toEqual({
      kind: "series",
      tmdbId: 1399,
    });
    expect(discoveryMediaDetailQuerySchema.parse({ language: "en-CA" })).toEqual({
      language: "en-CA",
    });
    expect(
      discoveryMediaDetailParamsSchema.safeParse({ kind: "person", tmdbId: 287 }).success,
    ).toBe(false);
    expect(
      discoveryMediaDetailParamsSchema.safeParse({ kind: "movie", tmdbId: "../../private" })
        .success,
    ).toBe(false);
    expect(discoveryMediaDetailQuerySchema.safeParse({ language: "../../private" }).success).toBe(
      false,
    );
  });

  it("accepts normalized movie and series details", () => {
    const common = {
      artwork: { backdropPath: null, posterPath: null },
      availability: "available",
      cast: [{ character: "Neo", name: "Keanu Reeves", personId: 6384, profilePath: null }],
      crew: [{ name: "Lana Wachowski", personId: 9339, role: "Director" }],
      genres: ["Action", "Science Fiction"],
      id: "movie:603",
      kind: "movie",
      mediaRecordState: "present",
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
        ],
        ratingsState: "ready",
        recommendations: [],
        recommendationsState: "empty",
        trailers: [
          {
            id: "youtube:m8e-FF8MsqU",
            provider: "youtube",
            resolution: 1080,
            title: "Official trailer",
            type: "trailer",
          },
        ],
      },
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
    } as const;
    const response = discoveryMediaDetailResponseSchema.parse({
      generatedAt: "2026-07-28T20:00:00.000Z",
      item: common,
    });
    expect(response.item.kind).toBe("movie");
    expect(response.item.intelligence.ratings[0]?.providerReference).toEqual({
      identifier: 603,
      mediaKind: "movie",
      provider: "tmdb",
    });

    const series = discoveryMediaDetailResponseSchema.parse({
      generatedAt: "2026-07-28T20:00:00.000Z",
      item: {
        ...common,
        episodeCount: 73,
        id: "series:1396",
        intelligence: {
          ...common.intelligence,
          ratings: common.intelligence.ratings.map((rating) => ({
            ...rating,
            providerReference:
              rating.source === "tmdb"
                ? { identifier: 1396, mediaKind: "series" as const, provider: "tmdb" as const }
                : {
                    identifier: "the_matrix",
                    mediaKind: "series" as const,
                    provider: "rotten_tomatoes" as const,
                  },
          })),
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
      },
    });
    expect(series.item.kind).toBe("series");
    if (series.item.kind === "series") expect(series.item.seasons).toHaveLength(2);
    expect(
      discoveryMediaDetailResponseSchema.safeParse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        item: {
          ...common,
          intelligence: {
            ...common.intelligence,
            ratings: [
              {
                ...common.intelligence.ratings[0],
                providerReference: { identifier: 1396, mediaKind: "series", provider: "tmdb" },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      discoveryMediaDetailResponseSchema.safeParse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        item: {
          ...common,
          intelligence: {
            ...common.intelligence,
            ratings: [
              {
                ...common.intelligence.ratings[0],
                providerReference: {
                  href: "https://private.invalid/title/603",
                  identifier: 603,
                  mediaKind: "movie",
                  provider: "tmdb",
                },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("allows only opaque library references on owned discovery details", () => {
    const detail = {
      artwork: { backdropPath: null, posterPath: null },
      availability: "available",
      cast: [],
      crew: [],
      genres: [],
      id: "movie:603",
      intelligence: {
        ratings: [],
        ratingsState: "empty",
        recommendations: [],
        recommendationsState: "empty",
        trailers: [],
      },
      kind: "movie",
      libraryReferenceId: "media_1234567890123456789012",
      mediaRecordState: "present",
      originalTitle: null,
      overview: null,
      productionStatus: null,
      runtimeMinutes: 136,
      source: "seerr",
      tagline: null,
      title: "The Matrix",
      tmdbId: 603,
      voteAverage: null,
      voteCount: null,
      year: 1999,
    };
    expect(
      discoveryMediaDetailResponseSchema.safeParse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        item: detail,
      }).success,
    ).toBe(true);
    expect(
      discoveryMediaDetailResponseSchema.safeParse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        item: { ...detail, libraryReferenceId: "jellyfin-private-item-id" },
      }).success,
    ).toBe(false);
  });

  it("rejects raw upstream fields and unbounded detail collections", () => {
    const detail = {
      artwork: { backdropPath: null, posterPath: null },
      availability: "unavailable",
      cast: [],
      crew: [],
      genres: [],
      id: "movie:603",
      intelligence: {
        ratings: [],
        ratingsState: "unavailable",
        recommendations: [],
        recommendationsState: "unavailable",
        trailers: [],
      },
      kind: "movie",
      mediaRecordState: "absent",
      originalTitle: null,
      overview: null,
      productionStatus: null,
      runtimeMinutes: null,
      source: "seerr",
      tagline: null,
      title: "The Matrix",
      tmdbId: 603,
      voteAverage: null,
      voteCount: null,
      year: 1999,
    } as const;
    const response = {
      generatedAt: "2026-07-28T20:00:00.000Z",
      item: detail,
    };
    expect(discoveryMediaDetailResponseSchema.safeParse(response).success).toBe(true);
    expect(
      discoveryMediaDetailResponseSchema.safeParse({
        ...response,
        item: {
          ...detail,
          backdropPath: "/private-upstream-value",
          mediaInfo: { serviceUrl: "https://private.invalid" },
        },
      }).success,
    ).toBe(false);
    expect(
      discoveryMediaDetailResponseSchema.safeParse({
        ...response,
        item: {
          ...detail,
          cast: Array.from({ length: 13 }, (_, index) => ({
            character: null,
            name: `Performer ${index}`,
            personId: index + 1,
            profilePath: null,
          })),
        },
      }).success,
    ).toBe(false);
    expect(
      discoveryMediaDetailResponseSchema.safeParse({
        ...response,
        item: {
          ...detail,
          intelligence: {
            ...detail.intelligence,
            ratings: [
              {
                audience: "community",
                label: "IMDb",
                scale: 10,
                sentiment: null,
                source: "imdb",
                value: 95,
                voteCount: null,
              },
            ],
            ratingsState: "ready",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("normalizes person biographies and bounded credits", () => {
    expect(discoveryPersonDetailParamsSchema.parse({ tmdbId: "6384" })).toEqual({
      tmdbId: 6384,
    });
    expect(
      discoveryPersonDetailResponseSchema.parse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        item: {
          biography: "An actor known for exacting genre work.",
          birthday: "1964-09-02",
          birthplace: "Beirut, Lebanon",
          credits: [
            {
              availability: "available",
              kind: "movie",
              mediaRecordState: "present",
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
      }).item.name,
    ).toBe("Keanu Reeves");
    expect(
      discoveryPersonDetailResponseSchema.safeParse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        item: {
          biography: null,
          birthday: null,
          birthplace: null,
          credits: [],
          creditsState: "empty",
          creditsTotal: 0,
          deathday: null,
          department: null,
          id: "person:6384",
          imdbId: "nm0000206",
          name: "Keanu Reeves",
          source: "seerr",
          tmdbId: 6384,
        },
      }).success,
    ).toBe(false);
  });

  it("normalizes bounded person-credit pages", () => {
    expect(discoveryPersonCreditsQuerySchema.parse({ page: "2" })).toEqual({
      language: "en",
      page: 2,
    });
    expect(
      discoveryPersonCreditsResponseSchema.parse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        items: [
          {
            availability: "available",
            kind: "movie",
            mediaRecordState: "present",
            role: "Neo",
            title: "The Matrix",
            tmdbId: 603,
            voteAverage: 8.2,
            year: 1999,
          },
        ],
        page: 3,
        pageSize: 24,
        totalPages: 3,
        totalResults: 49,
      }).totalPages,
    ).toBe(3);
    expect(discoveryPersonCreditsQuerySchema.safeParse({ page: 101 }).success).toBe(false);
    expect(
      discoveryPersonCreditsResponseSchema.safeParse({
        generatedAt: "2026-07-28T20:00:00.000Z",
        items: Array.from({ length: 25 }, () => ({
          availability: "unknown",
          kind: "movie",
          role: "Cast",
          title: "Bounded work",
          tmdbId: 1,
          voteAverage: null,
          year: null,
        })),
        page: 1,
        pageSize: 24,
        totalPages: 2,
        totalResults: 25,
      }).success,
    ).toBe(false);
  });

  it("normalizes and bounds a search query", () => {
    expect(discoverySearchQuerySchema.parse({ query: "  Meridian  ", page: "2" })).toEqual({
      language: "en",
      page: 2,
      query: "Meridian",
    });
    expect(discoverySearchQuerySchema.safeParse({ query: "x" }).success).toBe(false);
    expect(discoverySearchQuerySchema.safeParse({ query: "signal", page: "501" }).success).toBe(
      false,
    );
    expect(
      discoverySearchQuerySchema.safeParse({ query: "signal", language: "../../private" }).success,
    ).toBe(false);
  });

  it("accepts normalized movie, series, and person results", () => {
    const response = discoverySearchResponseSchema.parse({
      generatedAt: "2026-07-27T05:00:00.000Z",
      items: [
        movie,
        {
          ...movie,
          availability: "requested",
          id: "series:1399",
          kind: "series",
          originalTitle: "Game of Thrones",
          title: "Game of Thrones",
          tmdbId: 1399,
          year: 2011,
        },
        {
          id: "person:287",
          kind: "person",
          knownFor: [{ kind: "movie", title: "Fight Club", year: 1999 }],
          source: "seerr",
          title: "Brad Pitt",
          tmdbId: 287,
        },
      ],
      page: 1,
      query: "fight",
      totalPages: 4,
      totalResults: 65,
    });

    expect(response.items.map((item) => item.kind)).toEqual(["movie", "series", "person"]);
  });

  it("rejects raw upstream fields and unbounded pagination", () => {
    const base = {
      generatedAt: "2026-07-27T05:00:00.000Z",
      items: [movie],
      page: 1,
      query: "fight",
      totalPages: 1,
      totalResults: 1,
    };
    expect(
      discoverySearchResponseSchema.safeParse({
        ...base,
        items: [{ ...movie, posterPath: "/private-upstream-value" }],
      }).success,
    ).toBe(false);
    expect(discoverySearchResponseSchema.safeParse({ ...base, page: 501 }).success).toBe(false);
    expect(discoverySearchResponseSchema.safeParse({ ...base, totalPages: 501 }).success).toBe(
      false,
    );
  });

  it("publishes dialect-neutral route schemas", () => {
    expect(discoveryFeedQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryFeedResponseJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryMediaDetailParamsJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryMediaDetailQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryMediaDetailResponseJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryPersonDetailParamsJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryPersonDetailQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryPersonDetailResponseJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryPersonCreditsQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryPersonCreditsResponseJsonSchema).not.toHaveProperty("$schema");
    expect(discoverySearchQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoverySearchResponseJsonSchema).not.toHaveProperty("$schema");
  });
});
