import { describe, expect, it } from "vitest";

import {
  acquisitionProvenanceResponseSchema,
  acquisitionSearchIdempotencyKeySchema,
  acquisitionSearchResponseSchema,
  acquisitionTargetInputSchema,
} from "../src/acquisition.js";

const release = {
  downloadClient: "qBittorrent",
  indexer: "Cinema Index",
  protocol: "torrent" as const,
  quality: "Bluray-1080p",
  sizeBytes: 4_294_967_296,
  title: "Example.Movie.2026.1080p",
};

describe("acquisition provenance contracts", () => {
  it("coerces a bounded Sonarr target while retaining an optional season", () => {
    expect(
      acquisitionTargetInputSchema.parse({
        mediaId: "42",
        seasonNumber: "3",
        service: "sonarr",
      }),
    ).toEqual({ mediaId: 42, seasonNumber: 3, service: "sonarr" });
  });

  it("rejects seasons for movie targets and unknown request fields", () => {
    expect(() =>
      acquisitionTargetInputSchema.parse({ mediaId: 42, seasonNumber: 1, service: "radarr" }),
    ).toThrow();
    expect(() =>
      acquisitionTargetInputSchema.parse({
        apiKey: "must-never-cross-the-contract",
        mediaId: 42,
        service: "radarr",
      }),
    ).toThrow();
  });

  it("accepts a normalized queued search without exposing the raw command payload", () => {
    expect(
      acquisitionSearchResponseSchema.parse({
        acceptedAt: "2026-07-27T12:11:00.000Z",
        operationId: "sonarr:command:812",
        state: "queued",
        target: { kind: "series", mediaId: 8, seasonNumber: 2, service: "sonarr" },
      }),
    ).toMatchObject({ operationId: "sonarr:command:812", state: "queued" });
    expect(
      acquisitionSearchIdempotencyKeySchema.parse(
        "acquisition-01234567-89ab-cdef-0123-456789abcdef",
      ),
    ).toContain("acquisition-");
    expect(() =>
      acquisitionSearchResponseSchema.parse({
        acceptedAt: "2026-07-27T12:11:00.000Z",
        command: { body: { movieIds: [42] }, id: 812 },
        operationId: "radarr:command:812",
        state: "queued",
        target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
      }),
    ).toThrow();
  });

  it("accepts a newest-first normalized timeline", () => {
    const result = acquisitionProvenanceResponseSchema.parse({
      events: [
        {
          episodeNumbers: [],
          id: "radarr:queue:91",
          kind: "downloading",
          occurredAt: "2026-07-27T12:10:00.000Z",
          release,
          seasonNumber: null,
          state: "active",
          summary: "Download is moving through qBittorrent.",
        },
        {
          episodeNumbers: [],
          id: "radarr:history:90",
          kind: "grabbed",
          occurredAt: "2026-07-27T12:00:00.000Z",
          release,
          seasonNumber: null,
          state: "success",
          summary: "Release was sent to the download client.",
        },
      ],
      failures: [],
      generatedAt: "2026-07-27T12:11:00.000Z",
      state: "complete",
      target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
    });

    expect(result.events).toHaveLength(2);
  });

  it("rejects unsorted, duplicate, mismatched, and raw upstream data", () => {
    const base = {
      episodeNumbers: [],
      id: "sonarr:history:12",
      kind: "grabbed" as const,
      occurredAt: "2026-07-27T12:00:00.000Z",
      release,
      seasonNumber: 2,
      state: "success" as const,
      summary: "Release was sent to the download client.",
    };
    expect(() =>
      acquisitionProvenanceResponseSchema.parse({
        events: [
          base,
          { ...base, occurredAt: "2026-07-27T12:01:00.000Z", outputPath: "/private/media" },
        ],
        failures: [],
        generatedAt: "2026-07-27T12:02:00.000Z",
        state: "complete",
        target: { kind: "series", mediaId: 8, seasonNumber: 2, service: "sonarr" },
      }),
    ).toThrow();
    expect(() =>
      acquisitionProvenanceResponseSchema.parse({
        events: [],
        failures: [],
        generatedAt: "2026-07-27T12:02:00.000Z",
        state: "degraded",
        target: { kind: "movie", mediaId: 8, seasonNumber: null, service: "sonarr" },
      }),
    ).toThrow();
  });
});
