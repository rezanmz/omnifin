import { describe, expect, it } from "vitest";

import { connectorHealthSchema, partialFailureSchema } from "../src/connectors.js";
import {
  continueWatchingItemSchema,
  dashboardSnapshotSchema,
  mediaSummarySchema,
} from "../src/dashboard.js";

describe("connector contracts", () => {
  it("normalizes a safe partial failure without an upstream payload", () => {
    const failure = partialFailureSchema.parse({
      service: "radarr",
      operation: "probe",
      code: "invalid_credentials",
      message: "Radarr rejected the configured credentials.",
      retryable: false,
      occurredAt: "2026-07-25T12:00:00.000Z",
      upstreamBody: "api-key=secret",
    });

    expect(failure).not.toHaveProperty("upstreamBody");
  });

  it("requires a failure when a degraded state is represented by callers", () => {
    const result = connectorHealthSchema.safeParse({
      connectorId: "radarr-main",
      service: "radarr",
      displayName: "Radarr",
      status: "degraded",
      checkedAt: "2026-07-25T12:00:00.000Z",
      latencyMs: 12,
      version: null,
      capabilities: ["connector.health"],
      failure: null,
    });

    expect(result.success).toBe(false);
  });

  it("accepts an honest partial dashboard response", () => {
    const snapshot = dashboardSnapshotSchema.parse({
      generatedAt: "2026-07-25T12:00:00.000Z",
      state: "partial",
      hero: null,
      continueWatching: [],
      discoveryRails: [],
      upcoming: [],
      operations: [],
      failures: [
        {
          service: "jellyfin",
          operation: "continue_watching",
          code: "timeout",
          message: "Jellyfin did not respond before the deadline.",
          retryable: true,
          occurredAt: "2026-07-25T12:00:00.000Z",
        },
      ],
    });

    expect(snapshot.state).toBe("partial");
    expect(snapshot.failures).toHaveLength(1);
  });

  it("allows only same-origin media proxy paths for artwork", () => {
    const baseMedia = {
      id: "movie_1",
      kind: "movie",
      title: "Fixture",
      subtitle: null,
      overview: null,
      year: 2026,
      contentRating: null,
      runtimeMinutes: 90,
      artwork: {
        posterPath: "/v1/media/artwork/movie_1",
        backdropPath: null,
        blurHash: null,
        accentColor: "#123456",
      },
      availability: "available",
    };

    expect(mediaSummarySchema.safeParse(baseMedia).success).toBe(true);
    expect(
      mediaSummarySchema.safeParse({
        ...baseMedia,
        artwork: { ...baseMedia.artwork, posterPath: "/v1/media/../admin" },
      }).success,
    ).toBe(false);
  });

  it("keeps health capabilities unique and failures service-bound", () => {
    const baseHealth = {
      connectorId: "radarr-main",
      service: "radarr" as const,
      displayName: "Radarr",
      status: "degraded" as const,
      checkedAt: "2026-07-25T12:00:00.000Z",
      latencyMs: 12,
      version: "6.0.0",
      capabilities: ["connector.health", "connector.health"],
      failure: {
        service: "sonarr" as const,
        operation: "probe",
        code: "upstream_error" as const,
        message: "The upstream service returned an error.",
        retryable: true,
        occurredAt: "2026-07-25T12:00:00.000Z",
      },
    };

    const result = connectorHealthSchema.safeParse(baseHealth);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "Connector capabilities cannot contain duplicates.",
          "Connector failures must identify the same service as their health record.",
        ]),
      );
    }

    expect(
      connectorHealthSchema.safeParse({
        ...baseHealth,
        capabilities: ["connector.health"],
        failure: { ...baseHealth.failure, service: "radarr" },
        status: "healthy",
      }).success,
    ).toBe(false);
  });

  it("rejects playback positions beyond the media duration", () => {
    const media = {
      id: "episode_1",
      kind: "episode",
      title: "Fixture",
      subtitle: null,
      overview: null,
      year: 2026,
      contentRating: null,
      runtimeMinutes: 42,
      artwork: {
        posterPath: null,
        backdropPath: null,
        blurHash: null,
        accentColor: null,
      },
      availability: "available",
    };

    expect(
      continueWatchingItemSchema.safeParse({
        media,
        progressPercent: 80,
        positionSeconds: 2_600,
        durationSeconds: 2_500,
        lastPlayedAt: "2026-07-25T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
