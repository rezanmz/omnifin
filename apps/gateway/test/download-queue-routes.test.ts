import type { DownloadQueueReader } from "@omnifin/connectors/downloads";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { downloadQueueResponseSchema } from "@omnifin/contracts/downloads";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-28T03:00:00.000Z");
const privatePassword = "route-private-qbittorrent-password";
const privateUpstreamId = "route-private-upstream-hash";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 101),
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
    createId: () => `download-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

function capabilitySnapshot(capable: boolean) {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        ...(capable ? ["download.queue.read"] : []),
      ],
      checkedAt: now.toISOString(),
      connectorId: "qbittorrent-main",
      displayName: "qBittorrent",
      failure: null,
      latencyMs: 7,
      service: "qbittorrent",
      status: "healthy",
      version: "5.1.2",
    },
    schemaVersion: 1,
  });
}

async function harness(options: { capable?: boolean } = {}) {
  const config = testConfig();
  const readDownloadQueue = vi.fn<DownloadQueueReader["readDownloadQueue"]>(async () => ({
    generatedAt: now.toISOString(),
    items: [
      {
        addedAt: "2026-07-28T02:50:00.000Z",
        category: "movies",
        etaSeconds: 90,
        externalId: privateUpstreamId,
        leechers: 3,
        progress: 0.8,
        rateBytesPerSecond: 8_000_000,
        remainingBytes: 2_000_000_000,
        seeders: 28,
        sizeBytes: 10_000_000_000,
        state: "downloading",
        title: "The.Far.Meridian.2160p",
      },
    ],
    truncated: false,
  }));
  const app = await createApp({
    config,
    downloadQueueDependencies: {
      clock: () => now,
      createAdapter: () => ({ readDownloadQueue }),
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
        baseUrl: "https://qbittorrent.example.test/",
        capabilitySnapshotJson: capabilitySnapshot(options.capable !== false),
        createdAt: now,
        displayName: "qBittorrent",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: {
              kind: "username_password",
              password: privatePassword,
              username: "operator",
            },
            schemaVersion: 1,
          }),
          "connector_credentials:qbittorrent:qbittorrent-main",
        ),
        healthState: "healthy",
        id: "qbittorrent-main",
        type: "qbittorrent",
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
    .values(
      (["operator", "viewer"] as const).map((role) => ({
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
  return { app, operator, readDownloadQueue, viewer };
}

describe("download queue routes", () => {
  it("returns the authorized private queue with no-store headers and no upstream identifiers", async () => {
    const { app, operator, readDownloadQueue } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(downloadQueueResponseSchema.parse(response.json())).toMatchObject({
        state: "complete",
        summary: { downloading: 1, total: 1, totalRateBytesPerSecond: 8_000_000 },
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain(privatePassword);
      expect(response.body).not.toContain(privateUpstreamId);
      expect(readDownloadQueue).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("denies viewers before contacting an administrative download client", async () => {
    const { app, readDownloadQueue, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });

      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("permission_denied");
      expect(readDownloadQueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires an authenticated session", async () => {
    const { app, readDownloadQueue } = await harness();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/downloads/queue" });

      expect(response.statusCode).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("authentication_required");
      expect(readDownloadQueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns an unconfigured success state until a client has a validated queue capability", async () => {
    const { app, operator, readDownloadQueue } = await harness({ capable: false });
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(downloadQueueResponseSchema.parse(response.json())).toMatchObject({
        clients: [],
        items: [],
        state: "unconfigured",
      });
      expect(readDownloadQueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
