import {
  DEFAULT_PLAYBACK_PREFERENCES,
  playbackPreferencesResponseSchema,
} from "@omnifin/contracts/playback";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-03T20:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 117),
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

async function harness(config: AppConfig = testConfig()) {
  let token = 0;
  const app = await createApp({
    config,
    playbackPreferenceDependencies: { clock: () => now },
    sessionDependencies: {
      clock: () => now,
      createId: () => `playback-preference-session-${++token}`,
      createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
    },
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
        "private-jellyfin-token",
        "service_identity_access_token:jellyfin:viewer-link",
      ),
      externalDisplayName: "Viewer",
      externalServerId: "server-1",
      externalUserId: "viewer-external",
      externalUsername: "viewer",
      healthState: "linked",
      id: "viewer-link",
      lastVerifiedAt: now,
      revision: 1,
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
  return { app, viewer };
}

describe("playback preference routes", () => {
  it("reads defaults and saves only through the current CSRF-protected user session", async () => {
    const { app, viewer } = await harness();
    const cookie = `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`;
    try {
      const defaults = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/playback/preferences",
      });
      expect(defaults.statusCode, defaults.body).toBe(200);
      expect(playbackPreferencesResponseSchema.parse(defaults.json())).toEqual({
        networkClass: "home",
        preferences: DEFAULT_PLAYBACK_PREFERENCES,
        revision: 0,
        updatedAt: null,
      });
      expect(defaults.headers["cache-control"]).toBe("no-store");

      const request = {
        headers: {
          cookie,
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: viewer.csrfToken,
        },
        method: "PUT" as const,
        payload: {
          expectedRevision: 0,
          preferences: {
            ...DEFAULT_PLAYBACK_PREFERENCES,
            audio: { languages: ["fa", "en-CA"], preferOriginalLanguage: false },
          },
        },
        url: "/v1/playback/preferences",
      };
      const withoutCsrf = await app.inject({
        ...request,
        headers: { cookie, origin: "https://omnifin.example" },
      });
      expect(withoutCsrf.statusCode).toBe(403);

      const saved = await app.inject(request);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(playbackPreferencesResponseSchema.parse(saved.json())).toMatchObject({
        preferences: { audio: { languages: ["fa", "en-CA"] } },
        revision: 1,
      });
      expect(saved.body).not.toMatch(/viewer-external|jellyfin-token|streamIndex/iu);

      const conflict = await app.inject(request);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({
        error: { code: "playback_preferences_conflict" },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects anonymous reads before exposing private settings", async () => {
    const { app } = await harness();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/playback/preferences" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "authentication_required" } });
    } finally {
      await app.close();
    }
  });

  it("fails closed when an expected proxy omits client attribution", async () => {
    const { app, viewer } = await harness({ ...testConfig(), trustProxyHops: 1 });
    const cookie = `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`;
    try {
      const unattributed = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/playback/preferences",
      });
      expect(playbackPreferencesResponseSchema.parse(unattributed.json()).networkClass).toBe(
        "remote",
      );

      const publicClient = await app.inject({
        headers: { cookie, "x-forwarded-for": "203.0.113.44" },
        method: "GET",
        url: "/v1/playback/preferences",
      });
      expect(playbackPreferencesResponseSchema.parse(publicClient.json()).networkClass).toBe(
        "remote",
      );

      const privateClient = await app.inject({
        headers: { cookie, "x-forwarded-for": "192.168.1.44" },
        method: "GET",
        url: "/v1/playback/preferences",
      });
      expect(playbackPreferencesResponseSchema.parse(privateClient.json()).networkClass).toBe(
        "home",
      );
    } finally {
      await app.close();
    }
  });
});
