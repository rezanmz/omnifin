import { describe, expect, it } from "vitest";

import {
  ACQUISITION_CALENDAR_MAX_WINDOW_DAYS,
  acquisitionCalendarQuerySchema,
  acquisitionCalendarResponseJsonSchema,
  acquisitionCalendarResponseSchema,
} from "../src/calendar.js";

const failure = {
  code: "timeout" as const,
  message: "Sonarr did not respond before the deadline.",
  occurredAt: "2026-07-28T12:00:00.000Z",
  operation: "acquisition.calendar",
  retryable: true,
  service: "sonarr" as const,
};

const movie = {
  availability: "missing" as const,
  endAt: null,
  episodeNumber: null,
  eventAt: "2026-07-30T04:00:00.000Z",
  id: "calendar_ABCDEFGHIJKLMNOPQRSTUV",
  kind: "movie" as const,
  monitored: true,
  overview: "A signal crosses the far edge of the system.",
  releaseKind: "digital" as const,
  runtimeMinutes: 128,
  seasonNumber: null,
  service: "radarr" as const,
  sourceId: "calendar_source_ABCDEFGHIJKLMNOPQRSTUV",
  sourceName: "Radarr / Cinema",
  subtitle: "Digital release",
  title: "The Far Meridian",
  year: 2026,
};

const response = {
  endAt: "2026-08-03T04:00:00.000Z",
  events: [movie],
  failures: [failure],
  generatedAt: "2026-07-28T12:00:00.000Z",
  nextCursor: "Y3Vyc29y.c2lnbmF0dXJl",
  sourceTruncated: false,
  sources: [
    {
      displayName: "Radarr / Cinema",
      eventCount: 1,
      failure: null,
      id: "calendar_source_ABCDEFGHIJKLMNOPQRSTUV",
      service: "radarr" as const,
      status: "healthy" as const,
    },
    {
      displayName: "Sonarr / Series",
      eventCount: 0,
      failure,
      id: "calendar_source_ZYXWVUTSRQPONMLKJIHGFE",
      service: "sonarr" as const,
      status: "unavailable" as const,
    },
  ],
  startAt: "2026-07-27T04:00:00.000Z",
  state: "degraded" as const,
  summary: { available: 0, episodes: 0, missing: 1, movies: 1, total: 1 },
};

describe("acquisition calendar contracts", () => {
  it("accepts a paginated partial response without exposing upstream identifiers", () => {
    expect(acquisitionCalendarResponseSchema.parse(response)).toEqual(response);
  });

  it("coerces and bounds the same-repository browser query", () => {
    expect(
      acquisitionCalendarQuerySchema.parse({
        end: response.endAt,
        limit: "25",
        start: response.startAt,
      }).limit,
    ).toBe(25);
    expect(
      acquisitionCalendarQuerySchema.safeParse({
        end: new Date(
          Date.parse(response.startAt) +
            (ACQUISITION_CALENDAR_MAX_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1_000,
        ).toISOString(),
        start: response.startAt,
      }).success,
    ).toBe(false);
  });

  it("accepts an honest unconfigured calendar", () => {
    expect(
      acquisitionCalendarResponseSchema.parse({
        ...response,
        events: [],
        failures: [],
        nextCursor: null,
        sources: [],
        state: "unconfigured",
        summary: { available: 0, episodes: 0, missing: 0, movies: 0, total: 0 },
      }).state,
    ).toBe("unconfigured");
  });

  it.each([
    { state: "complete" },
    { summary: { ...response.summary, total: 2 } },
    { events: [{ ...movie, eventAt: response.endAt }] },
    { events: [{ ...movie, id: "radarr:movie:42" }] },
    { events: [{ ...movie, service: "sonarr" }] },
    { events: [{ ...movie, sourceName: "Different source" }] },
    { sources: [{ ...response.sources[0], eventCount: 0 }, response.sources[1]] },
    { failures: [] },
  ])("rejects inconsistent or upstream-revealing calendar data", (change) => {
    expect(acquisitionCalendarResponseSchema.safeParse({ ...response, ...change }).success).toBe(
      false,
    );
  });

  it("requires stable chronological event order", () => {
    const earlier = {
      ...movie,
      eventAt: "2026-07-29T04:00:00.000Z",
      id: "calendar_ZYXWVUTSRQPONMLKJIHGFE",
    };
    expect(
      acquisitionCalendarResponseSchema.safeParse({
        ...response,
        events: [movie, earlier],
        sources: [{ ...response.sources[0], eventCount: 2 }, response.sources[1]],
        summary: { ...response.summary, missing: 2, movies: 2, total: 2 },
      }).success,
    ).toBe(false);
  });

  it("exports Fastify-compatible JSON schema without a dialect field", () => {
    expect(acquisitionCalendarResponseJsonSchema).not.toHaveProperty("$schema");
    expect(acquisitionCalendarResponseJsonSchema).toMatchObject({ type: "object" });
  });
});
