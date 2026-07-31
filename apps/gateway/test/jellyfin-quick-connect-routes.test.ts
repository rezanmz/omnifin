import {
  jellyfinQuickConnectBootstrapPollResponseSchema,
  jellyfinQuickConnectInitiationResponseSchema,
  jellyfinQuickConnectPairingPollResponseSchema,
  jellyfinQuickConnectPollResponseSchema,
} from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { JellyfinQuickConnectServiceDependencies } from "../src/auth/jellyfin/quick-connect-service.js";
import type { AppConfig } from "../src/config.js";
import { externalIdentities, oidcProviders, users } from "../src/db/schema.js";

const START = new Date("2026-07-26T12:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 67),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    jellyfinUrl: new URL("https://jellyfin.example.test"),
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

function fixture(
  options: { authenticated?: boolean; enabled?: boolean; isAdministrator?: boolean } = {},
) {
  let now = new Date(START);
  let authenticated = options.authenticated ?? false;
  const calls = { authenticate: 0, enabled: 0, initiate: 0, poll: 0, publicInfo: 0 };
  const dependencies: JellyfinQuickConnectServiceDependencies = {
    clock: () => new Date(now),
    createBrowserBinding: () => Buffer.alloc(32, 5).toString("base64url"),
    createClient: () => ({
      authenticateWithQuickConnect: async () => {
        calls.authenticate += 1;
        return {
          AccessToken: "private-jellyfin-access-token",
          ServerId: "server-1",
          User: {
            Id: "jellyfin-user-1",
            Name: "Riley",
            Policy: { IsAdministrator: options.isAdministrator ?? false },
          },
        };
      },
      getPublicSystemInfo: async () => {
        calls.publicInfo += 1;
        return { Id: "server-1", ServerName: "Home Jellyfin", Version: "10.10.7" };
      },
      initiateQuickConnect: async () => {
        calls.initiate += 1;
        return {
          Authenticated: false,
          Code: "AB-1234",
          DateAdded: START.toISOString(),
          Secret: "private-quick-connect-secret",
        };
      },
      pollQuickConnect: async () => {
        calls.poll += 1;
        return {
          Authenticated: authenticated,
          Code: "AB-1234",
          DateAdded: START.toISOString(),
          Secret: "private-quick-connect-secret",
        };
      },
      quickConnectEnabled: async () => {
        calls.enabled += 1;
        return options.enabled ?? true;
      },
    }),
    createDeviceId: () => "quick-device-1",
    createId: () => "quick-connect-1",
  };
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    calls,
    dependencies,
    setAuthenticated(value: boolean) {
      authenticated = value;
    },
  };
}

function startRequest(payload: Record<string, unknown> = {}) {
  return {
    headers: { origin: "https://omnifin.example" },
    method: "POST" as const,
    payload,
    url: "/v1/auth/jellyfin/quick-connect",
  };
}

function cookieHeader(setCookie: string | string[] | undefined) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = values.find((value) => value.startsWith("__Host-omnifin_jellyfin_qc_binding="));
  if (!cookie) throw new Error("Expected a Quick Connect binding cookie.");
  return cookie.split(";", 1)[0]!;
}

function pollRequest(transactionId: string, cookie: string, payload: Record<string, unknown> = {}) {
  return {
    headers: { cookie, origin: "https://omnifin.example" },
    method: "POST" as const,
    payload,
    url: `/v1/auth/jellyfin/quick-connect/${transactionId}/poll`,
  };
}

function pendingOidcSession(app: Awaited<ReturnType<typeof createApp>>) {
  app.database.db
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
  app.database.db
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
  app.database.db
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
  return app.sessionService.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "oidc-identity-1",
      oidcProviderId: "oidc-home",
      userId: "oidc-user-1",
    },
  });
}

function recoverySession(app: Awaited<ReturnType<typeof createApp>>) {
  return app.sessionService.createSession({ attribution: { authMethod: "recovery" } });
}

describe("Jellyfin Quick Connect browser routes", () => {
  it("starts a transaction without exposing the upstream secret", async () => {
    const test = fixture();
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
      sessionDependencies: { clock: () => new Date(START) },
    });
    try {
      const response = await app.inject(startRequest());

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(jellyfinQuickConnectInitiationResponseSchema.parse(response.json())).toMatchObject({
        code: "AB-1234",
        pollAfterMs: 2_000,
        transactionId: "quick-connect-1",
      });
      expect(response.body).not.toMatch(/private-quick-connect-secret|quick-device-1/);
      const setCookie = Array.isArray(response.headers["set-cookie"])
        ? response.headers["set-cookie"].join("\n")
        : response.headers["set-cookie"];
      expect(setCookie).toMatch(/__Host-omnifin_jellyfin_qc_binding=/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Secure/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      expect(test.calls).toMatchObject({ enabled: 1, initiate: 1, publicInfo: 1 });
    } finally {
      await app.close();
    }
  });

  it("polls at the server cadence and issues a normal Jellyfin session after approval", async () => {
    const test = fixture();
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
      sessionDependencies: { clock: () => new Date(START.getTime() + 2_000) },
    });
    try {
      const startedResponse = await app.inject(startRequest());
      const started = jellyfinQuickConnectInitiationResponseSchema.parse(startedResponse.json());
      const cookie = cookieHeader(startedResponse.headers["set-cookie"]);

      const early = await app.inject(pollRequest(started.transactionId, cookie));
      expect(early.statusCode).toBe(200);
      expect(jellyfinQuickConnectPollResponseSchema.parse(early.json())).toMatchObject({
        status: "pending",
      });
      expect(test.calls.poll).toBe(0);

      test.advance(2_000);
      test.setAuthenticated(true);
      const completed = await app.inject(pollRequest(started.transactionId, cookie));
      expect(completed.statusCode).toBe(200);
      const body = jellyfinQuickConnectPollResponseSchema.parse(completed.json());
      expect(body).toMatchObject({
        principal: {
          accountState: "active",
          authenticationMethod: { kind: "jellyfin" },
          displayName: "Riley",
        },
        status: "signed_in",
      });
      expect(completed.body).not.toMatch(
        /private-jellyfin-access-token|private-quick-connect-secret/,
      );
      expect(completed.headers["set-cookie"]).toBeDefined();
      expect(test.calls).toMatchObject({ authenticate: 1, poll: 1 });
    } finally {
      await app.close();
    }
  });

  it("requires the exact application origin before starting or polling", async () => {
    const test = fixture();
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
    });
    try {
      const deniedStart = await app.inject({
        ...startRequest(),
        headers: { origin: "https://attacker.example" },
      });
      const deniedPoll = await app.inject({
        ...pollRequest("quick-connect-1", "stolen=value"),
        headers: { cookie: "stolen=value", origin: "https://attacker.example" },
      });

      expect(deniedStart.statusCode).toBe(403);
      expect(deniedPoll.statusCode).toBe(403);
      expect(test.calls).toEqual({
        authenticate: 0,
        enabled: 0,
        initiate: 0,
        poll: 0,
        publicInfo: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects extended bodies and a stolen binding before calling Jellyfin", async () => {
    const test = fixture();
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
    });
    try {
      const extended = await app.inject(startRequest({ connectorUrl: "https://attacker.example" }));
      expect(extended.statusCode).toBe(413);
      expect(test.calls.enabled).toBe(0);

      const startedResponse = await app.inject(startRequest());
      const started = jellyfinQuickConnectInitiationResponseSchema.parse(startedResponse.json());
      test.advance(2_000);
      const stolen = await app.inject(
        pollRequest(
          started.transactionId,
          `__Host-omnifin_jellyfin_qc_binding=${Buffer.alloc(32, 9).toString("base64url")}`,
        ),
      );
      expect(stolen.statusCode).toBe(400);
      expect(stolen.json()).toMatchObject({
        error: { code: "authentication_attempt_invalid" },
      });
      expect(test.calls.poll).toBe(0);
      expect(stolen.body).not.toContain(started.transactionId);
    } finally {
      await app.close();
    }
  });

  it("publishes capability-aware provider metadata", async () => {
    const test = fixture({ enabled: false });
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
    });
    try {
      const before = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      expect(before.json()).toMatchObject({
        providers: [expect.objectContaining({ kind: "jellyfin", quickConnectAvailable: true })],
      });

      const unavailable = await app.inject(startRequest());
      expect(unavailable.statusCode).toBe(503);
      const after = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      expect(after.json()).toMatchObject({
        providers: [expect.objectContaining({ kind: "jellyfin", quickConnectAvailable: false })],
      });
    } finally {
      await app.close();
    }
  });

  it("pairs Quick Connect only for the CSRF-proven pending OIDC session", async () => {
    const test = fixture();
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
      sessionDependencies: { clock: () => new Date(START) },
    });
    try {
      const pending = pendingOidcSession(app);
      const sessionCookie = `__Host-omnifin_session=${pending.sessionToken}`;
      const startedResponse = await app.inject({
        headers: {
          cookie: sessionCookie,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": pending.csrfToken,
        },
        method: "POST",
        payload: {},
        url: "/v1/auth/jellyfin/link/quick-connect",
      });
      expect(startedResponse.statusCode).toBe(200);
      const started = jellyfinQuickConnectInitiationResponseSchema.parse(startedResponse.json());
      const bindingCookie = cookieHeader(startedResponse.headers["set-cookie"]);

      const sibling = app.sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "oidc-identity-1",
          oidcProviderId: "oidc-home",
          userId: "oidc-user-1",
        },
      });
      test.advance(2_000);
      test.setAuthenticated(true);
      const stolen = await app.inject({
        headers: {
          cookie: `__Host-omnifin_session=${sibling.sessionToken}; ${bindingCookie}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": sibling.csrfToken,
        },
        method: "POST",
        payload: {},
        url: `/v1/auth/jellyfin/link/quick-connect/${started.transactionId}/poll`,
      });
      expect(stolen.statusCode).toBe(400);
      expect(stolen.json()).toMatchObject({
        error: { code: "authentication_attempt_invalid" },
      });
      expect(test.calls.poll).toBe(0);

      const completed = await app.inject({
        headers: {
          cookie: `${sessionCookie}; ${bindingCookie}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": pending.csrfToken,
        },
        method: "POST",
        payload: {},
        url: `/v1/auth/jellyfin/link/quick-connect/${started.transactionId}/poll`,
      });

      expect(completed.statusCode).toBe(200);
      expect(jellyfinQuickConnectPairingPollResponseSchema.parse(completed.json())).toMatchObject({
        principal: {
          accountState: "active",
          authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
          userId: "oidc-user-1",
        },
        status: "paired",
      });
      expect(completed.body).not.toMatch(
        /private-jellyfin-access-token|private-quick-connect-secret/,
      );
      expect(test.calls).toMatchObject({ authenticate: 1, poll: 1 });
    } finally {
      await app.close();
    }
  });

  it("bootstraps the first admin through recovery-bound Quick Connect", async () => {
    const test = fixture({ isAdministrator: true });
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
      sessionDependencies: { clock: () => new Date(START) },
    });
    try {
      const recovery = recoverySession(app);
      const sessionCookie = `__Host-omnifin_session=${recovery.sessionToken}`;
      const startedResponse = await app.inject({
        headers: {
          cookie: sessionCookie,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        method: "POST",
        payload: {},
        url: "/v1/auth/bootstrap/jellyfin/quick-connect",
      });
      expect(startedResponse.statusCode).toBe(200);
      const started = jellyfinQuickConnectInitiationResponseSchema.parse(startedResponse.json());
      const bindingCookie = cookieHeader(startedResponse.headers["set-cookie"]);

      test.advance(2_000);
      test.setAuthenticated(true);
      const completed = await app.inject({
        headers: {
          cookie: `${sessionCookie}; ${bindingCookie}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        method: "POST",
        payload: {},
        url: `/v1/auth/bootstrap/jellyfin/quick-connect/${started.transactionId}/poll`,
      });

      expect(completed.statusCode).toBe(200);
      expect(jellyfinQuickConnectBootstrapPollResponseSchema.parse(completed.json())).toMatchObject(
        {
          principal: {
            authenticationMethod: { kind: "jellyfin" },
            role: "admin",
          },
          status: "bootstrapped",
        },
      );
      expect(completed.body).not.toMatch(
        /private-jellyfin-access-token|private-quick-connect-secret/,
      );
      expect(app.sessionService.resolveAndRefresh(recovery.sessionToken)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("rejects administrator Quick Connect without CSRF before contacting Jellyfin", async () => {
    const test = fixture({ isAdministrator: true });
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
      sessionDependencies: { clock: () => new Date(START) },
    });
    try {
      const recovery = recoverySession(app);
      const response = await app.inject({
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
        },
        method: "POST",
        payload: {},
        url: "/v1/auth/bootstrap/jellyfin/quick-connect",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_denied" } });
      expect(test.calls).toEqual({
        authenticate: 0,
        enabled: 0,
        initiate: 0,
        poll: 0,
        publicInfo: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects Quick Connect pairing without CSRF before contacting Jellyfin", async () => {
    const test = fixture();
    const app = await createApp({
      config: config(),
      jellyfinQuickConnectDependencies: test.dependencies,
      sessionDependencies: { clock: () => new Date(START) },
    });
    try {
      const pending = pendingOidcSession(app);
      const response = await app.inject({
        headers: {
          cookie: `__Host-omnifin_session=${pending.sessionToken}`,
          origin: "https://omnifin.example",
        },
        method: "POST",
        payload: {},
        url: "/v1/auth/jellyfin/link/quick-connect",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_denied" } });
      expect(test.calls).toEqual({
        authenticate: 0,
        enabled: 0,
        initiate: 0,
        poll: 0,
        publicInfo: 0,
      });
    } finally {
      await app.close();
    }
  });
});
