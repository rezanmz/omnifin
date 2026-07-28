import { describe, expect, it } from "vitest";

import {
  connectorAdminSchema,
  connectorAdminJsonSchema,
  connectorCreateRequestSchema,
  connectorDeleteQuerySchema,
  connectorDeleteResponseJsonSchema,
  connectorHealthSchema,
  connectorListQuerySchema,
  connectorUpdateRequestSchema,
  partialFailureSchema,
} from "../src/connectors.js";
import {
  continueWatchingResponseJsonSchema,
  continueWatchingResponseSchema,
  continueWatchingItemSchema,
  dashboardSnapshotSchema,
  mediaSummarySchema,
} from "../src/dashboard.js";

describe("connector contracts", () => {
  const shapedCaCertificate = "-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n";

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

  it("accepts only service-compatible connector credentials and explicit transport approval", () => {
    const base = {
      id: "radarr-main",
      service: "radarr",
      displayName: "Radarr",
      baseUrl: "https://radarr.example.test/base/",
      credentials: { kind: "api_key", apiKey: "fixture-api-key" },
      tlsPolicy: "strict",
      insecureHttpApproved: false,
    } as const;

    expect(connectorCreateRequestSchema.safeParse(base).success).toBe(true);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        baseUrl: "",
      }).success,
    ).toBe(false);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        baseUrl: "not a URL",
      }).success,
    ).toBe(false);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        credentials: { kind: "username_password", username: "admin", password: "private" },
      }).success,
    ).toBe(false);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        baseUrl: "http://radarr.example.test/",
      }).success,
    ).toBe(false);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        baseUrl: "http://radarr.example.test/",
        insecureHttpApproved: true,
      }).success,
    ).toBe(true);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        baseUrl: "https://radarr.example.test/?apiKey=private",
      }).success,
    ).toBe(false);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        tlsPolicy: "allow_self_signed",
      }).success,
    ).toBe(false);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        tlsCaCertificatePem: shapedCaCertificate,
        tlsPolicy: "allow_self_signed",
      }).success,
    ).toBe(true);
    expect(
      connectorCreateRequestSchema.safeParse({
        ...base,
        tlsCaCertificatePem: shapedCaCertificate,
      }).success,
    ).toBe(false);
  });

  it("exposes a secret-free administration record and bounded cursor query", () => {
    const input = {
      id: "radarr-main",
      service: "radarr",
      displayName: "Radarr",
      baseUrl: "https://radarr.example.test/",
      credentialKind: "api_key",
      credentialsConfigured: true,
      tlsPolicy: "strict",
      tlsCaCertificateConfigured: false,
      insecureHttpApproved: false,
      enabled: false,
      healthState: "unknown",
      lastProbe: null,
      revision: "0123456789abcdef",
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
    } as const;
    expect(connectorAdminSchema.safeParse({ ...input, apiKey: "must-not-cross" }).success).toBe(
      false,
    );
    const record = connectorAdminSchema.parse(input);
    expect(record).not.toHaveProperty("apiKey");
    expect(record).not.toHaveProperty("credentials");
    expect(connectorListQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
    expect(connectorListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
  });

  it("requires optimistic revision and a material update", () => {
    expect(
      connectorUpdateRequestSchema.safeParse({
        revision: "0123456789abcdef",
        displayName: "Living room Radarr",
      }).success,
    ).toBe(true);
    expect(connectorUpdateRequestSchema.safeParse({ revision: "0123456789abcdef" }).success).toBe(
      false,
    );
  });

  it("publishes dialect-neutral route schemas and validates delete revisions", () => {
    expect(connectorAdminJsonSchema).not.toHaveProperty("$schema");
    expect(connectorDeleteResponseJsonSchema).not.toHaveProperty("$schema");
    expect(connectorDeleteQuerySchema.safeParse({ revision: "0123456789abcdef" }).success).toBe(
      true,
    );
    expect(connectorDeleteQuerySchema.safeParse({ revision: "quoted revision" }).success).toBe(
      false,
    );
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

  it("publishes a bounded Continue Watching response with opaque media references", () => {
    const response = continueWatchingResponseSchema.parse({
      failures: [],
      generatedAt: "2026-07-28T08:00:00.000Z",
      items: [
        {
          media: {
            id: "media_0123456789abcdefghijkl",
            kind: "episode",
            title: "A Narrow Signal",
            subtitle: "Northern Lights · S2 E3",
            overview: "The observatory receives a reply.",
            year: 2026,
            contentRating: "TV-14",
            runtimeMinutes: 52,
            artwork: {
              posterPath: "/v1/media/media_0123456789abcdefghijkl/images/primary",
              backdropPath: null,
              blurHash: null,
              accentColor: null,
            },
            availability: "available",
            upstreamItemId: "must-not-cross-the-gateway",
          },
          progressPercent: 42,
          positionSeconds: 1_310,
          durationSeconds: 3_120,
          lastPlayedAt: "2026-07-28T07:45:00.000Z",
        },
      ],
      source: {
        connectorId: "jellyfin-main",
        displayName: "Living Room Jellyfin",
        failure: null,
        status: "healthy",
      },
      state: "complete",
      truncated: false,
    });

    expect(response.items[0]?.media).not.toHaveProperty("upstreamItemId");
    expect(continueWatchingResponseJsonSchema).not.toHaveProperty("$schema");
  });

  it("keeps unavailable Continue Watching responses failure-bound and media-free", () => {
    const failure = {
      service: "jellyfin" as const,
      operation: "continue_watching",
      code: "timeout" as const,
      message: "Jellyfin did not respond before the deadline.",
      retryable: true,
      occurredAt: "2026-07-28T08:00:00.000Z",
    };
    expect(
      continueWatchingResponseSchema.safeParse({
        failures: [failure],
        generatedAt: "2026-07-28T08:00:00.000Z",
        items: [],
        source: {
          connectorId: "jellyfin-main",
          displayName: "Living Room Jellyfin",
          failure,
          status: "unavailable",
        },
        state: "unavailable",
        truncated: false,
      }).success,
    ).toBe(true);

    expect(
      continueWatchingResponseSchema.safeParse({
        failures: [],
        generatedAt: "2026-07-28T08:00:00.000Z",
        items: [],
        source: {
          connectorId: "jellyfin-main",
          displayName: "Living Room Jellyfin",
          failure,
          status: "unavailable",
        },
        state: "empty",
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it("rejects raw and duplicate upstream identifiers in Continue Watching responses", () => {
    const media = {
      id: "raw-jellyfin-item-id",
      kind: "movie",
      title: "Fixture",
      subtitle: null,
      overview: null,
      year: 2026,
      contentRating: null,
      runtimeMinutes: 90,
      artwork: {
        posterPath: null,
        backdropPath: null,
        blurHash: null,
        accentColor: null,
      },
      availability: "available",
    };
    const response = {
      failures: [],
      generatedAt: "2026-07-28T08:00:00.000Z",
      items: [
        {
          media,
          progressPercent: 50,
          positionSeconds: 2_700,
          durationSeconds: 5_400,
          lastPlayedAt: "2026-07-28T07:45:00.000Z",
        },
      ],
      source: {
        connectorId: "jellyfin-main",
        displayName: "Jellyfin",
        failure: null,
        status: "healthy",
      },
      state: "complete",
      truncated: false,
    };

    expect(continueWatchingResponseSchema.safeParse(response).success).toBe(false);
    expect(
      continueWatchingResponseSchema.safeParse({
        ...response,
        items: [
          { ...response.items[0], media: { ...media, id: "media_0123456789abcdefghijkl" } },
          { ...response.items[0], media: { ...media, id: "media_0123456789abcdefghijkl" } },
        ],
      }).success,
    ).toBe(false);
  });
});
