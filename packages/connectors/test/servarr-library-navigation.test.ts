import { describe, expect, it } from "vitest";

import { RadarrAdapter } from "../src/adapters/radarr.js";
import { SonarrAdapter } from "../src/adapters/sonarr.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

function config(service: "radarr" | "sonarr", responses: Response[]) {
  const mock = createMockTransport(responses);
  const adapterConfig = {
    apiKey: `${service}-navigation-key`,
    baseUrl: `https://${service}.example.test/`,
    clock: fixedClock(),
    connectorId: `${service}-main`,
    displayName: service === "radarr" ? "Radarr" : "Sonarr",
    resolveHost: publicResolver,
    transport: mock.transport,
  };
  return {
    adapter:
      service === "radarr" ? new RadarrAdapter(adapterConfig) : new SonarrAdapter(adapterConfig),
    requests: mock.requests,
  };
}

describe("Servarr library navigation", () => {
  it("resolves one exact Radarr slug without returning provider IDs or paths", async () => {
    const { adapter, requests } = config("radarr", [
      jsonResponse([
        {
          hasFile: true,
          id: 42,
          imdbId: "tt1234567",
          monitored: true,
          path: "/private/movies/The Long Meridian",
          titleSlug: "the-long-meridian-2026",
          tmdbId: 98_765,
        },
      ]),
    ]);

    const navigation = await (adapter as RadarrAdapter).resolveLibraryMovieNavigation({
      imdb: "tt1234567",
      tmdb: 98_765,
    });
    expect(navigation).toEqual({
      mediaId: 42,
      titleSlug: "the-long-meridian-2026",
    });
    expect(JSON.stringify(navigation)).not.toMatch(/private|tmdb|imdb|path/iu);
    expect(requests[0]?.url.pathname).toBe("/api/v3/movie");
    expect(requests[0]?.url.searchParams.get("tmdbId")).toBe("98765");
  });

  it("resolves one exact Sonarr series and rejects ambiguous matches", async () => {
    const record = {
      id: 17,
      titleSlug: "northern-lights",
      tmdbId: 1_042,
      tvdbId: 401_337,
    };
    const exact = config("sonarr", [jsonResponse([record])]);
    await expect(
      (exact.adapter as SonarrAdapter).resolveLibrarySeriesNavigation({
        tmdb: 1_042,
        tvdb: 401_337,
      }),
    ).resolves.toEqual({ mediaId: 17, titleSlug: "northern-lights" });
    expect(exact.requests[0]?.url.pathname).toBe("/api/v3/series");
    expect(exact.requests[0]?.url.searchParams.get("tvdbId")).toBe("401337");

    const ambiguous = config("sonarr", [jsonResponse([record, { ...record, id: 18 }])]);
    await expect(
      (ambiguous.adapter as SonarrAdapter).resolveLibrarySeriesNavigation({
        tmdb: 1_042,
        tvdb: 401_337,
      }),
    ).rejects.toMatchObject({
      code: "response_invalid",
      operation: "media.library.connected_action",
    });
  });

  it("rejects unsafe slugs at the connector boundary", async () => {
    const { adapter } = config("radarr", [
      jsonResponse([
        {
          hasFile: true,
          id: 42,
          monitored: true,
          titleSlug: "../private",
          tmdbId: 98_765,
        },
      ]),
    ]);
    await expect(
      (adapter as RadarrAdapter).resolveLibraryMovieNavigation({
        imdb: null,
        tmdb: 98_765,
      }),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it.each(["radarr", "sonarr"] as const)(
    "rejects %s slugs with unacknowledged whitespace",
    async (service) => {
      const { adapter } = config(service, [
        jsonResponse([
          service === "radarr"
            ? {
                hasFile: true,
                id: 42,
                monitored: true,
                titleSlug: " northern-lights ",
                tmdbId: 98_765,
              }
            : { id: 17, titleSlug: " northern-lights ", tvdbId: 401_337 },
        ]),
      ]);
      const navigation =
        service === "radarr"
          ? (adapter as RadarrAdapter).resolveLibraryMovieNavigation({
              imdb: null,
              tmdb: 98_765,
            })
          : (adapter as SonarrAdapter).resolveLibrarySeriesNavigation({
              tmdb: null,
              tvdb: 401_337,
            });

      await expect(navigation).rejects.toMatchObject({
        code: "response_invalid",
      });
    },
  );
});
