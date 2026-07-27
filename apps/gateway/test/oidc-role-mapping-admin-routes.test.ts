import {
  oidcRoleMappingDeleteResponseSchema,
  oidcRoleMappingMutationResponseSchema,
  oidcRoleMappingsAdminResponseSchema,
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
const now = new Date("2026-07-26T20:00:00.000Z");
const providerId = "oidc-home";

const mappingRequest = {
  claimPath: ["groups"],
  enabled: true,
  operator: "contains_any",
  priority: 500,
  role: "operator",
  values: ["media-operators", 7, true],
} as const;

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 73),
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
    clock: () => new Date(now),
    createId: () => `mapping-session-${(identifier += 1)}`,
    createToken: () => Buffer.alloc(32, (token += 1) % 255).toString("base64url"),
  };
}

function mappingDependencies() {
  let identifier = 0;
  return {
    clock: () => new Date(now),
    createId: () => `role-${(identifier += 1)}`,
  };
}

async function harness() {
  const app = await createApp({
    config: testConfig(),
    oidcRoleMappingAdminDependencies: mappingDependencies(),
    sessionDependencies: sessionDependencies(),
  });
  app.database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(["https://id.example.test"]),
      clientId: "omnifin",
      createdAt: now,
      displayName: "Home identity",
      enabled: true,
      id: providerId,
      issuer: "https://id.example.test/application/o/omnifin/",
      slug: "home",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: now,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Operator",
      id: "operator-user",
      role: "operator",
      roleSource: "oidc_mapping",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(externalIdentities)
    .values({
      createdAt: now,
      displayClaimsJson: JSON.stringify({ displayName: "Operator" }),
      id: "operator-identity",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: now,
      providerId,
      subject: "immutable-operator-subject",
      updatedAt: now,
      userId: "operator-user",
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: now,
      deviceId: "operator-device",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Operator",
      externalServerId: "jellyfin-server",
      externalUserId: "jellyfin-operator",
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
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Administrator",
      id: "admin-user",
      role: "admin",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: now,
      deviceId: "admin-device",
      encryptedAccessToken: "v2.fixture-admin-access-token",
      externalDisplayName: "Administrator",
      externalServerId: "jellyfin-server",
      externalUserId: "jellyfin-admin",
      externalUsername: "administrator",
      healthState: "linked",
      id: "admin-link",
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "admin-user",
    })
    .run();
  const recovery = app.sessionService.createSession({
    attribution: { authMethod: "recovery" },
  });
  const admin = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "admin-link",
      userId: "admin-user",
    },
  });
  const createAffectedSession = () =>
    app.sessionService.createSession({
      attribution: {
        authMethod: "oidc",
        externalIdentityId: "operator-identity",
        oidcProviderId: providerId,
        serviceIdentityLinkId: "operator-link",
        userId: "operator-user",
      },
    });
  return { admin, app, createAffectedSession, recovery };
}

function authenticatedHeaders(session: Awaited<ReturnType<typeof harness>>["recovery"]) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    origin: baseUrl,
    [SESSION_CSRF_HEADER]: session.csrfToken,
    "user-agent": "role mapping administration test",
    "x-request-id": "mappingreq-001",
  };
}

describe("OIDC role mapping administration routes", () => {
  it("creates, lists, and deletes mappings while atomically revoking affected authority", async () => {
    const { admin, app, createAffectedSession, recovery } = await harness();
    try {
      const affected = createAffectedSession();
      const forbidden = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${affected.sessionToken}` },
        method: "GET",
        url: `/v1/admin/auth/oidc/providers/${providerId}/role-mappings`,
      });
      expect(forbidden.statusCode).toBe(403);

      const permitted = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}` },
        method: "GET",
        url: `/v1/admin/auth/oidc/providers/${providerId}/role-mappings`,
      });
      expect(permitted.statusCode).toBe(200);

      const created = await app.inject({
        body: mappingRequest,
        headers: authenticatedHeaders(admin),
        method: "POST",
        url: `/v1/admin/auth/oidc/providers/${providerId}/role-mappings`,
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const creation = oidcRoleMappingMutationResponseSchema.parse(created.json());
      expect(creation).toMatchObject({
        mapping: {
          claimPath: ["groups"],
          enabled: true,
          id: "mapping-role-1",
          operator: "contains_any",
          priority: 500,
          providerId,
          role: "operator",
        },
        revokedSessions: 1,
      });
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((row) => row.id === affected.principal.sessionId)?.revokedAt,
      ).toEqual(now);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((row) => row.id === recovery.principal.sessionId)?.revokedAt,
      ).toBeNull();
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((row) => row.id === admin.principal.sessionId)?.revokedAt,
      ).toBeNull();

      const listed = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
        method: "GET",
        url: `/v1/admin/auth/oidc/providers/${providerId}/role-mappings`,
      });
      expect(listed.statusCode).toBe(200);
      expect(oidcRoleMappingsAdminResponseSchema.parse(listed.json())).toEqual({
        mappings: [creation.mapping],
      });

      const affectedAfterCreate = createAffectedSession();
      const deleted = await app.inject({
        headers: authenticatedHeaders(admin),
        method: "DELETE",
        url: `/v1/admin/auth/oidc/providers/${providerId}/role-mappings/${creation.mapping.id}`,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(oidcRoleMappingDeleteResponseSchema.parse(deleted.json())).toEqual({
        deletedMappingId: creation.mapping.id,
        revokedSessions: 1,
      });
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((row) => row.id === affectedAfterCreate.principal.sessionId)?.revokedAt,
      ).toEqual(now);
      expect(app.database.db.select().from(roleMappings).all()).toEqual([]);

      const audits = app.database.sqlite
        .prepare(
          `select event_type as eventType, outcome, metadata_json as metadataJson
           from audit_events
           where event_type in (
             'auth.oidc.role_mapping.created',
             'auth.oidc.role_mapping.deleted'
           )
           order by created_at, id`,
        )
        .all() as Array<{ eventType: string; metadataJson: string; outcome: string }>;
      expect(
        audits.map((audit) => ({
          eventType: audit.eventType,
          metadata: JSON.parse(audit.metadataJson),
          outcome: audit.outcome,
        })),
      ).toEqual([
        {
          eventType: "auth.oidc.role_mapping.created",
          metadata: {
            enabled: true,
            operator: "contains_any",
            priority: 500,
            providerId,
            revokedSessions: 1,
            role: "operator",
          },
          outcome: "success",
        },
        {
          eventType: "auth.oidc.role_mapping.deleted",
          metadata: {
            enabled: true,
            operator: "contains_any",
            priority: 500,
            providerId,
            revokedSessions: 1,
            role: "operator",
          },
          outcome: "success",
        },
      ]);
      expect(JSON.stringify(audits)).not.toContain("media-operators");
      expect(JSON.stringify(audits)).not.toContain("claimPath");
    } finally {
      await app.close();
    }
  });

  it("requires CSRF and rejects equivalent or missing mapping targets without extra writes", async () => {
    const { app, recovery } = await harness();
    try {
      const url = `/v1/admin/auth/oidc/providers/${providerId}/role-mappings`;
      const missingCsrf = await app.inject({
        body: mappingRequest,
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}`,
          origin: baseUrl,
        },
        method: "POST",
        url,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(app.database.db.select().from(roleMappings).all()).toEqual([]);

      const first = await app.inject({
        body: mappingRequest,
        headers: authenticatedHeaders(recovery),
        method: "POST",
        url,
      });
      expect(first.statusCode).toBe(201);
      const duplicate = await app.inject({
        body: { ...mappingRequest, values: [true, "media-operators", 7] },
        headers: authenticatedHeaders(recovery),
        method: "POST",
        url,
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        error: { code: "oidc_role_mapping_conflict" },
      });
      expect(app.database.db.select().from(roleMappings).all()).toHaveLength(1);

      const missing = await app.inject({
        headers: authenticatedHeaders(recovery),
        method: "DELETE",
        url: `${url}/mapping-missing`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: { code: "oidc_role_mapping_not_found" },
      });
      expect(app.database.db.select().from(roleMappings).all()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
