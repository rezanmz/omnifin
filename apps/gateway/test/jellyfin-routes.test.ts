import {
  ADMINISTRATOR_RECOVERY_CONFIRMATION,
  administratorRecoveryReplacementResponseSchema,
  authenticatedSessionResponseSchema,
} from "@omnifin/contracts/auth";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  AdministratorRecoveryError,
  type AdministratorRecoveryReplacementResult,
} from "../src/auth/administrator-recovery-service.js";
import {
  JellyfinQuickConnectService,
  JellyfinQuickConnectServiceError,
} from "../src/auth/jellyfin/quick-connect-service.js";
import {
  JellyfinSignInService,
  JellyfinSignInServiceError,
  type JellyfinSignInServiceDependencies,
} from "../src/auth/jellyfin/sign-in-service.js";
import { SessionIssuanceLimitError } from "../src/auth/session-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  sessions,
  users,
} from "../src/db/schema.js";

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

function dependencyFixture(
  options: { authenticationError?: Error; isAdministrator?: boolean; serverId?: string } = {},
) {
  const calls = { authentication: 0, publicInfo: 0 };
  const dependencies: JellyfinSignInServiceDependencies = {
    createClient: () => ({
      authenticateByName: async () => {
        calls.authentication += 1;
        if (options.authenticationError) throw options.authenticationError;
        return {
          AccessToken: "private-jellyfin-access-token",
          ServerId: options.serverId ?? "server-1",
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

function recoverySession(app: Awaited<ReturnType<typeof createApp>>) {
  return app.sessionService.createSession({ attribution: { authMethod: "recovery" } });
}

async function administratorRecoveryRouteHarness() {
  const app = await createApp({
    config: config(),
    jellyfinDependencies: dependencyFixture({ isAdministrator: true }).dependencies,
  });
  const recovery = recoverySession(app);
  const target = {
    administratorId: "target-administrator",
    confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION,
    expectedUpdatedAt: new Date().toISOString(),
  };
  return {
    app,
    headers: {
      cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
      origin: "https://omnifin.example",
      "x-omnifin-csrf": recovery.csrfToken,
    },
    passwordBody: { ...target, password: "private-password", username: "replacement" },
    recovery,
    target,
  };
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

describe("POST /v1/auth/bootstrap/jellyfin/password", () => {
  it("requires CSRF-proven recovery access and replaces it with the first admin session", async () => {
    const fixture = dependencyFixture({ isAdministrator: true });
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const recovery = recoverySession(app);
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        url: "/v1/auth/bootstrap/jellyfin/password",
      });

      expect(response.statusCode).toBe(200);
      const body = authenticatedSessionResponseSchema.parse(response.json());
      expect(body.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "jellyfin" },
        role: "admin",
      });
      expect(cookieHeader(response.headers["set-cookie"])).not.toContain(recovery.sessionToken);
      expect(response.body).not.toMatch(/private-password|private-jellyfin-access-token/);
      expect(fixture.calls).toEqual({ authentication: 1, publicInfo: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects missing CSRF proof before parsing credentials or contacting Jellyfin", async () => {
    const fixture = dependencyFixture({ isAdministrator: true });
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const recovery = recoverySession(app);
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
        },
        url: "/v1/auth/bootstrap/jellyfin/password",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_denied" } });
      expect(fixture.calls).toEqual({ authentication: 0, publicInfo: 0 });
    } finally {
      await app.close();
    }
  });

  it("fails closed for a non-administrator Jellyfin account", async () => {
    const fixture = dependencyFixture({ isAdministrator: false });
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const recovery = recoverySession(app);
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        url: "/v1/auth/bootstrap/jellyfin/password",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "jellyfin_admin_required" } });
      expect(app.sessionService.resolveAndRefresh(recovery.sessionToken)?.principal).toMatchObject({
        accountState: "recovery",
      });
    } finally {
      await app.close();
    }
  });

  it("does not let an ordinary Jellyfin session invoke the recovery bootstrap", async () => {
    const fixture = dependencyFixture({ isAdministrator: true });
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const signedIn = await app.inject(request());
      const body = authenticatedSessionResponseSchema.parse(signedIn.json());
      expect(body.principal.role).toBe("viewer");

      const response = await app.inject({
        ...request(),
        headers: {
          cookie: cookieHeader(signedIn.headers["set-cookie"]),
          origin: "https://omnifin.example",
          "x-omnifin-csrf": body.csrfToken,
        },
        url: "/v1/auth/bootstrap/jellyfin/password",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "permission_denied" } });
      expect(fixture.calls).toEqual({ authentication: 1, publicInfo: 1 });
    } finally {
      await app.close();
    }
  });

  it("returns an opaque conflict once a local administrator already exists", async () => {
    const fixture = dependencyFixture({ isAdministrator: true });
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      app.database.db
        .insert(users)
        .values({
          displayName: "Existing administrator",
          id: "existing-admin",
          role: "admin",
          roleSource: "manual",
          status: "active",
        })
        .run();
      const recovery = recoverySession(app);
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        url: "/v1/auth/bootstrap/jellyfin/password",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "bootstrap_not_available" } });
      expect(response.body).not.toMatch(/existing-admin|private-password/u);
      expect(app.sessionService.resolveAndRefresh(recovery.sessionToken)?.principal).toMatchObject({
        accountState: "recovery",
      });
    } finally {
      await app.close();
    }
  });

  it("maps rejected credentials and upstream failure to distinct safe bootstrap errors", async () => {
    const testCases = [
      {
        error: new SafeConnectorError({
          code: "invalid_credentials",
          message: "Jellyfin rejected connector credentials.",
          operation: "password_authentication",
          retryable: false,
          service: "jellyfin",
          status: 401,
        }),
        expectedCode: "authentication_denied",
        expectedStatus: 401,
      },
      {
        error: new Error("private upstream failure"),
        expectedCode: "authentication_unavailable",
        expectedStatus: 503,
      },
    ] as const;

    for (const testCase of testCases) {
      const fixture = dependencyFixture({ authenticationError: testCase.error });
      const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
      try {
        const recovery = recoverySession(app);
        const response = await app.inject({
          ...request(),
          headers: {
            cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
            origin: "https://omnifin.example",
            "x-omnifin-csrf": recovery.csrfToken,
          },
          url: "/v1/auth/bootstrap/jellyfin/password",
        });

        expect(response.statusCode).toBe(testCase.expectedStatus);
        expect(response.json()).toMatchObject({ error: { code: testCase.expectedCode } });
        expect(response.body).not.toMatch(/private-password|private upstream failure/u);
        expect(
          app.sessionService.resolveAndRefresh(recovery.sessionToken)?.principal,
        ).toMatchObject({ accountState: "recovery" });
      } finally {
        await app.close();
      }
    }
  });

  it("rejects malformed bootstrap credentials before contacting Jellyfin", async () => {
    const fixture = dependencyFixture({ isAdministrator: true });
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const recovery = recoverySession(app);
      const response = await app.inject({
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        method: "POST",
        payload: { password: "private-password" },
        url: "/v1/auth/bootstrap/jellyfin/password",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(fixture.calls).toEqual({ authentication: 0, publicInfo: 0 });
    } finally {
      await app.close();
    }
  });
});

describe("POST /v1/auth/recovery/administrator-replacement/jellyfin/password", () => {
  it("requires exact recovery browser proof and replaces only the sole administrator", async () => {
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    const fixture = dependencyFixture({ isAdministrator: true });
    const app = await createApp({
      config: config({ logLevel: "info" }),
      jellyfinDependencies: fixture.dependencies,
    });
    const createdAt = new Date(Date.now() - 1_000);
    try {
      const connector = app.database.db.select().from(connectorConfigs).get();
      if (!connector) throw new Error("Expected the configured Jellyfin connector.");
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
        app.database.db
          .insert(users)
          .values({
            createdAt,
            displayName: account.role === "admin" ? "Current administrator" : "Replacement account",
            id: account.id,
            role: account.role,
            roleSource: account.role === "admin" ? "manual" : "default",
            status: "active",
            updatedAt: createdAt,
          })
          .run();
        app.database.db
          .insert(serviceIdentityLinks)
          .values({
            connectorId: connector.id,
            createdAt,
            deviceId: `${account.id}-device`,
            encryptedAccessToken: `v2.${account.id}-token`,
            externalDisplayName: account.id,
            externalServerId: "server-1",
            externalUserId: account.externalUserId,
            externalUsername: account.id,
            healthState: "linked",
            id: `${account.id}-link`,
            lastVerifiedAt: createdAt,
            service: "jellyfin",
            tokenCreatedAt: createdAt,
            updatedAt: createdAt,
            userId: account.id,
          })
          .run();
      }
      const administrator = app.sessionService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "target-administrator-link",
          userId: "target-administrator",
        },
      });
      app.sessionService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "replacement-account-link",
          userId: "replacement-account",
        },
      });
      const recovery = recoverySession(app);
      const body = {
        administratorId: "target-administrator",
        confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION,
        expectedUpdatedAt: createdAt.toISOString(),
        password: "private-password",
        username: "replacement",
      };
      const endpoint = "/v1/auth/recovery/administrator-replacement/jellyfin/password";

      const blocked = await Promise.all([
        app.inject({
          body,
          headers: { origin: "https://omnifin.example" },
          method: "POST",
          url: endpoint,
        }),
        app.inject({
          body,
          headers: {
            cookie: `__Host-omnifin_session=${administrator.sessionToken}`,
            origin: "https://omnifin.example",
            "x-omnifin-csrf": administrator.csrfToken,
          },
          method: "POST",
          url: endpoint,
        }),
        app.inject({
          body,
          headers: {
            cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
            origin: "https://omnifin.example",
          },
          method: "POST",
          url: endpoint,
        }),
        app.inject({
          body,
          headers: {
            cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
            origin: "https://attacker.example",
            "x-omnifin-csrf": recovery.csrfToken,
          },
          method: "POST",
          url: endpoint,
        }),
      ]);
      expect(blocked.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
      expect(fixture.calls).toEqual({ authentication: 0, publicInfo: 0 });

      const response = await app.inject({
        body,
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        method: "POST",
        url: endpoint,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(administratorRecoveryReplacementResponseSchema.parse(response.json())).toMatchObject({
        revokedSessions: { recovery: 1, replacement: 1, target: 1 },
        status: "replaced",
      });
      expect(response.body).not.toMatch(
        /private-password|private-jellyfin-access-token|jellyfin-user-1|server-1/,
      );
      expect(fixture.calls).toEqual({ authentication: 1, publicInfo: 1 });
      expect(
        app.database.db
          .select()
          .from(users)
          .all()
          .map(({ id, role, status }) => ({ id, role, status })),
      ).toEqual([
        { id: "target-administrator", role: "admin", status: "disabled" },
        { id: "replacement-account", role: "admin", status: "active" },
      ]);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .filter((session) => session.revokedAt === null),
      ).toHaveLength(1);
      expect(output.join("\n")).not.toMatch(
        /private-password|private-jellyfin-access-token|jellyfin-user-1|server-1/,
      );
    } finally {
      await app.close();
      stdout.mockRestore();
    }
  });

  it.each([
    ["denied", 403],
    ["unavailable", 409],
  ] as const)("returns a bounded %s replacement outcome", async (status, expectedStatus) => {
    const test = await administratorRecoveryRouteHarness();
    const replace = vi
      .spyOn(JellyfinSignInService.prototype, "replaceAdministratorWithPassword")
      .mockResolvedValue({ status } as AdministratorRecoveryReplacementResult);
    try {
      const response = await test.app.inject({
        body: test.passwordBody,
        headers: test.headers,
        method: "POST",
        url: "/v1/auth/recovery/administrator-replacement/jellyfin/password",
      });
      expect(response.statusCode, response.body).toBe(expectedStatus);
      expect(administratorRecoveryReplacementResponseSchema.parse(response.json())).toEqual({
        status,
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      replace.mockRestore();
      await test.app.close();
    }
  });

  it.each([
    [new SessionIssuanceLimitError("issuance_rate_limit"), 429, "rate_limit_exceeded", "86400"],
    [new JellyfinSignInServiceError("provider_unavailable"), 503, undefined, undefined],
    [new AdministratorRecoveryError("storage_failure"), 503, undefined, undefined],
  ] as const)(
    "fails closed when password replacement throws %#",
    async (error, status, code, retryAfter) => {
      const test = await administratorRecoveryRouteHarness();
      const replace = vi
        .spyOn(JellyfinSignInService.prototype, "replaceAdministratorWithPassword")
        .mockRejectedValue(error);
      try {
        const response = await test.app.inject({
          body: test.passwordBody,
          headers: test.headers,
          method: "POST",
          url: "/v1/auth/recovery/administrator-replacement/jellyfin/password",
        });
        expect(response.statusCode, response.body).toBe(status);
        expect(response.headers["retry-after"]).toBe(retryAfter);
        if (code) expect(response.json()).toMatchObject({ error: { code } });
        else expect(response.json()).toEqual({ status: "unavailable" });
      } finally {
        replace.mockRestore();
        await test.app.close();
      }
    },
  );

  it("rejects malformed password replacement input before service dispatch", async () => {
    const test = await administratorRecoveryRouteHarness();
    const replace = vi.spyOn(JellyfinSignInService.prototype, "replaceAdministratorWithPassword");
    try {
      const response = await test.app.inject({
        body: { ...test.passwordBody, unexpected: true },
        headers: test.headers,
        method: "POST",
        url: "/v1/auth/recovery/administrator-replacement/jellyfin/password",
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(replace).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
      await test.app.close();
    }
  });

  it.each([
    ["recovery_session_required", 409],
    ["capacity_exceeded", 503],
    ["configuration_invalid", 503],
    ["invalid_transaction", 503],
    ["pairing_session_required", 503],
    ["provider_unavailable", 503],
    ["quick_connect_disabled", 503],
  ] as const)("maps administrator Quick Connect start failure %s", async (reason, status) => {
    const test = await administratorRecoveryRouteHarness();
    const start = vi
      .spyOn(JellyfinQuickConnectService.prototype, "startAdministratorReplacement")
      .mockRejectedValue(new JellyfinQuickConnectServiceError(reason));
    try {
      const response = await test.app.inject({
        body: test.target,
        headers: test.headers,
        method: "POST",
        url: "/v1/auth/recovery/administrator-replacement/jellyfin/quick-connect",
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toEqual({ status: "unavailable" });
    } finally {
      start.mockRestore();
      await test.app.close();
    }
  });

  it("starts administrator Quick Connect and rejects malformed confirmation", async () => {
    const test = await administratorRecoveryRouteHarness();
    const start = vi
      .spyOn(JellyfinQuickConnectService.prototype, "startAdministratorReplacement")
      .mockResolvedValue({
        browserBindingToken: Buffer.alloc(32, 7).toString("base64url"),
        code: "ABCD12",
        expiresAt: new Date(Date.now() + 60_000),
        pollAfterMs: 1_000,
        transactionId: "quick-connect-1",
      } as never);
    try {
      const invalid = await test.app.inject({
        body: { ...test.target, confirmation: "incorrect" },
        headers: test.headers,
        method: "POST",
        url: "/v1/auth/recovery/administrator-replacement/jellyfin/quick-connect",
      });
      expect(invalid.statusCode).toBe(400);
      expect(start).not.toHaveBeenCalled();

      const response = await test.app.inject({
        body: test.target,
        headers: test.headers,
        method: "POST",
        url: "/v1/auth/recovery/administrator-replacement/jellyfin/quick-connect",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ code: "ABCD12", transactionId: "quick-connect-1" });
      expect(response.headers["set-cookie"]).toBeTruthy();
    } finally {
      start.mockRestore();
      await test.app.close();
    }
  });

  it.each([
    [{ status: "expired" }, 200, "expired"],
    [
      { expiresAt: new Date(Date.now() + 60_000), pollAfterMs: 1_000, status: "pending" },
      200,
      "pending",
    ],
    [{ status: "denied" }, 403, "denied"],
    [{ status: "unavailable" }, 409, "unavailable"],
  ] as const)(
    "maps administrator Quick Connect poll result %#",
    async (result, status, bodyStatus) => {
      const test = await administratorRecoveryRouteHarness();
      const poll = vi
        .spyOn(JellyfinQuickConnectService.prototype, "pollAdministratorReplacement")
        .mockResolvedValue(result as never);
      try {
        const response = await test.app.inject({
          body: {},
          headers: test.headers,
          method: "POST",
          url: "/v1/auth/recovery/administrator-replacement/jellyfin/quick-connect/quick-connect-1/poll",
        });
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ status: bodyStatus });
      } finally {
        poll.mockRestore();
        await test.app.close();
      }
    },
  );

  it.each([
    [new SessionIssuanceLimitError("active_session_limit"), 429, "rate_limit_exceeded"],
    [
      new JellyfinQuickConnectServiceError("invalid_transaction"),
      400,
      "authentication_attempt_invalid",
    ],
    [new JellyfinQuickConnectServiceError("recovery_session_required"), 409, undefined],
    [new JellyfinQuickConnectServiceError("provider_unavailable"), 503, undefined],
    [new AdministratorRecoveryError("unavailable"), 503, undefined],
  ] as const)(
    "fails closed for administrator Quick Connect poll error %#",
    async (error, status, code) => {
      const test = await administratorRecoveryRouteHarness();
      const poll = vi
        .spyOn(JellyfinQuickConnectService.prototype, "pollAdministratorReplacement")
        .mockRejectedValue(error);
      try {
        const response = await test.app.inject({
          body: {},
          headers: test.headers,
          method: "POST",
          url: "/v1/auth/recovery/administrator-replacement/jellyfin/quick-connect/quick-connect-1/poll",
        });
        expect(response.statusCode, response.body).toBe(status);
        if (code) expect(response.json()).toMatchObject({ error: { code } });
        else expect(response.json()).toEqual({ status: "unavailable" });
      } finally {
        poll.mockRestore();
        await test.app.close();
      }
    },
  );
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

  it("denies recovery access before parsing pairing credentials or contacting Jellyfin", async () => {
    const fixture = dependencyFixture();
    const app = await createApp({ config: config(), jellyfinDependencies: fixture.dependencies });
    try {
      const recovery = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const response = await app.inject({
        ...request(),
        headers: {
          cookie: `__Host-omnifin_session=${recovery.sessionToken}`,
          origin: "https://omnifin.example",
          "x-omnifin-csrf": recovery.csrfToken,
        },
        url: "/v1/auth/jellyfin/link/password",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "permission_denied" } });
      expect(fixture.calls).toEqual({ authentication: 0, publicInfo: 0 });
      const auditPayload = JSON.stringify(
        app.database.sqlite
          .prepare(
            `select metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.jellyfin.identity.pairing_attempt'`,
          )
          .all(),
      );
      expect(auditPayload).toContain("permission_denied");
      expect(auditPayload).not.toMatch(/private-password|riley/u);
    } finally {
      await app.close();
    }
  });
});
