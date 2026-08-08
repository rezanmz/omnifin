import { describe, expect, it } from "vitest";

import {
  BazarrAdapter,
  type BazarrSubtitleCandidate,
  type BazarrTargetError,
} from "../src/adapters/bazarr.js";
import type { ConnectorTargetConfig } from "../src/types.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

const API_KEY = "fixture-api-key";

function adapter(responses: readonly Response[]) {
  const mock = createMockTransport(responses);
  const target: ConnectorTargetConfig = {
    baseUrl: "https://bazarr.example.test/",
    clock: fixedClock(),
    connectorId: "bazarr-main",
    displayName: "Bazarr",
    resolveHost: publicResolver,
    transport: mock.transport,
  };
  return { adapter: new BazarrAdapter({ ...target, apiKey: API_KEY }), mock };
}

function upstreamCandidate(overrides: Record<string, unknown> = {}) {
  return {
    dont_matches: ["release_group"],
    forced: "False",
    hearing_impaired: "True",
    language: "English",
    matches: ["series", "season", "episode"],
    original_format: "False",
    orig_score: 328,
    provider: "OpenSubtitles.com",
    release_info: ["Northern.Lights.S02E03.1080p.WEB-DL"],
    score: 96.5,
    score_without_hash: 328,
    subtitle: "cache-token-known-only-to-bazarr",
    uploader: "caption-curator",
    url: "https://provider.example.test/subtitle/123",
    ...overrides,
  };
}

function candidate(): BazarrSubtitleCandidate {
  return {
    dontMatches: ["release_group"],
    forced: false,
    hearingImpaired: true,
    language: "English",
    matches: ["title"],
    originalFormat: false,
    provider: "OpenSubtitles.com",
    releaseNames: ["Ember.Coast.2026.1080p.WEB-DL"],
    score: 98,
    subtitleToken: "private-cache-token",
    uploader: null,
  };
}

describe("Bazarr subtitle operations", () => {
  it("matches a movie exactly and normalizes provider results", async () => {
    const { adapter: client, mock } = adapter([
      jsonResponse([
        { poster: "/ignored", radarrId: 17, title: "Amélie", year: 2001 },
        { radarrId: 18, title: "Amelie 2", year: 2001 },
      ]),
      jsonResponse({ data: [upstreamCandidate()] }),
    ]);

    await expect(
      client.searchSubtitles({ kind: "movie", title: "Amelie", year: 2001 }),
    ).resolves.toEqual({
      candidates: [
        {
          dontMatches: ["release_group"],
          forced: false,
          hearingImpaired: true,
          language: "English",
          matches: ["series", "season", "episode"],
          originalFormat: false,
          provider: "OpenSubtitles.com",
          releaseNames: ["Northern.Lights.S02E03.1080p.WEB-DL"],
          score: 96.5,
          subtitleToken: "cache-token-known-only-to-bazarr",
          uploader: "caption-curator",
        },
      ],
      target: { kind: "movie", radarrId: 17 },
    });
    expect(mock.requests.map(({ url }) => url.pathname)).toEqual([
      "/api/system/searches",
      "/api/providers/movies",
    ]);
    expect(mock.requests[0]?.url.searchParams.get("query")).toBe("Amelie");
    expect(mock.requests[1]?.url.searchParams.get("radarrid")).toBe("17");
    expect(mock.requests.every(({ init }) => init.headers.get("x-api-key") === API_KEY)).toBe(true);
  });

  it("resolves a series episode without treating the episode year as the series year", async () => {
    const { adapter: client, mock } = adapter([
      jsonResponse([
        { sonarrSeriesId: 41, title: "Northern Lights", year: 2022 },
        { radarrId: 51, title: "Northern Lights", year: 2026 },
      ]),
      jsonResponse({
        data: [
          { episode: 2, season: 2, sonarrEpisodeId: 72, sonarrSeriesId: 41 },
          { episode: 3, season: 2, sonarrEpisodeId: 73, sonarrSeriesId: 41 },
        ],
      }),
      jsonResponse({ data: [upstreamCandidate({ hearing_impaired: false })] }),
    ]);

    const result = await client.searchSubtitles({
      episodeNumber: 3,
      kind: "episode",
      seasonNumber: 2,
      title: "Northern Lights",
      year: 2026,
    });

    expect(result.target).toEqual({ episodeId: 73, kind: "episode", seriesId: 41 });
    expect(result.candidates[0]?.hearingImpaired).toBe(false);
    expect(mock.requests.map(({ url }) => url.pathname)).toEqual([
      "/api/system/searches",
      "/api/episodes",
      "/api/providers/episodes",
    ]);
    expect(mock.requests[1]?.url.searchParams.get("seriesid[]")).toBe("41");
    expect(mock.requests[2]?.url.searchParams.get("episodeid")).toBe("73");
  });

  it("fails closed when a title or episode cannot be matched uniquely", async () => {
    const ambiguous = adapter([
      jsonResponse([
        { radarrId: 17, title: "Ember Coast", year: 2026 },
        { radarrId: 18, title: "Ember Coast", year: 2026 },
      ]),
    ]).adapter;
    await expect(
      ambiguous.searchSubtitles({ kind: "movie", title: "Ember Coast", year: 2026 }),
    ).rejects.toMatchObject({ reason: "ambiguous" } satisfies Partial<BazarrTargetError>);

    const missingEpisode = adapter([
      jsonResponse([{ sonarrSeriesId: 41, title: "Northern Lights", year: 2022 }]),
      jsonResponse({
        data: [{ episode: 2, season: 2, sonarrEpisodeId: 72, sonarrSeriesId: 41 }],
      }),
    ]).adapter;
    await expect(
      missingEpisode.searchSubtitles({
        episodeNumber: 3,
        kind: "episode",
        seasonNumber: 2,
        title: "Northern Lights",
        year: null,
      }),
    ).rejects.toMatchObject({ reason: "not_found" } satisfies Partial<BazarrTargetError>);
  });

  it("caps normalized results and rejects reflected credentials", async () => {
    const capped = adapter([
      jsonResponse([{ radarrId: 17, title: "Ember Coast", year: 2026 }]),
      jsonResponse({
        data: Array.from({ length: 101 }, (_, index) =>
          upstreamCandidate({ subtitle: `cache-token-${index}` }),
        ),
      }),
    ]).adapter;
    await expect(
      capped.searchSubtitles({ kind: "movie", title: "Ember Coast", year: 2026 }),
    ).resolves.toMatchObject({ candidates: { length: 100 } });

    const reflected = adapter([
      jsonResponse([{ radarrId: 17, title: "Ember Coast", year: 2026 }]),
      jsonResponse({ data: [upstreamCandidate({ uploader: API_KEY })] }),
    ]).adapter;
    await expect(
      reflected.searchSubtitles({ kind: "movie", title: "Ember Coast", year: 2026 }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "subtitle.search" });
  });

  it("posts the opaque Bazarr selection as form data and requires a 204 acknowledgement", async () => {
    const { adapter: client, mock } = adapter([new Response(null, { status: 204 })]);

    await expect(
      client.downloadSubtitle(
        { kind: "movie", radarrId: 17 },
        candidate(),
        undefined,
        `mutation_dispatch_${"d".repeat(22)}`,
      ),
    ).resolves.toBe(undefined);

    const request = mock.requests[0]!;
    const body = new URLSearchParams(new TextDecoder().decode(request.init.body));
    expect(request.url.pathname).toBe("/api/providers/movies");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    expect(request.init.headers.get("x-omnifin-operation-id")).toBe(
      `mutation_dispatch_${"d".repeat(22)}`,
    );
    expect(Object.fromEntries(body)).toEqual({
      forced: "false",
      hi: "true",
      original_format: "false",
      provider: "OpenSubtitles.com",
      radarrid: "17",
      subtitle: "private-cache-token",
    });

    const unexpectedStatus = adapter([new Response("queued", { status: 200 })]).adapter;
    await expect(
      unexpectedStatus.downloadSubtitle(
        { episodeId: 73, kind: "episode", seriesId: 41 },
        candidate(),
      ),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "subtitle.download" });
  });
});
