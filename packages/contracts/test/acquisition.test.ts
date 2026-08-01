import { describe, expect, it } from "vitest";

import {
  acquisitionMonitoringStateSchema,
  acquisitionMonitoringTargetInputSchema,
  acquisitionMonitoringUpdateInputSchema,
  acquisitionProvenanceSnapshotEventSchema,
  acquisitionProvenanceResponseSchema,
  acquisitionEventSchema,
  acquisitionQueueRecoveryResponseSchema,
  acquisitionSearchIdempotencyKeySchema,
  acquisitionSearchResponseSchema,
  acquisitionTargetInputSchema,
  manualReleaseCandidateSchema,
  manualReleaseGrabResponseSchema,
  manualReleaseSearchResponseSchema,
  manualReleaseTargetInputSchema,
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

  it("offers recovery only on an opaque stalled event and returns no upstream identifier", () => {
    const recovery = {
      expiresAt: "2026-07-27T12:15:00.000Z",
      reference: `aqr_v2.${"A".repeat(100)}`,
    };
    expect(
      acquisitionEventSchema.parse({
        episodeNumbers: [],
        id: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "stalled",
        occurredAt: "2026-07-27T12:10:00.000Z",
        recovery,
        release,
        seasonNumber: null,
        state: "warning",
        summary: "Download needs operator attention.",
      }),
    ).toMatchObject({ recovery });
    expect(() =>
      acquisitionEventSchema.parse({
        episodeNumbers: [],
        id: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "downloading",
        occurredAt: "2026-07-27T12:10:00.000Z",
        recovery,
        release,
        seasonNumber: null,
        state: "active",
        summary: "Download is active.",
      }),
    ).toThrow();
    expect(
      acquisitionQueueRecoveryResponseSchema.parse({
        completedAt: "2026-07-27T12:12:00.000Z",
        eventId: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
        operationId: "acquisition_recovery_ABCDEFGHIJKLMNOPQRSTUV",
        service: "radarr",
        state: "removed_and_blocklisted",
      }),
    ).not.toHaveProperty("queueId");
  });

  it("binds a live snapshot to one opaque resumable cursor", () => {
    const provenance = acquisitionProvenanceResponseSchema.parse({
      events: [],
      failures: [],
      generatedAt: "2026-07-27T12:11:00.000Z",
      state: "complete",
      target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
    });

    expect(
      acquisitionProvenanceSnapshotEventSchema.parse({
        cursor: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "snapshot",
        provenance,
      }),
    ).toMatchObject({ cursor: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV", provenance });
    expect(() =>
      acquisitionProvenanceSnapshotEventSchema.parse({
        cursor: "radarr-private-history-id",
        kind: "snapshot",
        provenance,
      }),
    ).toThrow();
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

describe("acquisition monitoring contracts", () => {
  it("normalizes one whole-title target and its verified state", () => {
    expect(
      acquisitionMonitoringTargetInputSchema.parse({ mediaId: "42", service: "radarr" }),
    ).toEqual({ mediaId: 42, service: "radarr" });
    expect(
      acquisitionMonitoringStateSchema.parse({
        monitored: true,
        target: { kind: "series", mediaId: 77, service: "sonarr" },
        verifiedAt: "2026-07-28T12:00:00.000Z",
      }),
    ).toMatchObject({ monitored: true, target: { kind: "series" } });
  });

  it("requires a real state transition and rejects ambiguous or raw upstream fields", () => {
    expect(() =>
      acquisitionMonitoringUpdateInputSchema.parse({
        expectedMonitored: true,
        mediaId: 42,
        monitored: true,
        service: "radarr",
      }),
    ).toThrow();
    expect(() =>
      acquisitionMonitoringTargetInputSchema.parse({
        mediaId: 77,
        seasonNumber: 2,
        service: "sonarr",
      }),
    ).toThrow();
    expect(() =>
      acquisitionMonitoringStateSchema.parse({
        monitored: false,
        path: "/private/series",
        target: { kind: "movie", mediaId: 77, service: "sonarr" },
        verifiedAt: "2026-07-28T12:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("manual release contracts", () => {
  const candidate = {
    ageMinutes: 84,
    customFormats: ["HDR10", "Surround"],
    customFormatScore: 1350,
    decision: "approved" as const,
    downloadAllowed: true,
    episodeNumbers: [],
    fullSeason: false,
    id: "release_0123456789abcdefghijklmnopqrstuv",
    indexer: "Northstar",
    languages: ["English"],
    leechers: 12,
    protocol: "torrent" as const,
    publishedAt: "2026-07-27T12:00:00.000Z",
    quality: "WEBDL-2160p",
    rejectionReasons: [],
    releaseGroup: "Example",
    requiresOverride: false,
    seeders: 84,
    sizeBytes: 18_420_000_000,
    title: "Example.Movie.2026.2160p.WEB-DL",
  };

  it("requires exact movie, season, or episode targets and rejects broad Sonarr RSS searches", () => {
    expect(manualReleaseTargetInputSchema.parse({ mediaId: "42", service: "radarr" })).toEqual({
      mediaId: 42,
      service: "radarr",
    });
    expect(
      manualReleaseTargetInputSchema.parse({ mediaId: 77, seasonNumber: "2", service: "sonarr" }),
    ).toEqual({ mediaId: 77, seasonNumber: 2, service: "sonarr" });
    expect(
      manualReleaseTargetInputSchema.parse({ episodeId: "91", mediaId: 77, service: "sonarr" }),
    ).toEqual({ episodeId: 91, mediaId: 77, service: "sonarr" });
    expect(() =>
      manualReleaseTargetInputSchema.parse({ mediaId: 77, service: "sonarr" }),
    ).toThrow();
    expect(() =>
      manualReleaseTargetInputSchema.parse({
        episodeId: 91,
        mediaId: 77,
        seasonNumber: 2,
        service: "sonarr",
      }),
    ).toThrow();
  });

  it("accepts normalized candidates while excluding upstream release references", () => {
    expect(manualReleaseCandidateSchema.parse(candidate)).toMatchObject({
      decision: "approved",
      id: candidate.id,
      quality: "WEBDL-2160p",
    });
    expect(() =>
      manualReleaseCandidateSchema.parse({
        ...candidate,
        guid: "private-indexer-guid",
        magnetUrl: "magnet:?xt=urn:btih:secret",
      }),
    ).toThrow();
    expect(() =>
      manualReleaseCandidateSchema.parse({
        ...candidate,
        decision: "rejected",
        rejectionReasons: ["Quality profile does not allow this release"],
      }),
    ).toThrow();
  });

  it("accepts bounded search and grab receipts without raw upstream payloads", () => {
    expect(
      manualReleaseSearchResponseSchema.parse({
        expiresAt: "2026-07-27T12:20:00.000Z",
        generatedAt: "2026-07-27T12:00:00.000Z",
        releases: [candidate],
        target: {
          episodeId: null,
          kind: "movie",
          mediaId: 42,
          seasonNumber: null,
          service: "radarr",
        },
      }).releases,
    ).toHaveLength(1);
    expect(
      manualReleaseGrabResponseSchema.parse({
        acceptedAt: "2026-07-27T12:01:00.000Z",
        operationId: "release_grab_0123456789abcdefghijklmnopqrstuv",
        releaseId: candidate.id,
        service: "radarr",
        state: "accepted",
      }),
    ).toMatchObject({ state: "accepted" });
    expect(() =>
      manualReleaseGrabResponseSchema.parse({
        acceptedAt: "2026-07-27T12:01:00.000Z",
        operationId: "release_grab_0123456789abcdefghijklmnopqrstuv",
        releaseId: candidate.id,
        service: "radarr",
        state: "accepted",
        upstream: { guid: "must-not-cross" },
      }),
    ).toThrow();
  });
});
