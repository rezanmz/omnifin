import { PENDING_LINK_PERMISSIONS } from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";
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
import { SessionService } from "../src/auth/session-service.js";
import { hashToken } from "../src/security/crypto.js";

const initialTime = new Date("2026-07-25T12:00:00.000Z");

function sessionConfig(overrides: Partial<AppConfig["session"]> = {}) {
  return {
    absoluteTtlMs: 60 * 60 * 1_000,
    inactivityTtlMs: 10 * 60 * 1_000,
    recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
    rotationIntervalMs: 5 * 60 * 1_000,
    ...overrides,
  };
}

function createHarness(database: DatabaseHandle, overrides: Partial<AppConfig["session"]> = {}) {
  let now = new Date(initialTime);
  let identifier = 0;
  let token = 0;
  const service = new SessionService(
    database,
    { encryptionKey: Buffer.alloc(32, 9), session: sessionConfig(overrides) },
    {
      clock: () => new Date(now),
      createId: () => `session-fixture-${(identifier += 1)}`,
      createToken: () => Buffer.alloc(32, (token += 1)).toString("base64url"),
    },
  );
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    service,
  };
}

function seedLinkedOidcIdentity(database: DatabaseHandle) {
  database.db
    .insert(users)
    .values({ displayName: "Riley", id: "user-1", role: "requester", status: "active" })
    .run();
  database.db
    .insert(oidcProviders)
    .values({
      clientId: "omnifin",
      displayName: "Home identity",
      id: "oidc-home",
      issuer: "https://id.example.test/application/o/omnifin/",
      slug: "home",
    })
    .run();
  database.db
    .insert(externalIdentities)
    .values({
      displayClaimsJson: JSON.stringify({
        displayName: "Riley",
        email: "riley@example.test",
      }),
      id: "identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: initialTime,
      providerId: "oidc-home",
      subject: "immutable-subject",
      userId: "user-1",
    })
    .run();
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
    })
    .run();
  database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: initialTime,
      deviceId: "device-1",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Riley",
      externalServerId: "server-1",
      externalUserId: "jellyfin-user-1",
      externalUsername: "riley",
      healthState: "linked",
      id: "link-1",
      lastVerifiedAt: initialTime,
      service: "jellyfin",
      tokenCreatedAt: initialTime,
      userId: "user-1",
    })
    .run();
}

function issueOidcSession(service: SessionService) {
  return service.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "identity-1",
      idTokenHint: "private-id-token-hint",
      oidcProviderId: "oidc-home",
      oidcSessionId: "private-upstream-session-id",
      serviceIdentityLinkId: "link-1",
      userId: "user-1",
    },
    ipAddress: "192.0.2.10",
    requestId: "request_creation_123",
    userAgent: "fixture-browser/1.0",
  });
}

describe("SessionService", () => {
  it("persists only hashes and encrypted proofs while resolving complete OIDC attribution", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);

      const issued = issueOidcSession(service);
      const stored = database.db.select().from(sessions).get();

      expect(issued.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
        linkedServices: [{ id: "link-1", service: "jellyfin" }],
        role: "requester",
        userId: "user-1",
      });
      expect(stored).toMatchObject({
        csrfTokenHash: hashToken(issued.csrfToken),
        tokenHash: hashToken(issued.sessionToken),
      });
      const persisted = JSON.stringify(stored);
      expect(persisted).not.toContain(issued.sessionToken);
      expect(persisted).not.toContain(issued.csrfToken);
      expect(persisted).not.toContain("private-id-token-hint");
      expect(persisted).not.toContain("private-upstream-session-id");
      expect(stored?.encryptedCsrfToken).toMatch(/^v2\./);
      expect(stored?.encryptedIdTokenHint).toMatch(/^v2\./);
      expect(stored?.ipHash).toHaveLength(22);
      expect(stored?.userAgentHash).toHaveLength(22);
      const creationAudit = database.sqlite
        .prepare(
          `select
             event_type as eventType,
             metadata_json as metadataJson,
             request_id as requestId,
             ip_hash as ipHash
           from audit_events
           where event_type = 'auth.session.created'`,
        )
        .get();
      expect(creationAudit).toEqual({
        eventType: "auth.session.created",
        ipHash: expect.any(String),
        metadataJson: '{"authenticationMethod":"oidc"}',
        requestId: "request_creation_123",
      });
      expect(JSON.stringify(creationAudit)).not.toContain(issued.sessionToken);
      expect(JSON.stringify(creationAudit)).not.toContain(issued.csrfToken);
    } finally {
      database.close();
    }
  });

  it("caps recovery sessions at fifteen minutes even when configuration is more permissive", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database, {
        inactivityTtlMs: 60 * 60 * 1_000,
        recoveryAbsoluteTtlMs: 4 * 60 * 60 * 1_000,
      });

      const issued = service.createSession({ attribution: { authMethod: "recovery" } });

      expect(issued.principal).toMatchObject({
        accountState: "recovery",
        authenticationMethod: { kind: "recovery" },
        userId: null,
      });
      expect(issued.absoluteExpiresAt.getTime() - initialTime.getTime()).toBe(15 * 60 * 1_000);
      expect(issued.inactivityExpiresAt).toEqual(issued.absoluteExpiresAt);
    } finally {
      database.close();
    }
  });

  it("requires the exact usable Jellyfin identity link for direct sessions", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);

      expect(() =>
        service.createSession({
          attribution: {
            authMethod: "jellyfin",
            serviceIdentityLinkId: "missing-link",
            userId: "user-1",
          },
        }),
      ).toThrow(/foreign key/i);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);

      const issued = service.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });
      expect(issued.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "jellyfin" },
        linkedServices: [{ id: "link-1" }],
      });

      database.db.update(connectorConfigs).set({ enabled: false }).run();
      expect(service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
    } finally {
      database.close();
    }
  });

  it("resolves an OIDC identity without Jellyfin as a pairing-only pending account", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      database.db.delete(serviceIdentityLinks).run();
      database.db.delete(connectorConfigs).run();
      const { service } = createHarness(database);

      const issued = service.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          userId: "user-1",
        },
      });

      expect(issued.principal).toMatchObject({
        accountState: "pending_link",
        linkedServices: [],
        permissions: PENDING_LINK_PERMISSIONS,
      });
    } finally {
      database.close();
    }
  });

  it("rotates bearer hashes atomically, rejects the old token, and caps inactivity at absolute expiry", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const harness = createHarness(database, {
        absoluteTtlMs: 20 * 60 * 1_000,
        inactivityTtlMs: 10 * 60 * 1_000,
      });
      const issued = issueOidcSession(harness.service);
      harness.advance(6 * 60 * 1_000);

      const rotated = harness.service.resolveAndRefresh(issued.sessionToken);

      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");
      expect(rotated?.rotatedSessionToken).not.toBe(issued.sessionToken);
      expect(rotated?.inactivityExpiresAt).toEqual(
        new Date(initialTime.getTime() + 16 * 60 * 1_000),
      );
      expect(harness.service.resolveAndRefresh(issued.sessionToken)).toMatchObject({
        principal: { sessionId: issued.principal.sessionId },
      });
      const storedAfterRotation = database.db.select().from(sessions).get();
      expect(storedAfterRotation?.tokenHash).toBe(hashToken(rotated!.rotatedSessionToken!));
      expect(JSON.stringify(storedAfterRotation)).not.toContain(rotated!.rotatedSessionToken!);

      harness.advance(10_001);
      expect(harness.service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(harness.service.validateSessionCsrf(issued.sessionToken, issued.csrfToken)).toBeNull();

      harness.advance(9 * 60 * 1_000);
      const nearAbsoluteExpiry = harness.service.resolveAndRefresh(rotated!.rotatedSessionToken!);
      expect(nearAbsoluteExpiry?.inactivityExpiresAt).toEqual(
        new Date(initialTime.getTime() + 20 * 60 * 1_000),
      );
    } finally {
      database.close();
    }
  });

  it("fails closed at inactivity expiry and for malformed bearer cookies", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const harness = createHarness(database);
      const issued = harness.service.createSession({ attribution: { authMethod: "recovery" } });

      expect(harness.service.resolveAndRefresh("unbounded-or-malformed")).toBeNull();
      harness.advance(10 * 60 * 1_000);
      expect(harness.service.resolveAndRefresh(issued.sessionToken)).toBeNull();
    } finally {
      database.close();
    }
  });

  it("validates CSRF proofs against both their hash and encrypted value without storing attempts", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });
      const incorrectCsrf = Buffer.alloc(32, 99).toString("base64url");

      expect(service.validateSessionCsrf(issued.sessionToken, issued.csrfToken)).toMatchObject({
        sessionId: issued.principal.sessionId,
      });
      expect(
        service.validateSessionCsrf(issued.sessionToken, incorrectCsrf, {
          ipAddress: "192.0.2.11",
          requestId: "request_fixture_123",
        }),
      ).toBeNull();

      const audit = database.sqlite
        .prepare(
          `select
            event_type as eventType,
            outcome,
            metadata_json as metadataJson,
            request_id as requestId,
            ip_hash as ipHash
           from audit_events
           where event_type = 'auth.session.csrf_denied'`,
        )
        .get();
      expect(audit).toEqual({
        eventType: "auth.session.csrf_denied",
        ipHash: expect.any(String),
        metadataJson: '{"reason":"csrf_mismatch"}',
        outcome: "denied",
        requestId: "request_fixture_123",
      });
      expect(JSON.stringify(audit)).not.toContain(incorrectCsrf);
      expect(JSON.stringify(audit)).not.toContain(issued.csrfToken);
    } finally {
      database.close();
    }
  });

  it("revokes sessions whose encrypted CSRF proof fails integrity verification", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });
      database.sqlite
        .prepare("update sessions set encrypted_csrf_token = ?")
        .run("v2.invalid.invalid.invalid");

      expect(service.validateSessionCsrf(issued.sessionToken, issued.csrfToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
      expect(
        database.sqlite
          .prepare(
            `select event_type as eventType, metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.session.invalidated'`,
          )
          .get(),
      ).toEqual({
        eventType: "auth.session.invalidated",
        metadataJson: '{"reason":"csrf_integrity_failure"}',
      });
    } finally {
      database.close();
    }
  });

  it("revokes a session when joined provider attribution becomes unusable", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const issued = issueOidcSession(service);
      database.db.update(oidcProviders).set({ enabled: false }).run();

      expect(service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
      expect(
        database.sqlite
          .prepare(
            `select metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.session.invalidated'`,
          )
          .get(),
      ).toEqual({ metadataJson: '{"reason":"attribution_invalid"}' });
    } finally {
      database.close();
    }
  });

  it("invalidates recovery records whose persisted absolute lifetime exceeds the hard cap", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });
      database.sqlite
        .prepare("update sessions set expires_at = ?, absolute_expires_at = ?")
        .run(initialTime.getTime() + 30 * 60 * 1_000, initialTime.getTime() + 60 * 60 * 1_000);

      expect(service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
      expect(
        database.sqlite
          .prepare(
            `select metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.session.invalidated'`,
          )
          .get(),
      ).toEqual({ metadataJson: '{"reason":"recovery_ttl_invalid"}' });
    } finally {
      database.close();
    }
  });

  it("audits successful revocation and treats repeated revocation as idempotent", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });

      expect(
        service.revokeSession(issued.sessionToken, {
          ipAddress: "192.0.2.12",
          requestId: "request_logout_123",
        }),
      ).toBe(true);
      expect(service.revokeSession(issued.sessionToken)).toBe(false);
      expect(
        database.sqlite
          .prepare(
            `select
              event_type as eventType,
              outcome,
              actor_session_id as actorSessionId,
              actor_auth_method as actorAuthMethod,
              request_id as requestId,
              metadata_json as metadataJson
             from audit_events`,
          )
          .all(),
      ).toEqual([
        {
          actorAuthMethod: "recovery",
          actorSessionId: issued.principal.sessionId,
          eventType: "auth.session.created",
          metadataJson: '{"authenticationMethod":"recovery"}',
          outcome: "success",
          requestId: null,
        },
        {
          actorAuthMethod: "recovery",
          actorSessionId: issued.principal.sessionId,
          eventType: "auth.session.logout",
          metadataJson: '{"reason":"user_logout"}',
          outcome: "success",
          requestId: "request_logout_123",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("revokes by the stable validated session when a concurrent read rotates the bearer", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const harness = createHarness(database);
      const issued = harness.service.createSession({ attribution: { authMethod: "recovery" } });
      const validated = harness.service.validateSessionCsrf(issued.sessionToken, issued.csrfToken);
      expect(validated).not.toBeNull();
      harness.advance(6 * 60 * 1_000);
      const rotated = harness.service.resolveAndRefresh(issued.sessionToken);
      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");

      expect(harness.service.revokeValidatedSession(validated!)).toBe(true);
      expect(harness.service.resolveAndRefresh(rotated!.rotatedSessionToken!)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(
        new Date(initialTime.getTime() + 6 * 60 * 1_000),
      );
    } finally {
      database.close();
    }
  });

  it("rejects invalid clock and duration seams before they can weaken session policy", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      expect(
        () =>
          new SessionService(database, {
            encryptionKey: Buffer.alloc(32, 9),
            session: sessionConfig({ inactivityTtlMs: 0 }),
          }),
      ).toThrow(/positive integer duration/i);

      const service = new SessionService(
        database,
        { encryptionKey: Buffer.alloc(32, 9), session: sessionConfig() },
        { clock: () => new Date(Number.NaN) },
      );
      expect(() => service.createSession({ attribution: { authMethod: "recovery" } })).toThrow(
        /valid clock value/i,
      );
    } finally {
      database.close();
    }
  });
});
