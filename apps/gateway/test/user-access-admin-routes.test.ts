import {
  oidcRoleAssignmentResponseSchema,
  oidcRoleMappingsAdminResponseSchema,
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
  roleMappings,
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

function insertOidcUser(
  app: Awaited<ReturnType<typeof createApp>>,
  input: {
    role?: "viewer" | "operator";
    roleSource?: "default" | "oidc_mapping";
    subject: string;
    userId: string;
  },
) {
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: input.userId,
      id: input.userId,
      role: input.role ?? "viewer",
      roleSource: input.roleSource ?? "default",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(externalIdentities)
    .values({
      createdAt: now,
      displayClaimsJson: JSON.stringify({ displayName: input.userId }),
      id: `${input.userId}-identity`,
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: now,
      providerId: "oidc-home",
      subject: input.subject,
      updatedAt: now,
      userId: input.userId,
    })
    .run();
}

async function harness() {
  let sessionId = 0;
  let sessionToken = 0;
  let auditId = 0;
  let mappingId = 0;
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
      oidcRoleMapping: {
        clock: () => new Date(now),
        createId: () => `assignment-${++mappingId}`,
      },
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

  it("creates a server-owned fallback mapping without exposing the OIDC subject", async () => {
    const { admin, app, viewer } = await harness();
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
      insertOidcUser(app, { subject: "immutable-target-subject", userId: "oidc-target" });
      insertOidcUser(app, {
        role: "operator",
        roleSource: "oidc_mapping",
        subject: "immutable-peer-subject",
        userId: "oidc-peer",
      });
      const targetSession = app.sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "oidc-target-identity",
          oidcProviderId: "oidc-home",
          userId: "oidc-target",
        },
      });
      const peerSession = app.sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "oidc-peer-identity",
          oidcProviderId: "oidc-home",
          userId: "oidc-peer",
        },
      });
      const url = "/v1/admin/users/oidc-target/oidc-role-assignment";
      const invalidBody = await app.inject({
        body: {
          claimPath: ["sub"],
          enabled: true,
          expectedUpdatedAt: now.toISOString(),
          operator: "equals",
          priority: 1000,
          role: "operator",
          subject: "request-forged-subject",
          values: ["request-forged-subject"],
        },
        headers: mutationHeaders(admin),
        method: "POST",
        url,
      });
      expect(invalidBody.statusCode).toBe(400);
      expect(app.database.db.select().from(roleMappings).all()).toEqual([]);

      const assigned = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url,
      });
      expect(assigned.statusCode, assigned.body).toBe(201);
      expect(assigned.headers["cache-control"]).toBe("no-store");
      expect(oidcRoleAssignmentResponseSchema.parse(assigned.json())).toEqual({
        effectiveAfter: "next_oidc_sign_in",
        fallbackPrecedence: "lowest",
        mappingId: "mapping-assignment-1",
        priority: 0,
        revokedSessions: 2,
        role: "operator",
      });
      expect(assigned.body).not.toContain("immutable-target-subject");
      expect(assigned.body).not.toContain("id.example.test");
      expect(
        app.database.sqlite
          .prepare("select role, role_source from users where id = ?")
          .get("oidc-target"),
      ).toEqual({ role: "viewer", role_source: "default" });
      expect(
        app.database.sqlite
          .prepare(
            "select provider_id, claim_path_json, operator, values_json, priority, enabled, role from role_mappings",
          )
          .get(),
      ).toEqual({
        claim_path_json: '["sub"]',
        enabled: 1,
        operator: "equals",
        priority: 0,
        provider_id: "oidc-home",
        role: "operator",
        values_json: '["immutable-target-subject"]',
      });
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((session) => session.id === targetSession.principal.sessionId)?.revokedAt,
      ).toEqual(now);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((session) => session.id === peerSession.principal.sessionId)?.revokedAt,
      ).toEqual(now);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((session) => session.id === viewer.principal.sessionId)?.revokedAt,
      ).toBeNull();
      const audit = app.database.sqlite
        .prepare(
          "select metadata_json as metadata from audit_events where event_type = 'auth.oidc.role_mapping.created'",
        )
        .get() as { metadata: string };
      expect(audit.metadata).not.toContain("immutable-target-subject");
      expect(audit.metadata).not.toContain("id.example.test");

      const listed = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}` },
        method: "GET",
        url: "/v1/admin/auth/oidc/providers/oidc-home/role-mappings",
      });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(oidcRoleMappingsAdminResponseSchema.parse(listed.json())).toMatchObject({
        mappings: [
          {
            claimPath: ["sub"],
            values: [],
            valuesRedacted: true,
          },
        ],
      });
      expect(listed.body).not.toContain("immutable-target-subject");

      const duplicateSession = app.sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "oidc-target-identity",
          oidcProviderId: "oidc-home",
          userId: "oidc-target",
        },
      });
      const duplicate = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url,
      });
      expect(duplicate.statusCode, duplicate.body).toBe(409);
      expect(duplicate.json()).toMatchObject({ error: { code: "oidc_role_mapping_conflict" } });
      expect(app.database.db.select().from(roleMappings).all()).toHaveLength(1);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((session) => session.id === duplicateSession.principal.sessionId)?.revokedAt,
      ).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("rejects self, stale, missing, multiple, and invalid OIDC identities", async () => {
    const { admin, app, recovery, viewer } = await harness();
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
      const url = "/v1/admin/users/direct-user/oidc-role-assignment";
      const missing = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url,
      });
      expect(missing.statusCode).toBe(409);
      expect(missing.json()).toMatchObject({ error: { code: "oidc_identity_unavailable" } });

      insertOidcUser(app, { subject: "multiple-first", userId: "multiple-user" });
      app.database.db
        .insert(externalIdentities)
        .values({
          createdAt: now,
          displayClaimsJson: "{}",
          id: "multiple-second-identity",
          issuer: "https://id.example.test/application/o/omnifin/",
          lastLoginAt: now,
          providerId: "oidc-home",
          subject: "multiple-second",
          updatedAt: now,
          userId: "multiple-user",
        })
        .run();
      const multiple = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url: "/v1/admin/users/multiple-user/oidc-role-assignment",
      });
      expect(multiple.statusCode).toBe(409);
      expect(multiple.json()).toMatchObject({ error: { code: "oidc_identity_unavailable" } });

      app.database.db
        .insert(users)
        .values({
          createdAt: now,
          displayName: "Invalid identity",
          id: "invalid-identity-user",
          role: "viewer",
          roleSource: "default",
          status: "active",
          updatedAt: now,
        })
        .run();
      app.database.db
        .insert(externalIdentities)
        .values({
          createdAt: now,
          displayClaimsJson: "{}",
          id: "invalid-identity",
          issuer: "https://id.example.test/application/o/omnifin/",
          lastLoginAt: now,
          providerId: "oidc-home",
          subject: "",
          updatedAt: now,
          userId: "invalid-identity-user",
        })
        .run();
      const invalid = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url: "/v1/admin/users/invalid-identity-user/oidc-role-assignment",
      });
      expect(invalid.statusCode).toBe(409);
      expect(invalid.json()).toMatchObject({ error: { code: "oidc_identity_unavailable" } });

      insertLinkedUser(app, {
        displayName: "Manual OIDC user",
        role: "viewer",
        roleSource: "manual",
        userId: "manual-oidc-user",
      });
      app.database.db
        .insert(externalIdentities)
        .values({
          createdAt: now,
          displayClaimsJson: "{}",
          id: "manual-oidc-identity",
          issuer: "https://id.example.test/application/o/omnifin/",
          lastLoginAt: now,
          providerId: "oidc-home",
          subject: "manual-oidc-subject",
          updatedAt: now,
          userId: "manual-oidc-user",
        })
        .run();
      const manual = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url: "/v1/admin/users/manual-oidc-user/oidc-role-assignment",
      });
      expect(manual.statusCode).toBe(409);
      expect(manual.json()).toMatchObject({ error: { code: "oidc_role_assignment_unavailable" } });

      insertOidcUser(app, { subject: "valid-subject", userId: "stale-user" });
      const stale = await app.inject({
        body: { expectedUpdatedAt: "2026-07-29T00:00:00.000Z", role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url: "/v1/admin/users/stale-user/oidc-role-assignment",
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: "user_access_revision_conflict" } });

      const self = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url: "/v1/admin/users/admin-user/oidc-role-assignment",
      });
      expect(self.statusCode).toBe(409);
      expect(self.json()).toMatchObject({ error: { code: "user_access_self_mutation" } });

      const ordinary = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(viewer),
        method: "POST",
        url: "/v1/admin/users/stale-user/oidc-role-assignment",
      });
      expect(ordinary.statusCode).toBe(403);
      const recoveryResponse = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(recovery),
        method: "POST",
        url: "/v1/admin/users/stale-user/oidc-role-assignment",
      });
      expect(recoveryResponse.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rolls back assignment, revocation, and audit when mapping audit fails", async () => {
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
      insertOidcUser(app, { subject: "rollback-subject", userId: "rollback-user" });
      const targetSession = app.sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "rollback-user-identity",
          oidcProviderId: "oidc-home",
          userId: "rollback-user",
        },
      });
      app.database.sqlite.exec(`
        create trigger reject_oidc_role_mapping_audit
        before insert on audit_events
        when new.event_type = 'auth.oidc.role_mapping.created'
        begin
          select raise(abort, 'forced_oidc_role_mapping_audit_failure');
        end
      `);
      const response = await app.inject({
        body: { expectedUpdatedAt: now.toISOString(), role: "operator" },
        headers: mutationHeaders(admin),
        method: "POST",
        url: "/v1/admin/users/rollback-user/oidc-role-assignment",
      });
      expect(response.statusCode).toBe(503);
      expect(app.database.db.select().from(roleMappings).all()).toEqual([]);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((session) => session.id === targetSession.principal.sessionId)?.revokedAt,
      ).toBeNull();
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.oidc.role_mapping.created'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });
});
