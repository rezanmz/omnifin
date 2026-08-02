import type { DownloadQueueReader } from "@omnifin/connectors/downloads";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  downloadQueueActionResponseSchema,
  downloadQueueBulkActionResponseSchema,
  downloadQueuePromotionResponseSchema,
  downloadQueueRemovalResponseSchema,
  downloadQueueResponseSchema,
  downloadQueueSnapshotEventSchema,
} from "@omnifin/contracts/downloads";
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
        ...(capable ? ["download.queue.read", "download.queue.mutate"] : []),
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

async function harness(
  options: {
    capable?: boolean;
    eventDependencies?: {
      connectionLifetimeMs?: number;
      createCursor?: () => string;
      heartbeatIntervalMs?: number;
      maxConnections?: number;
      maxConnectionsPerSession?: number;
      pollIntervalMs?: number;
      reconnectDelayMs?: number;
    };
  } = {},
) {
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
        queuePosition: 1,
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
  const updateDownloadQueueItem = vi.fn(async () => undefined);
  const promoteDownloadQueueItem = vi.fn(async () => undefined);
  const removeDownloadQueueItem = vi.fn(async () => undefined);
  const app = await createApp({
    config,
    downloadQueueDependencies: {
      clock: () => now,
      createAdapter: () => ({
        promoteDownloadQueueItem,
        readDownloadQueue,
        removeDownloadQueueItem,
        updateDownloadQueueItem,
      }),
    },
    ...(options.eventDependencies === undefined
      ? {}
      : { downloadQueueEventDependencies: options.eventDependencies }),
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
  return {
    app,
    operator,
    promoteDownloadQueueItem,
    readDownloadQueue,
    removeDownloadQueueItem,
    updateDownloadQueueItem,
    viewer,
  };
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

  it("streams a strict private queue snapshot with resumable SSE headers", async () => {
    const { app, operator, readDownloadQueue } = await harness({
      eventDependencies: {
        connectionLifetimeMs: 30,
        createCursor: () => "download_event_ABCDEFGHIJKLMNOPQRSTUV",
        heartbeatIntervalMs: 10,
        pollIntervalMs: 60_000,
        reconnectDelayMs: 3_000,
      },
    });
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue/events",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store, no-transform");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.headers["x-accel-buffering"]).toBe("no");
      expect(response.body).toContain("retry: 3000\n\n");
      expect(response.body).toContain("id: download_event_ABCDEFGHIJKLMNOPQRSTUV\n");
      const dataLine = response.body.split("\n").find((line) => line.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const event = downloadQueueSnapshotEventSchema.parse(
        JSON.parse(dataLine!.slice("data: ".length)),
      );
      expect(event).toMatchObject({
        cursor: "download_event_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "snapshot",
        queue: { state: "complete", summary: { total: 1 } },
      });
      expect(response.body).not.toContain(privatePassword);
      expect(response.body).not.toContain(privateUpstreamId);
      expect(readDownloadQueue).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("rejects invalid resume cursors before contacting a download client", async () => {
    const { app, operator, readDownloadQueue } = await harness();
    try {
      const response = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          "last-event-id": "private-upstream-cursor",
        },
        method: "GET",
        url: "/v1/downloads/queue/events",
      });

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "download_queue_event_cursor_invalid",
      );
      expect(readDownloadQueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("denies viewers from opening a live download stream", async () => {
    const { app, readDownloadQueue, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue/events",
      });

      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("permission_denied");
      expect(readDownloadQueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a bounded retry response before opening an excess session stream", async () => {
    const { app, operator, readDownloadQueue } = await harness({
      eventDependencies: {
        connectionLifetimeMs: 40,
        createCursor: () => "download_event_ABCDEFGHIJKLMNOPQRSTUV",
        heartbeatIntervalMs: 20,
        maxConnectionsPerSession: 1,
        pollIntervalMs: 60_000,
        reconnectDelayMs: 3_000,
      },
    });
    try {
      const openStream = app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue/events",
      });
      await vi.waitFor(() => expect(readDownloadQueue).toHaveBeenCalledOnce());
      const limited = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue/events",
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("3");
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(apiErrorSchema.parse(limited.json()).error.code).toBe(
        "download_queue_event_capacity_reached",
      );
      await openStream;
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

  it("requires same-origin CSRF and controls one opaque item for an operator", async () => {
    const { app, operator, readDownloadQueue, updateDownloadQueueItem, viewer } = await harness();
    try {
      const queueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });
      const item = downloadQueueResponseSchema.parse(queueResponse.json()).items[0]!;
      const body = {
        action: "pause",
        connectorId: item.connectorId,
        expectedState: "downloading",
        itemId: item.id,
      } as const;

      const csrfDenied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
        },
        method: "POST",
        payload: body,
        url: "/v1/downloads/queue/actions",
      });
      expect(csrfDenied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(csrfDenied.json()).error.code).toBe("csrf_denied");

      const permissionDenied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": viewer.csrfToken,
        },
        method: "POST",
        payload: body,
        url: "/v1/downloads/queue/actions",
      });
      expect(permissionDenied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(permissionDenied.json()).error.code).toBe("permission_denied");

      readDownloadQueue
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({
          generatedAt: now.toISOString(),
          items: [
            {
              addedAt: "2026-07-28T02:50:00.000Z",
              category: "movies",
              etaSeconds: null,
              externalId: privateUpstreamId,
              leechers: 3,
              progress: 0.8,
              rateBytesPerSecond: 0,
              remainingBytes: 2_000_000_000,
              seeders: 28,
              sizeBytes: 10_000_000_000,
              state: "paused",
              title: "The.Far.Meridian.2160p",
            },
          ],
          truncated: false,
        });
      const updated = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        payload: body,
        url: "/v1/downloads/queue/actions",
      });

      expect(updated.statusCode, updated.body).toBe(200);
      expect(downloadQueueActionResponseSchema.parse(updated.json())).toMatchObject({
        action: "pause",
        item: { id: item.id, state: "paused" },
        replayed: false,
      });
      expect(updateDownloadQueueItem).toHaveBeenCalledWith(
        { action: "pause", externalId: privateUpstreamId },
        expect.any(AbortSignal),
      );
      expect(updated.headers["cache-control"]).toBe("no-store");
      expect(updated.body).not.toContain(privateUpstreamId);
      expect(updated.body).not.toContain(privatePassword);
    } finally {
      await app.close();
    }
  });

  it("maps missing, stale, and rate-limited action targets to bounded errors", async () => {
    const { app, operator, readDownloadQueue, updateDownloadQueueItem } = await harness();
    try {
      const queueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });
      const item = downloadQueueResponseSchema.parse(queueResponse.json()).items[0]!;
      const request = () =>
        app.inject({
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
            origin: baseUrl,
            "x-omnifin-csrf": operator.csrfToken,
          },
          method: "POST",
          payload: {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          url: "/v1/downloads/queue/actions",
        });

      readDownloadQueue.mockResolvedValueOnce({
        generatedAt: now.toISOString(),
        items: [],
        truncated: false,
      });
      const missing = await request();
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error.code).toBe("download_queue_item_not_found");

      readDownloadQueue.mockResolvedValueOnce({
        generatedAt: now.toISOString(),
        items: [
          {
            addedAt: null,
            category: "movies",
            etaSeconds: null,
            externalId: privateUpstreamId,
            leechers: 0,
            progress: 0.8,
            rateBytesPerSecond: 0,
            remainingBytes: 2_000_000_000,
            seeders: 0,
            sizeBytes: 10_000_000_000,
            state: "queued",
            title: "The.Far.Meridian.2160p",
          },
        ],
        truncated: false,
      });
      const stale = await request();
      expect(stale.statusCode).toBe(409);
      expect(apiErrorSchema.parse(stale.json()).error.code).toBe("download_queue_state_changed");

      readDownloadQueue.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "rate_limited",
          message: "Private qBittorrent rate-limit detail",
          operation: "download.queue.action",
          retryAfterSeconds: 17,
          retryable: true,
          service: "qbittorrent",
          status: 429,
        }),
      );
      const limited = await request();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("17");
      expect(apiErrorSchema.parse(limited.json()).error.code).toBe(
        "download_queue_action_rate_limited",
      );
      expect(limited.body).not.toContain("Private qBittorrent rate-limit detail");
      expect(updateDownloadQueueItem).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("authorizes and idempotently applies a bounded bulk queue action", async () => {
    const { app, operator, readDownloadQueue, updateDownloadQueueItem, viewer } = await harness();
    try {
      const queueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });
      const item = downloadQueueResponseSchema.parse(queueResponse.json()).items[0]!;
      const payload = {
        action: "pause",
        targets: [
          {
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
        ],
      } as const;

      const denied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "idempotency-key": "viewer-bulk-route-fixture",
          origin: baseUrl,
          "x-omnifin-csrf": viewer.csrfToken,
        },
        method: "POST",
        payload,
        url: "/v1/downloads/queue/bulk-actions",
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("permission_denied");

      const missingProof = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        payload,
        url: "/v1/downloads/queue/bulk-actions",
      });
      expect(missingProof.statusCode).toBe(400);
      expect(apiErrorSchema.parse(missingProof.json()).error.code).toBe("invalid_request");

      readDownloadQueue
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({
          generatedAt: now.toISOString(),
          items: [
            {
              addedAt: "2026-07-28T02:50:00.000Z",
              category: "movies",
              etaSeconds: null,
              externalId: privateUpstreamId,
              leechers: 3,
              progress: 0.8,
              rateBytesPerSecond: 0,
              remainingBytes: 2_000_000_000,
              seeders: 28,
              sizeBytes: 10_000_000_000,
              state: "paused",
              title: "The.Far.Meridian.2160p",
            },
          ],
          truncated: false,
        });
      const request = (body: object = payload) =>
        app.inject({
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
            "idempotency-key": "bulk-route-fixture",
            origin: baseUrl,
            "x-omnifin-csrf": operator.csrfToken,
          },
          method: "POST",
          payload: body,
          url: "/v1/downloads/queue/bulk-actions",
        });
      const completed = await request();

      expect(completed.statusCode, completed.body).toBe(200);
      expect(downloadQueueBulkActionResponseSchema.parse(completed.json())).toMatchObject({
        action: "pause",
        replayed: false,
        state: "complete",
        summary: { failed: 0, requested: 1, succeeded: 1 },
      });
      expect(completed.headers["idempotency-replayed"]).toBe("false");
      expect(completed.headers["cache-control"]).toBe("no-store");
      expect(completed.body).not.toContain(privateUpstreamId);
      expect(completed.body).not.toContain(privatePassword);
      expect(updateDownloadQueueItem).toHaveBeenCalledOnce();

      const replayed = await request();
      expect(replayed.statusCode, replayed.body).toBe(200);
      expect(downloadQueueBulkActionResponseSchema.parse(replayed.json()).replayed).toBe(true);
      expect(replayed.headers["idempotency-replayed"]).toBe("true");
      expect(updateDownloadQueueItem).toHaveBeenCalledOnce();

      const conflicted = await request({
        action: "resume",
        targets: [{ ...payload.targets[0], expectedState: "paused" }],
      });
      expect(conflicted.statusCode).toBe(409);
      expect(apiErrorSchema.parse(conflicted.json()).error.code).toBe("idempotency_key_conflict");
    } finally {
      await app.close();
    }
  });

  it("promotes one exact queue item with CSRF, position verification, and no private identifiers", async () => {
    const { app, operator, promoteDownloadQueueItem, readDownloadQueue } = await harness();
    try {
      const queueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });
      const item = downloadQueueResponseSchema.parse(queueResponse.json()).items[0]!;
      readDownloadQueue
        .mockResolvedValueOnce({
          generatedAt: now.toISOString(),
          items: [
            {
              addedAt: "2026-07-28T02:50:00.000Z",
              category: "movies",
              etaSeconds: 90,
              externalId: privateUpstreamId,
              leechers: 3,
              progress: 0.8,
              queuePosition: 1,
              rateBytesPerSecond: 8_000_000,
              remainingBytes: 2_000_000_000,
              seeders: 28,
              sizeBytes: 10_000_000_000,
              state: "downloading",
              title: "The.Far.Meridian.2160p",
            },
          ],
          truncated: false,
        })
        .mockResolvedValueOnce({
          generatedAt: now.toISOString(),
          items: [
            {
              addedAt: "2026-07-28T02:50:00.000Z",
              category: "movies",
              etaSeconds: 90,
              externalId: privateUpstreamId,
              leechers: 3,
              progress: 0.8,
              queuePosition: 0,
              rateBytesPerSecond: 8_000_000,
              remainingBytes: 2_000_000_000,
              seeders: 28,
              sizeBytes: 10_000_000_000,
              state: "downloading",
              title: "The.Far.Meridian.2160p",
            },
          ],
          truncated: false,
        });

      const promoted = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        payload: {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        url: "/v1/downloads/queue/promotions",
      });

      expect(promoted.statusCode, promoted.body).toBe(200);
      expect(downloadQueuePromotionResponseSchema.parse(promoted.json())).toMatchObject({
        item: { id: item.id },
        position: 0,
        previousPosition: 1,
        replayed: false,
      });
      expect(promoteDownloadQueueItem).toHaveBeenCalledWith(
        { externalId: privateUpstreamId },
        expect.any(AbortSignal),
      );
      expect(promoted.headers["cache-control"]).toBe("no-store");
      expect(promoted.body).not.toContain(privateUpstreamId);
      expect(promoted.body).not.toContain(privatePassword);

      readDownloadQueue.mockResolvedValueOnce({
        generatedAt: now.toISOString(),
        items: [
          {
            addedAt: "2026-07-28T02:50:00.000Z",
            category: "movies",
            etaSeconds: 90,
            externalId: privateUpstreamId,
            leechers: 3,
            progress: 0.8,
            queuePosition: null,
            rateBytesPerSecond: 8_000_000,
            remainingBytes: 2_000_000_000,
            seeders: 28,
            sizeBytes: 10_000_000_000,
            state: "downloading",
            title: "The.Far.Meridian.2160p",
          },
        ],
        truncated: false,
      });
      const unavailable = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        payload: {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        url: "/v1/downloads/queue/promotions",
      });
      expect(unavailable.statusCode).toBe(409);
      expect(apiErrorSchema.parse(unavailable.json()).error.code).toBe(
        "download_queue_order_unavailable",
      );
      expect(promoteDownloadQueueItem).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("removes one exact queue item with idempotency and downloaded files preserved", async () => {
    const { app, operator, readDownloadQueue, removeDownloadQueueItem } = await harness();
    try {
      const queueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });
      const item = downloadQueueResponseSchema.parse(queueResponse.json()).items[0]!;
      readDownloadQueue
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({ generatedAt: now.toISOString(), items: [], truncated: false });

      const removalRequest = () =>
        app.inject({
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
            "idempotency-key": "download-removal-route-fixture",
            origin: baseUrl,
            "x-omnifin-csrf": operator.csrfToken,
          },
          method: "POST",
          payload: {
            connectorId: item.connectorId,
            expectedState: item.state,
            itemId: item.id,
          },
          url: "/v1/downloads/queue/removals",
        });
      const removed = await removalRequest();

      expect(removed.statusCode, removed.body).toBe(200);
      expect(downloadQueueRemovalResponseSchema.parse(removed.json())).toMatchObject({
        contentDisposition: "preserved",
        item: { id: item.id },
        replayed: false,
      });
      expect(removeDownloadQueueItem).toHaveBeenCalledWith(
        { externalId: privateUpstreamId },
        expect.any(AbortSignal),
      );
      expect(removed.headers["idempotency-replayed"]).toBe("false");
      expect(removed.headers["cache-control"]).toBe("no-store");
      expect(removed.body).not.toContain(privateUpstreamId);
      expect(removed.body).not.toContain(privatePassword);

      const replayed = await removalRequest();
      expect(replayed.statusCode, replayed.body).toBe(200);
      expect(downloadQueueRemovalResponseSchema.parse(replayed.json()).replayed).toBe(true);
      expect(replayed.headers["idempotency-replayed"]).toBe("true");
      expect(removeDownloadQueueItem).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("rejects queue removal before mutation when CSRF, permission, or idempotency proof is missing", async () => {
    const { app, operator, readDownloadQueue, removeDownloadQueueItem, viewer } = await harness();
    try {
      const queueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/downloads/queue",
      });
      const item = downloadQueueResponseSchema.parse(queueResponse.json()).items[0]!;
      const body = {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      };
      readDownloadQueue.mockClear();

      const csrfDenied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          "idempotency-key": "csrf-denied-removal-fixture",
          origin: baseUrl,
        },
        method: "POST",
        payload: body,
        url: "/v1/downloads/queue/removals",
      });
      expect(csrfDenied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(csrfDenied.json()).error.code).toBe("csrf_denied");

      const permissionDenied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "idempotency-key": "permission-denied-removal-fixture",
          origin: baseUrl,
          "x-omnifin-csrf": viewer.csrfToken,
        },
        method: "POST",
        payload: body,
        url: "/v1/downloads/queue/removals",
      });
      expect(permissionDenied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(permissionDenied.json()).error.code).toBe("permission_denied");

      const idempotencyDenied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        payload: body,
        url: "/v1/downloads/queue/removals",
      });
      expect(idempotencyDenied.statusCode).toBe(400);
      expect(apiErrorSchema.parse(idempotencyDenied.json()).error.code).toBe("invalid_request");

      expect(readDownloadQueue).not.toHaveBeenCalled();
      expect(removeDownloadQueueItem).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
