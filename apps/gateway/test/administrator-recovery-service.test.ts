import type { JellyfinAuthenticationResult } from "@omnifin/connectors/auth/jellyfin-authentication-client";
import { ADMINISTRATOR_RECOVERY_CONFIRMATION } from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";

import { AdministratorRecoveryService } from "../src/auth/administrator-recovery-service.js";
import type { AdministratorRecoveryError } from "../src/auth/administrator-recovery-service.js";
import { SessionService } from "../src/auth/session-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, sessions, users } from "../src/db/schema.js";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const EARLIER = new Date("2026-08-08T11:00:00.000Z");
const ENCRYPTION_KEY = Buffer.alloc(32, 109);

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: ENCRYPTION_KEY,
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

function seedUser(
  database: DatabaseHandle,
  input: {
    externalUserId: string;
    id: string;
    role: "admin" | "viewer";
    status?: "active" | "disabled";
  },
) {
  database.db
    .insert(users)
    .values({
      createdAt: EARLIER,
      displayName: input.role === "admin" ? "Current administrator" : "Replacement account",
      id: input.id,
      role: input.role,
      roleSource: input.role === "admin" ? "manual" : "default",
      status: input.status ?? "active",
      updatedAt: EARLIER,
    })
    .run();
  database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: EARLIER,
      deviceId: `${input.id}-device`,
      encryptedAccessToken: `v2.${input.id}-encrypted-token`,
      externalDisplayName: input.id,
      externalServerId: "server-1",
      externalUserId: input.externalUserId,
      externalUsername: input.id,
      healthState: "linked",
      id: `${input.id}-link`,
      lastVerifiedAt: EARLIER,
      service: "jellyfin",
      tokenCreatedAt: EARLIER,
      updatedAt: EARLIER,
      userId: input.id,
    })
    .run();
}

function harness(options: { candidateStatus?: "active" | "disabled" } = {}) {
  const database = openDatabase(":memory:");
  database.migrate();
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: EARLIER,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-connector-secret",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: EARLIER,
    })
    .run();
  seedUser(database, {
    externalUserId: "upstream-target",
    id: "target-administrator",
    role: "admin",
  });
  seedUser(database, {
    externalUserId: "upstream-replacement",
    id: "replacement-account",
    role: "viewer",
    ...(options.candidateStatus === undefined ? {} : { status: options.candidateStatus }),
  });
  let sessionId = 0;
  let tokenId = 0;
  const sessionService = new SessionService(database, config(), {
    clock: () => new Date(NOW),
    createId: () => `administrator-recovery-session-${++sessionId}`,
    createToken: () => Buffer.alloc(32, ++tokenId).toString("base64url"),
  });
  const targetSession = sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "target-administrator-link",
      userId: "target-administrator",
    },
  });
  const candidateSession =
    options.candidateStatus === "disabled"
      ? undefined
      : sessionService.createSession({
          attribution: {
            authMethod: "jellyfin",
            serviceIdentityLinkId: "replacement-account-link",
            userId: "replacement-account",
          },
        });
  const recoverySession = sessionService.createSession({ attribution: { authMethod: "recovery" } });
  const validatedRecovery = sessionService.validateSessionCsrf(
    recoverySession.sessionToken,
    recoverySession.csrfToken,
  );
  if (!validatedRecovery) throw new Error("Expected a validated recovery fixture.");
  let auditId = 0;
  const service = new AdministratorRecoveryService(database, sessionService, config(), {
    clock: () => new Date(NOW),
    createId: () => `administrator-replacement-audit-${++auditId}`,
  });
  return {
    candidateSession,
    database,
    recoverySession,
    service,
    sessionService,
    targetSession,
    validatedRecovery,
  };
}

function target(expectedUpdatedAt = EARLIER.toISOString()) {
  return {
    administratorId: "target-administrator",
    confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION,
    expectedUpdatedAt,
  };
}

function authentication(
  overrides: Partial<JellyfinAuthenticationResult> = {},
): JellyfinAuthenticationResult {
  return {
    AccessToken: "fresh-private-access-token",
    ServerId: "server-1",
    User: {
      Id: "upstream-replacement",
      Name: "Replacement account",
      Policy: { IsAdministrator: true },
    },
    ...overrides,
  };
}

function replacementInput(
  validatedSession: unknown,
  overrides: Partial<Parameters<AdministratorRecoveryService["replaceWithJellyfin"]>[0]> = {},
) {
  return {
    ...target(),
    authentication: authentication(),
    deviceId: "fresh-proof-device",
    ipAddress: "192.0.2.10",
    proof: "password" as const,
    requestId: "administrator-recovery-request",
    target: {
      baseUrl: "https://jellyfin.example.test",
      connectorId: "jellyfin-home",
      displayName: "Home Jellyfin",
      insecureHttpApproved: false,
      updatedAt: EARLIER.getTime(),
    },
    userAgent: "administrator recovery fixture",
    validatedSession,
    ...overrides,
  };
}

describe("AdministratorRecoveryService", () => {
  it("returns only the sole administrator preview and denies an ordinary administrator", () => {
    const test = harness();
    try {
      const preview = test.service.preview(test.recoverySession.principal);
      expect(preview).toEqual({
        administrator: {
          activeSessions: 1,
          authenticationMethods: ["jellyfin"],
          displayName: "Current administrator",
          id: "target-administrator",
          updatedAt: EARLIER.toISOString(),
        },
        status: "available",
      });
      expect(JSON.stringify(preview)).not.toMatch(/upstream-|server-1|encrypted-token/);
      expect(() => test.service.preview(test.targetSession.principal)).toThrow(
        expect.objectContaining<Partial<AdministratorRecoveryError>>({
          reason: "permission_denied",
        }),
      );
      expect(() =>
        test.service.preview({
          ...test.recoverySession.principal,
          permissions: test.recoverySession.principal.permissions.filter(
            (permission) => permission !== "recovery.administrator.replace",
          ),
        }),
      ).toThrow(
        expect.objectContaining<Partial<AdministratorRecoveryError>>({
          reason: "permission_denied",
        }),
      );
    } finally {
      test.database.close();
    }
  });

  it("atomically promotes the fresh-proved candidate, disables the target, and leaves one session", () => {
    const test = harness();
    try {
      const result = test.service.replaceWithJellyfin(replacementInput(test.validatedRecovery));
      expect(result.status).toBe("replaced");
      if (result.status !== "replaced") throw new Error("Expected replacement success.");
      expect(result.session.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "jellyfin" },
        role: "admin",
        userId: "replacement-account",
      });
      expect(result.revokedSessions).toEqual({ recovery: 1, replacement: 1, target: 1 });
      expect(
        test.database.db
          .select()
          .from(users)
          .all()
          .map(({ id, role, roleSource, status }) => ({
            id,
            role,
            roleSource,
            status,
          })),
      ).toEqual([
        {
          id: "target-administrator",
          role: "admin",
          roleSource: "manual",
          status: "disabled",
        },
        {
          id: "replacement-account",
          role: "admin",
          roleSource: "recovery_bootstrap",
          status: "active",
        },
      ]);
      expect(
        test.database.db
          .select()
          .from(sessions)
          .all()
          .filter((session) => session.revokedAt === null)
          .map((session) => session.id),
      ).toEqual([result.session.principal.sessionId]);
      const audits = test.database.sqlite
        .prepare(
          `select event_type as eventType, metadata_json as metadataJson
           from audit_events
           where event_type = 'auth.administrator.replaced'`,
        )
        .all() as { eventType: string; metadataJson: string }[];
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadataJson).not.toMatch(
        /fresh-private-access-token|upstream-replacement|server-1/,
      );
      expect(JSON.parse(audits[0]!.metadataJson)).toMatchObject({
        proof: "jellyfin_password",
        recoverySessionsRevoked: 1,
        replacementSessionsRevoked: 1,
        targetSessionsRevoked: 1,
      });
      expect(() => JSON.stringify(result)).toThrow(/cannot be serialized/i);
    } finally {
      test.database.close();
    }
  });

  it.each([
    {
      name: "stale target",
      options: {},
      override: { expectedUpdatedAt: new Date(EARLIER.getTime() - 1).toISOString() },
      status: "unavailable",
    },
    {
      name: "non-administrator proof",
      options: {},
      override: {
        authentication: authentication({
          User: {
            Id: "upstream-replacement",
            Name: "Replacement account",
            Policy: { IsAdministrator: false },
          },
        }),
      },
      status: "denied",
    },
    {
      name: "same identity",
      options: {},
      override: {
        authentication: authentication({
          User: {
            Id: "upstream-target",
            Name: "Current administrator",
            Policy: { IsAdministrator: true },
          },
        }),
      },
      status: "denied",
    },
    {
      name: "disabled candidate",
      options: { candidateStatus: "disabled" as const },
      override: {},
      status: "denied",
    },
  ])("leaves the target unchanged for $name", ({ options, override, status }) => {
    const test = harness(options);
    try {
      const result = test.service.replaceWithJellyfin(
        replacementInput(test.validatedRecovery, override),
      );
      expect(result.status).toBe(status);
      expect(
        test.database.db
          .select()
          .from(users)
          .all()
          .find((user) => user.id === "target-administrator"),
      ).toMatchObject({ role: "admin", status: "active", updatedAt: EARLIER });
      expect(
        test.sessionService.resolveAndRefresh(test.recoverySession.sessionToken)?.principal,
      ).toMatchObject({ accountState: "recovery" });
      expect(
        test.database.sqlite
          .prepare("select count(*) as count from audit_events where event_type = ?")
          .get("auth.administrator.replaced"),
      ).toEqual({ count: 0 });
    } finally {
      test.database.close();
    }
  });

  it("returns a generic unavailable preview for zero or multiple active administrators", () => {
    for (const state of ["zero", "multiple"] as const) {
      const test = harness();
      try {
        if (state === "zero") {
          test.database.sqlite
            .prepare("update users set role = 'viewer' where id = 'target-administrator'")
            .run();
        } else {
          test.database.sqlite
            .prepare("update users set role = 'admin' where id = 'replacement-account'")
            .run();
        }
        expect(test.service.preview(test.recoverySession.principal)).toEqual({
          status: "unavailable",
        });
      } finally {
        test.database.close();
      }
    }
  });

  it("rolls back users, sessions, and the refreshed token when the replacement audit fails", () => {
    const test = harness();
    try {
      test.database.sqlite.exec(`
        create trigger fail_administrator_replacement_audit
        before insert on audit_events
        when new.event_type = 'auth.administrator.replaced'
        begin
          select raise(abort, 'fixture audit failure');
        end
      `);
      expect(() =>
        test.service.replaceWithJellyfin(replacementInput(test.validatedRecovery)),
      ).toThrow(expect.objectContaining({ reason: "storage_failure" }));
      expect(
        test.database.db
          .select()
          .from(users)
          .all()
          .map(({ id, role, status }) => ({
            id,
            role,
            status,
          })),
      ).toEqual([
        { id: "target-administrator", role: "admin", status: "active" },
        { id: "replacement-account", role: "viewer", status: "active" },
      ]);
      expect(
        test.database.db
          .select()
          .from(sessions)
          .all()
          .filter((session) => session.revokedAt === null),
      ).toHaveLength(3);
      expect(
        test.database.db
          .select()
          .from(serviceIdentityLinks)
          .all()
          .find((link) => link.id === "replacement-account-link"),
      ).toMatchObject({ revision: 0, updatedAt: EARLIER });
    } finally {
      test.database.close();
    }
  });

  it("rolls back the authority transfer when replacement session issuance fails", () => {
    const test = harness();
    try {
      test.database.sqlite.exec(`
        create trigger fail_replacement_session
        before insert on sessions
        when new.auth_method <> 'recovery'
        begin
          select raise(abort, 'fixture session failure');
        end
      `);
      expect(() =>
        test.service.replaceWithJellyfin(replacementInput(test.validatedRecovery)),
      ).toThrow(expect.objectContaining({ reason: "storage_failure" }));
      expect(
        test.database.db
          .select()
          .from(users)
          .all()
          .map(({ id, role, status }) => ({
            id,
            role,
            status,
          })),
      ).toEqual([
        { id: "target-administrator", role: "admin", status: "active" },
        { id: "replacement-account", role: "viewer", status: "active" },
      ]);
      expect(
        test.database.db
          .select()
          .from(sessions)
          .all()
          .filter((session) => session.revokedAt === null),
      ).toHaveLength(3);
      expect(
        test.database.sqlite
          .prepare("select count(*) as count from audit_events where event_type = ?")
          .get("auth.administrator.replaced"),
      ).toEqual({ count: 0 });
    } finally {
      test.database.close();
    }
  });
});
