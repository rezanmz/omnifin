import type { AcquisitionCalendarReader } from "@omnifin/connectors/calendar";
import { acquisitionCalendarResponseSchema } from "@omnifin/contracts/calendar";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-28T04:30:00.000Z");
const privateApiKey = "route-private-radarr-key";
const privateUpstreamId = "route-private-calendar-id";
const range = "start=2026-07-27T04%3A00%3A00.000Z&end=2026-08-03T04%3A00%3A00.000Z";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 107),
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
    createId: () => `calendar-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

function capabilitySnapshot(capable: boolean) {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        ...(capable ? ["acquisition.calendar"] : []),
      ],
      checkedAt: now.toISOString(),
      connectorId: "radarr-main",
      displayName: "Radarr",
      failure: null,
      latencyMs: 7,
      service: "radarr",
      status: "healthy",
      version: "6.3.0",
    },
    schemaVersion: 1,
  });
}

async function harness(options: { capable?: boolean } = {}) {
  const config = testConfig();
  const readAcquisitionCalendar = vi.fn<AcquisitionCalendarReader["readAcquisitionCalendar"]>(
    async () => ({
      events: [
        {
          availability: "monitored",
          endAt: null,
          episodeNumber: null,
          eventAt: "2026-07-30T04:00:00.000Z",
          externalId: privateUpstreamId,
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
    }),
  );
  const app = await createApp({
    acquisitionCalendarDependencies: {
      clock: () => now,
      createAdapter: () => ({ readAcquisitionCalendar }),
    },
    config,
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
        capabilitySnapshotJson: capabilitySnapshot(options.capable !== false),
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
    })
    .run();
  const viewer = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  return { app, readAcquisitionCalendar, viewer };
}

describe("acquisition calendar routes", () => {
  it("returns a viewer's private calendar with no-store headers and no internal identifiers", async () => {
    const { app, readAcquisitionCalendar, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/acquisitions/calendar?${range}`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(acquisitionCalendarResponseSchema.parse(response.json())).toMatchObject({
        state: "complete",
        summary: { movies: 1, total: 1 },
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain(privateApiKey);
      expect(response.body).not.toContain(privateUpstreamId);
      expect(response.body).not.toContain("radarr-main");
      expect(readAcquisitionCalendar).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("requires an authenticated session before contacting a source", async () => {
    const { app, readAcquisitionCalendar } = await harness();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/acquisitions/calendar?${range}`,
      });

      expect(response.statusCode).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("authentication_required");
      expect(readAcquisitionCalendar).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects malformed ranges before contacting a source", async () => {
    const { app, readAcquisitionCalendar, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/calendar?start=not-a-date&end=2026-08-03T04%3A00%3A00.000Z",
      });

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_request");
      expect(readAcquisitionCalendar).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps a tampered signed cursor to one safe client error", async () => {
    const { app, readAcquisitionCalendar, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/acquisitions/calendar?${range}&cursor=invalid.cursor-value-that-is-long-enough`,
      });

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "acquisition_calendar_cursor_invalid",
      );
      expect(readAcquisitionCalendar).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns an unconfigured success until a source has a validated capability", async () => {
    const { app, readAcquisitionCalendar, viewer } = await harness({ capable: false });
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/acquisitions/calendar?${range}`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(acquisitionCalendarResponseSchema.parse(response.json())).toMatchObject({
        events: [],
        sources: [],
        state: "unconfigured",
      });
      expect(readAcquisitionCalendar).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
