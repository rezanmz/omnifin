import { SeerrRequestError } from "@omnifin/connectors/adapters/seerr";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  requestReviewItemSchema,
  requestReviewPageSchema,
  type RequestReviewItem,
} from "@omnifin/contracts/requests";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import type { RequestReviewAdapter } from "../src/requests/request-review-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-28T17:15:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 85),
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
    createId: () => `review-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

const pendingRequest: RequestReviewItem = {
  createdAt: "2026-07-28T16:30:00.000Z",
  id: "request:101",
  is4k: false,
  kind: "movie",
  qualityProfile: "1080p",
  requestedBy: "alex",
  seasons: null,
  source: "seerr",
  status: "pending",
  title: "The Long Meridian",
  tmdbId: 550,
  updatedAt: "2026-07-28T16:35:00.000Z",
  year: 2026,
};

async function harness(
  options: {
    reviewMediaRequest?: RequestReviewAdapter["reviewMediaRequest"];
    role?: "operator" | "viewer";
  } = {},
) {
  const config = testConfig();
  const listMediaRequests = vi.fn<RequestReviewAdapter["listMediaRequests"]>(async (query) => ({
    generatedAt: now.toISOString(),
    items: [pendingRequest],
    nextCursor: query.limit === 1 ? "requests:21" : null,
    status: query.status,
  }));
  const reviewMediaRequest =
    options.reviewMediaRequest ??
    vi.fn<RequestReviewAdapter["reviewMediaRequest"]>(async (_requestId, input) => ({
      ...pendingRequest,
      status: input.decision === "approve" ? "approved" : "declined",
      updatedAt: now.toISOString(),
    }));
  let recordIdentifier = 0;
  const app = await createApp({
    config,
    requestReviewDependencies: {
      clock: () => now,
      createAdapter: () => ({ listMediaRequests, reviewMediaRequest }),
      createId: () => `review-route-record-${++recordIdentifier}`,
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
            capabilities: ["connector.health", "connector.version", "request.review"],
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
      displayName: "Stack operator",
      id: "operator-user",
      role: options.role ?? "operator",
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
      deviceId: "operator-device",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Stack operator",
      externalServerId: "jellyfin-server",
      externalUserId: "jellyfin-user-1",
      externalUsername: "operator",
      healthState: "linked",
      id: "operator-link",
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "operator-user",
    })
    .run();
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "operator-link",
      userId: "operator-user",
    },
  });
  const cookie = `${SESSION_COOKIE_NAME}=${session.sessionToken}`;
  const mutationHeaders = {
    [SESSION_CSRF_HEADER]: session.csrfToken,
    cookie,
    "idempotency-key": "route-review-key-0001",
    origin: baseUrl,
  };
  return { app, cookie, listMediaRequests, mutationHeaders, reviewMediaRequest };
}

describe("request review routes", () => {
  it("returns a private, bounded review page with parsed filters and cursor", async () => {
    const { app, cookie, listMediaRequests } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/requests/review?cursor=requests%3A20&limit=1&status=approved",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(requestReviewPageSchema.parse(response.json())).toMatchObject({
        nextCursor: "requests:21",
        status: "approved",
      });
      expect(listMediaRequests).toHaveBeenCalledWith(
        { cursor: "requests:20", limit: 1, status: "approved" },
        expect.any(AbortSignal),
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain("route-private-api-key");
    } finally {
      await app.close();
    }
  });

  it("requires CSRF-bound operator authority and durably replays a decision", async () => {
    const { app, mutationHeaders, reviewMediaRequest } = await harness();
    try {
      const first = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { decision: "approve" },
        url: "/v1/requests/request:101/review",
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers["idempotency-replayed"]).toBe("false");
      expect(requestReviewItemSchema.parse(first.json()).status).toBe("approved");

      const replay = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { decision: "approve" },
        url: "/v1/requests/request:101/review",
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(reviewMediaRequest).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects missing CSRF, malformed input, and viewer access before Seerr", async () => {
    const operator = await harness();
    try {
      const withoutCsrf = Object.fromEntries(
        Object.entries(operator.mutationHeaders).filter(([name]) => name !== SESSION_CSRF_HEADER),
      );
      const csrfDenied = await operator.app.inject({
        headers: withoutCsrf,
        method: "POST",
        payload: { decision: "approve" },
        url: "/v1/requests/request:101/review",
      });
      expect(csrfDenied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(csrfDenied.json()).error.code).toBe("csrf_denied");

      const invalid = await operator.app.inject({
        headers: operator.mutationHeaders,
        method: "POST",
        payload: { decision: "approve", userId: 1 },
        url: "/v1/requests/request:101/review",
      });
      expect(invalid.statusCode).toBe(400);
      expect(operator.reviewMediaRequest).not.toHaveBeenCalled();
    } finally {
      await operator.app.close();
    }

    const viewer = await harness({ role: "viewer" });
    try {
      const denied = await viewer.app.inject({
        headers: { cookie: viewer.cookie },
        method: "GET",
        url: "/v1/requests/review",
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("permission_denied");
      expect(viewer.listMediaRequests).not.toHaveBeenCalled();
    } finally {
      await viewer.app.close();
    }
  });

  it("maps stale request conflicts without exposing upstream response details", async () => {
    const privateMessage = "private stale request detail";
    const reviewMediaRequest = vi.fn<RequestReviewAdapter["reviewMediaRequest"]>(async () => {
      const error = new SeerrRequestError("request_conflict");
      Object.defineProperty(error, "privateMessage", { value: privateMessage });
      throw error;
    });
    const { app, mutationHeaders } = await harness({ reviewMediaRequest });
    try {
      const response = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { decision: "decline" },
        url: "/v1/requests/request:101/review",
      });
      expect(response.statusCode).toBe(409);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("request_review_conflict");
      expect(response.body).not.toContain(privateMessage);
    } finally {
      await app.close();
    }
  });
});
