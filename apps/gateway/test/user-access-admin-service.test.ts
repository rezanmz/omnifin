import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";

import { SessionService } from "../src/auth/session-service.js";
import { UserAccessAdminService } from "../src/auth/user-access-admin-service.js";
import type { UserAccessAdminError } from "../src/auth/user-access-admin-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  users,
} from "../src/db/schema.js";

const now = new Date("2026-07-30T01:00:00.000Z");
const baseUrl = "https://omnifin.example";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 91),
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

function insertJellyfinIdentity(
  database: DatabaseHandle,
  input: {
    displayName: string;
    role: "admin" | "requester" | "viewer";
    status?: "active" | "disabled" | "pending_link";
    userId: string;
  },
) {
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: input.displayName,
      id: input.userId,
      role: input.role,
      roleSource: input.role === "viewer" ? "default" : "manual",
      status: input.status ?? "active",
      updatedAt: now,
    })
    .run();
  database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-main",
      createdAt: now,
      deviceId: `${input.userId}-device`,
      encryptedAccessToken: `v2.${input.userId}-token`,
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

function createHarness() {
  const config = testConfig();
  const database = openDatabase(config.databaseUrl);
  database.migrate();
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: now,
      displayName: "Jellyfin",
      encryptedCredentials: "v2.connector-token",
      healthState: "healthy",
      id: "jellyfin-main",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  insertJellyfinIdentity(database, {
    displayName: "Administrator",
    role: "admin",
    userId: "admin-user",
  });
  insertJellyfinIdentity(database, {
    displayName: "Morgan",
    role: "viewer",
    userId: "direct-user",
  });
  let sessionId = 0;
  let token = 0;
  const sessions = new SessionService(database, config, {
    clock: () => new Date(now),
    createId: () => `access-session-${++sessionId}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  });
  const admin = sessions.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "admin-user-link",
      userId: "admin-user",
    },
  });
  const directSession = () =>
    sessions.createSession({
      attribution: {
        authMethod: "jellyfin",
        serviceIdentityLinkId: "direct-user-link",
        userId: "direct-user",
      },
    });
  let auditId = 0;
  const service = new UserAccessAdminService(database, config, {
    clock: () => new Date(now),
    createId: () => `access-${++auditId}`,
  });
  const context = {
    ipAddress: "203.0.113.80",
    principal: admin.principal,
    requestId: "user-access-request-001",
  };
  return { admin, config, context, database, directSession, service };
}

function expectedRevision() {
  return now.toISOString();
}

describe("user access administration service", () => {
  it("lists only normalized identity and activity summaries", () => {
    const { database, directSession, service } = createHarness();
    try {
      directSession();
      const page = service.list({});
      expect(page).toMatchObject({ nextCursor: null });
      expect(page.users).toHaveLength(2);
      expect(page.users.find((user) => user.id === "direct-user")).toMatchObject({
        activeSessions: 1,
        authenticationMethods: ["jellyfin"],
        jellyfinLinkHealth: "linked",
        lastActiveAt: now.toISOString(),
        role: "viewer",
        status: "active",
      });
      expect(JSON.stringify(page)).not.toContain("external-user");
      expect(JSON.stringify(page)).not.toContain("connector-token");
    } finally {
      database.close();
    }
  });

  it("paginates deterministically with a bounded user cursor", () => {
    const { database, service } = createHarness();
    try {
      for (let index = 0; index < 51; index += 1) {
        database.db
          .insert(users)
          .values({
            createdAt: new Date(now.getTime() + index + 1),
            displayName: `Viewer ${index}`,
            id: `viewer-${String(index).padStart(2, "0")}`,
            status: "pending_link",
            updatedAt: new Date(now.getTime() + index + 1),
          })
          .run();
      }
      const first = service.list({});
      expect(first.users).toHaveLength(50);
      expect(first.nextCursor).toBe(first.users.at(-1)?.id);
      const second = service.list({ cursor: first.nextCursor! });
      expect(second.users).toHaveLength(3);
      expect(second.nextCursor).toBeNull();
      expect(() => service.list({ cursor: "missing-user" })).toThrow(
        expect.objectContaining<Partial<UserAccessAdminError>>({ reason: "cursor_invalid" }),
      );
    } finally {
      database.close();
    }
  });

  it("changes a Jellyfin-only role, revokes sessions, and audits atomically", () => {
    const { context, database, directSession, service } = createHarness();
    try {
      directSession();
      directSession();
      const result = service.update(
        "direct-user",
        { expectedUpdatedAt: expectedRevision(), role: "operator" },
        context,
      );
      expect(result).toMatchObject({
        revokedSessions: 2,
        user: { activeSessions: 0, role: "operator", roleSource: "manual" },
      });
      const audit = database.sqlite
        .prepare(
          `select event_type as eventType, target_id as targetId, metadata_json as metadata,
                  ip_hash as ipHash
           from audit_events where event_type = 'auth.user.access_updated'`,
        )
        .get() as { eventType: string; ipHash: string; metadata: string; targetId: string };
      expect(audit).toMatchObject({
        eventType: "auth.user.access_updated",
        targetId: "direct-user",
      });
      expect(JSON.parse(audit.metadata)).toEqual({
        newRole: "operator",
        newStatus: "active",
        previousRole: "viewer",
        previousStatus: "active",
        revokedSessions: 2,
      });
      expect(audit.ipHash).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    } finally {
      database.close();
    }
  });

  it("disables and safely re-enables accounts from current link state", () => {
    const { context, database, service } = createHarness();
    try {
      const disabled = service.update(
        "direct-user",
        { enabled: false, expectedUpdatedAt: expectedRevision() },
        context,
      );
      expect(disabled.user.status).toBe("disabled");
      database.sqlite
        .prepare(
          `update service_identity_links
           set health_state = 'revoked', encrypted_access_token = null,
               token_created_at = null, revoked_at = ?, updated_at = ?
           where id = 'direct-user-link'`,
        )
        .run(now.getTime() + 2, now.getTime() + 2);
      const enabled = service.update(
        "direct-user",
        { enabled: true, expectedUpdatedAt: disabled.user.updatedAt },
        context,
      );
      expect(enabled.user).toMatchObject({
        jellyfinLinkHealth: "revoked",
        status: "pending_link",
      });
    } finally {
      database.close();
    }
  });

  it("keeps OIDC authority mapped by the provider", () => {
    const { context, database, service } = createHarness();
    try {
      database.db
        .insert(oidcProviders)
        .values({
          clientId: "omnifin",
          createdAt: now,
          displayName: "Authentik",
          id: "oidc-main",
          issuer: "https://id.example.test/application/o/omnifin/",
          slug: "authentik",
          updatedAt: now,
        })
        .run();
      database.db
        .insert(externalIdentities)
        .values({
          createdAt: now,
          id: "oidc-direct-user",
          issuer: "https://id.example.test/application/o/omnifin/",
          lastLoginAt: now,
          providerId: "oidc-main",
          subject: "immutable-subject",
          updatedAt: now,
          userId: "direct-user",
        })
        .run();
      expect(() =>
        service.update(
          "direct-user",
          { expectedUpdatedAt: expectedRevision(), role: "admin" },
          context,
        ),
      ).toThrow(
        expect.objectContaining<Partial<UserAccessAdminError>>({
          reason: "role_managed_by_provider",
        }),
      );
      expect(
        database.sqlite.prepare("select role from users where id = 'direct-user'").get(),
      ).toEqual({ role: "viewer" });
    } finally {
      database.close();
    }
  });

  it("rejects self-mutation, stale writes, missing permissions, and no-op writes", () => {
    const { context, database, service } = createHarness();
    try {
      expect(() =>
        service.update(
          "admin-user",
          { enabled: false, expectedUpdatedAt: expectedRevision() },
          context,
        ),
      ).toThrow(
        expect.objectContaining<Partial<UserAccessAdminError>>({ reason: "self_mutation" }),
      );
      expect(() =>
        service.update(
          "direct-user",
          { expectedUpdatedAt: "2026-07-29T00:00:00.000Z", role: "operator" },
          context,
        ),
      ).toThrow(
        expect.objectContaining<Partial<UserAccessAdminError>>({ reason: "stale_revision" }),
      );
      expect(() =>
        service.update(
          "direct-user",
          { expectedUpdatedAt: expectedRevision(), role: "operator" },
          {
            ...context,
            principal: {
              ...context.principal,
              permissions: [...ROLE_PERMISSIONS.viewer],
              role: "viewer",
            },
          },
        ),
      ).toThrow(
        expect.objectContaining<Partial<UserAccessAdminError>>({ reason: "permission_denied" }),
      );
      expect(() =>
        service.update(
          "direct-user",
          { enabled: true, expectedUpdatedAt: expectedRevision() },
          context,
        ),
      ).toThrow(expect.objectContaining<Partial<UserAccessAdminError>>({ reason: "no_effect" }));
    } finally {
      database.close();
    }
  });

  it("refuses to remove the final active administrator", () => {
    const { context, database, service } = createHarness();
    try {
      insertJellyfinIdentity(database, {
        displayName: "Second administrator",
        role: "admin",
        userId: "second-admin",
      });
      const secondContext = {
        ...context,
        principal: {
          ...context.principal,
          displayName: "Second administrator",
          sessionId: "second-admin-session",
          userId: "second-admin",
        },
      };
      database.sqlite
        .prepare(
          `insert into sessions (
            id, token_hash, user_id, auth_method, service_identity_link_id,
            csrf_token_hash, encrypted_csrf_token, last_rotated_at, last_seen_at,
            expires_at, absolute_expires_at, created_at
          ) values (?, ?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          secondContext.principal.sessionId,
          Buffer.alloc(32, 51).toString("base64url"),
          "second-admin",
          "second-admin-link",
          Buffer.alloc(32, 52).toString("base64url"),
          "v2.encrypted-csrf",
          now.getTime(),
          now.getTime(),
          now.getTime() + 60_000,
          now.getTime() + 120_000,
          now.getTime(),
        );
      service.update(
        "admin-user",
        { enabled: false, expectedUpdatedAt: expectedRevision() },
        secondContext,
      );
      expect(() =>
        service.update(
          "second-admin",
          { expectedUpdatedAt: expectedRevision(), role: "viewer" },
          context,
        ),
      ).toThrow(
        expect.objectContaining<Partial<UserAccessAdminError>>({ reason: "last_active_admin" }),
      );
    } finally {
      database.close();
    }
  });
});
