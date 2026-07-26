import { describe, expect, it } from "vitest";
import { SessionService } from "../src/auth/session-service.js";
import {
  OidcFrontchannelLogoutError,
  OidcFrontchannelLogoutService,
} from "../src/auth/oidc/frontchannel-logout.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { externalIdentities, oidcProviders, users } from "../src/db/schema.js";

const providerId = "oidc-home";
const issuer = "https://identity.example.test/application/o/omnifin/";
const now = new Date("2026-07-26T19:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 89),
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

function seedIdentity(
  database: DatabaseHandle,
  input: {
    identityId: string;
    issuer?: string;
    providerId?: string;
    subject: string;
    userId: string;
  },
) {
  database.db
    .insert(users)
    .values({
      createdAt: new Date(now.getTime() - 60_000),
      displayName: input.subject,
      id: input.userId,
      status: "active",
      updatedAt: new Date(now.getTime() - 60_000),
    })
    .run();
  database.db
    .insert(externalIdentities)
    .values({
      createdAt: new Date(now.getTime() - 60_000),
      id: input.identityId,
      issuer: input.issuer ?? issuer,
      lastLoginAt: new Date(now.getTime() - 60_000),
      providerId: input.providerId ?? providerId,
      subject: input.subject,
      updatedAt: new Date(now.getTime() - 60_000),
      userId: input.userId,
    })
    .run();
}

function openHarness() {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  database.db
    .insert(oidcProviders)
    .values({
      clientId: "omnifin-client",
      createdAt: new Date(now.getTime() - 60_000),
      displayName: "Home identity",
      id: providerId,
      issuer,
      slug: "home",
      updatedAt: new Date(now.getTime() - 60_000),
    })
    .run();
  database.db
    .insert(oidcProviders)
    .values({
      clientId: "work-client",
      createdAt: new Date(now.getTime() - 60_000),
      displayName: "Work identity",
      id: "oidc-work",
      issuer: "https://work-identity.example.test/",
      slug: "work",
      updatedAt: new Date(now.getTime() - 60_000),
    })
    .run();
  seedIdentity(database, {
    identityId: "identity-riley",
    subject: "immutable-riley",
    userId: "user-riley",
  });
  seedIdentity(database, {
    identityId: "identity-work",
    issuer: "https://work-identity.example.test/",
    providerId: "oidc-work",
    subject: "immutable-work",
    userId: "user-work",
  });
  seedIdentity(database, {
    identityId: "identity-alex",
    subject: "immutable-alex",
    userId: "user-alex",
  });

  const sessions = new SessionService(database, config, { clock: () => new Date(now) });
  const rileyFirst = sessions.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "identity-riley",
      oidcProviderId: providerId,
      oidcSessionId: "upstream-session-riley-first",
      userId: "user-riley",
    },
  });
  const rileySecond = sessions.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "identity-riley",
      oidcProviderId: providerId,
      oidcSessionId: "upstream-session-riley-second",
      userId: "user-riley",
    },
  });
  const alex = sessions.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "identity-alex",
      oidcProviderId: providerId,
      oidcSessionId: "upstream-session-alex",
      userId: "user-alex",
    },
  });
  const work = sessions.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "identity-work",
      oidcProviderId: "oidc-work",
      oidcSessionId: "upstream-session-riley-first",
      userId: "user-work",
    },
  });

  return { alex, config, database, rileyFirst, rileySecond, work };
}

function revoked(database: DatabaseHandle, sessionId: string) {
  return database.sqlite
    .prepare("select revoked_at is not null as revoked from sessions where id = ?")
    .get(sessionId) as { revoked: number };
}

function totalChanges(database: DatabaseHandle) {
  return (
    database.sqlite.prepare("select total_changes() as totalChanges").get() as {
      totalChanges: number;
    }
  ).totalChanges;
}

describe("OIDC front-channel logout", () => {
  it("revokes only the provider session identified by the exact issuer and sid", () => {
    const { alex, config, database, rileyFirst, rileySecond, work } = openHarness();
    const service = new OidcFrontchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => "audit-frontchannel-1",
    });

    try {
      const result = service.process({
        issuer,
        providerId,
        requestId: "frontchannel-request-1",
        sessionId: "upstream-session-riley-first",
      });

      expect(result).toEqual({
        disposition: "accepted",
        frameAncestorOrigin: "https://identity.example.test",
        revokedSessionCount: 1,
      });
      expect(revoked(database, rileyFirst.principal.sessionId)).toEqual({ revoked: 1 });
      expect(revoked(database, rileySecond.principal.sessionId)).toEqual({ revoked: 0 });
      expect(revoked(database, alex.principal.sessionId)).toEqual({ revoked: 0 });
      expect(revoked(database, work.principal.sessionId)).toEqual({ revoked: 0 });
      expect(
        database.sqlite
          .prepare(
            `select event_type as eventType, outcome, target_id as targetId,
                    request_id as requestId, metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.oidc.frontchannel_logout'`,
          )
          .get(),
      ).toEqual({
        eventType: "auth.oidc.frontchannel_logout",
        metadataJson:
          '{"reason":"provider_initiated_logout","scope":"session","revokedSessionCount":1}',
        outcome: "success",
        requestId: "frontchannel-request-1",
        targetId: providerId,
      });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(
        "upstream-session-riley-first",
      );
    } finally {
      database.close();
    }
  });

  it("acknowledges a repeated valid request without another audit write", () => {
    const { config, database } = openHarness();
    let auditId = 0;
    const service = new OidcFrontchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => `audit-frontchannel-${(auditId += 1)}`,
    });
    const request = {
      issuer,
      providerId,
      requestId: "frontchannel-request-replay",
      sessionId: "upstream-session-riley-first",
    };

    try {
      expect(service.process(request).disposition).toBe("accepted");
      const changesAfterFirstRequest = totalChanges(database);

      expect(service.process(request)).toEqual({
        disposition: "replayed",
        frameAncestorOrigin: "https://identity.example.test",
        revokedSessionCount: 0,
      });
      expect(totalChanges(database)).toBe(changesAfterFirstRequest);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.oidc.frontchannel_logout'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      input: {
        ...Object.freeze({ issuer, providerId, sessionId: "upstream-session-riley-first" }),
        issuer: `${issuer}mismatch`,
      },
      name: "an issuer mismatch",
    },
    {
      input: {
        issuer,
        providerId: "missing-provider",
        sessionId: "upstream-session-riley-first",
      },
      name: "an unknown provider",
    },
    { input: { issuer, providerId, sessionId: "" }, name: "an empty sid" },
    {
      input: { issuer, providerId, sessionId: "x".repeat(513) },
      name: "an oversized sid",
    },
  ])("rejects $name without mutating sessions or audit history", ({ input }) => {
    const { config, database, rileyFirst } = openHarness();
    const service = new OidcFrontchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => "audit-frontchannel-rejected",
    });
    const changesBefore = totalChanges(database);

    try {
      expect(() => service.process(input)).toThrowError(
        new OidcFrontchannelLogoutError("invalid_logout_request"),
      );
      expect(totalChanges(database)).toBe(changesBefore);
      expect(revoked(database, rileyFirst.principal.sessionId)).toEqual({ revoked: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls session revocation back when the audit record cannot be committed", () => {
    const { config, database, rileyFirst } = openHarness();
    database.sqlite.exec(`
      create trigger reject_frontchannel_logout_audit
      before insert on audit_events
      when new.event_type = 'auth.oidc.frontchannel_logout'
      begin
        select raise(abort, 'frontchannel audit unavailable');
      end;
    `);
    const service = new OidcFrontchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => "audit-frontchannel-rollback",
    });

    try {
      expect(() =>
        service.process({
          issuer,
          providerId,
          requestId: "frontchannel-atomic-request",
          sessionId: "upstream-session-riley-first",
        }),
      ).toThrowError(new OidcFrontchannelLogoutError("logout_storage_failed"));
      expect(revoked(database, rileyFirst.principal.sessionId)).toEqual({ revoked: 0 });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.oidc.frontchannel_logout'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
