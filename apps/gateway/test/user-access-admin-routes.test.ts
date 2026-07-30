import {
  userAccessListResponseSchema,
  userAccessMutationResponseSchema,
} from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  sessions,
  users,
} from "../src/db/schema.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-30T02:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 93),
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

function insertLinkedUser(
  app: Awaited<ReturnType<typeof createApp>>,
  input: {
    displayName: string;
    role: "admin" | "viewer";
    roleSource?: "default" | "manual" | "oidc_mapping";
    userId: string;
  },
) {
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: input.displayName,
      id: input.userId,
      role: input.role,
      roleSource: input.roleSource ?? (input.role === "admin" ? "manual" : "default"),
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: now,
      deviceId: `${input.userId}-device`,
      encryptedAccessToken: `v2.${input.userId}-secret-token`,
      externalDisplayName: input.displayName,
      externalServerId: "jellyfin-server",
      externalUserId: `${input.userId}-external`,
      externalUsername: input.userId,
      healthState: "linked",
      id: `${input.userId}-link`,
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: input.userId,
    })
    .run();
}

async function harness() {
  let sessionId = 0;
  let sessionToken = 0;
  let auditId = 0;
  const app = await createApp({
    config: testConfig(),
    sessionDependencies: {
      clock: () => new Date(now),
      createId: () => `user-route-session-${++sessionId}`,
      createToken: () => Buffer.alloc(32, ++sessionToken).toString("base64url"),
    },
    userAccessAdminDependencies: {
      clock: () => new Date(now),
      createId: () => `user-route-${++auditId}`,
    },
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: now,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-connector-secret",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  insertLinkedUser(app, {
    displayName: "Administrator",
    role: "admin",
    userId: "admin-user",
  });
  insertLinkedUser(app, {
    displayName: "Direct viewer",
    role: "viewer",
    userId: "direct-user",
  });
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
      serviceIdentityLinkId: "direct-user-link",
      userId: "direct-user",
    },
  });
  const recovery = app.sessionService.createSession({ attribution: { authMethod: "recovery" } });
  return { admin, app, recovery, viewer };
}

function mutationHeaders(session: Awaited<ReturnType<typeof harness>>["admin"]) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    origin: baseUrl,
    [SESSION_CSRF_HEADER]: session.csrfToken,
    "user-agent": "user access administration route test",
    "x-request-id": "useraccessreq-001",
  };
}

describe("user access administration routes", () => {
  it("returns only normalized summaries to an authorized administrator", async () => {
    const { admin, app } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}` },
        method: "GET",
        url: "/v1/admin/users",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const page = userAccessListResponseSchema.parse(response.json());
      expect(page.users).toHaveLength(2);
      expect(page.users.find((user) => user.id === "direct-user")).toMatchObject({
        activeSessions: 1,
        authenticationMethods: ["jellyfin"],
        jellyfinLinkHealth: "linked",
        role: "viewer",
        status: "active",
      });
      expect(response.body).not.toContain("secret-token");
      expect(response.body).not.toContain("external");
    } finally {
      await app.close();
    }
  });

  it("denies anonymous, ordinary-user, and recovery sessions", async () => {
    const { app, recovery, viewer } = await harness();
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/v1/admin/users" }),
        app.inject({
          headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
          method: "GET",
          url: "/v1/admin/users",
        }),
        app.inject({
          headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
          method: "GET",
          url: "/v1/admin/users",
        }),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([401, 403, 403]);
    } finally {
      await app.close();
    }
  });

  it("changes direct authority and revokes every target session", async () => {
    const { admin, app, viewer } = await harness();
    try {
      const extraViewerSession = app.sessionService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "direct-user-link",
          userId: "direct-user",
        },
      });
      const response = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "PATCH",
        url: "/v1/admin/users/direct-user",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(userAccessMutationResponseSchema.parse(response.json())).toMatchObject({
        revokedSessions: 2,
        user: { activeSessions: 0, role: "operator", roleSource: "manual" },
      });
      const targetSessions = app.database.db
        .select()
        .from(sessions)
        .all()
        .filter((session) =>
          [viewer.principal.sessionId, extraViewerSession.principal.sessionId].includes(session.id),
        );
      expect(targetSessions).toHaveLength(2);
      expect(targetSessions.every((session) => session.revokedAt !== null)).toBe(true);
      expect(
        app.database.sqlite
          .prepare("select count(*) as total from audit_events where event_type = ?")
          .get("auth.user.access_updated"),
      ).toEqual({ total: 1 });
    } finally {
      await app.close();
    }
  });

  it("requires the session mutation proof and rejects ambiguous bodies", async () => {
    const { admin, app } = await harness();
    try {
      const missingProof = await app.inject({
        body: { enabled: false, expectedUpdatedAt: now.toISOString() },
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}`, origin: baseUrl },
        method: "PATCH",
        url: "/v1/admin/users/direct-user",
      });
      expect(missingProof.statusCode).toBe(403);

      const emptyMutation = await app.inject({
        body: { expectedUpdatedAt: now.toISOString() },
        headers: mutationHeaders(admin),
        method: "PATCH",
        url: "/v1/admin/users/direct-user",
      });
      expect(emptyMutation.statusCode).toBe(400);

      const invalidRole = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "owner" },
        headers: mutationHeaders(admin),
        method: "PATCH",
        url: "/v1/admin/users/direct-user",
      });
      expect(invalidRole.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("preserves OIDC role ownership and exposes stable conflict codes", async () => {
    const { admin, app } = await harness();
    try {
      app.database.db
        .insert(oidcProviders)
        .values({
          clientId: "omnifin",
          createdAt: now,
          displayName: "Authentik",
          id: "oidc-home",
          issuer: "https://id.example.test/application/o/omnifin/",
          slug: "authentik",
          updatedAt: now,
        })
        .run();
      app.database.db
        .insert(externalIdentities)
        .values({
          createdAt: now,
          id: "direct-user-oidc",
          issuer: "https://id.example.test/application/o/omnifin/",
          lastLoginAt: now,
          providerId: "oidc-home",
          subject: "immutable-user-subject",
          updatedAt: now,
          userId: "direct-user",
        })
        .run();

      const providerManaged = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "admin" },
        headers: mutationHeaders(admin),
        method: "PATCH",
        url: "/v1/admin/users/direct-user",
      });
      expect(providerManaged.statusCode, providerManaged.body).toBe(409);
      expect(providerManaged.json()).toMatchObject({
        error: { code: "user_role_managed_by_provider" },
      });

      const selfMutation = await app.inject({
        body: { enabled: false, expectedUpdatedAt: now.toISOString() },
        headers: mutationHeaders(admin),
        method: "PATCH",
        url: "/v1/admin/users/admin-user",
      });
      expect(selfMutation.statusCode, selfMutation.body).toBe(409);
      expect(selfMutation.json()).toMatchObject({
        error: { code: "user_access_self_mutation" },
      });
    } finally {
      await app.close();
    }
  });
});
