import { oidcProviderAdminSchema, oidcProvidersAdminResponseSchema } from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import { oidcClientSecretEncryptionContext } from "../src/auth/oidc/provider-registry.js";
import type { AppConfig } from "../src/config.js";
import { externalIdentities, oidcProviders, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-26T15:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 71),
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

function sessionDependencies() {
  let identifier = 0;
  let token = 0;
  return {
    clock: () => new Date(now),
    createId: () => `admin-session-${(identifier += 1)}`,
    createToken: () => Buffer.alloc(32, (token += 1) % 255).toString("base64url"),
  };
}

function providerDependencies() {
  let identifier = 0;
  return {
    clock: () => new Date(now),
    createId: () => `admin-${(identifier += 1)}`,
  };
}

const providerRequest = {
  allowJitProvisioning: true,
  approvedEndpointOrigins: ["https://id.example.test"],
  clientId: "omnifin",
  clientSecret: "private-client-secret",
  displayName: "Home identity",
  enabled: true,
  idTokenSigningAlg: "RS256",
  issuer: "https://id.example.test/application/o/omnifin/",
  scopes: ["openid", "profile", "email", "groups"],
  slug: "home-identity",
  tokenEndpointAuthMethod: "client_secret_basic",
} as const;

async function harness() {
  const config = testConfig();
  const app = await createApp({
    config,
    oidcProviderAdminDependencies: providerDependencies(),
    sessionDependencies: sessionDependencies(),
  });
  const session = app.sessionService.createSession({
    attribution: { authMethod: "recovery" },
    ipAddress: "127.0.0.1",
    requestId: "recovery-session-request",
  });
  return { app, config, session };
}

function authenticatedHeaders(session: Awaited<ReturnType<typeof harness>>["session"]) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    origin: baseUrl,
    [SESSION_CSRF_HEADER]: session.csrfToken,
    "user-agent": "provider administration test",
    "x-request-id": "adminreq-001",
  };
}

function pendingViewerSession(app: Awaited<ReturnType<typeof createApp>>) {
  app.database.db
    .insert(oidcProviders)
    .values({
      clientId: "viewer-client",
      displayName: "Viewer identity",
      enabled: true,
      id: "oidc-viewer",
      issuer: "https://viewer-id.example.test/application/o/omnifin/",
      slug: "viewer-identity",
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Viewer",
      id: "viewer-user",
      role: "viewer",
      roleSource: "oidc_mapping",
      status: "pending_link",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(externalIdentities)
    .values({
      createdAt: now,
      displayClaimsJson: JSON.stringify({ displayName: "Viewer" }),
      id: "viewer-identity",
      issuer: "https://viewer-id.example.test/application/o/omnifin/",
      lastLoginAt: now,
      providerId: "oidc-viewer",
      subject: "immutable-viewer-subject",
      updatedAt: now,
      userId: "viewer-user",
    })
    .run();
  return app.sessionService.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "viewer-identity",
      oidcProviderId: "oidc-viewer",
      userId: "viewer-user",
    },
  });
}

describe("OIDC provider administration routes", () => {
  it("creates and lists an encrypted, secret-free provider configuration with an audit record", async () => {
    const { app, config, session } = await harness();
    try {
      const response = await app.inject({
        body: providerRequest,
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const provider = oidcProviderAdminSchema.parse(response.json());
      expect(provider).toMatchObject({
        clientSecretConfigured: true,
        discoveryCheckedAt: null,
        discoveryState: "unchecked",
        id: "oidc-admin-1",
        slug: "home-identity",
      });
      expect(response.body).not.toContain(providerRequest.clientSecret);

      const stored = app.database.sqlite
        .prepare(
          `select encrypted_client_secret as encryptedClientSecret
           from oidc_providers where id = ?`,
        )
        .get(provider.id) as { encryptedClientSecret: string };
      expect(stored.encryptedClientSecret).not.toContain(providerRequest.clientSecret);
      expect(
        new EnvelopeCipher(config.encryptionKey).decrypt(
          stored.encryptedClientSecret,
          oidcClientSecretEncryptionContext(provider.id),
        ),
      ).toBe(providerRequest.clientSecret);
      expect(app.database.sqlite.serialize().toString("utf8")).not.toContain(
        providerRequest.clientSecret,
      );

      const audit = app.database.sqlite
        .prepare(
          `select actor_session_id as actorSessionId,
                  actor_auth_method as actorAuthMethod,
                  event_type as eventType,
                  outcome,
                  target_id as targetId,
                  metadata_json as metadataJson
           from audit_events where event_type = 'auth.oidc.provider.created'`,
        )
        .get() as Record<string, unknown>;
      expect(audit).toMatchObject({
        actorAuthMethod: "recovery",
        actorSessionId: session.principal.sessionId,
        eventType: "auth.oidc.provider.created",
        outcome: "success",
        targetId: provider.id,
      });
      expect(JSON.parse(audit.metadataJson as string)).toEqual({
        allowJitProvisioning: true,
        enabled: true,
        tokenEndpointAuthMethod: "client_secret_basic",
      });

      const list = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(list.statusCode).toBe(200);
      expect(oidcProvidersAdminResponseSchema.parse(list.json())).toEqual({
        providers: [provider],
      });
      expect(list.body).not.toContain(providerRequest.clientSecret);
    } finally {
      await app.close();
    }
  });

  it("requires an authenticated permission boundary and CSRF proof", async () => {
    const { app, session } = await harness();
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(anonymous.statusCode).toBe(401);

      const missingCsrf = await app.inject({
        body: providerRequest,
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
          origin: baseUrl,
        },
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(
        app.database.sqlite.prepare("select count(*) as count from oidc_providers").get(),
      ).toEqual({ count: 0 });

      const viewer = pendingViewerSession(app);
      const forbidden = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejects duplicate issuer and slug configuration without overwriting the first provider", async () => {
    const { app, session } = await harness();
    try {
      const request = {
        body: providerRequest,
        headers: authenticatedHeaders(session),
        method: "POST" as const,
        url: "/v1/admin/auth/oidc/providers",
      };
      expect((await app.inject(request)).statusCode).toBe(201);
      const duplicate = await app.inject(request);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ error: { code: "oidc_provider_conflict" } });
      expect(
        app.database.sqlite.prepare("select count(*) as count from oidc_providers").get(),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });
});
