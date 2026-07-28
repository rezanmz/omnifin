import {
  oidcProviderAdminSchema,
  oidcProviderDeleteResponseSchema,
  oidcProviderMutationResponseSchema,
  oidcProviderValidationResponseSchema,
  oidcProvidersAdminResponseSchema,
} from "@omnifin/contracts/auth";
import {
  Configuration,
  type ClientAuth,
  type ClientMetadata,
  type ServerMetadata,
} from "openid-client";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import { oidcClientSecretEncryptionContext } from "../src/auth/oidc/provider-registry.js";
import type { AppConfig } from "../src/config.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  roleMappings,
  serviceIdentityLinks,
  sessions,
  users,
} from "../src/db/schema.js";
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

const providerConfiguration = {
  allowJitProvisioning: true,
  approvedEndpointOrigins: ["https://id.example.test"],
  clientId: "omnifin",
  displayName: "Home identity",
  enabled: true,
  idTokenSigningAlg: "RS256",
  issuer: "https://id.example.test/application/o/omnifin/",
  scopes: ["openid", "profile", "email", "groups"],
  slug: "home-identity",
  tokenEndpointAuthMethod: "client_secret_basic",
} as const;

const providerRequest = {
  ...providerConfiguration,
  clientSecret: "private-client-secret",
} as const;

function validationMetadata(overrides: Readonly<Record<string, unknown>> = {}): ServerMetadata {
  return {
    authorization_endpoint: "https://id.example.test/application/o/authorize/",
    backchannel_logout_session_supported: true,
    backchannel_logout_supported: true,
    code_challenge_methods_supported: ["S256"],
    end_session_endpoint: "https://id.example.test/application/o/omnifin/end-session/",
    frontchannel_logout_session_supported: true,
    frontchannel_logout_supported: true,
    grant_types_supported: ["authorization_code"],
    id_token_signing_alg_values_supported: ["RS256"],
    issuer: providerRequest.issuer,
    jwks_uri: "https://id.example.test/application/o/omnifin/jwks/",
    response_types_supported: ["code"],
    token_endpoint: "https://id.example.test/application/o/token/",
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    userinfo_endpoint: "https://id.example.test/application/o/userinfo/",
    ...overrides,
  } as ServerMetadata;
}

function providerRegistryDependencies(server: ServerMetadata = validationMetadata()) {
  return {
    createSafeFetch: vi.fn(() => vi.fn()),
    discover: vi.fn(
      async (
        _server: URL,
        clientId: string,
        clientMetadata?: Partial<ClientMetadata> | string,
        clientAuthentication?: ClientAuth,
      ) => new Configuration(server, clientId, clientMetadata, clientAuthentication),
    ),
  };
}

async function harness(
  registryDependencies: ReturnType<
    typeof providerRegistryDependencies
  > = providerRegistryDependencies(),
  adminDependencies: ReturnType<typeof providerDependencies> = providerDependencies(),
) {
  const config = testConfig();
  const app = await createApp({
    config,
    oidcProviderAdminDependencies: {
      ...adminDependencies,
      providerRegistry: registryDependencies,
    },
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
      approvedEndpointOriginsJson: JSON.stringify(["https://viewer-id.example.test"]),
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

function activeAdminSession(app: Awaited<ReturnType<typeof createApp>>) {
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin-admin.example.test",
      createdAt: now,
      displayName: "Administrator Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-admin",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(["https://admin-id.example.test"]),
      clientId: "admin-user-client",
      displayName: "Administrator identity",
      enabled: true,
      id: "oidc-admin-user",
      issuer: "https://admin-id.example.test/application/o/omnifin/",
      slug: "administrator-identity",
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Administrator",
      id: "admin-user",
      role: "admin",
      roleSource: "oidc_mapping",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(externalIdentities)
    .values({
      createdAt: now,
      displayClaimsJson: JSON.stringify({ displayName: "Administrator" }),
      id: "admin-identity",
      issuer: "https://admin-id.example.test/application/o/omnifin/",
      lastLoginAt: now,
      providerId: "oidc-admin-user",
      subject: "immutable-admin-subject",
      updatedAt: now,
      userId: "admin-user",
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-admin",
      createdAt: now,
      deviceId: "admin-device",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Administrator",
      externalServerId: "admin-server",
      externalUserId: "admin-external-user",
      externalUsername: "administrator",
      healthState: "linked",
      id: "admin-jellyfin-link",
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "admin-user",
    })
    .run();
  return app.sessionService.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "admin-identity",
      oidcProviderId: "oidc-admin-user",
      serviceIdentityLinkId: "admin-jellyfin-link",
      userId: "admin-user",
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
        id: "oidc-home-identity",
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

  it("namespaces base64url audit entropy before enforcing identifier shape", async () => {
    const { app, session } = await harness(providerRegistryDependencies(), {
      clock: () => new Date(now),
      createId: () => "-fixture-entropy",
    });
    try {
      const response = await app.inject({
        body: providerRequest,
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(
        app.database.sqlite
          .prepare("select id from audit_events where event_type = 'auth.oidc.provider.created'")
          .get(),
      ).toEqual({ id: "audit--fixture-entropy" });
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

      const missingUpdateCsrf = await app.inject({
        body: providerRequest,
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
          origin: baseUrl,
        },
        method: "PUT",
        url: "/v1/admin/auth/oidc/providers/oidc-missing",
      });
      expect(missingUpdateCsrf.statusCode).toBe(403);

      const missingDeleteCsrf = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
          origin: baseUrl,
        },
        method: "DELETE",
        url: "/v1/admin/auth/oidc/providers/oidc-missing",
      });
      expect(missingDeleteCsrf.statusCode).toBe(403);

      const viewer = pendingViewerSession(app);
      const forbidden = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(forbidden.statusCode).toBe(403);

      const admin = activeAdminSession(app);
      const permitted = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${admin.sessionToken}` },
        method: "GET",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(permitted.statusCode).toBe(200);
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
      const createdResponse = await app.inject(request);
      expect(createdResponse.statusCode).toBe(201);
      const created = oidcProviderAdminSchema.parse(createdResponse.json());
      const duplicate = await app.inject(request);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ error: { code: "oidc_provider_conflict" } });
      expect(
        app.database.sqlite.prepare("select count(*) as count from oidc_providers").get(),
      ).toEqual({ count: 1 });

      const renamed = await app.inject({
        body: { ...providerRequest, slug: "renamed-identity" },
        headers: authenticatedHeaders(session),
        method: "PUT",
        url: `/v1/admin/auth/oidc/providers/${created.id}`,
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      const staleIdCollision = await app.inject({
        body: {
          ...providerRequest,
          approvedEndpointOrigins: ["https://replacement-id.example.test"],
          issuer: "https://replacement-id.example.test/application/o/omnifin/",
        },
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      expect(staleIdCollision.statusCode).toBe(409);
      expect(staleIdCollision.json()).toMatchObject({
        error: { code: "oidc_provider_conflict" },
      });
      expect(
        app.database.sqlite.prepare("select count(*) as count from oidc_providers").get(),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("updates a provider atomically, retains omitted secrets, and revokes its OIDC sessions", async () => {
    const { app, config, session } = await harness();
    try {
      const createdResponse = await app.inject({
        body: providerRequest,
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      const created = oidcProviderAdminSchema.parse(createdResponse.json());
      app.database.db
        .update(oidcProviders)
        .set({
          discoveryCapabilitiesJson: JSON.stringify({ schemaVersion: 1 }),
          discoveryCheckedAt: now,
          discoveryState: "ready",
        })
        .run();
      app.database.db
        .insert(users)
        .values({
          createdAt: now,
          displayName: "Managed viewer",
          id: "managed-viewer",
          role: "viewer",
          roleSource: "default",
          status: "active",
          updatedAt: now,
        })
        .run();
      app.database.db
        .insert(externalIdentities)
        .values({
          createdAt: now,
          displayClaimsJson: JSON.stringify({ displayName: "Managed viewer" }),
          id: "managed-viewer-identity",
          issuer: providerRequest.issuer,
          lastLoginAt: now,
          providerId: created.id,
          subject: "immutable-managed-viewer",
          updatedAt: now,
          userId: "managed-viewer",
        })
        .run();
      app.database.db
        .insert(connectorConfigs)
        .values({
          baseUrl: "https://managed-jellyfin.example.test",
          createdAt: now,
          displayName: "Managed Jellyfin",
          encryptedCredentials: "v2.fixture-managed-credentials",
          healthState: "healthy",
          id: "managed-jellyfin",
          type: "jellyfin",
          updatedAt: now,
        })
        .run();
      app.database.db
        .insert(serviceIdentityLinks)
        .values({
          connectorId: "managed-jellyfin",
          createdAt: now,
          deviceId: "managed-device",
          encryptedAccessToken: "v2.fixture-managed-token",
          externalDisplayName: "Managed viewer",
          externalServerId: "managed-server",
          externalUserId: "managed-external-user",
          externalUsername: "managed-viewer",
          healthState: "linked",
          id: "managed-viewer-link",
          lastVerifiedAt: now,
          service: "jellyfin",
          tokenCreatedAt: now,
          updatedAt: now,
          userId: "managed-viewer",
        })
        .run();
      const affectedSession = app.sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "managed-viewer-identity",
          oidcProviderId: created.id,
          serviceIdentityLinkId: "managed-viewer-link",
          userId: "managed-viewer",
        },
      });
      const directJellyfinSession = app.sessionService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "managed-viewer-link",
          userId: "managed-viewer",
        },
      });

      const enabledDelete = await app.inject({
        headers: authenticatedHeaders(session),
        method: "DELETE",
        url: `/v1/admin/auth/oidc/providers/${created.id}`,
      });
      expect(enabledDelete.statusCode).toBe(409);
      expect(enabledDelete.json()).toMatchObject({
        error: { code: "oidc_provider_must_be_disabled" },
      });

      const updateBase = providerConfiguration;
      const updatedResponse = await app.inject({
        body: {
          ...updateBase,
          clientId: "omnifin-reconfigured",
          displayName: "Home identity control",
          enabled: false,
          slug: "home-identity-control",
          tokenEndpointAuthMethod: "client_secret_post",
        },
        headers: authenticatedHeaders(session),
        method: "PUT",
        url: `/v1/admin/auth/oidc/providers/${created.id}`,
      });
      expect(updatedResponse.statusCode, updatedResponse.body).toBe(200);
      expect(updatedResponse.headers["cache-control"]).toBe("no-store");
      const updated = oidcProviderMutationResponseSchema.parse(updatedResponse.json());
      expect(updated).toMatchObject({
        provider: {
          clientId: "omnifin-reconfigured",
          clientSecretConfigured: true,
          discoveryCheckedAt: null,
          discoveryState: "unchecked",
          displayName: "Home identity control",
          enabled: false,
          id: created.id,
          slug: "home-identity-control",
          tokenEndpointAuthMethod: "client_secret_post",
        },
        revokedSessions: 1,
      });
      const stored = app.database.sqlite
        .prepare(
          `select encrypted_client_secret as encryptedClientSecret
           from oidc_providers where id = ?`,
        )
        .get(created.id) as { encryptedClientSecret: string };
      expect(
        new EnvelopeCipher(config.encryptionKey).decrypt(
          stored.encryptedClientSecret,
          oidcClientSecretEncryptionContext(created.id),
        ),
      ).toBe(providerRequest.clientSecret);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((row) => row.id === affectedSession.principal.sessionId)?.revokedAt,
      ).toEqual(now);
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((row) => row.id === session.principal.sessionId)?.revokedAt,
      ).toBeNull();
      expect(
        app.database.db
          .select()
          .from(sessions)
          .all()
          .find((row) => row.id === directJellyfinSession.principal.sessionId)?.revokedAt,
      ).toBeNull();

      const issuerChange = await app.inject({
        body: {
          ...updateBase,
          approvedEndpointOrigins: ["https://replacement-id.example.test"],
          enabled: false,
          issuer: "https://replacement-id.example.test/application/o/omnifin/",
        },
        headers: authenticatedHeaders(session),
        method: "PUT",
        url: `/v1/admin/auth/oidc/providers/${created.id}`,
      });
      expect(issuerChange.statusCode).toBe(409);
      expect(issuerChange.json()).toMatchObject({ error: { code: "oidc_provider_in_use" } });

      const inUseDelete = await app.inject({
        headers: authenticatedHeaders(session),
        method: "DELETE",
        url: `/v1/admin/auth/oidc/providers/${created.id}`,
      });
      expect(inUseDelete.statusCode).toBe(409);
      expect(inUseDelete.json()).toMatchObject({ error: { code: "oidc_provider_in_use" } });

      const audit = app.database.sqlite
        .prepare(
          `select metadata_json as metadataJson
           from audit_events where event_type = 'auth.oidc.provider.updated'`,
        )
        .get() as { metadataJson: string };
      expect(JSON.parse(audit.metadataJson)).toEqual({
        changedFields: ["clientId", "displayName", "enabled", "slug", "tokenEndpointAuthMethod"],
        revokedSessions: 1,
        runtimeReset: true,
      });
      expect(audit.metadataJson).not.toContain("omnifin-reconfigured");
      expect(audit.metadataJson).not.toContain(providerRequest.clientSecret);
    } finally {
      await app.close();
    }
  });

  it("deletes only disabled unused providers and cascades their unbound mappings", async () => {
    const { app, session } = await harness();
    try {
      const createdResponse = await app.inject({
        body: { ...providerRequest, enabled: false },
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      const provider = oidcProviderAdminSchema.parse(createdResponse.json());
      app.database.db
        .insert(roleMappings)
        .values({
          claimPathJson: JSON.stringify(["groups"]),
          createdAt: now,
          enabled: true,
          id: "deletion-mapping",
          operator: "contains_any",
          priority: 500,
          providerId: provider.id,
          role: "operator",
          updatedAt: now,
          valuesJson: JSON.stringify(["operators"]),
        })
        .run();

      const deletedResponse = await app.inject({
        headers: authenticatedHeaders(session),
        method: "DELETE",
        url: `/v1/admin/auth/oidc/providers/${provider.id}`,
      });
      expect(deletedResponse.statusCode, deletedResponse.body).toBe(200);
      expect(oidcProviderDeleteResponseSchema.parse(deletedResponse.json())).toEqual({
        deletedProviderId: provider.id,
        deletedRoleMappings: 1,
        revokedSessions: 0,
      });
      expect(app.database.db.select().from(oidcProviders).all()).toEqual([]);
      expect(app.database.db.select().from(roleMappings).all()).toEqual([]);
      const audit = app.database.sqlite
        .prepare(
          `select metadata_json as metadataJson, target_id as targetId
           from audit_events where event_type = 'auth.oidc.provider.deleted'`,
        )
        .get() as { metadataJson: string; targetId: string };
      expect(audit.targetId).toBe(provider.id);
      expect(JSON.parse(audit.metadataJson)).toEqual({
        deletedRoleMappings: 1,
        revokedSessions: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("requires a fresh secret when a public client becomes confidential", async () => {
    const { app, session } = await harness();
    try {
      const publicRequest = providerConfiguration;
      const createdResponse = await app.inject({
        body: { ...publicRequest, tokenEndpointAuthMethod: "none" },
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      const provider = oidcProviderAdminSchema.parse(createdResponse.json());
      const update = await app.inject({
        body: publicRequest,
        headers: authenticatedHeaders(session),
        method: "PUT",
        url: `/v1/admin/auth/oidc/providers/${provider.id}`,
      });
      expect(update.statusCode).toBe(422);
      expect(update.json()).toMatchObject({
        error: { code: "oidc_provider_client_secret_required" },
      });
      expect(app.database.db.select().from(oidcProviders).get()).toMatchObject({
        encryptedClientSecret: null,
        tokenEndpointAuthMethod: "none",
      });
    } finally {
      await app.close();
    }
  });

  it("freshly validates a disabled provider without exposing protocol endpoints or enabling sign-in", async () => {
    const registryDependencies = providerRegistryDependencies();
    const { app, session } = await harness(registryDependencies);
    try {
      const created = await app.inject({
        body: { ...providerRequest, enabled: false },
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      const provider = oidcProviderAdminSchema.parse(created.json());
      const validated = await app.inject({
        headers: authenticatedHeaders(session),
        method: "POST",
        url: `/v1/admin/auth/oidc/providers/${provider.id}/validate`,
      });

      expect(validated.statusCode, validated.body).toBe(200);
      expect(validated.headers["cache-control"]).toBe("no-store");
      const result = oidcProviderValidationResponseSchema.parse(validated.json());
      expect(result).toMatchObject({
        capabilities: {
          authorizationCodeFlow: true,
          idTokenSigningAlg: "RS256",
          pkceS256: true,
          tokenEndpointAuthMethod: "client_secret_basic",
        },
        provider: {
          discoveryState: "ready",
          enabled: false,
          id: provider.id,
        },
      });
      expect(registryDependencies.discover).toHaveBeenCalledOnce();
      expect(validated.body).not.toContain(providerRequest.clientSecret);
      expect(validated.body).not.toContain("authorization_endpoint");
      expect(validated.body).not.toContain("runtimeSecuritySeal");

      const publicProviders = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      expect(publicProviders.statusCode).toBe(200);
      expect(publicProviders.body).not.toContain(provider.id);

      const audit = app.database.sqlite
        .prepare(
          `select outcome, metadata_json as metadataJson
           from audit_events where event_type = 'auth.oidc.provider.validated'`,
        )
        .get() as { metadataJson: string; outcome: string };
      expect(audit.outcome).toBe("success");
      expect(JSON.parse(audit.metadataJson)).toEqual({ reason: "ready", retryable: false });
    } finally {
      await app.close();
    }
  });

  it("enables a validated confidential provider while retaining its encrypted secret", async () => {
    const { app, config, session } = await harness();
    try {
      const createdResponse = await app.inject({
        body: { ...providerRequest, enabled: false },
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      const created = oidcProviderAdminSchema.parse(createdResponse.json());

      const validatedResponse = await app.inject({
        headers: authenticatedHeaders(session),
        method: "POST",
        url: `/v1/admin/auth/oidc/providers/${created.id}/validate`,
      });
      expect(validatedResponse.statusCode, validatedResponse.body).toBe(200);

      const mappingResponse = await app.inject({
        body: {
          claimPath: ["groups"],
          enabled: true,
          operator: "contains_any",
          priority: 1_000,
          role: "admin",
          values: ["authentik Admins"],
        },
        headers: authenticatedHeaders(session),
        method: "POST",
        url: `/v1/admin/auth/oidc/providers/${created.id}/role-mappings`,
      });
      expect(mappingResponse.statusCode, mappingResponse.body).toBe(201);

      const enabledResponse = await app.inject({
        body: { ...providerConfiguration, clientSecret: undefined },
        headers: authenticatedHeaders(session),
        method: "PUT",
        url: `/v1/admin/auth/oidc/providers/${created.id}`,
      });
      expect(enabledResponse.statusCode, enabledResponse.body).toBe(200);
      expect(oidcProviderMutationResponseSchema.parse(enabledResponse.json())).toMatchObject({
        provider: {
          clientSecretConfigured: true,
          discoveryState: "ready",
          enabled: true,
          id: created.id,
        },
        revokedSessions: 0,
      });

      const stored = app.database.sqlite
        .prepare(
          `select encrypted_client_secret as encryptedClientSecret
           from oidc_providers where id = ?`,
        )
        .get(created.id) as { encryptedClientSecret: string };
      expect(
        new EnvelopeCipher(config.encryptionKey).decrypt(
          stored.encryptedClientSecret,
          oidcClientSecretEncryptionContext(created.id),
        ),
      ).toBe(providerRequest.clientSecret);
    } finally {
      await app.close();
    }
  });

  it("audits sanitized validation failures and enforces CSRF plus retry backoff", async () => {
    const registryDependencies = providerRegistryDependencies(
      validationMetadata({ code_challenge_methods_supported: ["plain"] }),
    );
    const { app, session } = await harness(registryDependencies);
    try {
      const created = await app.inject({
        body: providerRequest,
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/auth/oidc/providers",
      });
      const provider = oidcProviderAdminSchema.parse(created.json());
      const url = `/v1/admin/auth/oidc/providers/${provider.id}/validate`;

      const missingCsrf = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
          origin: baseUrl,
        },
        method: "POST",
        url,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(registryDependencies.discover).not.toHaveBeenCalled();

      const rejected = await app.inject({
        headers: authenticatedHeaders(session),
        method: "POST",
        url,
      });
      expect(rejected.statusCode, rejected.body).toBe(422);
      expect(rejected.json()).toMatchObject({
        error: { code: "oidc_provider_validation_rejected" },
      });
      expect(rejected.body).not.toContain("code_challenge_methods_supported");

      const backedOff = await app.inject({
        headers: authenticatedHeaders(session),
        method: "POST",
        url,
      });
      expect(backedOff.statusCode).toBe(503);
      expect(backedOff.headers["retry-after"]).toBe("30");
      expect(registryDependencies.discover).toHaveBeenCalledOnce();

      const audits = app.database.sqlite
        .prepare(
          `select outcome, metadata_json as metadataJson
           from audit_events where event_type = 'auth.oidc.provider.validated'
           order by created_at, id`,
        )
        .all() as Array<{ metadataJson: string; outcome: string }>;
      expect(
        audits.map((audit) => ({
          metadata: JSON.parse(audit.metadataJson),
          outcome: audit.outcome,
        })),
      ).toEqual([
        {
          metadata: { reason: "oidc_provider_misconfigured", retryable: false },
          outcome: "failure",
        },
        {
          metadata: { reason: "oidc_provider_discovery_failed", retryable: true },
          outcome: "failure",
        },
      ]);
    } finally {
      await app.close();
    }
  });
});
