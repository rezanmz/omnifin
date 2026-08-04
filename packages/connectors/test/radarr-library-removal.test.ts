import { describe, expect, it } from "vitest";

import { RadarrAdapter } from "../src/adapters/radarr.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

function radarrWithResponses(responses: Response[]) {
  const mock = createMockTransport(responses);
  return {
    adapter: new RadarrAdapter({
      apiKey: "radarr-removal-key",
      baseUrl: "https://radarr.example.test/",
      clock: fixedClock(),
      connectorId: "radarr-main",
      displayName: "Radarr",
      resolveHost: publicResolver,
      transport: mock.transport,
    }),
    requests: mock.requests,
  };
}

describe("Radarr library ownership", () => {
  it("resolves one exact movie without returning its path or external provider identity", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse([
        {
          hasFile: true,
          id: 42,
          imdbId: "tt1234567",
          monitored: true,
          movieFile: { size: 6_979_321_856 },
          path: "/private/movies/The Long Meridian",
          tmdbId: 98_765,
        },
      ]),
    ]);

    const ownership = await adapter.resolveLibraryMovie({
      imdb: "tt1234567",
      tmdb: 98_765,
    });

    expect(ownership).toEqual({
      hasFile: true,
      mediaId: 42,
      monitored: true,
      sizeBytes: 6_979_321_856,
    });
    expect(JSON.stringify(ownership)).not.toMatch(/private|tmdb|imdb|path/iu);
    expect(requests[0]?.url.pathname).toBe("/api/v3/movie");
    expect(requests[0]?.url.searchParams.get("tmdbId")).toBe("98765");
    expect(requests[0]?.url.searchParams.has("imdbId")).toBe(false);
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-removal-key");
  });

  it("fails closed when Radarr returns more than one exact ownership match", async () => {
    const movie = {
      hasFile: true,
      imdbId: "tt1234567",
      monitored: true,
      tmdbId: 98_765,
    };
    const { adapter } = radarrWithResponses([
      jsonResponse([
        { ...movie, id: 42, movieFile: { size: 100 } },
        { ...movie, id: 43, movieFile: { size: 200 } },
      ]),
    ]);

    await expect(
      adapter.resolveLibraryMovie({ imdb: "tt1234567", tmdb: 98_765 }),
    ).rejects.toMatchObject({
      code: "response_invalid",
      operation: "library.removal.preview",
    });
  });

  it("does not claim ownership when an IMDb-only lookup lacks an exact response identity", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse([
        {
          hasFile: true,
          id: 42,
          monitored: true,
          movieFile: { size: 6_979_321_856 },
          tmdbId: 98_765,
        },
      ]),
    ]);

    await expect(
      adapter.resolveLibraryMovie({ imdb: "tt1234567", tmdb: null }),
    ).resolves.toBeNull();
    expect(requests[0]?.url.searchParams.get("imdbId")).toBe("tt1234567");
  });
});
