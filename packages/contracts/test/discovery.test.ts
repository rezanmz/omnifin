import { describe, expect, it } from "vitest";

import {
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
    expect(discoverySearchQueryJsonSchema).not.toHaveProperty("$schema");
    expect(discoverySearchResponseJsonSchema).not.toHaveProperty("$schema");
  });
});
