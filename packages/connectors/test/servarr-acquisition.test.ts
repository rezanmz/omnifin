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
      apiKey: "radarr-fixture-key",
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
      apiKey: "sonarr-fixture-key",
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

const quality = { quality: { id: 7, name: "Bluray-1080p", source: "bluray" } };

describe("Servarr acquisition monitoring", () => {
  it("reads and updates one Radarr movie without sending unrelated fields", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse({ id: 42, monitored: true, path: "/private/movies/Example" }),
      jsonResponse([{ id: 42, monitored: false, path: "/private/movies/Example" }], {
        status: 202,
      }),
    ]);

    const read = await adapter.readAcquisitionMonitoring({ mediaId: 42, service: "radarr" });
    expect(read).toEqual({
      monitored: true,
      target: { kind: "movie", mediaId: 42, service: "radarr" },
      verifiedAt: "2026-07-25T12:00:00.000Z",
    });
    const updated = await adapter.updateAcquisitionMonitoring({
      expectedMonitored: true,
      mediaId: 42,
      monitored: false,
      service: "radarr",
    });
    expect(updated).toMatchObject({ monitored: false, target: { kind: "movie", mediaId: 42 } });

    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v3/movie/42",
      "/api/v3/movie/editor",
    ]);
    expect(requests[1]?.init.method).toBe("PUT");
    expect(JSON.parse(new TextDecoder().decode(requests[1]?.init.body))).toEqual({
      monitored: false,
      movieIds: [42],
    });
    expect(JSON.stringify({ read, updated })).not.toContain("/private/");
  });

  it("uses the Sonarr series editor and rejects cross-service targets before transport", async () => {
    const { adapter, requests } = sonarrWithResponses([
      jsonResponse([{ id: 77, monitored: true }], { status: 202 }),
    ]);

    await expect(
      adapter.updateAcquisitionMonitoring({
        expectedMonitored: false,
        mediaId: 77,
        monitored: true,
        service: "sonarr",
      }),
    ).resolves.toMatchObject({ monitored: true, target: { kind: "series", mediaId: 77 } });
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.init.body))).toEqual({
      monitored: true,
      seriesIds: [77],
    });

    await expect(
      adapter.readAcquisitionMonitoring({ mediaId: 77, service: "radarr" }),
    ).rejects.toMatchObject({
      code: "configuration_invalid",
      operation: "acquisition.monitoring.read",
    });
    expect(requests).toHaveLength(1);
  });

  it("fails closed when an editor response does not confirm the exact target state", async () => {
    const { adapter } = radarrWithResponses([
      jsonResponse([{ id: 43, monitored: false, rootFolderPath: "/private/media" }], {
        status: 202,
      }),
    ]);

    await expect(
      adapter.updateAcquisitionMonitoring({
        expectedMonitored: true,
        mediaId: 42,
        monitored: false,
        service: "radarr",
      }),
    ).rejects.toMatchObject({
      code: "response_invalid",
      operation: "acquisition.monitoring.update",
    });
  });
});

describe("Servarr acquisition provenance", () => {
  it("queues an exact Radarr movie search with a bounded normalized response", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse(
        { body: { privatePath: "/media/movies" }, id: 812, name: "MoviesSearch" },
        {
          status: 201,
        },
      ),
    ]);

    await expect(
      adapter.queueAcquisitionSearch({ mediaId: 42, service: "radarr" }),
    ).resolves.toEqual({
      acceptedAt: "2026-07-25T12:00:00.000Z",
      operationId: "radarr:command:812",
      state: "queued",
      target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/api/v3/command");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers.get("content-type")).toBe("application/json");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-fixture-key");
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.init.body))).toEqual({
      movieIds: [42],
      name: "MoviesSearch",
    });
  });

  it.each([
    {
      expected: { name: "SeriesSearch", seriesId: 8 },
      input: { mediaId: 8, service: "sonarr" as const },
    },
    {
      expected: { name: "SeasonSearch", seasonNumber: 2, seriesId: 8 },
      input: { mediaId: 8, seasonNumber: 2, service: "sonarr" as const },
    },
  ])("queues the supported Sonarr search command %#", async ({ expected, input }) => {
    const { adapter, requests } = sonarrWithResponses([
      jsonResponse({ id: 913, name: expected.name }, { status: 201 }),
    ]);

    const result = await adapter.queueAcquisitionSearch(input);

    expect(result.operationId).toBe("sonarr:command:913");
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.init.body))).toEqual(expected);
  });

  it("rejects malformed command responses without reflecting upstream data", async () => {
    const { adapter } = radarrWithResponses([
      jsonResponse({ id: "private-command-id", outputPath: "/private/media" }, { status: 201 }),
    ]);

    await expect(
      adapter.queueAcquisitionSearch({ mediaId: 42, service: "radarr" }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "acquisition.search" });
  });

  it("normalizes Radarr history and queue data without leaking paths or download identifiers", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse({
        page: 1,
        pageSize: 250,
        records: [
          {
            data: {
              downloadClientName: "qBittorrent",
              droppedPath: "/private/downloads/Example.Movie.mkv",
              indexer: "Cinema Index",
              protocol: "torrent",
            },
            date: "2026-07-25T11:50:00.000Z",
            downloadId: "private-download-hash",
            eventType: "grabbed",
            id: 88,
            movieId: 42,
            quality,
            sourceTitle: "Example.Movie.2026.1080p",
          },
          {
            data: { isUpgrade: "true" },
            date: "2026-07-25T11:40:00.000Z",
            eventType: "downloadFolderImported",
            id: 87,
            movieId: 42,
            quality,
            sourceTitle: "Example.Movie.2026.1080p",
          },
        ],
        totalRecords: 2,
      }),
      jsonResponse({
        page: 1,
        pageSize: 250,
        records: [
          {
            added: "2026-07-25T11:55:00.000Z",
            downloadClient: "qBittorrent",
            downloadId: "private-queue-hash",
            id: 91,
            indexer: "Cinema Index",
            movieId: 42,
            outputPath: "/private/downloads/Example.Movie",
            protocol: "torrent",
            quality,
            size: 4_294_967_296,
            status: "downloading",
            title: "Example.Movie.2026.1080p",
            trackedDownloadState: "downloading",
            trackedDownloadStatus: "ok",
          },
        ],
        totalRecords: 1,
      }),
    ]);

    const result = await adapter.readAcquisitionProvenance({ mediaId: 42, service: "radarr" });

    expect(result).toMatchObject({
      failures: [],
      generatedAt: "2026-07-25T12:00:00.000Z",
      state: "complete",
      target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
    });
    expect(result.events.map(({ kind }) => kind)).toEqual(["downloading", "grabbed", "upgraded"]);
    expect(result.events[0]).toMatchObject({
      id: "radarr:queue:91",
      release: {
        downloadClient: "qBittorrent",
        indexer: "Cinema Index",
        protocol: "torrent",
        quality: "Bluray-1080p",
        sizeBytes: 4_294_967_296,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(requests.map(({ url }) => url.pathname)).toEqual(["/api/v3/history", "/api/v3/queue"]);
    expect(requests[0]?.url.searchParams.get("movieIds")).toBe("42");
    expect(requests[1]?.url.searchParams.get("movieIds")).toBe("42");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-fixture-key");
  });

  it("filters Sonarr records to the requested season and normalizes a stalled download", async () => {
    const { adapter, requests } = sonarrWithResponses([
      jsonResponse({
        records: [
          {
            date: "2026-07-25T11:40:00.000Z",
            episode: { episodeNumber: 3, seasonNumber: 2 },
            episodeId: 203,
            eventType: "downloadFailed",
            id: 52,
            quality,
            seriesId: 8,
            sourceTitle: "Signal.S02E03.1080p",
          },
          {
            date: "2026-07-25T11:30:00.000Z",
            episode: { episodeNumber: 1, seasonNumber: 3 },
            episodeId: 301,
            eventType: "grabbed",
            id: 51,
            quality,
            seriesId: 8,
            sourceTitle: "Signal.S03E01.1080p",
          },
        ],
        totalRecords: 2,
      }),
      jsonResponse({
        records: [
          {
            added: "2026-07-25T11:50:00.000Z",
            downloadClient: "SABnzbd",
            episode: { episodeNumber: 3, seasonNumber: 2 },
            episodeId: 203,
            id: 61,
            protocol: "usenet",
            quality,
            seriesId: 8,
            status: "completed",
            title: "Signal.S02E03.1080p",
            trackedDownloadState: "importPending",
            trackedDownloadStatus: "warning",
          },
        ],
        totalRecords: 1,
      }),
    ]);

    const result = await adapter.readAcquisitionProvenance({
      mediaId: 8,
      seasonNumber: 2,
      service: "sonarr",
    });

    expect(result.events.map(({ kind }) => kind)).toEqual(["stalled", "download_failed"]);
    expect(result.events[0]).toMatchObject({
      episodeNumbers: [3],
      seasonNumber: 2,
      state: "warning",
    });
    expect(requests[0]?.url.searchParams.get("seriesIds")).toBe("8");
    expect(requests[1]?.url.searchParams.get("seriesIds")).toBe("8");
  });

  it("returns useful queue data with a typed partial failure when history is unavailable", async () => {
    const { adapter } = radarrWithResponses([
      jsonResponse({ privateFailure: "must-not-leak" }, { status: 503 }),
      jsonResponse({
        records: [
          {
            added: "2026-07-25T11:55:00.000Z",
            id: 91,
            movieId: 42,
            status: "queued",
            title: "Example.Movie.2026.1080p",
          },
        ],
        totalRecords: 1,
      }),
    ]);

    const result = await adapter.readAcquisitionProvenance({ mediaId: 42, service: "radarr" });

    expect(result).toMatchObject({
      state: "degraded",
      failures: [
        {
          code: "upstream_error",
          operation: "acquisition.history",
          retryable: true,
          service: "radarr",
        },
      ],
    });
    expect(result.events.map(({ kind }) => kind)).toEqual(["queued"]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("re-reads an exact stalled item and sends the explicit remove-and-blocklist semantics", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse({
        records: [
          {
            added: "2026-07-25T11:55:00.000Z",
            id: 91,
            movieId: 42,
            status: "completed",
            title: "Example.Movie.2026.1080p",
            trackedDownloadState: "importPending",
            trackedDownloadStatus: "warning",
          },
          {
            added: "2026-07-25T11:54:00.000Z",
            id: 92,
            movieId: 43,
            status: "completed",
            trackedDownloadStatus: "warning",
          },
        ],
        totalRecords: 2,
      }),
      jsonResponse({}, { status: 200 }),
    ]);

    const queue = await adapter.readAcquisitionQueue({ mediaId: 42, service: "radarr" });
    expect(queue).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ kind: "stalled", state: "warning" }),
        externalId: 91,
      }),
    ]);
    await adapter.removeAndBlocklistAcquisitionQueueItem(91);

    expect(requests[0]?.url.pathname).toBe("/api/v3/queue");
    expect(requests[0]?.url.searchParams.get("movieIds")).toBe("42");
    expect(requests[1]?.url.pathname).toBe("/api/v3/queue/91");
    expect(requests[1]?.init.method).toBe("DELETE");
    expect(Object.fromEntries(requests[1]?.url.searchParams ?? [])).toEqual({
      blocklist: "true",
      changeCategory: "false",
      removeFromClient: "true",
      skipRedownload: "false",
    });
  });

  it("rejects unsafe queue identifiers before transport", async () => {
    const { adapter, requests } = sonarrWithResponses([]);

    await expect(adapter.removeAndBlocklistAcquisitionQueueItem(0)).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("fails safely when neither history nor queue can provide evidence", async () => {
    const { adapter } = radarrWithResponses([
      jsonResponse({ privateHistoryFailure: "must-not-leak" }, { status: 503 }),
      jsonResponse({ privateQueueFailure: "must-not-leak" }, { status: 503 }),
    ]);

    let failure: unknown;
    try {
      await adapter.readAcquisitionProvenance({ mediaId: 42, service: "radarr" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "upstream_error",
      operation: "acquisition.history",
      retryable: true,
      service: "radarr",
    });
    expect(JSON.stringify(failure)).not.toContain("must-not-leak");
  });

  it("rejects a target intended for another connector before making a request", async () => {
    const { adapter, requests } = radarrWithResponses([]);

    await expect(
      adapter.readAcquisitionProvenance({ mediaId: 8, service: "sonarr" }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(requests).toHaveLength(0);
  });
});
