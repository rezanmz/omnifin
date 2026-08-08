import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  manualReleaseGrabResponseSchema,
  manualReleaseSearchResponseSchema,
  type ManualReleaseCandidate,
} from "@omnifin/contracts/acquisition";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import {
  ManualReleaseError,
  ManualReleaseService,
  type ManualReleaseErrorReason,
} from "../src/acquisitions/manual-release-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-27T19:00:00.000Z");
const releaseId = "release_00000000000000000000000000000001";
const operationId = "release_grab_00000000000000000000000000000001";
const privateApiKey = "manual-route-private-api-key";
const privateGuid = "manual-route-private-release-guid";

const candidate: Omit<ManualReleaseCandidate, "id"> = {
  ageMinutes: 84,
  customFormats: ["HDR10"],
  customFormatScore: 1350,
  decision: "approved",
  downloadAllowed: true,
  episodeNumbers: [],
  fullSeason: false,
  indexer: "Northstar",
  languages: ["English"],
  leechers: 12,
  protocol: "torrent",
  publishedAt: "2026-07-27T17:36:00.000Z",
  quality: "WEBDL-2160p",
  rejectionReasons: [],
  releaseGroup: "Example",
  requiresOverride: false,
  seeders: 84,
  sizeBytes: 18_420_000_000,
  title: "Example.Movie.2026.2160p.WEB-DL",
};

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 97),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

function sessionDependencies() {
  let identifier = 0;
  let token = 0;
  return {
    clock: () => now,
    createId: () => `manual-release-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

function capabilitySnapshot() {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        "acquisition.search",
        "acquisition.grab",
      ],
      checkedAt: now.toISOString(),
      connectorId: "radarr-main",
      displayName: "Radarr",
      failure: null,
      latencyMs: 10,
      service: "radarr",
      status: "healthy",
      version: "6.3.0.10514",
    },
    schemaVersion: 1,
  });
}

async function harness(
  searchManualReleases = vi.fn(async () => ({
    candidates: [
      {
        details: candidate,
        reference: { guid: privateGuid, indexerId: 14 },
      },
    ],
    generatedAt: now.toISOString(),
    target: {
      episodeId: null,
      kind: "movie" as const,
      mediaId: 42,
      seasonNumber: null,
      service: "radarr" as const,
    },
  })),
) {
  const config = testConfig();
  const grabManualRelease = vi.fn(async () => undefined);
  const app = await createApp({
    config,
    manualReleaseDependencies: {
      clock: () => now,
      createAdapter: () => ({ grabManualRelease, searchManualReleases }),
      createOperationId: () => operationId,
      createReleaseId: () => releaseId,
    },
    sessionDependencies: sessionDependencies(),
  });
  app.database.db
    .insert(connectorConfigs)
    .values([
      {
        baseUrl: "https://jellyfin.example.test/",
        capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
        createdAt: now,
        displayName: "Jellyfin",
        enabled: true,
        encryptedCredentials: "v2.fixture-jellyfin-credentials",
        healthState: "healthy",
        id: "jellyfin-main",
        type: "jellyfin",
        updatedAt: now,
      },
      {
        baseUrl: "https://radarr.example.test/",
        capabilitySnapshotJson: capabilitySnapshot(),
        createdAt: now,
        displayName: "Radarr",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: privateApiKey, kind: "api_key" },
            schemaVersion: 1,
          }),
          "connector_credentials:radarr:radarr-main",
        ),
        healthState: "healthy",
        id: "radarr-main",
        type: "radarr",
        updatedAt: now,
      },
    ])
    .run();
  app.database.db
    .insert(users)
    .values([
      {
        createdAt: now,
        displayName: "Operator",
        id: "operator-user",
        role: "operator",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
      {
        createdAt: now,
        displayName: "Viewer",
        id: "viewer-user",
        role: "viewer",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
    ])
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values([
      {
        connectorId: "jellyfin-main",
        createdAt: now,
        deviceId: "operator-device",
        encryptedAccessToken: "v2.fixture-operator-token",
        externalDisplayName: "Operator",
        externalServerId: "jellyfin-server",
        externalUserId: "operator-external",
        externalUsername: "operator",
        healthState: "linked",
        id: "operator-link",
        lastVerifiedAt: now,
        service: "jellyfin",
        tokenCreatedAt: now,
        updatedAt: now,
        userId: "operator-user",
      },
      {
        connectorId: "jellyfin-main",
        createdAt: now,
        deviceId: "viewer-device",
        encryptedAccessToken: "v2.fixture-viewer-token",
        externalDisplayName: "Viewer",
        externalServerId: "jellyfin-server",
        externalUserId: "viewer-external",
        externalUsername: "viewer",
        healthState: "linked",
        id: "viewer-link",
        lastVerifiedAt: now,
        service: "jellyfin",
        tokenCreatedAt: now,
        updatedAt: now,
        userId: "viewer-user",
      },
    ])
    .run();
  const operator = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "operator-link",
      userId: "operator-user",
    },
  });
  const viewer = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  return { app, grabManualRelease, operator, searchManualReleases, viewer };
}

describe("manual release routes", () => {
  it("returns only normalized release candidates to an authorized operator", async () => {
    const { app, operator, searchManualReleases, viewer } = await harness();
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      expect(anonymous.statusCode).toBe(401);

      const denied = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      expect(denied.statusCode).toBe(403);

      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(manualReleaseSearchResponseSchema.parse(response.json())).toMatchObject({
        releases: [{ id: releaseId, title: candidate.title }],
        target: { kind: "movie", mediaId: 42, service: "radarr" },
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toMatch(/manual-route-private/u);
      expect(searchManualReleases).toHaveBeenCalledWith(
        { mediaId: 42, service: "radarr" },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("requires CSRF and an idempotency key, then replays one safe grab", async () => {
    const { app, grabManualRelease, operator, viewer } = await harness();
    const body = { overrideRejections: false, releaseId };
    const headers = {
      cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
      "idempotency-key": "manual-grab-route-0123456789abcdef",
      origin: baseUrl,
      "x-omnifin-csrf": operator.csrfToken,
    };
    try {
      await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });

      const denied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "idempotency-key": headers["idempotency-key"],
          origin: baseUrl,
          "x-omnifin-csrf": viewer.csrfToken,
        },
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/releases/grabs",
      });
      expect(denied.statusCode).toBe(403);

      const missingCsrf = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          "idempotency-key": headers["idempotency-key"],
          origin: baseUrl,
        },
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/releases/grabs",
      });
      expect(missingCsrf.statusCode).toBe(403);

      const created = await app.inject({
        headers,
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/releases/grabs",
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.headers["idempotency-replayed"]).toBe("false");
      expect(manualReleaseGrabResponseSchema.parse(created.json())).toEqual({
        acceptedAt: now.toISOString(),
        operationId,
        releaseId,
        service: "radarr",
        state: "accepted",
      });

      const replay = await app.inject({
        headers,
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/releases/grabs",
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(grabManualRelease).toHaveBeenCalledTimes(1);
      expect(grabManualRelease).toHaveBeenCalledWith(
        { guid: privateGuid, indexerId: 14 },
        expect.any(AbortSignal),
        expect.stringMatching(/^mutation_dispatch_[A-Za-z0-9_-]{22}$/u),
      );
      expect(`${created.body}${replay.body}`).not.toMatch(/manual-route-private/u);
    } finally {
      await app.close();
    }
  });

  it("rejects structurally invalid targets before connector access", async () => {
    const { app, operator, searchManualReleases } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42&seasonNumber=1",
      });
      expect(response.statusCode).toBe(400);
      expect(searchManualReleases).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a stable terminal uncertainty code after a lost grab response", async () => {
    const { app, grabManualRelease, operator } = await harness();
    try {
      await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      grabManualRelease.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "private lost response",
          operation: "acquisition.release.grab",
          retryable: true,
          service: "radarr",
        }),
      );
      const request = () =>
        app.inject({
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
            "idempotency-key": "manual-route-timeout-0001",
            origin: baseUrl,
            "x-omnifin-csrf": operator.csrfToken,
          },
          method: "POST",
          payload: { overrideRejections: false, releaseId },
          url: "/v1/acquisitions/releases/grabs",
        });
      const first = await request();
      const replay = await request();
      expect(first.statusCode).toBe(409);
      expect(replay.statusCode).toBe(409);
      expect(apiErrorSchema.parse(first.json()).error.code).toBe(
        "manual_release_grab_outcome_uncertain",
      );
      expect(grabManualRelease).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("preserves bounded retry guidance and redacts upstream search failures", async () => {
    const searchManualReleases = vi.fn(async () =>
      Promise.reject(
        new SafeConnectorError({
          code: "rate_limited",
          message: "Private Radarr response details",
          operation: "acquisition.release.search",
          retryAfterSeconds: 45,
          retryable: true,
          service: "radarr",
          status: 429,
        }),
      ),
    );
    const { app, operator } = await harness(searchManualReleases);
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("45");
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("manual_release_rate_limited");
      expect(response.body).not.toContain("Private Radarr response details");
    } finally {
      await app.close();
    }
  });

  it.each<{
    code: string;
    reason: ManualReleaseErrorReason;
    status: number;
  }>([
    { code: "manual_release_not_configured", reason: "connector_unconfigured", status: 503 },
    { code: "manual_release_identity_required", reason: "identity_required", status: 403 },
    {
      code: "manual_release_configuration_unavailable",
      reason: "connector_ambiguous",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "connector_integrity_failure",
      status: 503,
    },
    { code: "manual_release_configuration_unavailable", reason: "storage_failure", status: 503 },
    { code: "manual_release_configuration_unavailable", reason: "candidate_expired", status: 503 },
    {
      code: "manual_release_configuration_unavailable",
      reason: "configuration_unavailable",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "download_unavailable",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "idempotency_conflict",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "idempotency_in_progress",
      status: 503,
    },
    { code: "manual_release_configuration_unavailable", reason: "outcome_uncertain", status: 503 },
    { code: "manual_release_configuration_unavailable", reason: "override_required", status: 503 },
    { code: "manual_release_configuration_unavailable", reason: "rate_limited", status: 503 },
    { code: "manual_release_configuration_unavailable", reason: "response_invalid", status: 503 },
    {
      code: "manual_release_configuration_unavailable",
      reason: "temporarily_unavailable",
      status: 503,
    },
  ])("maps search failure $reason safely", async ({ code, reason, status }) => {
    const { app, operator } = await harness();
    const search = vi
      .spyOn(ManualReleaseService.prototype, "search")
      .mockRejectedValue(new ManualReleaseError(reason));
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
    } finally {
      search.mockRestore();
      await app.close();
    }
  });

  it.each<{
    code: string;
    reason: ManualReleaseErrorReason;
    retryAfter?: string;
    status: number;
  }>([
    { code: "idempotency_key_conflict", reason: "idempotency_conflict", status: 409 },
    {
      code: "manual_release_grab_outcome_pending",
      reason: "idempotency_in_progress",
      retryAfter: "2",
      status: 409,
    },
    { code: "manual_release_grab_outcome_uncertain", reason: "outcome_uncertain", status: 409 },
    { code: "manual_release_candidate_expired", reason: "candidate_expired", status: 409 },
    { code: "manual_release_override_required", reason: "override_required", status: 409 },
    { code: "manual_release_download_unavailable", reason: "download_unavailable", status: 409 },
    { code: "manual_release_identity_required", reason: "identity_required", status: 403 },
    {
      code: "manual_release_rate_limited",
      reason: "rate_limited",
      retryAfter: "30",
      status: 429,
    },
    { code: "manual_release_response_invalid", reason: "response_invalid", status: 502 },
    {
      code: "manual_release_configuration_unavailable",
      reason: "connector_unconfigured",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "connector_ambiguous",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "connector_integrity_failure",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "configuration_unavailable",
      status: 503,
    },
    {
      code: "manual_release_configuration_unavailable",
      reason: "storage_failure",
      status: 503,
    },
    {
      code: "manual_release_temporarily_unavailable",
      reason: "temporarily_unavailable",
      status: 503,
    },
  ])("maps grab failure $reason safely", async ({ code, reason, retryAfter, status }) => {
    const { app, operator } = await harness();
    const grab = vi
      .spyOn(ManualReleaseService.prototype, "grab")
      .mockRejectedValue(new ManualReleaseError(reason));
    try {
      const response = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          "idempotency-key": "manual-grab-route-error-mapping",
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        payload: { overrideRejections: false, releaseId },
        url: "/v1/acquisitions/releases/grabs",
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
      expect(response.headers["retry-after"]).toBe(retryAfter);
    } finally {
      grab.mockRestore();
      await app.close();
    }
  });

  it.each([
    ["response_invalid", "manual_release_response_invalid", 502],
    ["unsupported_version", "manual_release_response_invalid", 502],
    ["configuration_invalid", "manual_release_configuration_unavailable", 503],
    ["destination_blocked", "manual_release_configuration_unavailable", 503],
    ["invalid_credentials", "manual_release_configuration_unavailable", 503],
    ["timeout", "manual_release_temporarily_unavailable", 503],
  ] as const)("maps upstream %s search failures", async (upstreamCode, code, status) => {
    const searchManualReleases = vi.fn(async () =>
      Promise.reject(
        new SafeConnectorError({
          code: upstreamCode,
          message: "private upstream mapping detail",
          operation: "acquisition.release.search",
          retryable: upstreamCode === "timeout",
          service: "radarr",
        }),
      ),
    );
    const { app, operator } = await harness(searchManualReleases);
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
      expect(response.body).not.toContain("private upstream mapping detail");
    } finally {
      await app.close();
    }
  });

  it("omits retry-after when an upstream rate limit has no bounded delay", async () => {
    const searchManualReleases = vi.fn(async () =>
      Promise.reject(
        new SafeConnectorError({
          code: "rate_limited",
          message: "private upstream mapping detail",
          operation: "acquisition.release.search",
          retryable: true,
          service: "radarr",
        }),
      ),
    );
    const { app, operator } = await harness(searchManualReleases);
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/releases?service=radarr&mediaId=42",
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
