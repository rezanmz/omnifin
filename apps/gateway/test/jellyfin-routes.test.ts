import { authenticatedSessionResponseSchema } from "@omnifin/contracts/auth";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { JellyfinSignInServiceDependencies } from "../src/auth/jellyfin/sign-in-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { externalIdentities, oidcProviders, users } from "../src/db/schema.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 81),
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
    ...overrides,
  };
}

function dependencyFixture(options: { authenticationError?: Error; serverId?: string } = {}) {
  const calls = { authentication: 0, publicInfo: 0 };
  const dependencies: JellyfinSignInServiceDependencies = {
    createClient: () => ({
      authenticateByName: async () => {
        calls.authentication += 1;
        if (options.authenticationError) throw options.authenticationError;
        return {
          AccessToken: "private-jellyfin-access-token",
          ServerId: options.serverId ?? "server-1",
          User: { Id: "jellyfin-user-1", Name: "Riley" },
        };
      },
      getPublicSystemInfo: async () => {
        calls.publicInfo += 1;
        return { Id: "server-1", ServerName: "Home Jellyfin", Version: "10.10.7" };
      },
    }),
    createDeviceId: () => "gateway-device-1",
  };
  return { calls, dependencies };
}

function request(payload: Record<string, unknown> = {}) {
  return {
    headers: { origin: "https://omnifin.example" },
    method: "POST" as const,
    payload: {
      password: "private-password",
      username: "riley",
      ...payload,
    },
    url: "/v1/auth/jellyfin/password",
  };
}

function cookieHeader(setCookie: string | string[] | undefined) {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("Expected a session cookie.");
  return value.split(";", 1)[0]!;
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
      displayName: "Riley from OIDC",
      id: "oidc-user-1",
      role: "requester",
      roleSource: "oidc_mapping",
      status: "pending_link",
    })
    .run();
  app.database.db
    .insert(externalIdentities)
    .values({
      displayClaimsJson: JSON.stringify({ displayName: "Riley from OIDC" }),
      id: "oidc-identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: new Date(),
      providerId: "oidc-home",
      subject: "immutable-oidc-subject",
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

describe("POST /v1/auth/jellyfin/password", () => {
  it("signs in without exposing the password or upstream token", async () => {
    const database = openDatabase(":memory:");
    const fixture = dependencyFixture();
    const app = await createApp({
      config: config(),
      database,
      jellyfinDependencies: fixture.dependencies,
    });
    try {
      const response = await app.inject(request());

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      const body = authenticatedSessionResponseSchema.parse(response.json());
      expect(body.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "jellyfin" },
        displayName: "Riley",
      });
      expect(response.body).not.toMatch(/private-password|private-jellyfin-access-token/);
      expect(fixture.calls).toEqual({ authentication: 1, publicInfo: 1 });

      const cookie = cookieHeader(response.headers["set-cookie"]);
      const session = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/auth/session",
      });
      expect(session.statusCode).toBe(200);
      expect(authenticatedSessionResponseSchema.parse(session.json()).principal.userId).toBe(
        body.principal.userId,
      );
    } finally {
      await app.close();
    }
  });

  it("requires the exact application origin before parsing credentials", async () => {
    const fixture = dependencyFixture();
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const response = await app.inject({
        ...request(),
        headers: { origin: "https://attacker.example" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "origin_denied" } });
      expect(fixture.calls).toEqual({ authentication: 0, publicInfo: 0 });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed or extended credential bodies before contacting Jellyfin", async () => {
    const fixture = dependencyFixture();
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const response = await app.inject(request({ upstreamUrl: "https://attacker.example" }));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(fixture.calls).toEqual({ authentication: 0, publicInfo: 0 });
      expect(response.body).not.toContain("attacker.example");
    } finally {
      await app.close();
    }
  });

  it("uses one generic denial for invalid credentials", async () => {
    const failure = new SafeConnectorError({
      code: "invalid_credentials",
      message: "Jellyfin rejected connector credentials.",
      operation: "password_authentication",
      retryable: false,
      service: "jellyfin",
      status: 401,
    });
    const fixture = dependencyFixture({ authenticationError: failure });
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const response = await app.inject(request());

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "authentication_denied" } });
      expect(response.body).not.toMatch(/private-password|riley|Jellyfin rejected/);
    } finally {
      await app.close();
    }
  });

  it("reports configuration and server-binding failures as unavailable", async () => {
    const unconfiguredConfig = config();
    delete unconfiguredConfig.jellyfinUrl;
    const unconfigured = await createApp({
      config: unconfiguredConfig,
      jellyfinDependencies: dependencyFixture().dependencies,
    });
    const mismatchedFixture = dependencyFixture({ serverId: "different-server" });
    const mismatched = await createApp({
      config: config(),
      jellyfinDependencies: mismatchedFixture.dependencies,
    });
    try {
      const unconfiguredResponse = await unconfigured.inject(request());
      const mismatchedResponse = await mismatched.inject(request());

      expect(unconfiguredResponse.statusCode).toBe(503);
      expect(mismatchedResponse.statusCode).toBe(503);
      expect(unconfiguredResponse.json()).toMatchObject({
        error: { code: "authentication_unavailable" },
      });
      expect(mismatchedResponse.body).not.toContain("different-server");
    } finally {
      await unconfigured.close();
      await mismatched.close();
    }
  });

  it("rate limits credential verification and records only safe audit metadata", async () => {
    const failure = new SafeConnectorError({
      code: "invalid_credentials",
      message: "Jellyfin rejected connector credentials.",
      operation: "password_authentication",
      retryable: false,
      service: "jellyfin",
      status: 401,
    });
    const fixture = dependencyFixture({ authenticationError: failure });
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: config(),
      database,
      jellyfinDependencies: fixture.dependencies,
    });
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const denied = await app.inject(request());
        expect(denied.statusCode).toBe(401);
      }
      const limited = await app.inject(request());

      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(fixture.calls).toEqual({ authentication: 10, publicInfo: 10 });
      const auditPayload = JSON.stringify(
        database.sqlite
          .prepare(
            `select event_type as eventType, metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.jellyfin.sign_in'`,
          )
          .all(),
      );
      expect(auditPayload).not.toMatch(/private-password|riley/);
      expect(auditPayload).toContain("authentication_denied");
      expect(auditPayload).toContain("rate_limited");
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/auth/jellyfin/link/password", () => {
  it("pairs only through a CSRF-validated pending OIDC session", async () => {
    const fixture = dependencyFixture();
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const pending = pendingOidcSession(app);
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: `__Host-omnifin_session=${pending.sessionToken}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": pending.csrfToken,
        },
        url: "/v1/auth/jellyfin/link/password",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = authenticatedSessionResponseSchema.parse(response.json());
      expect(body.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
        userId: "oidc-user-1",
      });
      expect(body.principal.linkedServices).toEqual([
        expect.objectContaining({ externalUserId: "jellyfin-user-1", health: "linked" }),
      ]);
      expect(cookieHeader(response.headers["set-cookie"])).not.toContain(pending.sessionToken);
      expect(response.body).not.toMatch(/private-password|private-jellyfin-access-token/);
      expect(fixture.calls).toEqual({ authentication: 1, publicInfo: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects a missing CSRF proof before credential parsing or upstream contact", async () => {
    const fixture = dependencyFixture();
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const pending = pendingOidcSession(app);
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: `__Host-omnifin_session=${pending.sessionToken}`,
          origin: "https://omnifin.example",
        },
        url: "/v1/auth/jellyfin/link/password",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_denied" } });
      expect(fixture.calls).toEqual({ authentication: 0, publicInfo: 0 });
      expect(
        app.database.sqlite
          .prepare(
            `select event_type as eventType
             from audit_events
             where event_type in (
               'auth.session.csrf_denied',
               'auth.jellyfin.identity.pairing_attempt'
             )
             order by event_type`,
          )
          .all(),
      ).toEqual([{ eventType: "auth.session.csrf_denied" }]);
    } finally {
      await app.close();
    }
  });

  it("rejects an authenticated non-pending session before another upstream exchange", async () => {
    const fixture = dependencyFixture();
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const signedIn = await app.inject(request());
      const signedInBody = authenticatedSessionResponseSchema.parse(signedIn.json());
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: cookieHeader(signedIn.headers["set-cookie"]),
          origin: "https://omnifin.example",
          "x-omnifin-csrf": signedInBody.csrfToken,
        },
        url: "/v1/auth/jellyfin/link/password",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "pairing_not_available" } });
      expect(fixture.calls).toEqual({ authentication: 1, publicInfo: 1 });
    } finally {
      await app.close();
    }
  });
});
