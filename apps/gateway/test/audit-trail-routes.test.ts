import { auditEventListResponseSchema } from "@omnifin/contracts/audit";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";

const now = new Date("2026-08-02T14:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 105),
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

function addUser(
  app: Awaited<ReturnType<typeof createApp>>,
  id: string,
  displayName: string,
  role: "admin" | "viewer",
) {
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName,
      id,
      role,
      roleSource: role === "admin" ? "manual" : "default",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: now,
      deviceId: `${id}-device`,
      encryptedAccessToken: `v2.${id}-private-token`,
      externalDisplayName: displayName,
      externalServerId: "private-server-id",
      externalUserId: `${id}-external`,
      externalUsername: id,
      healthState: "linked",
      id: `${id}-link`,
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: id,
    })
    .run();
}

async function harness() {
  let sessionId = 0;
  let tokenId = 0;
  const app = await createApp({
    auditTrailDependencies: { clock: () => new Date(now) },
    config: testConfig(),
    sessionDependencies: {
      clock: () => new Date(now),
      createId: () => `audit-route-session-${++sessionId}`,
      createToken: () => Buffer.alloc(32, ++tokenId).toString("base64url"),
    },
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: now,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.private-connector-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  addUser(app, "admin-user", "Administrator", "admin");
  addUser(app, "viewer-user", "Viewer", "viewer");
  const admin = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "admin-user-link",
      userId: "admin-user",
    },
  });
  const viewer = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-user-link",
      userId: "viewer-user",
    },
  });
  const recovery = app.sessionService.createSession({ attribution: { authMethod: "recovery" } });
  app.database.sqlite
    .prepare(
      `insert into audit_events (
        id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
        target_type, target_id, request_id, metadata_json, ip_hash, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "raw-audit-private-id",
      "admin-user",
      "raw-private-session",
      "jellyfin",
      "connector.configuration.updated",
      "success",
      "private-target",
      "private-target-id",
      "private-request-id",
      JSON.stringify({ apiKey: "private-api-key", path: "/private/media" }),
      "private-ip-hash",
      now.getTime(),
    );
  return { admin, app, recovery, viewer };
}

function cookie(sessionToken: string) {
  return { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` };
}

describe("audit trail route", () => {
  it("returns a no-store privacy-safe page to an authorized administrator", async () => {
    const { admin, app } = await harness();
    try {
      const response = await app.inject({
        headers: cookie(admin.sessionToken),
        method: "GET",
        url: "/v1/admin/audit-events?category=configuration&limit=10",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      const page = auditEventListResponseSchema.parse(response.json());
      expect(page.events).toHaveLength(1);
      expect(page.events[0]).toMatchObject({
        actor: { displayName: "Administrator", kind: "user" },
        category: "configuration",
        eventType: "connector.configuration.updated",
      });
      for (const privateValue of [
        "raw-audit-private-id",
        "raw-private-session",
        "private-target",
        "private-request-id",
        "private-api-key",
        "/private/media",
        "private-ip-hash",
        "private-token",
      ]) {
        expect(response.body).not.toContain(privateValue);
      }
    } finally {
      await app.close();
    }
  });

  it("denies anonymous, ordinary-user, and recovery sessions", async () => {
    const { app, recovery, viewer } = await harness();
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/v1/admin/audit-events" }),
        app.inject({
          headers: cookie(viewer.sessionToken),
          method: "GET",
          url: "/v1/admin/audit-events",
        }),
        app.inject({
          headers: cookie(recovery.sessionToken),
          method: "GET",
          url: "/v1/admin/audit-events",
        }),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([401, 403, 403]);
    } finally {
      await app.close();
    }
  });

  it("rejects unsupported filters and reports unusable cursors safely", async () => {
    const { admin, app } = await harness();
    try {
      const unsupported = await app.inject({
        headers: cookie(admin.sessionToken),
        method: "GET",
        url: "/v1/admin/audit-events?category=secrets",
      });
      expect(unsupported.statusCode).toBe(400);
      const cursor = await app.inject({
        headers: cookie(admin.sessionToken),
        method: "GET",
        url: `/v1/admin/audit-events?cursor=${`audit_cursor_v2.${"A".repeat(16)}.${"A".repeat(32)}.${"A".repeat(22)}`}`,
      });
      expect(cursor.statusCode).toBe(400);
      expect(cursor.json()).toMatchObject({ error: { code: "audit_cursor_invalid" } });
    } finally {
      await app.close();
    }
  });

  it("uses a stable unavailable response when audit storage fails", async () => {
    const { admin, app } = await harness();
    try {
      app.database.sqlite.exec("drop table audit_events");
      const response = await app.inject({
        headers: cookie(admin.sessionToken),
        method: "GET",
        url: "/v1/admin/audit-events",
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "audit_trail_unavailable" } });
    } finally {
      await app.close();
    }
  });
});
