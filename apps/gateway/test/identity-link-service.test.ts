import { describe, expect, it } from "vitest";

import { IdentityLinkService } from "../src/auth/identity-link-service.js";
import type { IdentityLinkServiceError } from "../src/auth/identity-link-service.js";
import { SessionService } from "../src/auth/session-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  sessions,
  users,
} from "../src/db/schema.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const EARLIER = new Date("2026-07-25T12:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
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
      inactivityTtlMs: 12 * 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 15 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

function seedIdentity(handle: DatabaseHandle) {
  handle.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: EARLIER,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: EARLIER,
    })
    .run();
  handle.db
    .insert(users)
    .values({
      createdAt: EARLIER,
      displayName: "Riley",
      id: "user-1",
      role: "requester",
      roleSource: "oidc_mapping",
      status: "active",
      updatedAt: EARLIER,
    })
    .run();
  handle.db
    .insert(oidcProviders)
    .values({
      clientId: "omnifin",
      displayName: "Home identity",
      enabled: true,
      id: "oidc-home",
      issuer: "https://id.example.test/application/o/omnifin/",
      slug: "home",
    })
    .run();
  handle.db
    .insert(externalIdentities)
    .values({
      createdAt: EARLIER,
      displayClaimsJson: JSON.stringify({ displayName: "Riley" }),
      id: "oidc-identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: EARLIER,
      providerId: "oidc-home",
      subject: "immutable-oidc-subject",
      updatedAt: EARLIER,
      userId: "user-1",
    })
    .run();
  handle.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: EARLIER,
      deviceId: "jellyfin-device-1",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Riley",
      externalServerId: "jellyfin-server-1",
      externalUserId: "jellyfin-user-1",
      externalUsername: "riley",
      healthState: "linked",
      id: "jellyfin-link-1",
      lastVerifiedAt: EARLIER,
      service: "jellyfin",
      tokenCreatedAt: EARLIER,
      updatedAt: EARLIER,
      userId: "user-1",
    })
    .run();
}

function fixture() {
  const handle = openDatabase(":memory:");
  handle.migrate();
  seedIdentity(handle);
  let sessionId = 0;
  let token = 0;
  const sessionsService = new SessionService(handle, config(), {
    clock: () => new Date(NOW),
    createId: () => `identity-session-${(sessionId += 1)}`,
    createToken: () => Buffer.alloc(32, (token += 1)).toString("base64url"),
  });
  const links = new IdentityLinkService(handle, config(), sessionsService, {
    clock: () => new Date(NOW),
    createId: () => "identity-link-audit-1",
  });
  return { handle, links, sessionsService };
}

function oidcSession(service: SessionService) {
  return service.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "oidc-identity-1",
      oidcProviderId: "oidc-home",
      serviceIdentityLinkId: "jellyfin-link-1",
      userId: "user-1",
    },
  });
}

describe("IdentityLinkService", () => {
  it("returns only normalized self-service link status", () => {
    const test = fixture();
    try {
      const issued = oidcSession(test.sessionsService);

      expect(test.links.listForPrincipal(issued.principal)).toEqual([
        {
          displayName: "Riley",
          externalUserId: "jellyfin-user-1",
          health: "linked",
          id: "jellyfin-link-1",
          lastVerifiedAt: EARLIER.toISOString(),
          linkedAt: EARLIER.toISOString(),
          service: "jellyfin",
          username: "riley",
        },
      ]);
    } finally {
      test.handle.close();
    }
  });

  it("erases the token, reduces the OIDC session, and revokes every sibling session atomically", () => {
    const test = fixture();
    try {
      const current = oidcSession(test.sessionsService);
      const oidcSibling = oidcSession(test.sessionsService);
      const directSibling = test.sessionsService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      const validated = test.sessionsService.validateSessionCsrf(
        current.sessionToken,
        current.csrfToken,
      );

      const result = test.links.revoke({
        ipAddress: "192.0.2.31",
        linkId: "jellyfin-link-1",
        requestId: "request-link-revoke-1",
        validatedSession: validated,
      });

      expect(result).toMatchObject({
        link: { health: "revoked", id: "jellyfin-link-1" },
        principal: {
          accountState: "pending_link",
          authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
          linkedServices: [],
          userId: "user-1",
        },
        revokedSessionCount: 2,
      });
      expect(() => JSON.stringify(result)).toThrow(/cannot be serialized/i);
      expect(test.handle.db.select().from(users).get()).toMatchObject({
        id: "user-1",
        status: "pending_link",
      });
      expect(test.handle.db.select().from(serviceIdentityLinks).get()).toMatchObject({
        encryptedAccessToken: null,
        healthState: "revoked",
        revision: 1,
        revokedAt: NOW,
        tokenCreatedAt: null,
      });
      expect(test.sessionsService.resolveAndRefresh(current.sessionToken)).toMatchObject({
        principal: { accountState: "pending_link", linkedServices: [] },
      });
      expect(test.sessionsService.resolveAndRefresh(oidcSibling.sessionToken)).toBeNull();
      expect(test.sessionsService.resolveAndRefresh(directSibling.sessionToken)).toBeNull();
      expect(
        test.handle.db
          .select()
          .from(sessions)
          .all()
          .find(({ id }) => id === current.principal.sessionId),
      ).toMatchObject({ serviceIdentityLinkId: null, revokedAt: null });
      expect(
        test.handle.sqlite
          .prepare(
            `select
              actor_user_id as actorUserId,
              actor_session_id as actorSessionId,
              actor_auth_method as actorAuthMethod,
              target_id as targetId,
              request_id as requestId,
              metadata_json as metadataJson,
              ip_hash as ipHash
             from audit_events
             where event_type = 'auth.jellyfin.identity.revoked'`,
          )
          .get(),
      ).toEqual({
        actorAuthMethod: "oidc",
        actorSessionId: current.principal.sessionId,
        actorUserId: "user-1",
        ipHash: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        metadataJson: JSON.stringify({ currentSessionRetained: true, revokedSessionCount: 2 }),
        requestId: "request-link-revoke-1",
        targetId: "jellyfin-link-1",
      });

      const repeated = test.links.revoke({
        linkId: "jellyfin-link-1",
        validatedSession: validated,
      });
      expect(repeated).toMatchObject({
        link: { health: "revoked" },
        revokedSessionCount: 0,
      });
      expect(
        test.handle.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.jellyfin.identity.revoked'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      test.handle.close();
    }
  });

  it("revokes the current direct Jellyfin session because it cannot become a pending OIDC session", () => {
    const test = fixture();
    try {
      const direct = test.sessionsService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      const validated = test.sessionsService.validateSessionCsrf(
        direct.sessionToken,
        direct.csrfToken,
      );

      const result = test.links.revoke({
        linkId: "jellyfin-link-1",
        validatedSession: validated,
      });

      expect(result).toMatchObject({ principal: null, revokedSessionCount: 1 });
      expect(test.sessionsService.resolveAndRefresh(direct.sessionToken)).toBeNull();
    } finally {
      test.handle.close();
    }
  });

  it("rejects a different link identifier without mutating identity or session state", () => {
    const test = fixture();
    try {
      const current = oidcSession(test.sessionsService);
      const validated = test.sessionsService.validateSessionCsrf(
        current.sessionToken,
        current.csrfToken,
      );

      expect(() =>
        test.links.revoke({ linkId: "another-link", validatedSession: validated }),
      ).toThrowError(
        expect.objectContaining<Partial<IdentityLinkServiceError>>({
          reason: "identity_link_not_found",
        }),
      );
      expect(test.handle.db.select().from(serviceIdentityLinks).get()).toMatchObject({
        encryptedAccessToken: "v2.fixture-access-token",
        healthState: "linked",
        revision: 0,
      });
      expect(test.sessionsService.resolveAndRefresh(current.sessionToken)).not.toBeNull();
    } finally {
      test.handle.close();
    }
  });
});
