import { describe, expect, it } from "vitest";

import {
  discoveryMediaDetailParamsSchema,
  discoveryMediaDetailParamsJsonSchema,
  discoveryMediaDetailQuerySchema,
  discoveryMediaDetailQueryJsonSchema,
  discoveryMediaDetailResponseJsonSchema,
  discoveryMediaDetailResponseSchema,
  discoverySearchQueryJsonSchema,
  discoverySearchQuerySchema,
  discoverySearchResponseJsonSchema,
  discoverySearchResponseSchema,
} from "../src/discovery.js";

const movie = {
  availability: "available",
  id: "movie:550",
  kind: "movie",
  originalTitle: "Fight Club",
  overview: "An insomniac and a soap maker form an underground club.",
  source: "seerr",
  title: "Fight Club",
  tmdbId: 550,
  voteAverage: 8.4,
  year: 1999,
} as const;

describe("discovery contracts", () => {
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
      availability: "available",
      cast: [{ character: "Neo", name: "Keanu Reeves" }],
      crew: [{ name: "Lana Wachowski", role: "Director" }],
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
    } as const;
    const response = discoveryMediaDetailResponseSchema.parse({
      generatedAt: "2026-07-28T20:00:00.000Z",
      item: common,
    });
    expect(response.item.kind).toBe("movie");

    const series = discoveryMediaDetailResponseSchema.parse({
      generatedAt: "2026-07-28T20:00:00.000Z",
      item: {
        ...common,
        episodeCount: 73,
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
      },
    });
    expect(series.item.kind).toBe("series");
    if (series.item.kind === "series") expect(series.item.seasons).toHaveLength(2);
  });

  it("rejects raw upstream fields and unbounded detail collections", () => {
    const detail = {
      availability: "unavailable",
      cast: [],
      crew: [],
      genres: [],
      id: "movie:603",
      kind: "movie",
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
          })),
        },
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
    expect(discoveryMediaDetailParamsJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryMediaDetailQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoveryMediaDetailResponseJsonSchema).not.toHaveProperty("$schema");
    expect(discoverySearchQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoverySearchResponseJsonSchema).not.toHaveProperty("$schema");
  });
});
