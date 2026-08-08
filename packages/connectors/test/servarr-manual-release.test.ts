import { describe, expect, it } from "vitest";

import { RadarrAdapter } from "../src/adapters/radarr.js";
import { SonarrAdapter } from "../src/adapters/sonarr.js";
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
      apiKey: "radarr-manual-fixture-key",
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

function sonarrWithResponses(responses: Response[]) {
  const mock = createMockTransport(responses);
  return {
    adapter: new SonarrAdapter({
      apiKey: "sonarr-manual-fixture-key",
      baseUrl: "https://sonarr.example.test/",
      clock: fixedClock(),
      connectorId: "sonarr-main",
      displayName: "Sonarr",
      resolveHost: publicResolver,
      transport: mock.transport,
    }),
    requests: mock.requests,
  };
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    ageMinutes: 84.3,
    approved: true,
    customFormats: [
      { id: 1, name: "HDR10" },
      { id: 2, name: "Surround" },
    ],
    customFormatScore: 1350,
    downloadAllowed: true,
    downloadUrl: "https://private-indexer.example.test/download/secret",
    episodeNumbers: [],
    fullSeason: false,
    guid: "private-indexer-guid",
    indexer: "Northstar",
    indexerId: 14,
    languages: [{ id: 1, name: "English" }],
    leechers: 12,
    magnetUrl: "magnet:?xt=urn:btih:private",
    mappedEpisodeNumbers: [],
    outputPath: "/private/downloads/Example.Movie.mkv",
    protocol: "torrent",
    publishDate: "2026-07-25T10:36:00.000Z",
    quality: { quality: { id: 7, name: "WEBDL-2160p", source: "web" } },
    rejected: false,
    rejections: [],
    releaseGroup: "Example",
    seeders: 84,
    size: 18_420_000_000,
    temporarilyRejected: false,
    title: "Example.Movie.2026.2160p.WEB-DL",
    ...overrides,
  };
}

describe("Servarr manual releases", () => {
  it("normalizes a bounded Radarr search while separating the private grab reference", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse([
        release(),
        release({
          approved: false,
          guid: "private-rejected-guid",
          indexerId: 19,
          rejections: [
            "Quality profile does not allow this release",
            "Existing file at /private/media/movies/Example.mkv is preferred",
            "See https://private.example.test/details/token",
          ],
          rejected: true,
          title: "Example.Movie.2026.1080p.WEB-DL",
        }),
      ]),
    ]);

    const result = await adapter.searchManualReleases({ mediaId: 42, service: "radarr" });

    expect(result).toMatchObject({
      generatedAt: "2026-07-25T12:00:00.000Z",
      target: {
        episodeId: null,
        kind: "movie",
        mediaId: 42,
        seasonNumber: null,
        service: "radarr",
      },
    });
    expect(result.candidates[0]).toMatchObject({
      details: {
        ageMinutes: 84,
        customFormats: ["HDR10", "Surround"],
        decision: "approved",
        quality: "WEBDL-2160p",
        requiresOverride: false,
      },
      reference: { guid: "private-indexer-guid", indexerId: 14 },
    });
    expect(result.candidates[1]?.details).toMatchObject({
      decision: "rejected",
      requiresOverride: true,
    });
    expect(result.candidates[1]?.details.rejectionReasons).toEqual([
      "Quality profile does not allow this release",
      "Existing file at [redacted path] is preferred",
      "See [redacted URL]",
    ]);
    expect(JSON.stringify(result.candidates.map(({ details }) => details))).not.toMatch(
      /private-indexer-guid|magnet:|\/private\/|download\/secret/u,
    );
    expect(requests[0]?.url.pathname).toBe("/api/v3/release");
    expect(requests[0]?.url.searchParams.get("movieId")).toBe("42");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-manual-fixture-key");
  });

  it.each([
    {
      expected: { episodeId: "91", seasonNumber: null, seriesId: null },
      input: { episodeId: 91, mediaId: 77, service: "sonarr" as const },
      kind: "episode",
    },
    {
      expected: { episodeId: null, seasonNumber: "2", seriesId: "77" },
      input: { mediaId: 77, seasonNumber: 2, service: "sonarr" as const },
      kind: "season",
    },
  ])("uses an exact Sonarr target for a $kind search", async ({ expected, input, kind }) => {
    const { adapter, requests } = sonarrWithResponses([jsonResponse([release()])]);

    const result = await adapter.searchManualReleases(input);

    expect(result.target.kind).toBe(kind);
    expect(requests[0]?.url.searchParams.get("episodeId")).toBe(expected.episodeId);
    expect(requests[0]?.url.searchParams.get("seriesId")).toBe(expected.seriesId);
    expect(requests[0]?.url.searchParams.get("seasonNumber")).toBe(expected.seasonNumber);
  });

  it("grabs only the searched release reference and validates the receipt", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse({
        downloadUrl: "https://private.example.test/download",
        guid: "private-indexer-guid",
        indexerId: 14,
        outputPath: "/private/media",
      }),
    ]);

    await expect(
      adapter.grabManualRelease(
        { guid: "private-indexer-guid", indexerId: 14 },
        undefined,
        `mutation_dispatch_${"g".repeat(22)}`,
      ),
    ).resolves.toBeUndefined();
    expect(requests[0]?.url.pathname).toBe("/api/v3/release");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers.get("content-type")).toBe("application/json");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-manual-fixture-key");
    expect(requests[0]?.init.headers.get("x-omnifin-operation-id")).toBe(
      `mutation_dispatch_${"g".repeat(22)}`,
    );
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.init.body))).toEqual({
      guid: "private-indexer-guid",
      indexerId: 14,
    });
  });

  it("fails closed on a mismatched grab receipt or cross-service target", async () => {
    const mismatched = radarrWithResponses([
      jsonResponse({ guid: "different-private-guid", indexerId: 14 }),
    ]);
    await expect(
      mismatched.adapter.grabManualRelease({ guid: "private-indexer-guid", indexerId: 14 }),
    ).rejects.toMatchObject({
      code: "response_invalid",
      operation: "acquisition.release.grab",
    });

    const crossService = radarrWithResponses([]);
    await expect(
      crossService.adapter.searchManualReleases({
        mediaId: 77,
        seasonNumber: 2,
        service: "sonarr",
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(crossService.requests).toHaveLength(0);
  });
});
