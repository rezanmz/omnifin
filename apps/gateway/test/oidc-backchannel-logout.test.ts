import { describe, expect, it, vi } from "vitest";
import { SessionService } from "../src/auth/session-service.js";
import {
  OidcBackchannelLogoutService,
  type VerifiedOidcBackchannelLogoutToken,
} from "../src/auth/oidc/backchannel-logout.js";
import { OidcProviderRegistryError } from "../src/auth/oidc/provider-registry.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { externalIdentities, oidcProviders, users } from "../src/db/schema.js";

const providerId = "oidc-home";
const issuer = "https://identity.example.test/application/o/omnifin/";
const now = new Date("2026-07-26T18:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 83),
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
  input: { identityId: string; subject: string; userId: string },
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
      issuer,
      lastLoginAt: new Date(now.getTime() - 60_000),
      providerId,
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
  seedIdentity(database, {
    identityId: "identity-riley",
    subject: "immutable-riley",
    userId: "user-riley",
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

  return { alex, config, database, rileyFirst, rileySecond };
}

function verifiedToken(
  overrides: Partial<VerifiedOidcBackchannelLogoutToken> = {},
): VerifiedOidcBackchannelLogoutToken {
  return {
    expiresAt: new Date(now.getTime() + 5 * 60_000),
    issuedAt: new Date(now.getTime() - 1_000),
    issuer,
    sessionId: "upstream-session-riley-first",
    subject: "immutable-riley",
    tokenId: "logout-token-1",
    ...overrides,
  };
}

function totalChanges(database: DatabaseHandle) {
  return (
    database.sqlite.prepare("select total_changes() as totalChanges").get() as {
      totalChanges: number;
    }
  ).totalChanges;
}

function subjectOnlyVerifiedToken(): VerifiedOidcBackchannelLogoutToken {
  const token = verifiedToken();
  return {
    expiresAt: token.expiresAt,
    issuedAt: token.issuedAt,
    issuer: token.issuer,
    subject: "immutable-riley",
    tokenId: token.tokenId,
  };
}

function sessionOnlyVerifiedToken(): VerifiedOidcBackchannelLogoutToken {
  const token = verifiedToken();
  return {
    expiresAt: token.expiresAt,
    issuedAt: token.issuedAt,
    issuer: token.issuer,
    sessionId: "upstream-session-riley-first",
    tokenId: "logout-token-session-only",
  };
}

describe("OIDC back-channel logout", () => {
  it("revokes only the provider session jointly identified by sid and subject", async () => {
    const { alex, config, database, rileyFirst, rileySecond } = openHarness();
    const privateLogoutToken = "header.private-provider-logout.signature";
    const verifyLogoutToken = vi.fn(async () => verifiedToken());
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => "audit-backchannel-1",
      verifyLogoutToken,
    });

    try {
      const result = await service.process({
        logoutToken: privateLogoutToken,
        providerId,
        requestId: "backchannel-request-1",
      });

      expect(result).toEqual({ disposition: "accepted", revokedSessionCount: 1 });
      expect(verifyLogoutToken).toHaveBeenCalledWith(providerId, privateLogoutToken, new Date(now));
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(rileyFirst.principal.sessionId),
      ).toEqual({ revoked: 1 });
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(rileySecond.principal.sessionId),
      ).toEqual({ revoked: 0 });
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(alex.principal.sessionId),
      ).toEqual({ revoked: 0 });
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 1 });
      expect(
        database.sqlite
          .prepare(
            `select event_type as eventType, outcome, target_id as targetId,
                    request_id as requestId, metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.oidc.backchannel_logout'`,
          )
          .get(),
      ).toEqual({
        eventType: "auth.oidc.backchannel_logout",
        metadataJson:
          '{"reason":"provider_initiated_logout","scope":"session","revokedSessionCount":1}',
        outcome: "success",
        requestId: "backchannel-request-1",
        targetId: providerId,
      });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateLogoutToken);
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(
        "upstream-session-riley-first",
      );
      expect(database.sqlite.serialize().toString("utf8")).not.toContain("logout-token-1");
    } finally {
      database.close();
    }
  });

  it("revokes every provider session for an immutable subject when sid is absent", async () => {
    const { alex, config, database, rileyFirst, rileySecond } = openHarness();
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => "audit-backchannel-subject",
      verifyLogoutToken: async () => subjectOnlyVerifiedToken(),
    });

    try {
      const result = await service.process({
        logoutToken: "header.subject-logout.signature",
        providerId,
        requestId: "backchannel-request-subject",
      });

      expect(result).toEqual({ disposition: "accepted", revokedSessionCount: 2 });
      const states = database.sqlite
        .prepare("select id, revoked_at is not null as revoked from sessions order by id")
        .all() as Array<{ id: string; revoked: number }>;
      expect(states.find(({ id }) => id === rileyFirst.principal.sessionId)?.revoked).toBe(1);
      expect(states.find(({ id }) => id === rileySecond.principal.sessionId)?.revoked).toBe(1);
      expect(states.find(({ id }) => id === alex.principal.sessionId)?.revoked).toBe(0);
      const audit = database.sqlite
        .prepare(
          "select metadata_json as metadataJson from audit_events where event_type = 'auth.oidc.backchannel_logout'",
        )
        .get() as { metadataJson: string };
      expect(JSON.parse(audit.metadataJson)).toEqual({
        reason: "provider_initiated_logout",
        revokedSessionCount: 2,
        scope: "subject",
      });
    } finally {
      database.close();
    }
  });

  it("revokes only the provider-scoped sid when a subject is absent", async () => {
    const { alex, config, database, rileyFirst, rileySecond } = openHarness();
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => "audit-backchannel-session-only",
      verifyLogoutToken: async () => sessionOnlyVerifiedToken(),
    });
    try {
      expect(
        await service.process({
          logoutToken: "header.session-only.signature",
          providerId,
          requestId: "backchannel-session-only",
        }),
      ).toEqual({ disposition: "accepted", revokedSessionCount: 1 });
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(rileyFirst.principal.sessionId),
      ).toEqual({ revoked: 1 });
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(rileySecond.principal.sessionId),
      ).toEqual({ revoked: 0 });
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(alex.principal.sessionId),
      ).toEqual({ revoked: 0 });
    } finally {
      database.close();
    }
  });

  it("acknowledges a verified replay without repeating revocation or audit writes", async () => {
    const { config, database } = openHarness();
    const verifyLogoutToken = vi.fn(async () => verifiedToken());
    let auditId = 0;
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => `audit-backchannel-${(auditId += 1)}`,
      verifyLogoutToken,
    });

    try {
      const request = {
        logoutToken: "header.replayed-logout.signature",
        providerId,
        requestId: "backchannel-request-replay",
      };
      expect(await service.process(request)).toEqual({
        disposition: "accepted",
        revokedSessionCount: 1,
      });
      const changesAfterFirst = totalChanges(database);

      expect(await service.process(request)).toEqual({
        disposition: "replayed",
        revokedSessionCount: 0,
      });
      expect(totalChanges(database)).toBe(changesAfterFirst);
      expect(verifyLogoutToken).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.oidc.backchannel_logout'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["a mismatched issuer", verifiedToken({ issuer: "https://attacker.example/" })],
    [
      "a stale issued-at time",
      verifiedToken({ issuedAt: new Date(now.getTime() - 5 * 60_000 - 1) }),
    ],
    ["an expired token", verifiedToken({ expiresAt: new Date(now) })],
    [
      "an expiry before its issued-at time",
      verifiedToken({
        expiresAt: new Date(now.getTime() + 30_000),
        issuedAt: new Date(now.getTime() + 60_000),
      }),
    ],
    [
      "neither an immutable subject nor a session identifier",
      {
        expiresAt: new Date(now.getTime() + 5 * 60_000),
        issuedAt: new Date(now.getTime() - 1_000),
        issuer,
        tokenId: "missing-revocation-coordinate",
      },
    ],
  ])("rejects %s before writing a receipt", async (_name, token) => {
    const { config, database, rileyFirst } = openHarness();
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      verifyLogoutToken: async () => token,
    });
    try {
      await expect(
        service.process({
          logoutToken: "header.rejected-logout.signature",
          providerId,
          requestId: "backchannel-rejected-claim",
        }),
      ).rejects.toMatchObject({ code: "invalid_logout_token" });
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(rileyFirst.principal.sessionId),
      ).toEqual({ revoked: 0 });
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back the receipt and revocation if its audit record cannot be committed", async () => {
    const { config, database, rileyFirst } = openHarness();
    database.sqlite.exec(`
      create trigger reject_backchannel_logout_audit
      before insert on audit_events
      when new.event_type = 'auth.oidc.backchannel_logout'
      begin
        select raise(abort, 'backchannel audit unavailable');
      end
    `);
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      createId: () => "audit-backchannel-rollback",
      verifyLogoutToken: async () => verifiedToken(),
    });
    try {
      await expect(
        service.process({
          logoutToken: "header.atomic-logout.signature",
          providerId,
          requestId: "backchannel-atomic-request",
        }),
      ).rejects.toMatchObject({ code: "logout_storage_failed" });
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = ?")
          .get(rileyFirst.principal.sessionId),
      ).toEqual({ revoked: 0 });
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.oidc.backchannel_logout'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("distinguishes a retryable provider-verification outage from an invalid assertion", async () => {
    const { config, database } = openHarness();
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      verifyLogoutToken: async () => {
        throw new OidcProviderRegistryError("oidc_provider_discovery_failed", true);
      },
    });
    try {
      await expect(
        service.process({
          logoutToken: "header.retryable-provider.signature",
          providerId,
          requestId: "backchannel-retryable-request",
        }),
      ).rejects.toMatchObject({ code: "logout_storage_failed" });
    } finally {
      database.close();
    }
  });

  it("rejects malformed request coordinates before invoking token verification", async () => {
    const { config, database } = openHarness();
    const verifyLogoutToken = vi.fn(async () => verifiedToken());
    const service = new OidcBackchannelLogoutService(database, config, {
      clock: () => new Date(now),
      verifyLogoutToken,
    });
    try {
      for (const input of [
        { logoutToken: "not-a-compact-jws", providerId },
        { logoutToken: "header.payload.signature", providerId: "../provider" },
        {
          logoutToken: "header.payload.signature",
          providerId,
          requestId: "request id with spaces",
        },
      ]) {
        await expect(service.process(input)).rejects.toMatchObject({
          code: "invalid_logout_request",
        });
      }
      expect(verifyLogoutToken).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
