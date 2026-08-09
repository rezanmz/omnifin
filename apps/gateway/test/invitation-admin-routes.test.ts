import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";

const origin = "https://omnifin.example";
const now = new Date("2026-08-01T00:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL(`${origin}/`),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 8),
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

function seedUser(
  app: Awaited<ReturnType<typeof createApp>>,
  userId: string,
  role: "admin" | "viewer",
) {
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: userId,
      id: userId,
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
      deviceId: `${userId}-device`,
      encryptedAccessToken: `v2.${userId}-token`,
      externalDisplayName: userId,
      externalServerId: "server-home",
      externalUserId: `${userId}-external`,
      externalUsername: userId,
      healthState: "linked",
      id: `${userId}-link`,
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId,
    })
    .run();
}

async function harness() {
  let id = 0;
  const app = await createApp({
    config: config(),
    sessionDependencies: {
      clock: () => now,
      createId: () => `route-session-${++id}`,
      createToken: () => Buffer.alloc(32, ++id).toString("base64url"),
    },
    invitationAdminDependencies: {
      clock: () => now,
      createId: () => `route-invitation-${++id}`,
      createToken: () => Buffer.alloc(32, ++id).toString("base64url"),
    },
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: now,
      displayName: "Jellyfin",
      encryptedCredentials: "v2.fixture-connector",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  seedUser(app, "admin-user", "admin");
  seedUser(app, "viewer-user", "viewer");
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
  return { admin, app, viewer };
}

function headers(session: Awaited<ReturnType<typeof harness>>["admin"]) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    origin,
    [SESSION_CSRF_HEADER]: session.csrfToken,
  };
}

describe("invitation administration routes", () => {
  it("requires an active administrator, CSRF, and exact origin", async () => {
    const { admin, app, viewer } = await harness();
    try {
      const missingCsrf = await app.inject({
        body: {},
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}`, origin },
        method: "POST",
        url: "/v1/admin/invites",
      });
      expect(missingCsrf.statusCode).toBe(403);

      const wrongOrigin = await app.inject({
        body: {},
        headers: { ...headers(admin), origin: "https://evil.example" },
        method: "POST",
        url: "/v1/admin/invites",
      });
      expect(wrongOrigin.statusCode).toBe(403);

      const viewerResponse = await app.inject({
        body: {},
        headers: headers(viewer),
        method: "POST",
        url: "/v1/admin/invites",
      });
      expect(viewerResponse.statusCode).toBe(403);

      const created = await app.inject({
        body: { expiresInSeconds: 60 * 60 },
        headers: headers(admin),
        method: "POST",
        url: "/v1/admin/invites",
      });
      expect(created.statusCode, created.body).toBe(201);
      const payload = created.json() as { invitation: { id: string }; invitationUrl: string };
      expect(payload.invitationUrl).toMatch(/^https:\/\/omnifin\.example\/invite#invite=/u);
      expect(created.json().invitation.expiresAt).toBe("2026-08-01T01:00:00.000Z");

      const listed = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}` },
        method: "GET",
        url: "/v1/admin/invites",
      });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.body).not.toContain(
        payload.invitationUrl.slice("https://omnifin.example/invite#invite=".length),
      );
      expect(listed.body).not.toContain("tokenHash");

      const revoked = await app.inject({
        headers: headers(admin),
        method: "POST",
        url: `/v1/admin/invites/${payload.invitation.id}/revoke`,
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json()).toMatchObject({
        invitation: { id: payload.invitation.id, status: "revoked" },
      });
    } finally {
      await app.close();
    }
  });

  it("does not disclose missing cursors and maps revoke races to stable conflict codes", async () => {
    const { admin, app } = await harness();
    try {
      const anonymous = await app.inject({
        headers: { origin },
        method: "GET",
        url: "/v1/admin/invites",
      });
      expect(anonymous.statusCode).toBe(401);

      const missingCursor = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}` },
        method: "GET",
        url: "/v1/admin/invites?cursor=invite_missing",
      });
      expect(missingCursor.statusCode).toBe(400);
      expect(missingCursor.json()).toMatchObject({
        error: { code: "invitation_cursor_invalid" },
      });

      const invalidBody = await app.inject({
        body: { expiresInSeconds: 1 },
        headers: headers(admin),
        method: "POST",
        url: "/v1/admin/invites",
      });
      expect(invalidBody.statusCode).toBe(400);

      const created = await app.inject({
        body: { expiresInSeconds: 60 * 60 },
        headers: headers(admin),
        method: "POST",
        url: "/v1/admin/invites",
      });
      const invitationId = (created.json() as { invitation: { id: string } }).invitation.id;
      const revoked = await app.inject({
        headers: headers(admin),
        method: "POST",
        url: `/v1/admin/invites/${invitationId}/revoke`,
      });
      expect(revoked.statusCode).toBe(200);
      const replayed = await app.inject({
        headers: headers(admin),
        method: "POST",
        url: `/v1/admin/invites/${invitationId}/revoke`,
      });
      expect(replayed.statusCode).toBe(409);
      expect(replayed.json()).toMatchObject({ error: { code: "invitation_revoked" } });

      const expired = await app.inject({
        body: { expiresInSeconds: 60 * 60 },
        headers: headers(admin),
        method: "POST",
        url: "/v1/admin/invites",
      });
      const expiredId = (expired.json() as { invitation: { id: string } }).invitation.id;
      app.database.sqlite.pragma("ignore_check_constraints = ON");
      app.database.sqlite
        .prepare("update invitations set expires_at = ? where id = ?")
        .run(now.getTime() - 1, expiredId);
      const expiredRevoke = await app.inject({
        headers: headers(admin),
        method: "POST",
        url: `/v1/admin/invites/${expiredId}/revoke`,
      });
      expect(expiredRevoke.statusCode).toBe(409);
      expect(expiredRevoke.json()).toMatchObject({ error: { code: "invitation_expired" } });
    } finally {
      await app.close();
    }
  });
});
