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
    expect(requests.every(({ init }) => init.headers.get("x-api-key") === "fixture-api-key")).toBe(
      true,
    );
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
    ]);

    await expect(adapter.readDiscoveryArtwork("/poster-safe.png", "poster")).resolves.toEqual({
      body: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    });
    await expect(adapter.readDiscoveryArtwork("/backdrop-safe.jpg", "backdrop")).resolves.toEqual({
      body: new Uint8Array([255, 216, 255]),
      contentType: "image/jpeg",
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/imageproxy/tmdb/t/p/w600_and_h900_bestv2/poster-safe.png",
      "/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/backdrop-safe.jpg",
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

    const result = await adapter.search({ language: "en", page: 1, query: "fight" });

    expect(result).toEqual({
      generatedAt: "2026-07-25T12:00:00.000Z",
      items: [
        {
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
        },
        {
          availability: "requested",
          id: "series:1399",
          kind: "series",
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
      query: "fight",
      totalPages: 4,
      totalResults: 65,
    });
    expect(JSON.stringify(result)).not.toContain("raw-");
    expect(requests[0]?.url.pathname).toBe("/api/v1/search");
    expect(requests[0]?.url.searchParams.get("query")).toBe("fight");
    expect(requests[0]?.url.searchParams.get("page")).toBe("1");
    expect(requests[0]?.url.searchParams.get("language")).toBe("en");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("fixture-api-key");
  });

  it.each([
    { expected: "unknown", mediaInfo: { status: 1 } },
    { expected: "processing", mediaInfo: { status: 3 } },
    { expected: "partial", mediaInfo: { status: 4 } },
    { expected: "unavailable", mediaInfo: { status: 6 } },
    { expected: "unavailable", mediaInfo: undefined },
  ])("maps Seerr availability to $expected", async ({ expected, mediaInfo }) => {
    const movie = Object.fromEntries(
      Object.entries(searchResponse.results[0]!).filter(([key]) => key !== "mediaInfo"),
    );
    const response = {
      ...searchResponse,
      results: [mediaInfo === undefined ? movie : { ...movie, mediaInfo }],
    };
    const { adapter } = adapterWithResponses([jsonResponse(response)]);

    const result = await adapter.search({ language: "en", page: 1, query: "fight" });

    expect(result.items[0]).toMatchObject({ availability: expected });
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
