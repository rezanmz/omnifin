import type {
  JellyfinAuthenticationResult,
  JellyfinQuickConnectResult,
} from "@omnifin/connectors/auth/jellyfin-authentication-client";
import { ADMINISTRATOR_RECOVERY_CONFIRMATION } from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";

import {
  JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT,
  JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
  JellyfinQuickConnectService,
  JellyfinQuickConnectServiceError,
} from "../src/auth/jellyfin/quick-connect-service.js";
import { JellyfinSignInService } from "../src/auth/jellyfin/sign-in-service.js";
import { SessionService } from "../src/auth/session-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  users,
} from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const START = new Date("2026-07-26T12:00:00.000Z");
const ENCRYPTION_KEY = Buffer.alloc(32, 37);
const BROWSER_BINDING = Buffer.alloc(32, 7).toString("base64url");

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

function database() {
  const handle = openDatabase(":memory:");
  handle.migrate();
  handle.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      capabilitySnapshotJson: JSON.stringify({
        authentication: { password: true, quickConnect: "unknown" },
        schemaVersion: 1,
      }),
      createdAt: START,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: START,
    })
    .run();
  return handle;
}

function authentication(
  overrides: Partial<JellyfinAuthenticationResult> = {},
): JellyfinAuthenticationResult {
  return {
    AccessToken: "private-quick-connect-access-token",
    ServerId: "server-1",
    User: {
      Id: "jellyfin-user-1",
      Name: "Riley",
      Policy: { IsAdministrator: true },
    },
    ...overrides,
  };
}

function quickConnect(
  authenticated: boolean,
  overrides: Partial<JellyfinQuickConnectResult> = {},
): JellyfinQuickConnectResult {
  return {
    Authenticated: authenticated,
    Code: "AB-1234",
    DateAdded: START.toISOString(),
    Secret: "private-quick-connect-secret",
    ...overrides,
  };
}

function fixture(
  handle: DatabaseHandle,
  options: {
    authenticated?: boolean;
    enabled?: boolean;
    isAdministrator?: boolean;
    onPoll?: () => void;
    pollServerId?: string;
    serverId?: string;
  } = {},
) {
  let now = new Date(START);
  const calls = { authenticate: 0, enabled: 0, initiate: 0, poll: 0, publicInfo: 0 };
  const appConfig = config();
  const sessions = new SessionService(handle, appConfig, { clock: () => new Date(now) });
  const signIn = new JellyfinSignInService(handle, appConfig, sessions, {
    clock: () => new Date(now),
    createClient: () => ({
      authenticateByName: async () => authentication(),
      getPublicSystemInfo: async () => ({
        Id: "server-1",
        ServerName: "Home Jellyfin",
        Version: "10.10.7",
      }),
    }),
    createDeviceId: () => "password-device",
  });
  let nextId = 0;
  const service = new JellyfinQuickConnectService(handle, appConfig, signIn, {
    clock: () => new Date(now),
    createBrowserBinding: () => BROWSER_BINDING,
    createClient: () => ({
      authenticateWithQuickConnect: async () => {
        calls.authenticate += 1;
        return authentication({
          ServerId: options.serverId ?? "server-1",
          User: {
            Id: "jellyfin-user-1",
            Name: "Riley",
            Policy: { IsAdministrator: options.isAdministrator ?? true },
          },
        });
      },
      getPublicSystemInfo: async () => {
        calls.publicInfo += 1;
        return {
          Id: calls.publicInfo > 1 ? (options.pollServerId ?? "server-1") : "server-1",
          ServerName: "Home Jellyfin",
          Version: "10.10.7",
        };
      },
      initiateQuickConnect: async () => {
        calls.initiate += 1;
        return quickConnect(false);
      },
      pollQuickConnect: async () => {
        calls.poll += 1;
        options.onPoll?.();
        return quickConnect(options.authenticated ?? false);
      },
      quickConnectEnabled: async () => {
        calls.enabled += 1;
        return options.enabled ?? true;
      },
    }),
    createDeviceId: () => "quick-device-1",
    createId: () => `quick-connect-${++nextId}`,
  });
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    calls,
    service,
    sessions,
  };
}

function pollInput(transactionId: string, overrides: Record<string, unknown> = {}) {
  return {
    browserBindingToken: BROWSER_BINDING,
    ipAddress: "192.0.2.10",
    requestId: "request-quick-connect",
    transactionId,
    userAgent: "fixture-browser/1.0",
    ...overrides,
  };
}

function seedPendingOidcSession(handle: DatabaseHandle, sessions: SessionService) {
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
    .insert(users)
    .values({
      createdAt: START,
      displayName: "Riley from OIDC",
      id: "oidc-user-1",
      role: "requester",
      roleSource: "oidc_mapping",
      status: "pending_link",
      updatedAt: START,
    })
    .run();
  handle.db
    .insert(externalIdentities)
    .values({
      createdAt: START,
      displayClaimsJson: JSON.stringify({ displayName: "Riley from OIDC" }),
      id: "oidc-identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: START,
      providerId: "oidc-home",
      subject: "immutable-oidc-subject",
      updatedAt: START,
      userId: "oidc-user-1",
    })
    .run();
  const session = sessions.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "oidc-identity-1",
      oidcProviderId: "oidc-home",
      userId: "oidc-user-1",
    },
  });
  const validated = sessions.validateSessionCsrf(session.sessionToken, session.csrfToken);
  if (!validated) throw new Error("Expected a validated pending OIDC session.");
  return { session, validated };
}

function seedRecoverySession(sessions: SessionService) {
  const session = sessions.createSession({ attribution: { authMethod: "recovery" } });
  const validated = sessions.validateSessionCsrf(session.sessionToken, session.csrfToken);
  if (!validated) throw new Error("Expected a validated recovery session.");
  return { session, validated };
}

describe("JellyfinQuickConnectService", () => {
  it("binds first-admin Quick Connect to recovery and replaces it after admin proof", async () => {
    const handle = database();
    const test = fixture(handle, { authenticated: true });
    try {
      const recovery = seedRecoverySession(test.sessions);
      const started = await test.service.startBootstrap({
        validatedSession: recovery.validated,
      });
      test.advance(JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS);

      const result = await test.service.pollBootstrap({
        ...pollInput(started.transactionId),
        validatedSession: recovery.validated,
      });

      expect(result.status).toBe("bootstrapped");
      if (result.status !== "bootstrapped") throw new Error("Expected bootstrap success.");
      expect(result.session.principal).toMatchObject({
        authenticationMethod: { kind: "jellyfin" },
        role: "admin",
      });
      expect(test.sessions.resolveAndRefresh(recovery.session.sessionToken)).toBeNull();
      expect(handle.db.select().from(users).all()).toEqual([
        expect.objectContaining({ role: "admin", roleSource: "recovery_bootstrap" }),
      ]);
    } finally {
      handle.close();
    }
  });

  it("binds sole-administrator replacement target and confirmation into one-use proof", async () => {
    const handle = database();
    const test = fixture(handle, { authenticated: true });
    try {
      for (const account of [
        {
          externalUserId: "upstream-target",
          id: "target-administrator",
          role: "admin" as const,
        },
        {
          externalUserId: "jellyfin-user-1",
          id: "replacement-account",
          role: "viewer" as const,
        },
      ]) {
        handle.db
          .insert(users)
          .values({
            createdAt: START,
            displayName: account.id,
            id: account.id,
            role: account.role,
            roleSource: account.role === "admin" ? "manual" : "default",
            status: "active",
            updatedAt: START,
          })
          .run();
        handle.db
          .insert(serviceIdentityLinks)
          .values({
            connectorId: "jellyfin-home",
            createdAt: START,
            deviceId: `${account.id}-device`,
            encryptedAccessToken: `v2.${account.id}-token`,
            externalDisplayName: account.id,
            externalServerId: "server-1",
            externalUserId: account.externalUserId,
            externalUsername: account.id,
            healthState: "linked",
            id: `${account.id}-link`,
            lastVerifiedAt: START,
            service: "jellyfin",
            tokenCreatedAt: START,
            updatedAt: START,
            userId: account.id,
          })
          .run();
      }
      test.sessions.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "target-administrator-link",
          userId: "target-administrator",
        },
      });
      test.sessions.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "replacement-account-link",
          userId: "replacement-account",
        },
      });
      const recovery = seedRecoverySession(test.sessions);
      const started = await test.service.startAdministratorReplacement({
        administratorId: "target-administrator",
        confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION,
        expectedUpdatedAt: START.toISOString(),
        validatedSession: recovery.validated,
      });
      const transaction = handle.sqlite
        .prepare(
          "select encrypted_payload as encryptedPayload from jellyfin_quick_connect_transactions where id = ?",
        )
        .get(started.transactionId) as { encryptedPayload: string };
      const plaintext = new EnvelopeCipher(ENCRYPTION_KEY).decrypt(
        transaction.encryptedPayload,
        `jellyfin-quick-connect:${started.transactionId}:payload`,
      );
      expect(JSON.parse(plaintext)).toMatchObject({
        administratorId: "target-administrator",
        confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION,
        expectedUpdatedAt: START.toISOString(),
        purpose: "administrator_replacement",
        recoverySessionId: recovery.session.principal.sessionId,
        schemaVersion: 5,
        configGeneration: 0,
        instanceGeneration: 0,
      });
      expect(JSON.stringify(transaction)).not.toContain("target-administrator");

      test.advance(JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS);
      const result = await test.service.pollAdministratorReplacement({
        ...pollInput(started.transactionId),
        validatedSession: recovery.validated,
      });
      expect(result.status).toBe("replaced");
      expect(handle.db.select().from(users).all()).toEqual([
        expect.objectContaining({ id: "target-administrator", status: "disabled" }),
        expect.objectContaining({ id: "replacement-account", role: "admin", status: "active" }),
      ]);
      await expect(
        test.service.pollAdministratorReplacement({
          ...pollInput(started.transactionId),
          validatedSession: recovery.validated,
        }),
      ).rejects.toMatchObject({ reason: "recovery_session_required" });
    } finally {
      handle.close();
    }
  });

  it("will not start administrator Quick Connect without a recovery session", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      await expect(
        test.service.startBootstrap({ validatedSession: undefined }),
      ).rejects.toMatchObject({ reason: "recovery_session_required" });
      expect(test.calls).toEqual({
        authenticate: 0,
        enabled: 0,
        initiate: 0,
        poll: 0,
        publicInfo: 0,
      });
    } finally {
      handle.close();
    }
  });

  it("retains recovery access when Quick Connect proves a non-administrator account", async () => {
    const handle = database();
    const test = fixture(handle, { authenticated: true, isAdministrator: false });
    try {
      const recovery = seedRecoverySession(test.sessions);
      const started = await test.service.startBootstrap({
        validatedSession: recovery.validated,
      });
      test.advance(JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS);

      const result = await test.service.pollBootstrap({
        ...pollInput(started.transactionId),
        validatedSession: recovery.validated,
      });

      expect(result).toMatchObject({
        reason: "jellyfin_admin_required",
        status: "denied",
      });
      expect(
        test.sessions.resolveAndRefresh(recovery.session.sessionToken)?.principal,
      ).toMatchObject({ accountState: "recovery" });
      expect(handle.db.select().from(users).all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("stores only encrypted protocol material and returns a browser-bound display code", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      const started = await test.service.start({});

      expect(started).toMatchObject({
        browserBindingToken: BROWSER_BINDING,
        code: "AB-1234",
        pollAfterMs: JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
        transactionId: "quick-connect-1",
      });
      expect(() => JSON.stringify(started)).toThrow(/cannot be serialized/i);
      const row = handle.sqlite
        .prepare(
          `select browser_binding_hash as browserBindingHash,
                  connector_instance_generation as connectorInstanceGeneration,
                  encrypted_payload as encryptedPayload
           from jellyfin_quick_connect_transactions`,
        )
        .get() as {
        browserBindingHash: string;
        connectorInstanceGeneration: number;
        encryptedPayload: string;
      };
      expect(row.browserBindingHash).not.toBe(BROWSER_BINDING);
      expect(row.connectorInstanceGeneration).toBe(0);
      expect(row.encryptedPayload).not.toMatch(/private-quick-connect-secret|AB-1234/);
      expect(
        new EnvelopeCipher(ENCRYPTION_KEY).decrypt(
          row.encryptedPayload,
          "jellyfin-quick-connect:quick-connect-1:payload",
        ),
      ).toContain("private-quick-connect-secret");
      expect(
        JSON.parse(
          handle.db
            .select({ snapshot: connectorConfigs.capabilitySnapshotJson })
            .from(connectorConfigs)
            .get()!.snapshot,
        ),
      ).toMatchObject({ authentication: { quickConnect: true } });
      expect(test.calls).toEqual({
        authenticate: 0,
        enabled: 1,
        initiate: 1,
        poll: 0,
        publicInfo: 1,
      });
    } finally {
      handle.close();
    }
  });

  it("records a disabled capability without creating a local transaction", async () => {
    const handle = database();
    const test = fixture(handle, { enabled: false });
    try {
      await expect(test.service.start({})).rejects.toMatchObject({
        reason: "quick_connect_disabled",
      });
      expect(
        handle.sqlite
          .prepare("select count(*) as count from jellyfin_quick_connect_transactions")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        JSON.parse(
          handle.db
            .select({ snapshot: connectorConfigs.capabilitySnapshotJson })
            .from(connectorConfigs)
            .get()!.snapshot,
        ),
      ).toMatchObject({ authentication: { quickConnect: false } });
    } finally {
      handle.close();
    }
  });

  it("enforces the polling cadence without contacting Jellyfin early", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      const started = await test.service.start({});
      const early = await test.service.poll(pollInput(started.transactionId));

      expect(early).toMatchObject({ pollAfterMs: 2_000, status: "pending" });
      expect(test.calls.poll).toBe(0);
      test.advance(2_000);
      const pending = await test.service.poll(pollInput(started.transactionId));
      expect(pending).toMatchObject({ pollAfterMs: 2_000, status: "pending" });
      expect(test.calls.poll).toBe(1);
    } finally {
      handle.close();
    }
  });

  it("authenticates an approved transaction once and attributes the identity proof", async () => {
    const handle = database();
    const test = fixture(handle, { authenticated: true });
    try {
      const started = await test.service.start({});
      test.advance(2_000);
      const result = await test.service.poll(pollInput(started.transactionId));

      expect(result.status).toBe("signed_in");
      if (result.status !== "signed_in") throw new Error("Expected Quick Connect sign-in.");
      expect(result.session.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "jellyfin" },
        displayName: "Riley",
      });
      expect(handle.db.select().from(users).all()).toHaveLength(1);
      expect(handle.db.select().from(serviceIdentityLinks).all()).toHaveLength(1);
      expect(
        handle.sqlite
          .prepare(
            "select consumed_at is not null as consumed from jellyfin_quick_connect_transactions",
          )
          .get(),
      ).toEqual({ consumed: 1 });
      const audits = handle.sqlite
        .prepare("select metadata_json as metadata from audit_events order by created_at asc")
        .all() as { metadata: string }[];
      expect(audits.map(({ metadata }) => JSON.parse(metadata))).toContainEqual(
        expect.objectContaining({ proof: "quick_connect", provisioned: true }),
      );
      await expect(test.service.poll(pollInput(started.transactionId))).rejects.toBeInstanceOf(
        JellyfinQuickConnectServiceError,
      );
      expect(test.calls.authenticate).toBe(1);
    } finally {
      handle.close();
    }
  });

  it("rejects a stolen transaction identifier before polling Jellyfin", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      const started = await test.service.start({});
      test.advance(2_000);
      await expect(
        test.service.poll(
          pollInput(started.transactionId, {
            browserBindingToken: Buffer.alloc(32, 9).toString("base64url"),
          }),
        ),
      ).rejects.toMatchObject({ reason: "invalid_transaction" });
      expect(test.calls.poll).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("invalidates a transaction when the connector binding changes", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      const started = await test.service.start({});
      handle.db
        .update(connectorConfigs)
        .set({
          baseUrl: "https://replacement.example.test",
          updatedAt: new Date(START.getTime() + 1),
        })
        .run();
      test.advance(2_000);

      await expect(test.service.poll(pollInput(started.transactionId))).rejects.toMatchObject({
        reason: "configuration_invalid",
      });
      expect(test.calls.poll).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("keeps a generation-bound transaction valid across a health-only timestamp update", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      const started = await test.service.start({});
      handle.db
        .update(connectorConfigs)
        .set({ updatedAt: new Date(START.getTime() + 2) })
        .run();
      test.advance(2_000);

      await expect(test.service.poll(pollInput(started.transactionId))).resolves.toMatchObject({
        status: "pending",
      });
      expect(test.calls.poll).toBe(1);
    } finally {
      handle.close();
    }
  });

  it("never sends an old Quick Connect secret to a replacement generation", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      const started = await test.service.start({});
      handle.db.update(connectorConfigs).set({ instanceGeneration: 1 }).run();
      test.advance(2_000);

      await expect(test.service.poll(pollInput(started.transactionId))).rejects.toMatchObject({
        reason: "configuration_invalid",
      });
      expect(test.calls.poll).toBe(0);
      expect(test.calls.authenticate).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("rechecks stable ServerId before sending an old Quick Connect secret", async () => {
    const handle = database();
    const test = fixture(handle, { pollServerId: "replacement-server" });
    try {
      const started = await test.service.start({});
      test.advance(2_000);

      await expect(test.service.poll(pollInput(started.transactionId))).rejects.toMatchObject({
        reason: "configuration_invalid",
      });
      expect(test.calls.poll).toBe(0);
      expect(test.calls.authenticate).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("expires locally without contacting Jellyfin", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      const started = await test.service.start({});
      test.advance(5 * 60 * 1_000);

      await expect(test.service.poll(pollInput(started.transactionId))).resolves.toMatchObject({
        status: "expired",
      });
      expect(test.calls.poll).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("caps active transactions per browser", async () => {
    const handle = database();
    const test = fixture(handle);
    try {
      for (let index = 0; index < JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT; index += 1) {
        await test.service.start({ browserBindingToken: BROWSER_BINDING });
      }
      await expect(
        test.service.start({ browserBindingToken: BROWSER_BINDING }),
      ).rejects.toMatchObject({ reason: "capacity_exceeded" });
      expect(
        handle.sqlite
          .prepare("select count(*) as count from jellyfin_quick_connect_transactions")
          .get(),
      ).toEqual({ count: JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT });
    } finally {
      handle.close();
    }
  });

  it("consumes an approved transaction before rejecting a server substitution", async () => {
    const handle = database();
    const test = fixture(handle, { authenticated: true, serverId: "attacker-server" });
    try {
      const started = await test.service.start({});
      test.advance(2_000);

      await expect(test.service.poll(pollInput(started.transactionId))).rejects.toMatchObject({
        reason: "provider_unavailable",
      });
      expect(
        handle.sqlite
          .prepare(
            "select consumed_at is not null as consumed from jellyfin_quick_connect_transactions",
          )
          .get(),
      ).toEqual({ consumed: 1 });
      expect(handle.db.select().from(users).all()).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it("binds a pairing transaction to one pending OIDC session and preserves OIDC attribution", async () => {
    const handle = database();
    const test = fixture(handle, { authenticated: true });
    try {
      const pending = seedPendingOidcSession(handle, test.sessions);
      const started = await test.service.startPairing({
        validatedSession: pending.validated,
      });
      expect(
        handle.sqlite
          .prepare(
            `select purpose, pairing_session_id as pairingSessionId
             from jellyfin_quick_connect_transactions`,
          )
          .get(),
      ).toEqual({
        pairingSessionId: pending.session.principal.sessionId,
        purpose: "pairing",
      });

      const secondSession = test.sessions.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "oidc-identity-1",
          oidcProviderId: "oidc-home",
          userId: "oidc-user-1",
        },
      });
      const secondValidated = test.sessions.validateSessionCsrf(
        secondSession.sessionToken,
        secondSession.csrfToken,
      );
      test.advance(2_000);
      await expect(
        test.service.pollPairing({
          ...pollInput(started.transactionId),
          validatedSession: secondValidated,
        }),
      ).rejects.toMatchObject({ reason: "invalid_transaction" });
      expect(test.calls.poll).toBe(0);

      const result = await test.service.pollPairing({
        ...pollInput(started.transactionId),
        validatedSession: pending.validated,
      });
      expect(result.status).toBe("paired");
      if (result.status !== "paired") throw new Error("Expected Quick Connect pairing.");
      expect(result.session.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
        userId: "oidc-user-1",
      });
      expect(handle.db.select().from(users).all()).toHaveLength(1);
      expect(handle.db.select().from(serviceIdentityLinks).all()).toEqual([
        expect.objectContaining({
          externalUserId: "jellyfin-user-1",
          userId: "oidc-user-1",
        }),
      ]);
      expect(test.sessions.resolveAndRefresh(secondSession.sessionToken)).toBeNull();
    } finally {
      handle.close();
    }
  });
});
