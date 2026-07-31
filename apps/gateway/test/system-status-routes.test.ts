import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  systemStatusResponseSchema,
  systemStatusSnapshotEventSchema,
} from "@omnifin/contracts/system";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-28T23:50:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
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
    createId: () => `system-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

async function harness(eventDependencies?: {
  connectionLifetimeMs?: number;
  createCursor?: () => string;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  reconnectDelayMs?: number;
}) {
  const config = testConfig();
  const readSystemHealth = vi.fn(async () => []);
  const readStorageCapacity = vi.fn(async () => [
    {
      externalId: "/private/media",
      freeBytes: 500_000_000_000,
      totalBytes: 1_000_000_000_000,
    },
  ]);
  const app = await createApp({
    config,
    sessionDependencies: sessionDependencies(),
    systemStatusDependencies: {
      clock: () => now,
      createAdapter: (input) => ({
        readStorageCapacity,
        readSystemHealth,
        service: input.service,
      }),
    },
    ...(eventDependencies === undefined
      ? {}
      : { systemStatusEventDependencies: eventDependencies }),
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
        healthState: "healthy" as const,
        id: "jellyfin-main",
        type: "jellyfin" as const,
        updatedAt: now,
      },
      {
        baseUrl: "https://radarr.example.test/",
        capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
        createdAt: now,
        displayName: "Cinema",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: "route-private-radarr-key", kind: "api_key" },
            schemaVersion: 1,
          }),
          "connector_credentials:radarr:radarr-main",
        ),
        healthState: "healthy" as const,
        id: "radarr-main",
        type: "radarr" as const,
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
        role: "operator" as const,
        roleSource: "manual" as const,
        status: "active" as const,
        updatedAt: now,
      },
      {
        createdAt: now,
        displayName: "Viewer",
        id: "viewer-user",
        role: "viewer" as const,
        roleSource: "manual" as const,
        status: "active" as const,
        updatedAt: now,
      },
    ])
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values(
      ["operator", "viewer"].map((role) => ({
        connectorId: "jellyfin-main",
        createdAt: now,
        deviceId: `${role}-device`,
        encryptedAccessToken: `v2.fixture-${role}-token`,
        externalDisplayName: role === "operator" ? "Operator" : "Viewer",
        externalServerId: "jellyfin-server",
        externalUserId: `${role}-external`,
        externalUsername: role,
        healthState: "linked" as const,
        id: `${role}-link`,
        lastVerifiedAt: now,
        service: "jellyfin" as const,
        tokenCreatedAt: now,
        updatedAt: now,
        userId: `${role}-user`,
      })),
    )
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
  return { app, operator, readStorageCapacity, readSystemHealth, viewer };
}

describe("system status routes", () => {
  it("streams one strict private snapshot with bounded resumable SSE headers", async () => {
    const fixture = await harness({
      connectionLifetimeMs: 30,
      createCursor: () => "system_event_ABCDEFGHIJKLMNOPQRSTUV",
      heartbeatIntervalMs: 10,
      pollIntervalMs: 60_000,
      reconnectDelayMs: 3_000,
    });
    try {
      const response = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.operator.sessionToken}` },
        method: "GET",
        url: "/v1/system/status/events",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store, no-transform");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.headers["x-accel-buffering"]).toBe("no");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["permissions-policy"]).toContain("camera=()");
      expect(response.body).toContain("retry: 3000\n\n");
      expect(response.body).toContain("id: system_event_ABCDEFGHIJKLMNOPQRSTUV\n");
      const dataLine = response.body.split("\n").find((line) => line.startsWith("data: "));
      expect(dataLine).toBeDefined();
      expect(
        systemStatusSnapshotEventSchema.parse(JSON.parse(dataLine!.slice("data: ".length))),
      ).toMatchObject({
        cursor: "system_event_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "snapshot",
        status: { state: "complete", summary: { sources: 1 } },
      });
      expect(response.body).not.toMatch(/private\/media|private-radarr-key|radarr-main/u);
      expect(fixture.readSystemHealth).toHaveBeenCalledOnce();
      expect(fixture.readStorageCapacity).toHaveBeenCalledOnce();
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects an untrusted resume cursor before contacting a connector", async () => {
    const fixture = await harness();
    try {
      const response = await fixture.app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${fixture.operator.sessionToken}`,
          "last-event-id": "private-upstream-cursor",
        },
        method: "GET",
        url: "/v1/system/status/events",
      });

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "system_status_event_cursor_invalid",
      );
      expect(fixture.readSystemHealth).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("denies viewers and anonymous callers before opening a live stream", async () => {
    const fixture = await harness();
    try {
      const viewer = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.viewer.sessionToken}` },
        method: "GET",
        url: "/v1/system/status/events",
      });
      const anonymous = await fixture.app.inject({
        method: "GET",
        url: "/v1/system/status/events",
      });

      expect(viewer.statusCode).toBe(403);
      expect(apiErrorSchema.parse(viewer.json()).error.code).toBe("permission_denied");
      expect(anonymous.statusCode).toBe(401);
      expect(apiErrorSchema.parse(anonymous.json()).error.code).toBe("authentication_required");
      expect(fixture.readSystemHealth).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("serves private, normalized system telemetry to operators", async () => {
    const fixture = await harness();
    try {
      const response = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.operator.sessionToken}` },
        method: "GET",
        url: "/v1/system/status",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toContain("Cookie");
      const body = systemStatusResponseSchema.parse(response.json());
      expect(body).toMatchObject({
        generatedAt: now.toISOString(),
        state: "complete",
        summary: { healthySources: 1, sources: 1 },
      });
      expect(body.sources[0]?.storage[0]).toMatchObject({
        label: "Cinema storage 1",
        state: "healthy",
      });
      expect(JSON.stringify(body)).not.toMatch(/private\/media|private-radarr-key|radarr-main/u);
      expect(fixture.readSystemHealth).toHaveBeenCalledOnce();
      expect(fixture.readStorageCapacity).toHaveBeenCalledOnce();
    } finally {
      await fixture.app.close();
    }
  });

  it("requires an authenticated operator role", async () => {
    const fixture = await harness();
    try {
      const viewer = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.viewer.sessionToken}` },
        method: "GET",
        url: "/v1/system/status",
      });
      const anonymous = await fixture.app.inject({ method: "GET", url: "/v1/system/status" });

      expect(viewer.statusCode).toBe(403);
      expect(apiErrorSchema.parse(viewer.json()).error.code).toBe("permission_denied");
      expect(anonymous.statusCode).toBe(401);
      expect(apiErrorSchema.parse(anonymous.json()).error.code).toBe("authentication_required");
    } finally {
      await fixture.app.close();
    }
  });

  it("fails closed when the configured telemetry scope exceeds the response contract", async () => {
    const fixture = await harness();
    try {
      const cipher = new EnvelopeCipher(testConfig().encryptionKey);
      for (let index = 0; index < 12; index += 1) {
        const id = `sonarr-${index}`;
        fixture.app.database.db
          .insert(connectorConfigs)
          .values({
            baseUrl: `https://sonarr-${index}.example.test/`,
            capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
            createdAt: now,
            displayName: `Television ${index + 1}`,
            enabled: true,
            encryptedCredentials: cipher.encrypt(
              JSON.stringify({
                credentials: { apiKey: `sonarr-key-${index}`, kind: "api_key" },
                schemaVersion: 1,
              }),
              `connector_credentials:sonarr:${id}`,
            ),
            healthState: "healthy",
            id,
            type: "sonarr",
            updatedAt: now,
          })
          .run();
      }
      const response = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.operator.sessionToken}` },
        method: "GET",
        url: "/v1/system/status",
      });

      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "system_status_configuration_unavailable",
      );
    } finally {
      await fixture.app.close();
    }
  });
});
