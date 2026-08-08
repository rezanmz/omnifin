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
      apiKey: "radarr-calendar-key",
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
      apiKey: "sonarr-calendar-key",
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

const range = {
  endAt: "2026-08-03T04:00:00.000Z",
  startAt: "2026-07-27T04:00:00.000Z",
};

describe("Servarr acquisition calendars", () => {
  it("normalizes the selected Radarr release date without exposing paths or media identifiers", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse([
        {
          digitalRelease: "2026-07-30T04:00:00.000Z",
          grabbed: false,
          hasFile: false,
          id: 42,
          images: [{ remoteUrl: "https://private.example.test/poster.jpg" }],
          inCinemas: "2026-06-14T04:00:00.000Z",
          monitored: true,
          overview: "A signal\nreaches the edge of known space.",
          path: "/private/media/The Far Meridian",
          physicalRelease: "2026-08-14T04:00:00.000Z",
          releaseDate: "2026-07-30T04:00:00.000Z",
          runtime: 128,
          title: "The Far Meridian",
          tmdbId: 9001,
          year: 2026,
        },
      ]),
    ]);

    const result = await adapter.readAcquisitionCalendar(range);

    expect(result).toEqual({
      events: [
        {
          availability: "monitored",
          endAt: null,
          episodeNumber: null,
          eventAt: "2026-07-30T04:00:00.000Z",
          externalId: "movie:42:digital:2026-07-30T04:00:00.000Z",
          kind: "movie",
          monitored: true,
          overview: "A signal reaches the edge of known space.",
          releaseKind: "digital",
          runtimeMinutes: 128,
          seasonNumber: null,
          service: "radarr",
          subtitle: "Digital release",
          title: "The Far Meridian",
          year: 2026,
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|tmdbId|\/media/u);
    expect(requests[0]?.url.pathname).toBe("/api/v3/calendar");
    expect(requests[0]?.url.searchParams.get("start")).toBe(range.startAt);
    expect(requests[0]?.url.searchParams.get("end")).toBe(range.endAt);
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-calendar-key");
  });

  it("normalizes Sonarr episode context and computes a bounded end time", async () => {
    const { adapter, requests } = sonarrWithResponses([
      jsonResponse([
        {
          airDateUtc: "2026-07-30T23:00:00.000Z",
          episodeNumber: 7,
          grabbed: true,
          hasFile: true,
          id: 812,
          monitored: true,
          overview: "The receiver resolves a second signal.",
          path: "/private/series/Signal",
          runtime: 46,
          seasonNumber: 1,
          series: { id: 77, path: "/private/series/Signal", title: "Signal", year: 2026 },
          seriesId: 77,
          title: "Carrier",
          tvdbId: 7007,
        },
      ]),
    ]);

    const result = await adapter.readAcquisitionCalendar(range);

    expect(result.events[0]).toEqual({
      availability: "available",
      endAt: "2026-07-30T23:46:00.000Z",
      episodeNumber: 7,
      eventAt: "2026-07-30T23:00:00.000Z",
      externalId: "episode:812",
      kind: "episode",
      monitored: true,
      overview: "The receiver resolves a second signal.",
      releaseKind: "episode",
      runtimeMinutes: 46,
      seasonNumber: 1,
      service: "sonarr",
      subtitle: "S01E07 · Carrier",
      title: "Signal",
      year: 2026,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|seriesId|tvdbId/u);
    expect(requests[0]?.url.searchParams.get("includeSeries")).toBe("true");
    expect(requests[0]?.url.searchParams.get("includeEpisodeFile")).toBe("false");
    expect(requests[0]?.url.searchParams.get("includeEpisodeImages")).toBe("false");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("sonarr-calendar-key");
  });

  it("marks a grabbed item as queued until its file is available", async () => {
    const { adapter } = radarrWithResponses([
      jsonResponse([
        {
          digitalRelease: "2026-07-31T04:00:00.000Z",
          grabbed: true,
          hasFile: false,
          id: 43,
          monitored: true,
          title: "Glass Horizon",
        },
      ]),
    ]);

    const result = await adapter.readAcquisitionCalendar(range);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      availability: "queued",
      externalId: "movie:43:digital:2026-07-31T04:00:00.000Z",
      title: "Glass Horizon",
    });
  });

  it("returns every valid event when a source contains more than 200 records", async () => {
    const records = Array.from({ length: 201 }, (_, index) => ({
      airDateUtc: new Date(Date.parse(range.startAt) + index * 60_000).toISOString(),
      episodeNumber: index + 1,
      hasFile: false,
      id: index + 1,
      monitored: true,
      seasonNumber: 1,
      series: { title: "Signal" },
      title: `Episode ${index + 1}`,
    }));
    const { adapter } = sonarrWithResponses([jsonResponse(records)]);

    const result = await adapter.readAcquisitionCalendar(range);

    expect(result.events).toHaveLength(201);
    expect(result.truncated).toBe(false);
    expect(result.events.map((event) => event.externalId)).toEqual(
      records.map((record) => `episode:${record.id}`),
    );
  });

  it("fails closed on an invalid range or malformed upstream response", async () => {
    const invalidRange = radarrWithResponses([]);
    await expect(
      invalidRange.adapter.readAcquisitionCalendar({
        endAt: range.startAt,
        startAt: range.endAt,
      }),
    ).rejects.toThrow();
    expect(invalidRange.requests).toHaveLength(0);

    const malformed = sonarrWithResponses([
      jsonResponse([
        {
          airDateUtc: "2026-07-30T23:00:00.000Z",
          episodeNumber: "7",
          hasFile: false,
          id: 812,
          monitored: true,
          seasonNumber: 1,
          series: { title: "Signal" },
          title: "Carrier",
        },
      ]),
    ]);
    await expect(malformed.adapter.readAcquisitionCalendar(range)).rejects.toMatchObject({
      code: "response_invalid",
      operation: "acquisition.calendar",
    });

    const overLimit = radarrWithResponses([
      jsonResponse(
        Array.from({ length: 5_001 }, (_, index) => ({
          id: index + 1,
          monitored: true,
          title: `Movie ${index + 1}`,
        })),
      ),
    ]);
    await expect(overLimit.adapter.readAcquisitionCalendar(range)).rejects.toMatchObject({
      code: "response_invalid",
      operation: "acquisition.calendar",
    });
  });

  it("reports the calendar capability in successful health snapshots", async () => {
    const { adapter } = radarrWithResponses([jsonResponse({ version: "6.3.0.10514" })]);
    await expect(adapter.probe()).resolves.toMatchObject({
      capabilities: expect.arrayContaining(["acquisition.calendar"]),
    });
  });
});
