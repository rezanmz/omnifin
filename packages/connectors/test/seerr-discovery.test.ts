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

const searchResponse = {
  page: 1,
  results: [
    {
      backdropPath: "/raw-backdrop.jpg",
      id: 550,
      mediaInfo: { status: 5 },
      mediaType: "movie",
      originalTitle: "Fight Club",
      overview: "An insomniac and a soap maker form an underground club.",
      posterPath: "/raw-poster.jpg",
      releaseDate: "1999-10-15",
      title: "Fight Club",
      voteAverage: 8.4,
    },
    {
      firstAirDate: "2011-04-17",
      id: 1399,
      mediaInfo: { status: 2 },
      mediaType: "tv",
      name: "Game of Thrones",
      originalName: "Game of Thrones",
      overview: "Nine families vie for control.",
      voteAverage: 8.5,
    },
    {
      id: 287,
      knownFor: [
        {
          id: 550,
          mediaType: "movie",
          originalTitle: "Fight Club",
          overview: "",
          releaseDate: "1999-10-15",
          title: "Fight Club",
          voteAverage: 8.4,
        },
      ],
      mediaType: "person",
      name: "Brad Pitt",
      profilePath: "/raw-profile.jpg",
    },
    { id: 123, mediaType: "collection", title: "A raw collection" },
  ],
  totalPages: 4,
  totalResults: 65,
};

describe("Seerr discovery", () => {
  it("translates a bounded movie browse query into vetted Seerr parameters", async () => {
    const requestableMovie = {
      ...searchResponse.results[0],
      id: 551,
      mediaInfo: { status: 6 },
      title: "Requestable signal",
      voteAverage: 8.8,
    };
    const partiallyAvailableMovie = {
      ...searchResponse.results[0],
      id: 552,
      mediaInfo: { status: 4 },
      title: "Partial signal",
      voteAverage: 8.7,
    };
    const { adapter, requests } = adapterWithResponses([
      jsonResponse({
        page: 2,
        results: [searchResponse.results[0], requestableMovie, partiallyAvailableMovie],
        totalPages: 12,
        totalResults: 231,
      }),
    ]);

    const result = await adapter.browse({
      availability: "requestable",
      genre: "science-fiction",
      kind: "movie",
      locale: "fr-CA",
      minimumRating: 7.5,
      minimumVotes: 250,
      originalLanguage: "ja",
      page: 2,
      runtimeMax: 150,
      sort: "rating",
      yearFrom: 1990,
      yearTo: 2026,
    });

    expect(result).toMatchObject({
      items: [
        { media: { availability: "unavailable", id: "movie:551" } },
        { media: { availability: "partial", id: "movie:552" } },
      ],
      page: 2,
      totalPages: 12,
      totalResults: 231,
    });
    expect(requests[0]?.url.pathname).toBe("/api/v1/discover/movies");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      genre: "878",
      language: "ja",
      page: "2",
      primaryReleaseDateGte: "1990-01-01",
      primaryReleaseDateLte: "2026-12-31",
      sortBy: "vote_average.desc",
      voteAverageGte: "7.5",
      voteCountGte: "250",
      withRuntimeLte: "150",
    });
    expect(requests[0]?.init.headers.get("accept-language")).toBe("fr-CA");
    expect(requests[0]?.url.searchParams.has("availability")).toBe(false);
  });

  it("uses the media search endpoint without leaking incompatible browse filters", async () => {
    const series = {
      ...searchResponse.results[1],
      firstAirDate: "2020-01-01",
      mediaInfo: { status: 5 },
      name: "A Series Result",
      voteAverage: 9.1,
    };
    const { adapter, requests } = adapterWithResponses([
      jsonResponse({ ...searchResponse, results: [searchResponse.results[0], series] }),
    ]);

    const result = await adapter.browse({
      availability: "available",
      kind: "series",
      locale: "en-CA",
      minimumRating: 8,
      page: 1,
      query: "series result",
      sort: "newest",
      yearFrom: 2010,
    });

    expect(result.items.map(({ media }) => media.id)).toEqual(["series:1399"]);
    expect(requests[0]?.url.pathname).toBe("/api/v1/search");
    expect(requests[0]?.url.search).toBe("?language=en-CA&page=1&query=series%20result");
    await expect(
      adapter.browse({
        genre: "drama",
        kind: "movie",
        locale: "en",
        query: "private passthrough",
      } as never),
    ).rejects.toBeTruthy();
    expect(requests).toHaveLength(1);
  });

  it("normalizes documented trending, popular, and upcoming discovery endpoints", async () => {
    const moviePage = {
      page: 1,
      results: [searchResponse.results[0]],
      totalPages: 2,
      totalResults: 21,
    };
    const seriesPage = {
      page: 1,
      results: [searchResponse.results[1]],
      totalPages: 3,
      totalResults: 41,
    };
    const { adapter, requests } = adapterWithResponses([
      jsonResponse(searchResponse),
      jsonResponse(moviePage),
      jsonResponse(seriesPage),
      jsonResponse(moviePage),
      jsonResponse(seriesPage),
    ]);

    const trending = await adapter.discover("trending", { language: "en-CA" });
    const movies = await adapter.discover("popular_movies", { language: "en-CA" });
    const series = await adapter.discover("popular_series", { language: "en-CA" });
    const upcoming = await adapter.discover("upcoming", { language: "en-CA" });

    expect(trending.items).toEqual([
      {
        artwork: { backdropPath: "/raw-backdrop.jpg", posterPath: "/raw-poster.jpg" },
        media: expect.objectContaining({ id: "movie:550", kind: "movie" }),
      },
      {
        artwork: { backdropPath: null, posterPath: null },
        media: expect.objectContaining({ id: "series:1399", kind: "series" }),
      },
    ]);
    expect(movies).toMatchObject({ totalResults: 21, items: [{ media: { id: "movie:550" } }] });
    expect(series).toMatchObject({ totalResults: 41, items: [{ media: { id: "series:1399" } }] });
    expect(upcoming.items.map(({ media }) => media.id)).toEqual(["movie:550", "series:1399"]);
    expect(upcoming.totalResults).toBe(62);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v1/discover/trending",
      "/api/v1/discover/movies",
      "/api/v1/discover/tv",
      "/api/v1/discover/movies/upcoming",
      "/api/v1/discover/tv/upcoming",
    ]);
    expect(requests[0]?.url.searchParams.get("mediaType")).toBe("all");
    expect(requests[0]?.url.searchParams.get("timeWindow")).toBe("day");
    expect(requests[1]?.url.searchParams.get("sortBy")).toBe("popularity.desc");
    expect(requests[0]?.url.searchParams.get("language")).toBe("en-CA");
    expect(requests[1]?.url.searchParams.has("language")).toBe(false);
    expect(requests[2]?.url.searchParams.has("language")).toBe(false);
    expect(requests[3]?.url.searchParams.get("language")).toBe("en-CA");
    expect(requests[4]?.url.searchParams.get("language")).toBe("en-CA");
    expect(requests[1]?.init.headers.get("accept-language")).toBe("en-CA");
    expect(requests[2]?.init.headers.get("accept-language")).toBe("en-CA");
    expect(requests.every(({ init }) => init.headers.get("x-api-key") === "fixture-api-key")).toBe(
      true,
    );
  });

  it.each(["en", "en-CA", "en-US", "fr-CA"])(
    "keeps %s as a display locale without applying an original-language filter to popular rails",
    async (language) => {
      const moviePage = {
        page: 1,
        results: [searchResponse.results[0]],
        totalPages: 1,
        totalResults: 1,
      };
      const seriesPage = {
        page: 1,
        results: [searchResponse.results[1]],
        totalPages: 1,
        totalResults: 1,
      };
      const { adapter, requests } = adapterWithResponses([
        jsonResponse(moviePage),
        jsonResponse(seriesPage),
      ]);

      await expect(adapter.discover("popular_movies", { language })).resolves.toMatchObject({
        totalResults: 1,
      });
      await expect(adapter.discover("popular_series", { language })).resolves.toMatchObject({
        totalResults: 1,
      });

      for (const request of requests) {
        expect(request.url.searchParams.has("language")).toBe(false);
        expect(request.init.headers.get("accept-language")).toBe(language);
      }
    },
  );

  it("accepts valid large Seerr page totals while bounding public navigation", async () => {
    const moviePage = {
      page: 1,
      results: [searchResponse.results[0]],
      totalPages: 61_307,
      totalResults: 1_226_132,
    };
    const seriesPage = {
      page: 1,
      results: [searchResponse.results[1]],
      totalPages: 11_416,
      totalResults: 228_307,
    };
    const { adapter } = adapterWithResponses([
      jsonResponse(moviePage),
      jsonResponse(seriesPage),
      jsonResponse(moviePage),
      jsonResponse(seriesPage),
    ]);

    await expect(adapter.discover("popular_movies", { language: "en-CA" })).resolves.toMatchObject({
      items: [{ media: { id: "movie:550" } }],
      totalResults: 1_226_132,
    });
    await expect(adapter.discover("popular_series", { language: "en-CA" })).resolves.toMatchObject({
      items: [{ media: { id: "series:1399" } }],
      totalResults: 228_307,
    });
    await expect(
      adapter.browse({
        availability: "any",
        kind: "movie",
        locale: "en-CA",
        page: 1,
        sort: "popularity",
      }),
    ).resolves.toMatchObject({ page: 1, totalPages: 500, totalResults: 1_226_132 });
    await expect(
      adapter.browse({
        availability: "any",
        kind: "series",
        locale: "en-CA",
        page: 1,
        sort: "popularity",
      }),
    ).resolves.toMatchObject({ page: 1, totalPages: 500, totalResults: 228_307 });
  });

  it.each([-1, 1.5, 10_000_001])("rejects malformed upstream page total %s", async (totalPages) => {
    const { adapter } = adapterWithResponses([
      jsonResponse({
        page: 1,
        results: [searchResponse.results[0]],
        totalPages,
        totalResults: 1,
      }),
    ]);

    await expect(adapter.discover("popular_movies", { language: "en-CA" })).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("deduplicates discovery media without copying person or collection results", async () => {
    const { adapter } = adapterWithResponses([
      jsonResponse({
        ...searchResponse,
        results: [
          searchResponse.results[0],
          searchResponse.results[0],
          searchResponse.results[2],
          searchResponse.results[3],
        ],
      }),
    ]);

    const result = await adapter.discover("trending", { language: "en" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.media.id).toBe("movie:550");
  });

  it("proxies only validated, bounded discovery artwork from Seerr", async () => {
    const { adapter, requests } = adapterWithResponses([
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
      new Response(new Uint8Array([255, 216, 255]), {
        headers: { "content-type": "image/jpg" },
      }),
      new Response(new Uint8Array([255, 216, 255]), {
        headers: { "content-type": "image/jpeg" },
      }),
    ]);

    await expect(adapter.readDiscoveryArtwork("/poster-safe.png", "poster")).resolves.toEqual({
      body: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    });
    await expect(adapter.readDiscoveryArtwork("/backdrop-safe.jpg", "backdrop")).resolves.toEqual({
      body: new Uint8Array([255, 216, 255]),
      contentType: "image/jpeg",
    });
    await expect(adapter.readDiscoveryArtwork("/profile-safe.jpg", "profile")).resolves.toEqual({
      body: new Uint8Array([255, 216, 255]),
      contentType: "image/jpeg",
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/imageproxy/tmdb/t/p/w600_and_h900_bestv2/poster-safe.png",
      "/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/backdrop-safe.jpg",
      "/imageproxy/tmdb/t/p/w300_and_h450_bestv2/profile-safe.jpg",
    ]);
    expect(requests.every(({ init }) => init.headers.get("x-api-key") === "fixture-api-key")).toBe(
      true,
    );
  });

  it("rejects unsafe artwork paths and executable image responses", async () => {
    const { adapter, requests } = adapterWithResponses([
      new Response("<svg><script>private-upstream-value</script></svg>", {
        headers: { "content-type": "image/svg+xml" },
      }),
    ]);

    await expect(
      adapter.readDiscoveryArtwork("https://private.invalid/image.jpg", "poster"),
    ).rejects.toBeTruthy();
    expect(requests).toHaveLength(0);
    await expect(adapter.readDiscoveryArtwork("/safe-image.jpg", "poster")).rejects.toMatchObject({
      code: "response_invalid",
    });
    expect(JSON.stringify(requests)).not.toContain("private-upstream-value");
  });

  it("normalizes mixed search results without exposing raw upstream artwork", async () => {
    const { adapter, requests } = adapterWithResponses([jsonResponse(searchResponse)]);
    const query = "Spider-Man: Brand New Day";

    const result = await adapter.search({ language: "en-CA", page: 1, query });

    expect(result).toEqual({
      generatedAt: "2026-07-25T12:00:00.000Z",
      items: [
        {
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
        },
        {
          availability: "requested",
          id: "series:1399",
          kind: "series",
          mediaRecordState: "present",
          originalTitle: "Game of Thrones",
          overview: "Nine families vie for control.",
          source: "seerr",
          title: "Game of Thrones",
          tmdbId: 1399,
          voteAverage: 8.5,
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
      query,
      totalPages: 4,
      totalResults: 65,
    });
    expect(JSON.stringify(result)).not.toContain("raw-");
    expect(requests[0]?.url.pathname).toBe("/api/v1/search");
    expect(requests[0]?.url.search).toBe(
      "?language=en-CA&page=1&query=Spider-Man%3A%20Brand%20New%20Day",
    );
    expect(requests[0]?.url.searchParams.get("query")).toBe(query);
    expect(requests[0]?.url.searchParams.get("page")).toBe("1");
    expect(requests[0]?.url.searchParams.get("language")).toBe("en-CA");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("fixture-api-key");
  });

  it.each([
    { availability: "unknown", mediaRecordState: "present", mediaInfo: { status: 1 } },
    { availability: "requested", mediaRecordState: "present", mediaInfo: { status: 2 } },
    { availability: "processing", mediaRecordState: "present", mediaInfo: { status: 3 } },
    { availability: "partial", mediaRecordState: "present", mediaInfo: { status: 4 } },
    { availability: "available", mediaRecordState: "present", mediaInfo: { status: 5 } },
    { availability: "unavailable", mediaRecordState: "present", mediaInfo: { status: 6 } },
    { availability: "unavailable", mediaRecordState: "absent", mediaInfo: undefined },
    { availability: "unavailable", mediaRecordState: "absent", mediaInfo: null },
    { availability: "unknown", mediaRecordState: "unknown", mediaInfo: "malformed" },
    { availability: "unknown", mediaRecordState: "unknown", mediaInfo: [] },
  ] as const)(
    "maps Seerr media info safely",
    async ({ availability, mediaRecordState, mediaInfo }) => {
      const movie = Object.fromEntries(
        Object.entries(searchResponse.results[0]!).filter(([key]) => key !== "mediaInfo"),
      );
      const response = {
        ...searchResponse,
        results: [mediaInfo === undefined ? movie : { ...movie, mediaInfo }],
      };
      const { adapter } = adapterWithResponses([jsonResponse(response)]);

      const result = await adapter.search({ language: "en", page: 1, query: "fight" });

      expect(result.items[0]).toMatchObject({ availability, mediaRecordState });
    },
  );

  it("does not leak malformed media info when the title remains valid", async () => {
    const movie = Object.fromEntries(
      Object.entries(searchResponse.results[0]!).filter(([key]) => key !== "mediaInfo"),
    );
    const { adapter } = adapterWithResponses([
      jsonResponse({
        ...searchResponse,
        results: [{ ...movie, mediaInfo: { status: 99, privatePayload: "secret" } }],
      }),
    ]);

    const result = await adapter.search({ language: "en", page: 1, query: "fight" });

    expect(result.items[0]).toMatchObject({ availability: "unknown", mediaRecordState: "unknown" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("requires an API key before performing discovery", async () => {
    const { adapter, requests } = adapterWithResponses([], "");

    await expect(adapter.search({ language: "en", page: 1, query: "fight" })).rejects.toMatchObject(
      { code: "configuration_invalid" } satisfies Partial<SafeConnectorError>,
    );
    expect(requests).toHaveLength(0);
  });

  it("rejects schema drift without returning the raw upstream value", async () => {
    const privateValue = "private-upstream-payload";
    const { adapter } = adapterWithResponses([
      jsonResponse({ ...searchResponse, results: [{ mediaType: "movie", payload: privateValue }] }),
    ]);

    let failure: unknown;
    try {
      await adapter.search({ language: "en", page: 1, query: "fight" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SafeConnectorError);
    expect(failure).toMatchObject({ code: "response_invalid" });
    expect(JSON.stringify(failure)).not.toContain(privateValue);
  });
});
