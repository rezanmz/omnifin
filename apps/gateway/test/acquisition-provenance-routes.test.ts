import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type {
  AcquisitionMonitoringState,
  AcquisitionEvent,
  AcquisitionProvenanceResponse,
  AcquisitionSearchResponse,
} from "@omnifin/contracts/acquisition";
import {
  acquisitionMonitoringStateSchema,
  acquisitionProvenanceSnapshotEventSchema,
  acquisitionProvenanceResponseSchema,
  acquisitionQueueRecoveryResponseSchema,
  acquisitionSearchResponseSchema,
} from "@omnifin/contracts/acquisition";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-27T19:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 89),
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
    createId: () => `acquisition-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

const normalizedResponse: AcquisitionProvenanceResponse = {
  events: [
    {
      episodeNumbers: [],
      id: "radarr:queue:14",
      kind: "downloading",
      occurredAt: "2026-07-27T18:55:00.000Z",
      release: {
        downloadClient: "qBittorrent",
        indexer: "Cinema Index",
        protocol: "torrent",
        quality: "WEBDL-1080p",
        sizeBytes: 9_000_000_000,
        title: "A.Safe.Release",
      },
      seasonNumber: null,
      state: "active",
      summary: "Download is moving through the configured client.",
    },
  ],
  failures: [],
  generatedAt: now.toISOString(),
  state: "complete",
  target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
};

const stalledResponse: AcquisitionProvenanceResponse = {
  ...normalizedResponse,
  events: [
    {
      ...normalizedResponse.events[0]!,
      id: "radarr:queue:91",
      kind: "stalled",
      state: "warning",
      summary: "Download needs operator attention before import can continue.",
    },
  ],
};

const normalizedSearch: AcquisitionSearchResponse = {
  acceptedAt: now.toISOString(),
  operationId: "radarr:command:814",
  state: "queued",
  target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
};

const monitoredState: AcquisitionMonitoringState = {
  monitored: true,
  target: { kind: "movie", mediaId: 42, service: "radarr" },
  verifiedAt: now.toISOString(),
};

const unmonitoredState: AcquisitionMonitoringState = {
  ...monitoredState,
  monitored: false,
};

function capabilitySnapshot() {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        "acquisition.history",
        "acquisition.monitoring",
        "acquisition.queue.mutate",
        "acquisition.search",
      ],
      checkedAt: now.toISOString(),
      connectorId: "radarr-main",
      displayName: "Radarr",
      failure: null,
      latencyMs: 10,
      service: "radarr",
      status: "healthy",
      version: "5.22.4",
    },
    schemaVersion: 1,
  });
}

async function harness(
  implementation = vi.fn(async () => normalizedResponse),
  options: {
    eventDependencies?: {
      connectionLifetimeMs?: number;
      createCursor?: () => string;
      heartbeatIntervalMs?: number;
      maxConnectionsPerSession?: number;
      pollIntervalMs?: number;
      reconnectDelayMs?: number;
    };
    withConnector?: boolean;
  } = {},
) {
  const config = testConfig();
  const queueAcquisitionSearch = vi.fn(async () => normalizedSearch);
  const readAcquisitionMonitoring = vi.fn(async () => monitoredState);
  const readAcquisitionQueue = vi.fn(
    async (): Promise<{ event: AcquisitionEvent; externalId: number }[]> => [],
  );
  const removeAndBlocklistAcquisitionQueueItem = vi.fn(async () => undefined);
  const updateAcquisitionMonitoring = vi.fn(async () => unmonitoredState);
  let operationIdentifier = 0;
  const app = await createApp({
    ...(options.eventDependencies === undefined
      ? {}
      : { acquisitionProvenanceEventDependencies: options.eventDependencies }),
    acquisitionProvenanceDependencies: {
      clock: () => now,
      createAdapter: () => ({
        queueAcquisitionSearch,
        readAcquisitionMonitoring,
        readAcquisitionQueue,
        readAcquisitionProvenance: implementation,
        removeAndBlocklistAcquisitionQueueItem,
        updateAcquisitionMonitoring,
      }),
      createId: () => `acquisition-operation-${++operationIdentifier}`,
      createOperationId: () => "acquisition_recovery_ABCDEFGHIJKLMNOPQRSTUV",
      wait: async () => undefined,
    },
    config,
    sessionDependencies: sessionDependencies(),
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
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
    })
    .run();
  if (options.withConnector !== false) {
    app.database.db
      .insert(connectorConfigs)
      .values({
        baseUrl: "https://radarr.example.test/",
        capabilitySnapshotJson: capabilitySnapshot(),
        createdAt: now,
        displayName: "Radarr",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: "route-private-api-key", kind: "api_key" },
            schemaVersion: 1,
          }),
          "connector_credentials:radarr:radarr-main",
        ),
        healthState: "healthy",
        id: "radarr-main",
        type: "radarr",
        updatedAt: now,
      })
      .run();
  }
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
  return {
    app,
    implementation,
    operator,
    queueAcquisitionSearch,
    readAcquisitionMonitoring,
    readAcquisitionQueue,
    removeAndBlocklistAcquisitionQueueItem,
    updateAcquisitionMonitoring,
    viewer,
  };
}

describe("acquisition provenance routes", () => {
  it("protects, confirms, and safely replays an exact queue recovery", async () => {
    const implementation = vi.fn(async () => stalledResponse);
    const { app, operator, readAcquisitionQueue, removeAndBlocklistAcquisitionQueueItem, viewer } =
      await harness(implementation);
    try {
      const provenanceResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance?service=radarr&mediaId=42",
      });
      const provenance = acquisitionProvenanceResponseSchema.parse(provenanceResponse.json());
      const event = provenance.events[0]!;
      expect(event.recovery).toBeDefined();
      const body = { reference: event.recovery!.reference };
      const headers = {
        cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
        "idempotency-key": "queue-recovery-route-key-0001",
        origin: baseUrl,
        "x-omnifin-csrf": operator.csrfToken,
      };

      const denied = await app.inject({
        headers: {
          ...headers,
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "x-omnifin-csrf": viewer.csrfToken,
        },
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/queue-recoveries",
      });
      expect(denied.statusCode).toBe(403);

      readAcquisitionQueue
        .mockResolvedValueOnce([{ event: stalledResponse.events[0]!, externalId: 91 }])
        .mockResolvedValueOnce([]);
      const created = await app.inject({
        headers,
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/queue-recoveries",
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.headers["idempotency-replayed"]).toBe("false");
      expect(acquisitionQueueRecoveryResponseSchema.parse(created.json())).toMatchObject({
        eventId: event.id,
        service: "radarr",
        state: "removed_and_blocklisted",
      });

      const replay = await app.inject({
        headers,
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/queue-recoveries",
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(removeAndBlocklistAcquisitionQueueItem).toHaveBeenCalledOnce();
      expect(created.body).not.toContain("radarr:queue:91");
    } finally {
      await app.close();
    }
  });

  it("protects and idempotently queues an operator acquisition search", async () => {
    const { app, operator, queueAcquisitionSearch, viewer } = await harness();
    const body = { mediaId: 42, service: "radarr" };
    const operatorHeaders = {
      cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
      "idempotency-key": "acquisition-01234567-89ab-cdef-0123-456789abcdef",
      origin: baseUrl,
      "x-omnifin-csrf": operator.csrfToken,
    };
    try {
      const anonymous = await app.inject({
        headers: { "content-type": "application/json", origin: baseUrl },
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/searches",
      });
      expect(anonymous.statusCode).toBe(403);

      const denied = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "idempotency-key": "acquisition-viewer-0123456789",
          origin: baseUrl,
          "x-omnifin-csrf": viewer.csrfToken,
        },
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/searches",
      });
      expect(denied.statusCode).toBe(403);

      const missingCsrf = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          "idempotency-key": operatorHeaders["idempotency-key"],
          origin: baseUrl,
        },
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/searches",
      });
      expect(missingCsrf.statusCode).toBe(403);

      const created = await app.inject({
        headers: operatorHeaders,
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/searches",
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.headers["idempotency-replayed"]).toBe("false");
      expect(acquisitionSearchResponseSchema.parse(created.json())).toEqual(normalizedSearch);
      expect(created.headers["cache-control"]).toBe("no-store");

      const replay = await app.inject({
        headers: operatorHeaders,
        method: "POST",
        payload: body,
        url: "/v1/acquisitions/searches",
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(queueAcquisitionSearch).toHaveBeenCalledTimes(1);
      expect(queueAcquisitionSearch).toHaveBeenCalledWith(body, expect.any(AbortSignal));
      expect(created.body).not.toContain("route-private-api-key");
    } finally {
      await app.close();
    }
  });

  it("requires an operator session and returns private normalized provenance", async () => {
    const { app, implementation, operator, viewer } = await harness();
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/acquisitions/provenance?service=radarr&mediaId=42",
      });
      expect(anonymous.statusCode).toBe(401);

      const denied = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance?service=radarr&mediaId=42",
      });
      expect(denied.statusCode).toBe(403);

      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance?service=radarr&mediaId=42",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(acquisitionProvenanceResponseSchema.parse(response.json())).toEqual({
        ...normalizedResponse,
        events: [
          {
            ...normalizedResponse.events[0],
            id: expect.stringMatching(/^acquisition_[A-Za-z0-9_-]{22}$/u),
          },
        ],
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain("route-private-api-key");
      expect(implementation).toHaveBeenCalledWith(
        { mediaId: 42, service: "radarr" },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("streams one strict target snapshot with resumable private SSE headers", async () => {
    const { app, implementation, operator } = await harness(undefined, {
      eventDependencies: {
        connectionLifetimeMs: 30,
        createCursor: () => "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        heartbeatIntervalMs: 10,
        pollIntervalMs: 60_000,
        reconnectDelayMs: 3_000,
      },
    });
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance/events?service=radarr&mediaId=42",
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
      expect(response.body).toContain("id: provenance_event_ABCDEFGHIJKLMNOPQRSTUV\n");
      const dataLine = response.body.split("\n").find((line) => line.startsWith("data: "));
      expect(dataLine).toBeDefined();
      expect(
        acquisitionProvenanceSnapshotEventSchema.parse(
          JSON.parse(dataLine!.slice("data: ".length)),
        ),
      ).toMatchObject({
        cursor: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        provenance: { target: { mediaId: 42, service: "radarr" } },
      });
      expect(response.body).not.toContain("route-private-api-key");
      expect(implementation).toHaveBeenCalledWith(
        { mediaId: 42, service: "radarr" },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects an untrusted resume cursor before contacting the connector", async () => {
    const { app, implementation, operator } = await harness();
    try {
      const response = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          "last-event-id": "private-radarr-history-id",
        },
        method: "GET",
        url: "/v1/acquisitions/provenance/events?service=radarr&mediaId=42",
      });

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "acquisition_provenance_event_cursor_invalid",
      );
      expect(implementation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("denies non-operators and invalid targets before opening a live stream", async () => {
    const { app, implementation, operator, viewer } = await harness();
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/acquisitions/provenance/events?service=radarr&mediaId=42",
      });
      expect(anonymous.statusCode).toBe(401);

      const denied = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance/events?service=radarr&mediaId=42",
      });
      expect(denied.statusCode).toBe(403);

      const invalidTarget = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance/events?service=radarr&mediaId=42&seasonNumber=1",
      });
      expect(invalidTarget.statusCode).toBe(400);
      expect(implementation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a bounded retry response before opening an excess session stream", async () => {
    const { app, implementation, operator } = await harness(undefined, {
      eventDependencies: {
        connectionLifetimeMs: 40,
        createCursor: () => "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
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
        url: "/v1/acquisitions/provenance/events?service=radarr&mediaId=42",
      });
      await vi.waitFor(() => expect(implementation).toHaveBeenCalledOnce());
      const limited = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance/events?service=radarr&mediaId=42",
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("3");
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(apiErrorSchema.parse(limited.json()).error.code).toBe(
        "acquisition_provenance_event_capacity_reached",
      );
      await openStream;
    } finally {
      await app.close();
    }
  });

  it("protects exact-target monitoring reads and CSRF-bound idempotent updates", async () => {
    const { app, operator, readAcquisitionMonitoring, updateAcquisitionMonitoring, viewer } =
      await harness();
    const body = {
      expectedMonitored: true,
      mediaId: 42,
      monitored: false,
      service: "radarr",
    };
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/acquisitions/monitoring?service=radarr&mediaId=42",
      });
      expect(anonymous.statusCode).toBe(401);

      const denied = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/monitoring?service=radarr&mediaId=42",
      });
      expect(denied.statusCode).toBe(403);

      const read = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/monitoring?service=radarr&mediaId=42",
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(acquisitionMonitoringStateSchema.parse(read.json())).toEqual(monitoredState);
      expect(read.headers["cache-control"]).toBe("no-store");

      const missingCsrf = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
        },
        method: "PUT",
        payload: body,
        url: "/v1/acquisitions/monitoring",
      });
      expect(missingCsrf.statusCode).toBe(403);

      const updated = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "PUT",
        payload: body,
        url: "/v1/acquisitions/monitoring",
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(acquisitionMonitoringStateSchema.parse(updated.json())).toEqual(unmonitoredState);
      expect(readAcquisitionMonitoring).toHaveBeenCalledTimes(2);
      expect(updateAcquisitionMonitoring).toHaveBeenCalledWith(body, expect.any(AbortSignal));
      expect(updated.body).not.toContain("route-private-api-key");
    } finally {
      await app.close();
    }
  });

  it("maps monitoring upstream failures to bounded private errors", async () => {
    const { app, operator, readAcquisitionMonitoring } = await harness();
    const request = () =>
      app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/monitoring?service=radarr&mediaId=42",
      });
    try {
      readAcquisitionMonitoring.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "rate_limited",
          message: "Private Radarr rate-limit response",
          operation: "acquisition.monitoring.read",
          retryAfterSeconds: 45,
          retryable: true,
          service: "radarr",
          status: 429,
        }),
      );
      const rateLimited = await request();
      expect(rateLimited.statusCode).toBe(429);
      expect(rateLimited.headers["retry-after"]).toBe("45");
      expect(apiErrorSchema.parse(rateLimited.json()).error.code).toBe(
        "acquisition_monitoring_rate_limited",
      );
      expect(rateLimited.body).not.toContain("Private Radarr rate-limit response");

      readAcquisitionMonitoring.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "response_invalid",
          message: "Private malformed Radarr payload",
          operation: "acquisition.monitoring.read",
          retryable: false,
          service: "radarr",
          status: 200,
        }),
      );
      const invalidResponse = await request();
      expect(invalidResponse.statusCode).toBe(502);
      expect(apiErrorSchema.parse(invalidResponse.json()).error.code).toBe(
        "acquisition_monitoring_response_invalid",
      );
      expect(invalidResponse.body).not.toContain("Private malformed Radarr payload");

      readAcquisitionMonitoring.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "invalid_credentials",
          message: "Private rejected Radarr credential",
          operation: "acquisition.monitoring.read",
          retryable: false,
          service: "radarr",
          status: 401,
        }),
      );
      const unavailable = await request();
      expect(unavailable.statusCode).toBe(503);
      expect(apiErrorSchema.parse(unavailable.json()).error.code).toBe(
        "acquisition_monitoring_configuration_unavailable",
      );
      expect(unavailable.body).not.toContain("Private rejected Radarr credential");
    } finally {
      await app.close();
    }
  });

  it("rejects mismatched movie season input before calling the connector", async () => {
    const { app, implementation, operator } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance?service=radarr&mediaId=42&seasonNumber=1",
      });
      expect(response.statusCode).toBe(400);
      expect(implementation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reports unconfigured acquisition history without exposing configuration", async () => {
    const { app, operator } = await harness(undefined, { withConnector: false });
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance?service=radarr&mediaId=42",
      });
      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("acquisition_not_configured");
    } finally {
      await app.close();
    }
  });

  it("preserves bounded retry guidance and redacts upstream error details", async () => {
    const upstream = new SafeConnectorError({
      code: "rate_limited",
      message: "Private Radarr response details",
      operation: "acquisition.history",
      retryAfterSeconds: 45,
      retryable: true,
      service: "radarr",
      status: 429,
    });
    const { app, operator } = await harness(vi.fn(async () => Promise.reject(upstream)));
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
        method: "GET",
        url: "/v1/acquisitions/provenance?service=radarr&mediaId=42",
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("45");
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("acquisition_rate_limited");
      expect(response.body).not.toContain("Private Radarr response details");
    } finally {
      await app.close();
    }
  });
});
