import { apiErrorSchema } from "@omnifin/contracts/errors";
import { mediaRequestResponseSchema, type MediaRequestResponse } from "@omnifin/contracts/requests";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import type { MediaRequestAdapter } from "../src/requests/media-request-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-27T16:45:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 83),
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
    createId: () => `media-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

const createdRequest: MediaRequestResponse = {
  createdAt: now.toISOString(),
  id: "request:101",
  is4k: false,
  kind: "movie",
  seasons: null,
  source: "seerr",
  status: "pending",
  tmdbId: 550,
};

async function harness(
  options: {
    createMediaRequest?: MediaRequestAdapter["createMediaRequest"];
    role?: "requester" | "viewer";
  } = {},
) {
  const config = testConfig();
  const resolveUser = vi.fn<MediaRequestAdapter["resolveUser"]>(async () => 42);
  const createMediaRequest =
    options.createMediaRequest ??
    vi.fn<MediaRequestAdapter["createMediaRequest"]>(async () => createdRequest);
  let requestIdentifier = 0;
  const app = await createApp({
    config,
    mediaRequestDependencies: {
      clock: () => now,
      createAdapter: () => ({ createMediaRequest, resolveUser }),
      createId: () => `media-route-request-${++requestIdentifier}`,
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
        baseUrl: "https://seerr.example.test/",
        capabilitySnapshotJson: JSON.stringify({
          health: {
            capabilities: ["connector.health", "connector.version", "request.create"],
            checkedAt: now.toISOString(),
            connectorId: "seerr-main",
            displayName: "Seerr",
            failure: null,
            latencyMs: 12,
            service: "seerr",
            status: "healthy",
            version: "2.7.3",
          },
          schemaVersion: 1,
        }),
        createdAt: now,
        displayName: "Seerr",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: "route-private-api-key", kind: "api_key" },
            schemaVersion: 1,
          }),
          "connector_credentials:seerr:seerr-main",
        ),
        healthState: "healthy",
        id: "seerr-main",
        type: "seerr",
        updatedAt: now,
      },
    ])
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Viewer",
      id: "viewer-user",
      role: options.role ?? "requester",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-main",
      createdAt: now,
      deviceId: "viewer-device",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Viewer",
      externalServerId: "jellyfin-server",
      externalUserId: "jellyfin-user-1",
      externalUsername: "viewer",
      healthState: "linked",
      id: "viewer-link",
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "viewer-user",
    })
    .run();
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  const headers = {
    [SESSION_CSRF_HEADER]: session.csrfToken,
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    "idempotency-key": "route-request-key-0001",
    origin: baseUrl,
  };
  return { app, createMediaRequest, headers, resolveUser };
}

describe("media request routes", () => {
  it("requires CSRF-bound requester authority and returns a private replayable response", async () => {
    const { app, createMediaRequest, headers, resolveUser } = await harness();
    try {
      const first = await app.inject({
        headers,
        method: "POST",
        payload: { kind: "movie", tmdbId: 550 },
        url: "/v1/requests",
      });
      expect(first.statusCode, first.body).toBe(201);
      expect(first.headers["idempotency-replayed"]).toBe("false");
      expect(mediaRequestResponseSchema.parse(first.json())).toEqual(createdRequest);
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.headers.vary).toBe("Cookie");

      const replay = await app.inject({
        headers,
        method: "POST",
        payload: { is4k: false, kind: "movie", tmdbId: 550 },
        url: "/v1/requests",
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(replay.json()).toEqual(createdRequest);
      expect(resolveUser).toHaveBeenCalledTimes(1);
      expect(createMediaRequest).toHaveBeenCalledTimes(1);
      expect(first.body).not.toContain("route-private-api-key");
    } finally {
      await app.close();
    }
  });

  it("rejects missing CSRF, invalid origin, and browser-controlled administration fields", async () => {
    const { app, createMediaRequest, headers } = await harness();
    try {
      const withoutCsrf = Object.fromEntries(
        Object.entries(headers).filter(([name]) => name !== SESSION_CSRF_HEADER),
      );
      const csrfDenied = await app.inject({
        headers: withoutCsrf,
        method: "POST",
        payload: { kind: "movie", tmdbId: 550 },
        url: "/v1/requests",
      });
      expect(csrfDenied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(csrfDenied.json()).error.code).toBe("csrf_denied");

      const originDenied = await app.inject({
        headers: { ...headers, origin: "https://attacker.example" },
        method: "POST",
        payload: { kind: "movie", tmdbId: 550 },
        url: "/v1/requests",
      });
      expect(originDenied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(originDenied.json()).error.code).toBe("origin_denied");

      const invalid = await app.inject({
        headers,
        method: "POST",
        payload: { kind: "movie", rootFolder: "/private/media", tmdbId: 550, userId: 1 },
        url: "/v1/requests",
      });
      expect(invalid.statusCode).toBe(400);
      expect(createMediaRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("denies viewers before resolving an upstream identity", async () => {
    const { app, createMediaRequest, headers, resolveUser } = await harness({ role: "viewer" });
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: { kind: "movie", tmdbId: 550 },
        url: "/v1/requests",
      });
      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("permission_denied");
      expect(resolveUser).not.toHaveBeenCalled();
      expect(createMediaRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps upstream failures without exposing their contents", async () => {
    const privateMessage = "private upstream request failure";
    const createMediaRequest = vi.fn<MediaRequestAdapter["createMediaRequest"]>(async () =>
      Promise.reject(new Error(privateMessage)),
    );
    const { app, headers } = await harness({ createMediaRequest });
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: { kind: "movie", tmdbId: 550 },
        url: "/v1/requests",
      });
      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "request_temporarily_unavailable",
      );
      expect(response.body).not.toContain(privateMessage);
    } finally {
      await app.close();
    }
  });
});
