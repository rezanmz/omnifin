import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { MediaRequestResponse } from "@omnifin/contracts/requests";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import {
  MediaRequestService,
  type MediaRequestAdapter,
  type MediaRequestFailureCode,
} from "../src/requests/media-request-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-27T16:30:00.000Z");
const privateApiKey = "request-private-api-key";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 82),
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

function principal(role: "requester" | "viewer" = "requester"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-26T16:30:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-27T17:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Viewer",
        externalUserId: "jellyfin-user-1",
        health: "linked",
        id: "viewer-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "viewer",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${role}-session`,
    userId: "viewer-user",
  });
}

const createdRequest: MediaRequestResponse = {
  createdAt: now.toISOString(),
  id: "request:91",
  is4k: false,
  kind: "series",
  seasons: [1, 3],
  source: "seerr",
  status: "approved",
  tmdbId: 1399,
};

function insertFoundation(database: DatabaseHandle, config: AppConfig) {
  database.db
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
            credentials: { apiKey: privateApiKey, kind: "api_key" },
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
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Viewer",
      id: "viewer-user",
      role: "requester",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  database.db
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
}

function harness(
  options: {
    createMediaRequest?: MediaRequestAdapter["createMediaRequest"];
    resolveUser?: MediaRequestAdapter["resolveUser"];
  } = {},
) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  insertFoundation(database, config);
  const resolveUser =
    options.resolveUser ?? vi.fn<MediaRequestAdapter["resolveUser"]>(async () => 42);
  const createMediaRequest =
    options.createMediaRequest ??
    vi.fn<MediaRequestAdapter["createMediaRequest"]>(async () => createdRequest);
  let id = 0;
  const service = new MediaRequestService(database, config, {
    clock: () => now,
    createAdapter: vi.fn(() => ({ createMediaRequest, resolveUser })),
    createId: () => `media-request-id-${String(++id).padStart(2, "0")}`,
  });
  return { createMediaRequest, database, resolveUser, service };
}

const context = () => ({
  ipAddress: "203.0.113.8",
  principal: principal(),
  requestId: "request-correlation-01",
});

describe("media request service", () => {
  it("delegates to the exact Jellyfin-linked Seerr user and durably replays success", async () => {
    const { createMediaRequest, database, resolveUser, service } = harness();
    try {
      const first = await service.create(
        { is4k: false, kind: "series", seasons: [3, 1], tmdbId: 1399 },
        "request-key-0001",
        context(),
      );
      const replay = await service.create(
        { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
        "request-key-0001",
        context(),
      );

      expect(first).toEqual({ replayed: false, request: createdRequest });
      expect(replay).toEqual({ replayed: true, request: createdRequest });
      expect(resolveUser).toHaveBeenCalledTimes(1);
      expect(resolveUser).toHaveBeenCalledWith(
        { jellyfinUserId: "jellyfin-user-1", jellyfinUsername: "viewer" },
        undefined,
      );
      expect(createMediaRequest).toHaveBeenCalledTimes(1);
      expect(createMediaRequest).toHaveBeenCalledWith(
        { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
        42,
        undefined,
      );
      const operation = database.sqlite
        .prepare(
          "select state, response_json as responseJson, idempotency_key_hash as keyHash from media_request_operations",
        )
        .get() as { keyHash: string; responseJson: string; state: string };
      expect(operation.state).toBe("succeeded");
      expect(operation.keyHash).toHaveLength(43);
      expect(operation.keyHash).not.toContain("request-key-0001");
      expect(JSON.parse(operation.responseJson)).toEqual(createdRequest);
      const audit = database.sqlite
        .prepare(
          "select event_type as eventType, outcome, target_id as targetId, metadata_json as metadataJson from audit_events where event_type = 'media.request.created'",
        )
        .get() as Record<string, string>;
      expect(audit).toMatchObject({
        eventType: "media.request.created",
        outcome: "success",
        targetId: "request:91",
      });
      expect(JSON.parse(audit.metadataJson!)).toEqual({
        is4k: false,
        kind: "series",
        tmdbId: 1399,
      });
      expect(JSON.stringify({ audit, operation })).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("rejects reuse of an idempotency key for a different canonical request", async () => {
    const { createMediaRequest, database, service } = harness();
    try {
      await service.create(
        { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
        "request-key-0002",
        context(),
      );
      await expect(
        service.create(
          { is4k: true, kind: "series", seasons: [1, 3], tmdbId: 1399 },
          "request-key-0002",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      expect(createMediaRequest).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("persists and replays a sanitized upstream failure without retrying the mutation", async () => {
    const privateMessage = "private upstream failure";
    const failure = new Error(privateMessage);
    const createMediaRequest = vi.fn<MediaRequestAdapter["createMediaRequest"]>(async () =>
      Promise.reject(failure),
    );
    const { database, resolveUser, service } = harness({ createMediaRequest });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          service.create(
            { is4k: false, kind: "series", seasons: "all", tmdbId: 1399 },
            "request-key-0003",
            context(),
          ),
        ).rejects.toMatchObject({
          reason: "temporarily_unavailable" satisfies MediaRequestFailureCode,
        });
      }
      expect(resolveUser).toHaveBeenCalledTimes(1);
      expect(createMediaRequest).toHaveBeenCalledTimes(1);
      const operation = database.sqlite
        .prepare(
          "select state, failure_code as failureCode, response_json as responseJson from media_request_operations",
        )
        .get();
      expect(operation).toEqual({
        failureCode: "temporarily_unavailable",
        responseJson: null,
        state: "failed",
      });
      const serializedAudit = JSON.stringify(
        database.sqlite
          .prepare(
            "select metadata_json from audit_events where event_type = 'media.request.failed'",
          )
          .get(),
      );
      expect(serializedAudit).toContain("temporarily_unavailable");
      expect(serializedAudit).not.toContain(privateMessage);
    } finally {
      database.close();
    }
  });

  it("authorizes request creation before reading connector or identity state", async () => {
    const { createMediaRequest, database, resolveUser, service } = harness();
    try {
      await expect(
        service.create({ is4k: false, kind: "movie", tmdbId: 550 }, "request-key-0004", {
          ...context(),
          principal: principal("viewer"),
        }),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
      expect(resolveUser).not.toHaveBeenCalled();
      expect(createMediaRequest).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select count(*) as count from media_request_operations").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("requires a healthy negotiated request capability before contacting Seerr", async () => {
    const { createMediaRequest, database, resolveUser, service } = harness();
    try {
      database.sqlite
        .prepare(
          "update connector_configs set capability_snapshot_json = ? where id = 'seerr-main'",
        )
        .run(
          JSON.stringify({
            health: {
              capabilities: ["connector.health", "connector.version", "media.discover"],
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
        service.create({ is4k: false, kind: "movie", tmdbId: 550 }, "request-key-0005", context()),
      ).rejects.toMatchObject({ reason: "configuration_unavailable" });
      expect(resolveUser).not.toHaveBeenCalled();
      expect(createMediaRequest).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare("select state, failure_code as failureCode from media_request_operations")
          .get(),
      ).toEqual({ failureCode: "configuration_unavailable", state: "failed" });
    } finally {
      database.close();
    }
  });
});
