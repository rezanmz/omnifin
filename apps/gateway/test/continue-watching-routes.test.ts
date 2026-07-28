import type { JellyfinContinueWatchingResult } from "@omnifin/connectors/media/jellyfin-user-media-client";
import { continueWatchingResponseSchema } from "@omnifin/contracts/dashboard";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T05:30:00.000Z");
const privateToken = "route-private-jellyfin-token";
const privateItemId = "route-private-upstream-item";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 113),
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
    createId: () => `continue-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

async function harness() {
  const config = testConfig();
  const result: JellyfinContinueWatchingResult = {
    items: [
      {
        artwork: { backdrop: null, poster: null },
        contentRating: "PG-13",
        externalId: privateItemId,
        kind: "movie",
        lastPlayedAt: "2026-07-28T05:15:00.000Z",
        overview: "A signal crosses the horizon.",
        positionSeconds: 1_200,
        runtimeSeconds: 7_200,
        subtitle: null,
        title: "The Far Meridian",
        year: 2026,
      },
    ],
    truncated: false,
  };
  const readContinueWatching = vi.fn(async () => result);
  const app = await createApp({
    config,
    continueWatchingDependencies: {
      clock: () => now,
      createClient: () => ({ readContinueWatching }),
      mediaReferences: {
        clock: () => now,
        createToken: () => "r".repeat(22),
      },
    },
    sessionDependencies: sessionDependencies(),
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: "Home Jellyfin",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:jellyfin-main",
      ),
      healthState: "healthy",
      id: "jellyfin-main",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Viewer",
      id: "viewer-user",
      role: "viewer",
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
      encryptedAccessToken: new EnvelopeCipher(config.encryptionKey).encrypt(
        privateToken,
        "service_identity_access_token:jellyfin:viewer-link",
      ),
      externalDisplayName: "Viewer",
      externalServerId: "server-1",
      externalUserId: "viewer-external",
      externalUsername: "viewer",
      healthState: "linked",
      id: "viewer-link",
      lastVerifiedAt: now,
      revision: 2,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "viewer-user",
    })
    .run();
  const viewer = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  return { app, readContinueWatching, viewer };
}

describe("Continue Watching routes", () => {
  it("serves the authenticated viewer's normalized feed with private caching disabled", async () => {
    const { app, readContinueWatching, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/continue-watching",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(continueWatchingResponseSchema.parse(response.json())).toMatchObject({
        items: [{ media: { id: `media_${"r".repeat(22)}` } }],
        state: "complete",
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain(privateToken);
      expect(response.body).not.toContain(privateItemId);
      expect(readContinueWatching).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("requires authentication before contacting Jellyfin", async () => {
    const { app, readContinueWatching } = await harness();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/media/continue-watching" });

      expect(response.statusCode).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("authentication_required");
      expect(readContinueWatching).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
