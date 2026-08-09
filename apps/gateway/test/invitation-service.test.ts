import {
  INVITATION_DEFAULT_TTL_SECONDS,
  REGISTRATION_HANDOFF_TTL_SECONDS,
} from "@omnifin/contracts/invitations";
import { describe, expect, it } from "vitest";

import { InvitationService, InvitationServiceError } from "../src/auth/invitation-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import type { SessionPrincipal } from "@omnifin/contracts/auth";

const now = new Date("2026-08-01T00:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example/"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 7),
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

function adminPrincipal(): SessionPrincipal {
  return {
    accountState: "active",
    absoluteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    authenticationMethod: { kind: "jellyfin" },
    csrfToken: undefined,
    displayName: "Administrator",
    externalIdentity: null,
    inactivityExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    issuedAt: now.toISOString(),
    linkedServices: [],
    permissions: ["identities.manage"],
    role: "admin",
    sessionId: "admin-session",
    userId: "admin-user",
  } as unknown as SessionPrincipal;
}

function context(): Parameters<typeof InvitationService.prototype.create>[1] {
  return { ipAddress: "127.0.0.1", principal: adminPrincipal(), requestId: "invite-test-1" };
}

function seedAuditActor(database: ReturnType<typeof openDatabase>) {
  database.sqlite
    .prepare(
      "insert into users (id, display_name, role, status, created_at, updated_at) values (?, ?, 'admin', 'active', ?, ?)",
    )
    .run("admin-user", "Administrator", now.getTime(), now.getTime());
  database.sqlite
    .prepare(
      `insert into sessions (
        id, token_hash, auth_method, csrf_token_hash, encrypted_csrf_token,
        created_at, last_rotated_at, last_seen_at, expires_at, absolute_expires_at
      ) values (?, ?, 'recovery', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "admin-session",
      "t".repeat(43),
      "c".repeat(43),
      "v2.fixture-csrf",
      now.getTime(),
      now.getTime(),
      now.getTime(),
      now.getTime() + 60_000,
      now.getTime() + 60_000,
    );
}

describe("invitation foundation service", () => {
  it("fails closed for malformed administration, bearer, and handoff inputs", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);

      const invalidContexts = [
        { principal: { ...adminPrincipal(), accountState: "disabled" } },
        { principal: { ...adminPrincipal(), role: "viewer" } },
        { principal: { ...adminPrincipal(), authenticationMethod: { kind: "recovery" } } },
        { principal: { ...adminPrincipal(), userId: undefined } },
        { principal: { ...adminPrincipal(), sessionId: "not valid" } },
        { ipAddress: " 127.0.0.1", principal: adminPrincipal() },
        { principal: adminPrincipal(), requestId: " request-id" },
        { principal: { ...adminPrincipal(), permissions: [] } },
      ];
      for (const override of invalidContexts) {
        const candidate = { ...context(), ...override } as Parameters<
          typeof InvitationService.prototype.create
        >[1];
        expect(() => new InvitationService(database, config()).list({}, candidate)).toThrowError(
          new InvitationServiceError("permission_denied"),
        );
      }

      const service = new InvitationService(database, config(), {
        clock: () => now,
        createId: () => "valid-id",
        createToken: () => Buffer.alloc(32, 31).toString("base64url"),
      });
      for (const token of [undefined, "short", "!".repeat(43)]) {
        expect(() => service.exchangeForRegistrationHandoff(token)).toThrowError(
          new InvitationServiceError("registration_handoff_invalid"),
        );
      }
      for (const input of [
        { invitationId: "bad id", handoffToken: "short" },
        {
          invitationId: "invite_missing",
          handoffToken: Buffer.alloc(32, 32).toString("base64url"),
        },
      ]) {
        expect(() => service.resolveRegistrationHandoff(input)).toThrowError(
          new InvitationServiceError("registration_handoff_invalid"),
        );
      }
      expect(() => service.beginRegistrationHandoff("short")).toThrowError(
        new InvitationServiceError("registration_handoff_invalid"),
      );
      expect(() =>
        service.consumeRegistrationHandoffInExistingTransaction({
          invitationId: "invite_missing",
          handoffToken: "short",
        }),
      ).toThrowError(new InvitationServiceError("storage_failure"));
    } finally {
      database.close();
    }
  });

  it("rejects corrupt invitation rows instead of presenting unsafe state", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);
      const service = new InvitationService(database, config(), { clock: () => now });
      const base = {
        id: "invite-integrity",
        tokenHash: "h".repeat(64),
        createdAt: now.getTime(),
        expiresAt: now.getTime() + 60_000,
        consumedAt: null,
        revokedAt: null,
        registrationHandoffHash: null,
        registrationHandoffExpiresAt: null,
      };
      const corruptions = [
        { createdAt: -1 },
        { expiresAt: now.getTime() },
        { consumedAt: now.getTime() - 1 },
        { revokedAt: now.getTime() - 1 },
        { consumedAt: now.getTime(), revokedAt: now.getTime() },
        { registrationHandoffHash: "a", registrationHandoffExpiresAt: now.getTime() + 1 },
        { registrationHandoffHash: null, registrationHandoffExpiresAt: now.getTime() + 1 },
        {
          registrationHandoffHash: Buffer.alloc(32, 33).toString("base64url"),
          registrationHandoffExpiresAt: now.getTime() + 61_000,
        },
        {
          consumedAt: now.getTime(),
          registrationHandoffHash: Buffer.alloc(32, 34).toString("base64url"),
          registrationHandoffExpiresAt: now.getTime() + 1,
        },
      ];
      database.sqlite.pragma("ignore_check_constraints = ON");
      for (const [index, corruption] of corruptions.entries()) {
        database.sqlite
          .prepare(
            `insert into invitations (
              id, token_hash, expires_at, created_at, consumed_at, revoked_at,
              registration_handoff_hash, registration_handoff_expires_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `invite_integrity_${index}`,
            Buffer.alloc(32, 35 + index).toString("base64url"),
            corruption.expiresAt ?? base.expiresAt,
            corruption.createdAt ?? base.createdAt,
            corruption.consumedAt ?? base.consumedAt,
            corruption.revokedAt ?? base.revokedAt,
            corruption.registrationHandoffHash ?? base.registrationHandoffHash,
            corruption.registrationHandoffExpiresAt ?? base.registrationHandoffExpiresAt,
          );
        expect(() => service.list({}, context())).toThrowError(
          new InvitationServiceError("integrity_failure"),
        );
        database.sqlite.prepare("delete from invitations").run();
      }
    } finally {
      database.close();
    }
  });

  it("reports terminal invitation states and bounds handoff leases", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);
      let current = now;
      let id = 0;
      const tokens = [41, 42, 43, 44].map((value) => Buffer.alloc(32, value).toString("base64url"));
      const handoffs = [51, 52, 53].map((value) => Buffer.alloc(32, value).toString("base64url"));
      const service = new InvitationService(database, config(), {
        clock: () => current,
        createHandoffToken: () => handoffs.shift() ?? "",
        createId: () => `state-${++id}`,
        createToken: () => tokens.shift() ?? "",
      });
      const [active, expired, revoked, consumed] = [1, 2, 3, 4].map(() =>
        service.create({ expiresInSeconds: 60 * 60 }, context()),
      );
      expect(service.list({}, context()).invitations.map(({ status }) => status)).toEqual([
        "active",
        "active",
        "active",
        "active",
      ]);
      current = new Date(expired!.invitation.expiresAt);
      expect(service.list({}, context()).invitations.map(({ status }) => status)).toEqual([
        "expired",
        "expired",
        "expired",
        "expired",
      ]);
      current = now;
      service.revoke(revoked!.invitation.id, context());
      const consumedHandoff = service.exchangeForRegistrationHandoff(
        Buffer.alloc(32, 44).toString("base64url"),
      );
      database.sqlite.transaction(() => {
        service.consumeRegistrationHandoffInExistingTransaction({
          handoffToken: consumedHandoff.handoffToken,
          invitationId: consumed!.invitation.id,
        });
      })();
      expect(service.list({}, context()).invitations.map(({ status }) => status)).toEqual([
        "active",
        "active",
        "revoked",
        "consumed",
      ]);
      expect(() => service.revoke(revoked!.invitation.id, context())).toThrowError(
        new InvitationServiceError("invitation_revoked"),
      );
      expect(() => service.revoke(consumed!.invitation.id, context())).toThrowError(
        new InvitationServiceError("invitation_consumed"),
      );
      current = new Date(expired!.invitation.expiresAt);
      expect(() => service.revoke(expired!.invitation.id, context())).toThrowError(
        new InvitationServiceError("invitation_expired"),
      );
      current = now;
      const activeHandoff = service.exchangeForRegistrationHandoff(
        Buffer.alloc(32, 41).toString("base64url"),
      );
      expect(activeHandoff.expiresAt.getTime()).toBe(
        now.getTime() + REGISTRATION_HANDOFF_TTL_SECONDS * 1_000,
      );
      current = new Date(activeHandoff.expiresAt);
      expect(() =>
        service.resolveRegistrationHandoff({
          invitationId: active!.invitation.id,
          handoffToken: activeHandoff.handoffToken,
        }),
      ).toThrowError(new InvitationServiceError("registration_handoff_invalid"));
    } finally {
      database.close();
    }
  });

  it("issues a one-time fragment URL while never persisting or listing its secret", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);
      const token = Buffer.alloc(32, 9).toString("base64url");
      const service = new InvitationService(database, config(), {
        clock: () => now,
        createId: () => "test-id",
        createToken: () => token,
      });
      const created = service.create({}, context());
      expect(created.invitationUrl).toBe(`https://omnifin.example/invite#invite=${token}`);
      expect(created.invitation.status).toBe("active");
      expect(created.invitation.expiresAt).toBe(
        new Date(now.getTime() + INVITATION_DEFAULT_TTL_SECONDS * 1_000).toISOString(),
      );
      const listed = service.list({}, context());
      expect(listed.invitations[0]).not.toHaveProperty("invitationUrl");
      expect(JSON.stringify(listed)).not.toContain(token);
      expect(JSON.stringify(listed)).not.toContain("tokenHash");
      expect(database.sqlite.prepare("select token_hash from invitations").get()).not.toEqual({
        token_hash: token,
      });
    } finally {
      database.close();
    }
  });

  it("does not revoke an invitation that expires at the transaction time", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);
      let current = now;
      const service = new InvitationService(database, config(), {
        clock: () => current,
        createId: () => "expiry-race-id",
        createToken: () => Buffer.alloc(32, 10).toString("base64url"),
      });
      const created = service.create({ expiresInSeconds: 60 * 60 }, context());
      current = new Date(created.invitation.expiresAt);

      expect(() => service.revoke(created.invitation.id, context())).toThrowError(
        new InvitationServiceError("invitation_expired"),
      );
      expect(
        database.sqlite
          .prepare("select consumed_at as consumedAt, revoked_at as revokedAt from invitations")
          .get(),
      ).toEqual({ consumedAt: null, revokedAt: null });
      expect(
        database.sqlite
          .prepare("select event_type as eventType from audit_events order by created_at")
          .all(),
      ).toEqual([{ eventType: "auth.invitation.created" }]);
    } finally {
      database.close();
    }
  });

  it("maps a revoke race that loses to consumption to the current terminal state", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);
      const token = Buffer.alloc(32, 11).toString("base64url");
      const handoffToken = Buffer.alloc(32, 12).toString("base64url");
      let id = 0;
      const service = new InvitationService(database, config(), {
        clock: () => now,
        createHandoffToken: () => handoffToken,
        createId: () => `terminal-race-id-${++id}`,
        createToken: () => token,
      });
      const created = service.create({}, context());
      const handoff = service.exchangeForRegistrationHandoff(token);
      database.sqlite.transaction(() => {
        service.consumeRegistrationHandoffInExistingTransaction({
          handoffToken: handoff.handoffToken,
          invitationId: created.invitation.id,
        });
      })();

      expect(() => service.revoke(created.invitation.id, context())).toThrowError(
        new InvitationServiceError("invitation_consumed"),
      );
      expect(
        database.sqlite
          .prepare("select consumed_at as consumedAt, revoked_at as revokedAt from invitations")
          .get(),
      ).toEqual({ consumedAt: now.getTime(), revokedAt: null });
    } finally {
      database.close();
    }
  });

  it("rotates a non-consuming handoff and consumes it only in the final transaction", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);
      const token = Buffer.alloc(32, 4).toString("base64url");
      const handoffs = [Buffer.alloc(32, 5), Buffer.alloc(32, 6)].map((value) =>
        value.toString("base64url"),
      );
      const service = new InvitationService(database, config(), {
        clock: () => now,
        createHandoffToken: () => handoffs.shift() ?? "",
        createId: (() => {
          let count = 0;
          return () => `test-id-${++count}`;
        })(),
        createToken: () => token,
      });
      const created = service.create({}, context());
      const exchanged = service.exchangeForRegistrationHandoff(token);
      const beforeConsume = database.sqlite
        .prepare(
          "select consumed_at as consumedAt, registration_handoff_hash as handoffHash from invitations",
        )
        .get() as { consumedAt: number | null; handoffHash: string | null };
      expect(beforeConsume.consumedAt).toBeNull();
      expect(beforeConsume.handoffHash).not.toBeNull();
      expect(
        service.resolveRegistrationHandoff({
          handoffToken: exchanged.handoffToken,
          invitationId: created.invitation.id,
        }).invitationId,
      ).toBe(created.invitation.id);
      const rotated = service.exchangeForRegistrationHandoff(token);
      expect(rotated.handoffToken).not.toBe(exchanged.handoffToken);
      expect(() =>
        service.resolveRegistrationHandoff({
          handoffToken: exchanged.handoffToken,
          invitationId: created.invitation.id,
        }),
      ).toThrowError(new InvitationServiceError("registration_handoff_invalid"));
      expect(() =>
        database.sqlite.transaction(() => {
          service.consumeRegistrationHandoffInExistingTransaction({
            handoffToken: rotated.handoffToken,
            invitationId: created.invitation.id,
          });
          throw new Error("proof lane rollback");
        })(),
      ).toThrow("proof lane rollback");
      expect(
        database.sqlite
          .prepare(
            "select consumed_at as consumedAt, registration_handoff_hash as handoffHash from invitations",
          )
          .get(),
      ).toEqual(expect.objectContaining({ consumedAt: null, handoffHash: expect.any(String) }));
      const claim = database.sqlite
        .transaction(() =>
          service.consumeRegistrationHandoffInExistingTransaction(
            { handoffToken: rotated.handoffToken, invitationId: created.invitation.id },
            { requestId: "claim-test-1" },
          ),
        )
        .immediate();
      expect(claim.invitationId).toBe(created.invitation.id);
      expect(() => JSON.stringify(claim)).toThrow();
      expect(
        database.sqlite
          .prepare(
            "select registration_handoff_hash as handoffHash, registration_handoff_expires_at as expiresAt from invitations",
          )
          .get(),
      ).toEqual({ expiresAt: null, handoffHash: null });
      const audit = database.sqlite
        .prepare(
          "select event_type as eventType, target_type as targetType, metadata_json as metadata from audit_events order by created_at",
        )
        .all() as { eventType: string; metadata: string; targetType: string }[];
      expect(audit.map((event) => event.eventType)).toEqual([
        "auth.invitation.created",
        "auth.invitation.consumed",
      ]);
      expect(audit.every((event) => event.targetType === "invitation")).toBe(true);
      expect(audit.join(" ")).not.toContain(token);
      expect(audit.join(" ")).not.toContain(rotated.handoffToken);
    } finally {
      database.close();
    }
  });

  it("resolves token-only handoffs, renews their lease, and rejects terminal states", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedAuditActor(database);
      let current = now;
      const issuedInvitationTokens = [11, 12, 13, 14].map((value) =>
        Buffer.alloc(32, value).toString("base64url"),
      );
      const invitationTokens = [...issuedInvitationTokens];
      const handoffTokens = [21, 22, 23, 24].map((value) =>
        Buffer.alloc(32, value).toString("base64url"),
      );
      let id = 0;
      const service = new InvitationService(database, config(), {
        clock: () => current,
        createHandoffToken: () => handoffTokens.shift() ?? "",
        createId: () => `handoff-proof-${++id}`,
        createToken: () => invitationTokens.shift() ?? "",
      });
      const created = [1, 2, 3, 4].map(() => service.create({}, context()));
      const exchanged = issuedInvitationTokens.map((token) =>
        service.exchangeForRegistrationHandoff(token),
      );
      const [first, expired, revoked, consumed] = created;
      const [firstHandoff, expiredHandoff, revokedHandoff, consumedHandoff] = exchanged;
      if (
        !first ||
        !expired ||
        !revoked ||
        !consumed ||
        !firstHandoff ||
        !expiredHandoff ||
        !revokedHandoff ||
        !consumedHandoff
      ) {
        throw new Error("fixture setup failed");
      }

      current = new Date(now.getTime() + 10_000);
      const renewed = service.beginRegistrationHandoff(firstHandoff.handoffToken);
      const renewedExpiry = now.getTime() + 15 * 60 * 1_000 + 10_000;
      expect(renewed.invitationId).toBe(first.invitation.id);
      expect(renewed.expiresAt).toEqual(new Date(renewedExpiry));
      expect(
        database.sqlite
          .prepare(
            "select registration_handoff_expires_at as expiresAt from invitations where id = ?",
          )
          .get(first.invitation.id),
      ).toEqual({ expiresAt: renewedExpiry });

      const cappedExpiry = current.getTime() + 5 * 60 * 1_000;
      database.sqlite
        .prepare(
          "update invitations set expires_at = ?, registration_handoff_expires_at = ? where id = ?",
        )
        .run(cappedExpiry, cappedExpiry, first.invitation.id);
      current = new Date(current.getTime() + 10_000);
      const capped = service.beginRegistrationHandoff(firstHandoff.handoffToken);
      expect(capped.invitationId).toBe(first.invitation.id);
      expect(capped.expiresAt).toEqual(new Date(cappedExpiry));
      expect(capped).not.toHaveProperty("handoffToken");
      expect(Object.keys(capped)).toEqual(["invitationId", "expiresAt"]);
      expect(() => JSON.stringify(capped)).toThrow();
      expect(
        service.resolveRegistrationHandoff({
          handoffToken: firstHandoff.handoffToken,
          invitationId: first.invitation.id,
        }).invitationId,
      ).toBe(first.invitation.id);

      database.sqlite
        .prepare("update invitations set registration_handoff_expires_at = ? where id = ?")
        .run(current.getTime() - 1, expired.invitation.id);
      expect(() => service.beginRegistrationHandoff(expiredHandoff.handoffToken)).toThrowError(
        new InvitationServiceError("registration_handoff_invalid"),
      );

      service.revoke(revoked.invitation.id, context());
      expect(() => service.beginRegistrationHandoff(revokedHandoff.handoffToken)).toThrowError(
        new InvitationServiceError("registration_handoff_invalid"),
      );

      database.sqlite.transaction(() => {
        service.consumeRegistrationHandoffInExistingTransaction({
          handoffToken: consumedHandoff.handoffToken,
          invitationId: consumed.invitation.id,
        });
      })();
      expect(() => service.beginRegistrationHandoff(consumedHandoff.handoffToken)).toThrowError(
        new InvitationServiceError("registration_handoff_invalid"),
      );

      const audit = database.sqlite
        .prepare("select metadata_json as metadata from audit_events")
        .all() as { metadata: string }[];
      expect(audit.join(" ")).not.toContain(firstHandoff.handoffToken);
      expect(audit.join(" ")).not.toContain(expiredHandoff.handoffToken);
      expect(audit.join(" ")).not.toContain(revokedHandoff.handoffToken);
      expect(audit.join(" ")).not.toContain(consumedHandoff.handoffToken);
    } finally {
      database.close();
    }
  });
});
