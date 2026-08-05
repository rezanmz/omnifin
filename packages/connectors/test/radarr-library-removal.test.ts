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
          movieFile: { id: 314, size: 6_979_321_856 },
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
      fileId: 314,
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

  it("deletes only the exact resolved movie file or manager record", async () => {
    const { adapter, requests } = radarrWithResponses([
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]);

    await adapter.deleteLibraryMovieFile(314);
    await adapter.deleteLibraryMovie(42);

    expect(requests[0]?.url.pathname).toBe("/api/v3/moviefile/314");
    expect(requests[0]?.url.search).toBe("");
    expect(requests[0]?.init.method).toBe("DELETE");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-removal-key");
    expect(requests[1]?.url.pathname).toBe("/api/v3/movie/42");
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toEqual({
      addImportExclusion: "false",
      deleteFiles: "true",
    });
    expect(requests[1]?.init.method).toBe("DELETE");
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
        { ...movie, id: 42, movieFile: { id: 314, size: 100 } },
        { ...movie, id: 43, movieFile: { id: 315, size: 200 } },
      ]),
    ]);

    await expect(
      adapter.resolveLibraryMovie({ imdb: "tt1234567", tmdb: 98_765 }),
    ).rejects.toMatchObject({
      code: "response_invalid",
      operation: "library.removal.preview",
    });
  });

  it("fails closed when Radarr reports conflicting file identity", async () => {
    const { adapter } = radarrWithResponses([
      jsonResponse([
        {
          hasFile: true,
          id: 42,
          imdbId: "tt1234567",
          monitored: true,
          movieFile: { id: 314, size: 6_979_321_856 },
          movieFileId: 315,
          tmdbId: 98_765,
        },
      ]),
    ]);

    await expect(
      adapter.resolveLibraryMovie({ imdb: "tt1234567", tmdb: 98_765 }),
    ).rejects.toMatchObject({
      code: "response_invalid",
      operation: "library.removal.preview",
    });
  });

  it("distinguishes an absent file and rejects a claimed file without a target", async () => {
    const absent = radarrWithResponses([
      jsonResponse([
        {
          hasFile: false,
          id: 42,
          imdbId: "tt1234567",
          monitored: false,
          movieFileId: 0,
          tmdbId: 98_765,
        },
      ]),
    ]).adapter;
    const inconsistent = radarrWithResponses([
      jsonResponse([
        {
          hasFile: true,
          id: 42,
          imdbId: "tt1234567",
          monitored: true,
          tmdbId: 98_765,
        },
      ]),
    ]).adapter;

    await expect(absent.resolveLibraryMovie({ imdb: "tt1234567", tmdb: 98_765 })).resolves.toEqual({
      fileId: null,
      hasFile: false,
      mediaId: 42,
      monitored: false,
      sizeBytes: null,
    });
    await expect(
      inconsistent.resolveLibraryMovie({ imdb: "tt1234567", tmdb: 98_765 }),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("rejects invalid removal identifiers before issuing a request", async () => {
    const { adapter, requests } = radarrWithResponses([]);

    await expect(adapter.deleteLibraryMovieFile(0)).rejects.toBeDefined();
    await expect(adapter.deleteLibraryMovie(Number.MAX_SAFE_INTEGER)).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("rejects queued destructive writes without claiming synchronous completion", async () => {
    const { adapter } = radarrWithResponses([
      new Response("queued", { status: 202 }),
      new Response("queued", { status: 202 }),
    ]);

    await expect(adapter.deleteLibraryMovieFile(314)).rejects.toMatchObject({
      code: "response_invalid",
      operation: "library.removal.file_delete",
    });
    await expect(adapter.deleteLibraryMovie(42)).rejects.toMatchObject({
      code: "response_invalid",
      operation: "library.removal.manager_delete",
    });
  });

  it("does not claim ownership when an IMDb-only lookup lacks an exact response identity", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse([
        {
          hasFile: true,
          id: 42,
          monitored: true,
          movieFile: { id: 314, size: 6_979_321_856 },
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
