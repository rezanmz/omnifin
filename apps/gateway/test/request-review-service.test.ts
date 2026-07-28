import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { RequestReviewItem, RequestReviewPage } from "@omnifin/contracts/requests";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, users } from "../src/db/schema.js";
import {
  RequestReviewService,
  type RequestReviewAdapter,
} from "../src/requests/request-review-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T17:00:00.000Z");
const privateApiKey = "review-private-api-key";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 84),
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

function principal(role: "operator" | "viewer" = "operator"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-27T17:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
    displayName: "Stack operator",
    externalIdentity: {
      displayClaims: { displayName: "Stack operator" },
      issuer: "https://identity.example.test/application/o/omnifin/",
      providerId: "oidc-home",
      subject: "operator-subject",
    },
    inactivityExpiresAt: "2026-07-28T18:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Home Jellyfin",
        externalUserId: "jellyfin-user-1",
        health: "linked",
        id: "operator-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "operator",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${role}-session`,
    userId: "operator-user",
  });
}

const pendingRequest: RequestReviewItem = {
  createdAt: "2026-07-28T16:30:00.000Z",
  id: "request:101",
  is4k: false,
  kind: "movie",
  requestedBy: "alex",
  seasons: null,
  source: "seerr",
  status: "pending",
  title: "The Long Meridian",
  tmdbId: 550,
  updatedAt: "2026-07-28T16:35:00.000Z",
  year: 2026,
};

const reviewPage: RequestReviewPage = {
  generatedAt: now.toISOString(),
  items: [pendingRequest],
  nextCursor: null,
  status: "pending",
};

function insertFoundation(database: DatabaseHandle, config: AppConfig) {
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Stack operator",
      id: "operator-user",
      role: "operator",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  database.db
    .insert(connectorConfigs)
    .values({
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
          credentials: { apiKey: privateApiKey, kind: "api_key" },
          schemaVersion: 1,
        }),
        "connector_credentials:seerr:seerr-main",
      ),
      healthState: "healthy",
      id: "seerr-main",
      type: "seerr",
      updatedAt: now,
    })
    .run();
}

function harness(overrides: Partial<RequestReviewAdapter> = {}) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  insertFoundation(database, config);
  const listMediaRequests =
    overrides.listMediaRequests ??
    vi.fn<RequestReviewAdapter["listMediaRequests"]>(async () => reviewPage);
  const reviewMediaRequest =
    overrides.reviewMediaRequest ??
    vi.fn<RequestReviewAdapter["reviewMediaRequest"]>(async (_requestId, input) => ({
      ...pendingRequest,
      status: input.decision === "approve" ? "approved" : "declined",
      updatedAt: now.toISOString(),
    }));
  let identifier = 0;
  const createAdapter = vi.fn(() => ({ listMediaRequests, reviewMediaRequest }));
  const service = new RequestReviewService(database, config, {
    clock: () => now,
    createAdapter,
    createId: () => `request-review-record-${++identifier}`,
  });
  return { createAdapter, database, listMediaRequests, reviewMediaRequest, service };
}

const context = (role: "operator" | "viewer" = "operator") => ({
  ipAddress: "203.0.113.9",
  principal: principal(role),
  requestId: "request-correlation-02",
});

describe("request review service", () => {
  it("lists only normalized review records through a healthy negotiated connector", async () => {
    const { createAdapter, database, listMediaRequests, service } = harness();
    try {
      const result = await service.list({ cursor: null, limit: 20, status: "pending" }, context());

      expect(result).toEqual(reviewPage);
      expect(listMediaRequests).toHaveBeenCalledWith(
        { cursor: null, limit: 20, status: "pending" },
        undefined,
      );
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: privateApiKey,
          baseUrl: "https://seerr.example.test/",
          connectorId: "seerr-main",
        }),
      );
      expect(JSON.stringify(result)).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("durably replays an approved decision and records a sanitized audit event", async () => {
    const { database, reviewMediaRequest, service } = harness();
    try {
      const first = await service.review(
        "request:101",
        { decision: "approve" },
        "review-key-0001",
        context(),
      );
      const replay = await service.review(
        "request:101",
        { decision: "approve" },
        "review-key-0001",
        context(),
      );

      expect(first).toMatchObject({ replayed: false, request: { status: "approved" } });
      expect(replay).toEqual({ replayed: true, request: first.request });
      expect(reviewMediaRequest).toHaveBeenCalledTimes(1);
      expect(reviewMediaRequest).toHaveBeenCalledWith(
        "request:101",
        { decision: "approve" },
        undefined,
      );
      const operation = database.sqlite
        .prepare(
          "select state, response_json as responseJson, idempotency_key_hash as keyHash from media_request_operations",
        )
        .get() as { keyHash: string; responseJson: string; state: string };
      expect(operation.state).toBe("succeeded");
      expect(operation.keyHash).toHaveLength(43);
      expect(operation.keyHash).not.toContain("review-key-0001");
      const audit = database.sqlite
        .prepare(
          "select event_type as eventType, outcome, target_id as targetId, metadata_json as metadataJson from audit_events where event_type = 'media.request.approved'",
        )
        .get() as Record<string, string>;
      expect(audit).toMatchObject({
        eventType: "media.request.approved",
        outcome: "success",
        targetId: "request:101",
      });
      expect(JSON.parse(audit.metadataJson!)).toEqual({ decision: "approve" });
      expect(JSON.stringify({ audit, operation })).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("rejects conflicting keys and out-of-range targets before a second mutation", async () => {
    const { database, reviewMediaRequest, service } = harness();
    try {
      await service.review("request:101", { decision: "decline" }, "review-key-0002", context());
      await expect(
        service.review("request:101", { decision: "approve" }, "review-key-0002", context()),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      await expect(
        service.review("request:9999999999", { decision: "approve" }, "review-key-0003", context()),
      ).rejects.toMatchObject({ reason: "request_not_found" });
      expect(reviewMediaRequest).toHaveBeenCalledTimes(1);
      expect(
        database.sqlite.prepare("select count(*) as count from media_request_operations").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("authorizes locally and fails closed when request review was not negotiated", async () => {
    const { createAdapter, database, service } = harness();
    try {
      await expect(
        service.list({ cursor: null, limit: 20, status: "pending" }, context("viewer")),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
      database.sqlite
        .prepare(
          "update connector_configs set capability_snapshot_json = ? where id = 'seerr-main'",
        )
        .run(
          JSON.stringify({
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
        );
      await expect(
        service.list({ cursor: null, limit: 20, status: "pending" }, context()),
      ).rejects.toMatchObject({ reason: "configuration_unavailable" });
      expect(createAdapter).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
