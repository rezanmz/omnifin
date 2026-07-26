import {
  Configuration,
  type ClientAuth,
  type ClientMetadata,
  type CustomFetch,
  type ServerMetadata,
} from "openid-client";
import { sessionResponseSchema } from "@omnifin/contracts/auth";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  OIDC_FAILURE_AUDIT_EVENT_TYPE,
  OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW,
  OidcFailureAuditService,
} from "../src/auth/oidc/failure-audit.js";
import type { OidcBackchannelLogoutDependencies } from "../src/auth/oidc/backchannel-logout.js";
import { OidcProviderRegistryError } from "../src/auth/oidc/provider-registry.js";
import type { OidcProtocolDependencies } from "../src/auth/oidc/protocol.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, oidcProviders, serviceIdentityLinks, users } from "../src/db/schema.js";
import { MAX_ACTIVE_SESSIONS_PER_USER } from "../src/auth/session-service.js";

const providerId = "oidc-home";
const issuer = "https://identity.example.test/application/o/omnifin/";
const routeTime = new Date("2026-07-26T02:00:00.000Z");
const browserBindingToken = Buffer.alloc(32, 59).toString("base64url");

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 53),
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
    ...overrides,
  };
}

function providerMetadata(): ServerMetadata {
  return {
    authorization_endpoint: "https://identity.example.test/application/o/authorize/",
    code_challenge_methods_supported: ["S256"],
    end_session_endpoint: "https://identity.example.test/application/o/omnifin/end-session/",
    grant_types_supported: ["authorization_code"],
    id_token_signing_alg_values_supported: ["RS256"],
    issuer,
    jwks_uri: "https://identity.example.test/application/o/omnifin/jwks/",
    response_types_supported: ["code"],
    token_endpoint: "https://identity.example.test/application/o/token/",
    token_endpoint_auth_methods_supported: ["none"],
  } as ServerMetadata;
}

function seedProvider(database: DatabaseHandle) {
  const createdAt = new Date(routeTime.getTime() - 60_000);
  database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(["https://identity.example.test"]),
      clientId: "omnifin-client",
      createdAt,
      displayName: "Home identity",
      id: providerId,
      issuer,
      slug: "home",
      tokenEndpointAuthMethod: "none",
      updatedAt: createdAt,
    })
    .run();
}

function discoveredConfiguration(
  clientId: string,
  clientMetadata: Partial<ClientMetadata> | string | undefined,
  clientAuthentication: ClientAuth | undefined,
) {
  return new Configuration(providerMetadata(), clientId, clientMetadata, clientAuthentication);
}

async function openRouteHarness(
  options: {
    config?: Partial<AppConfig>;
    createBrowserBinding?: () => string;
    verifyBackchannelLogoutToken?: OidcBackchannelLogoutDependencies["verifyLogoutToken"];
  } = {},
) {
  const database = openDatabase(":memory:");
  database.migrate();
  seedProvider(database);
  const discover = vi.fn(
    async (
      _server: URL,
      clientId: string,
      clientMetadata: Partial<ClientMetadata> | string | undefined,
      clientAuthentication: ClientAuth | undefined,
    ) => discoveredConfiguration(clientId, clientMetadata, clientAuthentication),
  );
  const authorizationCodeGrant = vi.fn<
    NonNullable<OidcProtocolDependencies["authorizationCodeGrant"]>
  >(async () => ({
    claims: {
      email: "viewer@example.test",
      email_verified: true,
      name: "Cinematic Viewer",
      sid: "synthetic-provider-session",
      sub: "immutable-viewer-subject",
    },
    idToken: "header.payload.signature",
  }));
  const app = await createApp({
    config: testConfig(options.config),
    database,
    oidcDependencies: {
      ...(options.verifyBackchannelLogoutToken
        ? {
            backchannelLogout: {
              clock: () => new Date(routeTime),
              verifyLogoutToken: options.verifyBackchannelLogoutToken,
            },
          }
        : {}),
      authorizationTransaction: {
        clock: () => new Date(routeTime),
        ...(options.createBrowserBinding
          ? { createBrowserBinding: options.createBrowserBinding }
          : {}),
      },
      failureAudit: { clock: () => new Date(routeTime) },
      identity: { clock: () => new Date(routeTime) },
      protocol: { authorizationCodeGrant },
      providerRegistry: {
        clock: () => new Date(routeTime),
        createSafeFetch: () => vi.fn<CustomFetch>(),
        discover,
      },
    },
    sessionDependencies: { clock: () => new Date(routeTime) },
  });
  return { app, authorizationCodeGrant, database, discover };
}

function indexedBindingToken(index: number) {
  const value = Buffer.alloc(32, 0);
  value.writeUInt32BE(index, 0);
  return value.toString("base64url");
}

function totalChanges(database: DatabaseHandle) {
  return (
    database.sqlite.prepare("select total_changes() as totalChanges").get() as {
      totalChanges: number;
    }
  ).totalChanges;
}

function setCookieHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join("\n") : value;
}

function transactionBindingCookie(
  response: { cookies: { name: string; value: string }[] },
  state: string | null,
  value?: string,
) {
  if (!state) throw new Error("Expected a canonical OIDC state.");
  const cookie = response.cookies.find(
    ({ name }) => name.includes("_oidc_tx_") && name.endsWith(state),
  );
  if (!cookie) throw new Error("Expected a state-specific OIDC binding cookie.");
  return `${cookie.name}=${value ?? cookie.value}`;
}

async function issueBrowserOidcSession(
  app: Awaited<ReturnType<typeof createApp>>,
  binding = browserBindingToken,
) {
  const started = await app.inject({
    headers: { cookie: `__Host-omnifin_oidc_binding=${binding}` },
    method: "GET",
    url: `/v1/auth/oidc/${providerId}/start`,
  });
  const state = new URL(started.headers.location!).searchParams.get("state");
  const callback = await app.inject({
    headers: { cookie: transactionBindingCookie(started, state) },
    method: "GET",
    url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code&state=${state}`,
  });
  const session = callback.cookies.find(({ name }) => name === "__Host-omnifin_session");
  if (!session) throw new Error("Expected an OIDC session cookie.");
  const cookie = `${session.name}=${session.value}`;
  const inspected = await app.inject({
    headers: { cookie },
    method: "GET",
    url: "/v1/auth/session",
  });
  const body = sessionResponseSchema.parse(inspected.json());
  if (!body.csrfToken || !body.principal) throw new Error("Expected an active OIDC session.");
  return { cookie, csrfToken: body.csrfToken, principal: body.principal };
}

describe("OIDC browser routes", () => {
  it("accepts a verified provider back-channel logout without browser credentials", async () => {
    const verifyBackchannelLogoutToken = vi.fn(async () => ({
      expiresAt: new Date(routeTime.getTime() + 5 * 60_000),
      issuedAt: new Date(routeTime.getTime() - 1_000),
      issuer,
      subject: "immutable-viewer-subject",
      tokenId: "provider-logout-token-route-1",
    }));
    const { app, database } = await openRouteHarness({ verifyBackchannelLogoutToken });
    try {
      const session = await issueBrowserOidcSession(app);
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          logout_token: "header.provider-logout.signature",
          provider_extension: "ignored-by-specification",
        }).toString(),
        url: `/v1/auth/oidc/backchannel/${providerId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.body).toBe("");
      expect(verifyBackchannelLogoutToken).toHaveBeenCalledWith(
        providerId,
        "header.provider-logout.signature",
        new Date(routeTime),
      );
      expect(app.sessionService.resolveAndRefresh(session.cookie.split("=", 2)[1])).toBeNull();
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects invalid back-channel assertions without revoking the target session", async () => {
    const verifyBackchannelLogoutToken = vi.fn(async () => {
      throw new Error("private-provider-verification-failure");
    });
    const { app, database } = await openRouteHarness({ verifyBackchannelLogoutToken });
    try {
      const session = await issueBrowserOidcSession(app);
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          logout_token: "header.invalid-provider-logout.signature",
        }).toString(),
        url: `/v1/auth/oidc/backchannel/${providerId}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "backchannel_authentication_denied" },
      });
      expect(app.sessionService.resolveAndRefresh(session.cookie.split("=", 2)[1])).not.toBeNull();
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 0 });
      expect(response.body).not.toContain("private-provider-verification-failure");
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(
        "private-provider-verification-failure",
      );
    } finally {
      await app.close();
    }
  });

  it("requires one form-encoded logout_token before invoking back-channel verification", async () => {
    const verifyBackchannelLogoutToken = vi.fn(async () => ({
      expiresAt: new Date(routeTime.getTime() + 5 * 60_000),
      issuedAt: new Date(routeTime.getTime() - 1_000),
      issuer,
      subject: "immutable-viewer-subject",
      tokenId: "unused-provider-logout-token",
    }));
    const { app } = await openRouteHarness({ verifyBackchannelLogoutToken });
    try {
      const requests = [
        {
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ logout_token: "header.json.signature" }),
        },
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "",
        },
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "logout_token=header.first.signature&logout_token=header.second.signature",
        },
      ];
      for (const request of requests) {
        const response = await app.inject({
          headers: request.headers,
          method: "POST",
          payload: request.payload,
          url: `/v1/auth/oidc/backchannel/${providerId}`,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(verifyBackchannelLogoutToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a retryable response when provider verification is temporarily unavailable", async () => {
    const verifyBackchannelLogoutToken = vi.fn(async () => {
      throw new OidcProviderRegistryError("oidc_provider_discovery_failed", true);
    });
    const { app } = await openRouteHarness({ verifyBackchannelLogoutToken });
    try {
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          logout_token: "header.retryable-provider.signature",
        }).toString(),
        url: `/v1/auth/oidc/backchannel/${providerId}`,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "backchannel_temporarily_unavailable" },
      });
      expect(response.body).not.toContain("oidc_provider_discovery_failed");
    } finally {
      await app.close();
    }
  });

  it("accepts an exact session-aware front-channel logout from the configured issuer", async () => {
    const { app, database } = await openRouteHarness();
    try {
      const session = await issueBrowserOidcSession(app);
      const response = await app.inject({
        method: "GET",
        url: `/v1/auth/oidc/frontchannel/${providerId}?${new URLSearchParams({
          iss: issuer,
          sid: "synthetic-provider-session",
        }).toString()}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["x-frame-options"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors https://identity.example.test",
      );
      expect(response.body).toBe("");
      expect(app.sessionService.resolveAndRefresh(session.cookie.split("=", 2)[1])).toBeNull();
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.oidc.frontchannel_logout'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed front-channel requests without making the denial frameable", async () => {
    const { app } = await openRouteHarness();
    try {
      const session = await issueBrowserOidcSession(app);
      const validQuery = new URLSearchParams({
        iss: issuer,
        sid: "synthetic-provider-session",
      }).toString();
      const requests = [
        `/v1/auth/oidc/frontchannel/${providerId}?${validQuery}&unexpected=1`,
        `/v1/auth/oidc/frontchannel/${providerId}?${validQuery}&iss=${encodeURIComponent(issuer)}`,
        `/v1/auth/oidc/frontchannel/${providerId}?${new URLSearchParams({
          iss: `${issuer}mismatch`,
          sid: "synthetic-provider-session",
        }).toString()}`,
        `/v1/auth/oidc/frontchannel/${providerId}?iss=${encodeURIComponent(issuer)}`,
      ];

      for (const url of requests) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: { code: "frontchannel_authentication_denied" },
        });
        expect(response.headers["x-frame-options"]).toBe("DENY");
        expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      }
      const headResponse = await app.inject({
        method: "HEAD",
        url: `/v1/auth/oidc/frontchannel/${providerId}?${validQuery}`,
      });
      expect(headResponse.statusCode).toBe(404);
      expect(headResponse.headers["x-frame-options"]).toBe("DENY");
      expect(app.sessionService.resolveAndRefresh(session.cookie.split("=", 2)[1])).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("rolls a front-channel revocation back when its audit record cannot be stored", async () => {
    const { app, database } = await openRouteHarness();
    try {
      const session = await issueBrowserOidcSession(app);
      database.sqlite.exec(`
        create trigger reject_frontchannel_route_audit
        before insert on audit_events
        when new.event_type = 'auth.oidc.frontchannel_logout'
        begin
          select raise(abort, 'frontchannel route audit unavailable');
        end;
      `);
      const response = await app.inject({
        method: "GET",
        url: `/v1/auth/oidc/frontchannel/${providerId}?${new URLSearchParams({
          iss: issuer,
          sid: "synthetic-provider-session",
        }).toString()}`,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "frontchannel_temporarily_unavailable" },
      });
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(app.sessionService.resolveAndRefresh(session.cookie.split("=", 2)[1])).not.toBeNull();
      expect(response.body).not.toContain("frontchannel route audit unavailable");
    } finally {
      await app.close();
    }
  });

  it("revokes locally before redirecting a form-submitted logout to the validated provider", async () => {
    const { app, database, discover } = await openRouteHarness();
    try {
      const session = await issueBrowserOidcSession(app);

      const response = await app.inject({
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: session.cookie,
          origin: "https://omnifin.example",
        },
        method: "POST",
        payload: new URLSearchParams({ csrfToken: session.csrfToken }).toString(),
        url: "/v1/auth/oidc/logout",
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("__Host-omnifin_session=;");
      const providerLogout = new URL(response.headers.location!);
      expect(providerLogout.origin + providerLogout.pathname).toBe(
        "https://identity.example.test/application/o/omnifin/end-session/",
      );
      expect(providerLogout.searchParams.get("client_id")).toBe("omnifin-client");
      expect(providerLogout.searchParams.get("id_token_hint")).toBe("header.payload.signature");
      expect(providerLogout.searchParams.get("post_logout_redirect_uri")).toBe(
        "https://omnifin.example/login?loggedOut=1",
      );
      expect(response.body).not.toContain("header.payload.signature");
      expect(response.body).not.toContain(session.csrfToken);
      expect(discover).toHaveBeenCalledOnce();
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = @sessionId")
          .get({ sessionId: session.principal.sessionId }),
      ).toEqual({ revoked: 1 });
      expect(
        database.sqlite
          .prepare(
            `select event_type as eventType, metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.oidc.logout_started'`,
          )
          .get(),
      ).toEqual({
        eventType: "auth.oidc.logout_started",
        metadataJson: '{"reason":"rp_initiated_oidc_logout","idTokenHintAvailable":true}',
      });
    } finally {
      await app.close();
    }
  });

  it("accepts only an exact same-origin form CSRF proof for browser logout", async () => {
    const { app } = await openRouteHarness();
    try {
      const session = await issueBrowserOidcSession(app);
      const baseHeaders = {
        "content-type": "application/x-www-form-urlencoded",
        cookie: session.cookie,
        origin: "https://omnifin.example",
      };
      const requests = [
        {
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: session.cookie,
          },
          payload: new URLSearchParams({ csrfToken: session.csrfToken }).toString(),
        },
        {
          headers: { ...baseHeaders, "content-type": "application/json" },
          payload: JSON.stringify({ csrfToken: session.csrfToken }),
        },
        { headers: baseHeaders, payload: "" },
        {
          headers: baseHeaders,
          payload: new URLSearchParams({
            csrfToken: session.csrfToken,
            extra: "denied",
          }).toString(),
        },
        {
          headers: baseHeaders,
          payload: `csrfToken=${session.csrfToken}&csrfToken=${session.csrfToken}`,
        },
        {
          headers: { ...baseHeaders, "x-omnifin-csrf": session.csrfToken },
          payload: new URLSearchParams({ csrfToken: session.csrfToken }).toString(),
        },
        {
          headers: baseHeaders,
          payload: new URLSearchParams({
            csrfToken: Buffer.alloc(32, 91).toString("base64url"),
          }).toString(),
        },
      ];

      for (const request of requests) {
        const response = await app.inject({
          headers: request.headers,
          method: "POST",
          payload: request.payload,
          url: "/v1/auth/oidc/logout",
        });
        expect(response.statusCode).toBe(403);
      }
      const inspected = await app.inject({
        headers: { cookie: session.cookie },
        method: "GET",
        url: "/v1/auth/session",
      });
      expect(sessionResponseSchema.parse(inspected.json()).principal?.sessionId).toBe(
        session.principal.sessionId,
      );
    } finally {
      await app.close();
    }
  });

  it("does not apply provider logout semantics to a direct Jellyfin session", async () => {
    const { app, database } = await openRouteHarness();
    try {
      const oidcSession = await issueBrowserOidcSession(app);
      const linkedAt = new Date(routeTime);
      database.db
        .insert(connectorConfigs)
        .values({
          baseUrl: "https://jellyfin.example.test",
          createdAt: linkedAt,
          displayName: "Home Jellyfin",
          encryptedCredentials: "v2.fixture-connector-credentials",
          healthState: "healthy",
          id: "jellyfin-home",
          type: "jellyfin",
          updatedAt: linkedAt,
        })
        .run();
      database.db
        .insert(serviceIdentityLinks)
        .values({
          connectorId: "jellyfin-home",
          createdAt: linkedAt,
          deviceId: "direct-route-device",
          encryptedAccessToken: "v2.fixture-jellyfin-token",
          externalDisplayName: "Cinematic Viewer",
          externalServerId: "jellyfin-server",
          externalUserId: "jellyfin-user",
          externalUsername: "viewer",
          healthState: "linked",
          id: "jellyfin-link",
          lastVerifiedAt: linkedAt,
          service: "jellyfin",
          tokenCreatedAt: linkedAt,
          updatedAt: linkedAt,
          userId: oidcSession.principal.userId!,
        })
        .run();
      database.db.update(users).set({ status: "active", updatedAt: linkedAt }).run();
      const direct = app.sessionService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "jellyfin-link",
          userId: oidcSession.principal.userId!,
        },
      });

      const response = await app.inject({
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `__Host-omnifin_session=${direct.sessionToken}`,
          origin: "https://omnifin.example",
        },
        method: "POST",
        payload: new URLSearchParams({ csrfToken: direct.csrfToken }).toString(),
        url: "/v1/auth/oidc/logout",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_logout_request" } });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(app.sessionService.resolveAndRefresh(direct.sessionToken)).toMatchObject({
        principal: { authenticationMethod: { kind: "jellyfin" } },
      });
    } finally {
      await app.close();
    }
  });

  it("finishes local logout when provider rediscovery is unavailable", async () => {
    const { app, database, discover } = await openRouteHarness();
    try {
      const session = await issueBrowserOidcSession(app);
      database.db
        .update(oidcProviders)
        .set({ displayName: "Changed identity", updatedAt: new Date(routeTime.getTime() + 1) })
        .run();
      discover.mockRejectedValueOnce(new Error("private-provider-logout-failure"));

      const response = await app.inject({
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: session.cookie,
          origin: "https://omnifin.example",
        },
        method: "POST",
        payload: new URLSearchParams({ csrfToken: session.csrfToken }).toString(),
        url: "/v1/auth/oidc/logout",
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/login?loggedOut=1");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("__Host-omnifin_session=;");
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = @sessionId")
          .get({ sessionId: session.principal.sessionId }),
      ).toEqual({ revoked: 1 });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(
        "private-provider-logout-failure",
      );
    } finally {
      await app.close();
    }
  });

  it("finishes local logout instead of emitting an oversized provider redirect", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();
    try {
      authorizationCodeGrant.mockResolvedValueOnce({
        claims: {
          email: "viewer@example.test",
          email_verified: true,
          name: "Cinematic Viewer",
          sub: "immutable-viewer-subject",
        },
        idToken: `a.${"x".repeat(16_380)}.b`,
      });
      const session = await issueBrowserOidcSession(app);

      const response = await app.inject({
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: session.cookie,
          origin: "https://omnifin.example",
        },
        method: "POST",
        payload: new URLSearchParams({ csrfToken: session.csrfToken }).toString(),
        url: "/v1/auth/oidc/logout",
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/login?loggedOut=1");
      expect(response.body).not.toContain("x".repeat(128));
      expect(
        database.sqlite
          .prepare("select revoked_at is not null as revoked from sessions where id = @sessionId")
          .get({ sessionId: session.principal.sessionId }),
      ).toEqual({ revoked: 1 });
    } finally {
      await app.close();
    }
  });

  it("completes a bound callback against the configured public URL and issues a session", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();
    const privateCode = "private-authorization-code-canary";
    const privateProviderSession = "private-provider-session-canary";

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=%2Fsettings`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      expect(started.statusCode).toBe(302);
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const callbackBinding = transactionBindingCookie(started, state);
      const callbackBindingName = callbackBinding.split("=", 1)[0];

      const response = await app.inject({
        headers: {
          cookie: callbackBinding,
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=${privateCode}&state=${state}` +
          `&iss=${encodeURIComponent(issuer)}&session_state=${privateProviderSession}` +
          "&provider_extension=bounded-value",
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/link/jellyfin");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("__Host-omnifin_session=");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("HttpOnly");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("SameSite=Lax");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("Secure");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain(`${callbackBindingName}=;`);
      expect(setCookieHeader(response.headers["set-cookie"])).not.toContain(
        "__Host-omnifin_oidc_binding=;",
      );
      expect(authorizationCodeGrant).toHaveBeenCalledOnce();
      const callbackUrl = authorizationCodeGrant.mock.calls[0]?.[1];
      expect(callbackUrl).toBeInstanceOf(URL);
      if (!callbackUrl) throw new Error("Expected the verified callback URL.");
      expect(callbackUrl.origin + callbackUrl.pathname).toBe(
        `https://omnifin.example/api/auth/oidc/callback/${providerId}`,
      );
      expect(callbackUrl.href).not.toContain("attacker.example");
      expect(callbackUrl.searchParams.get("iss")).toBe(issuer);
      expect(callbackUrl.searchParams.get("session_state")).toBe(privateProviderSession);
      expect(callbackUrl.searchParams.get("provider_extension")).toBe("bounded-value");
      expect(database.sqlite.prepare("select count(*) as count from users").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from external_identities").get(),
      ).toEqual({ count: 1 });
      expect(
        database.sqlite
          .prepare("select auth_method as authMethod, count(*) as count from sessions")
          .get(),
      ).toEqual({ authMethod: "oidc", count: 1 });
      expect(
        database.sqlite
          .prepare("select consumed_at is not null as consumed from auth_transactions")
          .get(),
      ).toEqual({ consumed: 1 });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateCode);
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateProviderSession);
    } finally {
      await app.close();
    }
  });

  it("preserves the requested return path once the OIDC account has a media identity", async () => {
    const { app, database } = await openRouteHarness();
    try {
      const firstStart = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const firstState = new URL(firstStart.headers.location!).searchParams.get("state");
      const firstCallback = await app.inject({
        headers: { cookie: transactionBindingCookie(firstStart, firstState) },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${firstState}`,
      });
      expect(firstCallback.headers.location).toBe("/link/jellyfin");

      const user = database.db.select().from(users).get();
      if (!user) throw new Error("Expected the provisioned OIDC user.");
      const linkedAt = new Date(routeTime);
      database.db
        .insert(connectorConfigs)
        .values({
          baseUrl: "https://jellyfin.example.test",
          createdAt: linkedAt,
          displayName: "Home Jellyfin",
          encryptedCredentials: "v2.fixture-connector-credentials",
          healthState: "healthy",
          id: "jellyfin-home",
          type: "jellyfin",
          updatedAt: linkedAt,
        })
        .run();
      database.db
        .insert(serviceIdentityLinks)
        .values({
          connectorId: "jellyfin-home",
          createdAt: linkedAt,
          deviceId: "oidc-route-device",
          encryptedAccessToken: "v2.fixture-jellyfin-token",
          externalDisplayName: "Cinematic Viewer",
          externalServerId: "jellyfin-server",
          externalUserId: "jellyfin-user",
          externalUsername: "viewer",
          healthState: "linked",
          id: "jellyfin-link",
          lastVerifiedAt: linkedAt,
          service: "jellyfin",
          tokenCreatedAt: linkedAt,
          updatedAt: linkedAt,
          userId: user.id,
        })
        .run();
      database.db.update(users).set({ status: "active", updatedAt: linkedAt }).run();

      const activeStart = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=%2Fsettings`,
      });
      const activeState = new URL(activeStart.headers.location!).searchParams.get("state");
      const activeCallback = await app.inject({
        headers: { cookie: transactionBindingCookie(activeStart, activeState) },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${activeState}`,
      });

      expect(activeCallback.statusCode).toBe(303);
      expect(activeCallback.headers.location).toBe("/settings");
    } finally {
      await app.close();
    }
  });

  it("consumes a provider denial before interpreting it and never calls discovery or exchange", async () => {
    const { app, authorizationCodeGrant, database, discover } = await openRouteHarness();
    const privateDescription = "private-provider-description-canary";

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      expect(state).toBeTruthy();
      expect(discover).toHaveBeenCalledOnce();

      const deniedUrl =
        `/v1/auth/oidc/callback/${providerId}?error=access_denied` +
        `&error_description=${privateDescription}&state=${state}`;
      const denied = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: deniedUrl,
      });

      expect(denied.statusCode).toBe(303);
      expect(denied.headers.location).toBe("/login?authError=authorization_denied");
      expect(denied.headers.location).not.toContain(privateDescription);
      expect(setCookieHeader(denied.headers["set-cookie"])).toContain(
        `${callbackBinding.split("=", 1)[0]}=;`,
      );
      expect(discover).toHaveBeenCalledOnce();
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare("select consumed_at is not null as consumed from auth_transactions")
          .get(),
      ).toEqual({ consumed: 1 });
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateDescription);

      const replay = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: deniedUrl,
      });
      expect(replay.statusCode).toBe(303);
      expect(replay.headers.location).toBe("/login?authError=invalid_request");
      expect(discover).toHaveBeenCalledOnce();
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("consumes a bound malformed response before rejecting code and error together", async () => {
    const { app, authorizationCodeGrant, database, discover } = await openRouteHarness();

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      const malformed = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=private-code` +
          `&error=access_denied&state=${state}`,
      });

      expect(malformed.statusCode).toBe(303);
      expect(malformed.headers.location).toBe("/login?authError=invalid_request");
      expect(discover).toHaveBeenCalledOnce();
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare("select consumed_at is not null as consumed from auth_transactions")
          .get(),
      ).toEqual({ consumed: 1 });
    } finally {
      await app.close();
    }
  });

  it("does not consume a valid transaction when the callback browser binding is wrong", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();
    const wrongBinding = Buffer.alloc(32, 61).toString("base64url");

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      const callbackUrl = `/v1/auth/oidc/callback/${providerId}?code=authorization-code&state=${state}`;
      const stolen = await app.inject({
        headers: { cookie: transactionBindingCookie(started, state, wrongBinding) },
        method: "GET",
        url: callbackUrl,
      });

      expect(stolen.statusCode).toBe(303);
      expect(stolen.headers.location).toBe("/login?authError=invalid_request");
      expect(
        database.sqlite
          .prepare("select consumed_at is null as available from auth_transactions")
          .get(),
      ).toEqual({ available: 1 });
      expect(authorizationCodeGrant).not.toHaveBeenCalled();

      const otherState = indexedBindingToken(9_999);
      const crossStateCookie = callbackBinding.replace(state!, otherState);
      const crossState = await app.inject({
        headers: { cookie: crossStateCookie },
        method: "GET",
        url: callbackUrl,
      });
      expect(crossState.headers.location).toBe("/login?authError=invalid_request");
      expect(
        database.sqlite
          .prepare("select consumed_at is null as available from auth_transactions")
          .get(),
      ).toEqual({ available: 1 });
      expect(authorizationCodeGrant).not.toHaveBeenCalled();

      const legitimate = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: callbackUrl,
      });
      expect(legitimate.statusCode).toBe(303);
      expect(legitimate.headers.location).toBe("/link/jellyfin");
      expect(authorizationCodeGrant).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("consumes the transaction and rejects a provider configuration changed mid-flow", async () => {
    const { app, authorizationCodeGrant, database, discover } = await openRouteHarness();

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      database.db
        .update(oidcProviders)
        .set({
          clientId: "changed-client",
          updatedAt: new Date(routeTime.getTime() + 1),
        })
        .run();

      const callback = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code&state=${state}`,
      });

      expect(callback.statusCode).toBe(303);
      expect(callback.headers.location).toBe("/login?authError=authentication_failed");
      expect(discover).toHaveBeenCalledTimes(2);
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(
        database.sqlite
          .prepare("select consumed_at is not null as consumed from auth_transactions")
          .get(),
      ).toEqual({ consumed: 1 });
    } finally {
      await app.close();
    }
  });

  it("keeps a failed token exchange one-shot and does not persist the upstream exception", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();
    const privateFailure = "private-token-endpoint-failure-canary";

    try {
      authorizationCodeGrant.mockRejectedValueOnce(new Error(privateFailure));
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      const callbackUrl = `/v1/auth/oidc/callback/${providerId}?code=private-code&state=${state}`;

      const failed = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: callbackUrl,
      });
      const replay = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: callbackUrl,
      });

      expect(failed.statusCode).toBe(303);
      expect(failed.headers.location).toBe("/login?authError=authentication_failed");
      expect(replay.statusCode).toBe(303);
      expect(replay.headers.location).toBe("/login?authError=invalid_request");
      expect(authorizationCodeGrant).toHaveBeenCalledOnce();
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateFailure);
    } finally {
      await app.close();
    }
  });

  it("leaves a legitimate transaction available after a callback with duplicate state", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      const duplicate = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=authorization-code` +
          `&state=${state}&state=${state}`,
      });

      expect(duplicate.statusCode).toBe(303);
      expect(duplicate.headers.location).toBe("/login?authError=invalid_request");
      expect(
        database.sqlite
          .prepare("select consumed_at is null as available from auth_transactions")
          .get(),
      ).toEqual({ available: 1 });
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
      expect(duplicate.headers["set-cookie"]).toBeUndefined();

      const legitimate = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${state}`,
      });
      expect(legitimate.headers.location).toBe("/link/jellyfin");
      expect(authorizationCodeGrant).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("revalidates the stored return path after consuming the transaction", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=%2Fsettings`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      database.sqlite.prepare("update auth_transactions set return_path = '/api/private'").run();

      const response = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${state}`,
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/login?authError=invalid_request");
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare("select consumed_at is not null as consumed from auth_transactions")
          .get(),
      ).toEqual({ consumed: 1 });
    } finally {
      await app.close();
    }
  });

  it("denies JIT provisioning without leaving a partial identity or session", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();

    try {
      database.db
        .update(oidcProviders)
        .set({
          allowJitProvisioning: false,
          updatedAt: new Date(routeTime.getTime() - 30_000),
        })
        .run();
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);

      const response = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${state}`,
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/login?authError=account_not_authorized");
      expect(authorizationCodeGrant).toHaveBeenCalledOnce();
      expect(database.sqlite.prepare("select count(*) as count from users").get()).toEqual({
        count: 0,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from external_identities").get(),
      ).toEqual({ count: 0 });
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      const auditRows = database.sqlite
        .prepare(
          `select event_type as eventType, request_id as requestId, metadata_json as metadataJson
           from audit_events
           where event_type in ('auth.oidc.failure', 'auth.oidc.identity.denied')`,
        )
        .all() as Array<{ eventType: string; metadataJson: string; requestId: string }>;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        eventType: OIDC_FAILURE_AUDIT_EVENT_TYPE,
        requestId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
      });
      expect(JSON.parse(auditRows[0]?.metadataJson ?? "{}")).toMatchObject({
        identityReason: "jit_provisioning_disabled",
        reason: "identity_rejected",
      });
    } finally {
      await app.close();
    }
  });

  it("reports a capped session issuance as an expected safe authentication outcome", async () => {
    const { app, database } = await openRouteHarness();

    try {
      const firstStart = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const firstState = new URL(firstStart.headers.location!).searchParams.get("state");
      const firstResponse = await app.inject({
        headers: { cookie: transactionBindingCookie(firstStart, firstState) },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${firstState}`,
      });
      expect(firstResponse.headers.location).toBe("/link/jellyfin");
      const attribution = database.sqlite
        .prepare(
          `select external_identity_id as externalIdentityId, user_id as userId
           from sessions
           where auth_method = 'oidc'
           limit 1`,
        )
        .get() as { externalIdentityId: string; userId: string };
      for (let index = 1; index < MAX_ACTIVE_SESSIONS_PER_USER; index += 1) {
        app.sessionService.createSession({
          attribution: {
            authMethod: "oidc",
            externalIdentityId: attribution.externalIdentityId,
            oidcProviderId: providerId,
            userId: attribution.userId,
          },
        });
      }
      const storageBefore = database.sqlite
        .prepare(
          `select
             (select count(*) from sessions) as sessions,
             (select count(*) from session_secret_reservations) as reservations,
             (select count(*) from audit_events where event_type = 'auth.session.created') as creationAudits`,
        )
        .get();

      const limitedStart = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const limitedState = new URL(limitedStart.headers.location!).searchParams.get("state");
      const limitedResponse = await app.inject({
        headers: { cookie: transactionBindingCookie(limitedStart, limitedState) },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${limitedState}`,
      });

      expect(limitedResponse.statusCode).toBe(303);
      expect(limitedResponse.headers.location).toBe("/login?authError=session_limit_reached");
      expect(
        database.sqlite
          .prepare(
            `select
               (select count(*) from sessions) as sessions,
               (select count(*) from session_secret_reservations) as reservations,
               (select count(*) from audit_events where event_type = 'auth.session.created') as creationAudits`,
          )
          .get(),
      ).toEqual(storageBefore);
      const failureAudit = database.sqlite
        .prepare(
          `select metadata_json as metadataJson, outcome
           from audit_events
           where event_type = 'auth.oidc.failure'
           order by created_at desc
           limit 1`,
        )
        .get() as { metadataJson: string; outcome: string };
      expect(failureAudit.outcome).toBe("denied");
      expect(JSON.parse(failureAudit.metadataJson)).toMatchObject({
        reason: "session_limit_reached",
      });
    } finally {
      await app.close();
    }
  });

  it("does not expose mutating OIDC browser routes through automatic HEAD handlers", async () => {
    const { app, database, discover } = await openRouteHarness();

    try {
      const start = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "HEAD",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const callback = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "HEAD",
        url: `/v1/auth/oidc/callback/${providerId}`,
      });

      expect(start.statusCode).toBe(404);
      expect(callback.statusCode).toBe(404);
      expect(discover).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("keeps two racing first-tab flows valid with distinct state-bound cookies", async () => {
    let bindingIndex = 200;
    const { app, authorizationCodeGrant, database, discover } = await openRouteHarness({
      createBrowserBinding: () => indexedBindingToken((bindingIndex += 1)),
    });

    try {
      const [firstPreflight, secondPreflight] = await Promise.all([
        app.inject({ method: "GET", url: `/v1/auth/oidc/${providerId}/start` }),
        app.inject({ method: "GET", url: `/v1/auth/oidc/${providerId}/start` }),
      ]);
      const firstBinding = firstPreflight.cookies.find(
        ({ name }) => name === "__Host-omnifin_oidc_binding",
      );
      const secondBinding = secondPreflight.cookies.find(
        ({ name }) => name === "__Host-omnifin_oidc_binding",
      );
      expect(firstPreflight.statusCode).toBe(303);
      expect(secondPreflight.statusCode).toBe(303);
      expect(firstBinding?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(secondBinding?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(firstBinding?.value).not.toBe(secondBinding?.value);

      const [firstStarted, secondStarted] = await Promise.all([
        app.inject({
          headers: { cookie: `${firstBinding!.name}=${firstBinding!.value}` },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        }),
        app.inject({
          headers: { cookie: `${secondBinding!.name}=${secondBinding!.value}` },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        }),
      ]);
      const firstState = new URL(firstStarted.headers.location!).searchParams.get("state");
      const secondState = new URL(secondStarted.headers.location!).searchParams.get("state");

      expect(firstStarted.statusCode).toBe(302);
      expect(secondStarted.statusCode).toBe(302);
      expect(firstState).not.toBe(secondState);
      const firstTransactionCookie = transactionBindingCookie(firstStarted, firstState);
      const secondTransactionCookie = transactionBindingCookie(secondStarted, secondState);
      expect(firstTransactionCookie.split("=", 1)[0]).not.toBe(
        secondTransactionCookie.split("=", 1)[0],
      );
      expect(discover).toHaveBeenCalledOnce();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 2 });

      const finalGenericCookie = `${secondBinding!.name}=${secondBinding!.value}`;
      const firstCallback = await app.inject({
        headers: {
          cookie: `${finalGenericCookie}; ${firstTransactionCookie}; ${secondTransactionCookie}`,
        },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=first-code&state=${firstState}`,
      });
      expect(firstCallback.headers.location).toBe("/link/jellyfin");
      expect(setCookieHeader(firstCallback.headers["set-cookie"])).toContain(
        `${firstTransactionCookie.split("=", 1)[0]}=;`,
      );
      expect(setCookieHeader(firstCallback.headers["set-cookie"])).not.toContain(
        `${secondTransactionCookie.split("=", 1)[0]}=;`,
      );

      const secondCallback = await app.inject({
        headers: { cookie: `${finalGenericCookie}; ${secondTransactionCookie}` },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=second-code&state=${secondState}`,
      });
      expect(secondCallback.headers.location).toBe("/link/jellyfin");
      expect(authorizationCodeGrant).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("suppresses repeated discovery work while a failed provider is cooling down", async () => {
    const { app, database, discover } = await openRouteHarness();
    const privateFailure = "private-discovery-failure-canary";

    try {
      discover.mockRejectedValueOnce(new Error(privateFailure));
      const first = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const second = await app.inject({
        headers: {
          cookie: `__Host-omnifin_oidc_binding=${indexedBindingToken(99)}`,
        },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });

      expect(first.headers.location).toBe("/login?authError=provider_unavailable");
      expect(second.headers.location).toBe("/login?authError=provider_unavailable");
      expect(discover).toHaveBeenCalledOnce();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 0 });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateFailure);
    } finally {
      await app.close();
    }
  });

  it("allows exactly one of two concurrent callback replays to exchange and sign in", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      const callback = {
        headers: { cookie: callbackBinding },
        method: "GET" as const,
        url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${state}`,
      };

      const responses = await Promise.all([app.inject(callback), app.inject(callback)]);

      expect(responses.map((response) => response.headers.location).sort()).toEqual([
        "/link/jellyfin",
        "/login?authError=invalid_request",
      ]);
      expect(authorizationCodeGrant).toHaveBeenCalledOnce();
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite
          .prepare("select consumed_at is not null as consumed from auth_transactions")
          .get(),
      ).toEqual({ consumed: 1 });
    } finally {
      await app.close();
    }
  });

  it("audits locally invalid claims separately without creating partial state", async () => {
    const { app, authorizationCodeGrant, database } = await openRouteHarness();
    const privateClaimsCanary = "private-invalid-claims-canary";

    try {
      authorizationCodeGrant.mockResolvedValueOnce({
        claims: { iss: issuer, privateValue: privateClaimsCanary },
        idToken: "header.payload.signature",
      });
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      const response = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${state}`,
      });

      expect(response.headers.location).toBe("/login?authError=authentication_failed");
      expect(database.sqlite.prepare("select count(*) as count from users").get()).toEqual({
        count: 0,
      });
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      const failureAudit = database.sqlite
        .prepare(
          `select metadata_json as metadataJson
           from audit_events
           where event_type = 'auth.oidc.failure'`,
        )
        .get() as { metadataJson: string };
      expect(JSON.parse(failureAudit.metadataJson)).toMatchObject({ reason: "claims_invalid" });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateClaimsCanary);
    } finally {
      await app.close();
    }
  });

  it("uses a fixed provider-unavailable callback redirect when rediscovery fails", async () => {
    const { app, authorizationCodeGrant, database, discover } = await openRouteHarness();
    const privateFailure = "private-callback-discovery-canary";

    try {
      const started = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const state = new URL(started.headers.location!).searchParams.get("state");
      const callbackBinding = transactionBindingCookie(started, state);
      database.db
        .update(oidcProviders)
        .set({
          displayName: "Refreshed identity",
          updatedAt: new Date(routeTime.getTime() + 1),
        })
        .run();
      discover.mockRejectedValueOnce(new Error(privateFailure));

      const response = await app.inject({
        headers: { cookie: callbackBinding },
        method: "GET",
        url: `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${state}`,
      });

      expect(response.headers.location).toBe("/login?authError=provider_unavailable");
      expect(discover).toHaveBeenCalledTimes(2);
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain(privateFailure);
    } finally {
      await app.close();
    }
  });

  it("starts one canonical authorization-code flow without trusting request host headers", async () => {
    const { app, database } = await openRouteHarness();

    try {
      const response = await app.inject({
        headers: {
          cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}`,
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=%2Fsettings`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain(
        "__Host-omnifin_oidc_binding=",
      );
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("HttpOnly");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("SameSite=Lax");
      expect(setCookieHeader(response.headers["set-cookie"])).toContain("Secure");

      const authorizationUrl = new URL(response.headers.location!);
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
        "https://identity.example.test/application/o/authorize/",
      );
      expect(authorizationUrl.searchParams.get("client_id")).toBe("omnifin-client");
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("response_mode")).toBe("query");
      expect(authorizationUrl.searchParams.get("scope")).toBe("openid profile email");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(authorizationUrl.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `https://omnifin.example/api/auth/oidc/callback/${providerId}`,
      );
      expect(authorizationUrl.href).not.toContain("attacker.example");
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized composed authorization URL before allocating browser capacity", async () => {
    const { app, database, discover } = await openRouteHarness();
    const scopes = ["openid"];
    while (scopes.join(" ").length < 1_900) {
      scopes.push(`scope-${scopes.length}-${"a".repeat(110)}`);
    }
    const oversizedEndpoint = `https://identity.example.test/${"authorize".repeat(300)}`;
    database.db
      .update(oidcProviders)
      .set({ scopes: scopes.join(" ") })
      .run();
    discover.mockImplementation(
      async (
        _server: URL,
        clientId: string,
        clientMetadata: Partial<ClientMetadata> | string | undefined,
        clientAuthentication: ClientAuth | undefined,
      ) =>
        new Configuration(
          { ...providerMetadata(), authorization_endpoint: oversizedEndpoint },
          clientId,
          clientMetadata,
          clientAuthentication,
        ),
    );

    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const response = await app.inject({
          headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        expect(response.statusCode).toBe(303);
        expect(response.headers.location).toBe("/login?authError=provider_unavailable");
      }
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 0 });
      expect(discover).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("preflights a missing browser binding without discovery or transaction allocation", async () => {
    const { app, database, discover } = await openRouteHarness();

    try {
      const preflight = await app.inject({
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=%2Fsettings`,
      });

      expect(preflight.statusCode).toBe(303);
      expect(preflight.headers.location).toBe(
        `/api/auth/oidc/${providerId}/start?returnPath=%2Fsettings`,
      );
      expect(preflight.headers["cache-control"]).toBe("no-store");
      expect(setCookieHeader(preflight.headers["set-cookie"])).toContain(
        "__Host-omnifin_oidc_binding=",
      );
      expect(setCookieHeader(preflight.headers["set-cookie"])).toContain("HttpOnly");
      expect(setCookieHeader(preflight.headers["set-cookie"])).toContain("SameSite=Lax");
      expect(setCookieHeader(preflight.headers["set-cookie"])).toContain("Secure");
      expect(discover).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 0 });

      const bindingCookie = preflight.cookies.find(
        ({ name }) => name === "__Host-omnifin_oidc_binding",
      );
      expect(bindingCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const started = await app.inject({
        headers: { cookie: `${bindingCookie!.name}=${bindingCookie!.value}` },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=%2Fsettings`,
      });
      expect(started.statusCode).toBe(302);
      expect(new URL(started.headers.location!).origin).toBe("https://identity.example.test");
      expect(discover).toHaveBeenCalledOnce();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects an unsafe return path before discovery without reflecting private input", async () => {
    const { app, database, discover } = await openRouteHarness();
    const privateReturnPath = "https://attacker.example/private?code=private-code-canary";

    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=${encodeURIComponent(privateReturnPath)}`,
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/login?authError=invalid_request");
      expect(response.headers.location).not.toContain(privateReturnPath);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(discover).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            `select event_type as eventType, metadata_json as metadataJson
             from audit_events`,
          )
          .get(),
      ).toEqual({
        eventType: "auth.oidc.failure",
        metadataJson: expect.stringContaining('"reason":"invalid_request"'),
      });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain("private-code-canary");
    } finally {
      await app.close();
    }
  });

  it("rejects unknown start parameters instead of forwarding or persisting them", async () => {
    const { app, database, discover } = await openRouteHarness();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start?returnPath=%2F&error_description=private-query-canary`,
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/login?authError=invalid_request");
      expect(discover).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 0 });
      expect(database.sqlite.serialize().toString("utf8")).not.toContain("private-query-canary");
    } finally {
      await app.close();
    }
  });

  it(
    "applies server-wide backpressure before the hard transaction ceiling",
    { timeout: 30_000 },
    async () => {
      const { app, database } = await openRouteHarness({ config: { trustProxyHops: 1 } });

      try {
        for (let index = 0; index < 512; index += 1) {
          const response = await app.inject({
            headers: {
              cookie: `__Host-omnifin_oidc_binding=${indexedBindingToken(index + 1)}`,
              "x-forwarded-for": `198.18.${Math.floor(index / 256)}.${index % 256}`,
            },
            method: "GET",
            url: `/v1/auth/oidc/${providerId}/start`,
          });
          expect(response.statusCode).toBe(302);
        }

        const limited = await app.inject({
          headers: {
            cookie: `__Host-omnifin_oidc_binding=${indexedBindingToken(513)}`,
            "x-forwarded-for": "198.18.2.1",
          },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBeTruthy();
        expect(limited.json()).toMatchObject({ error: { code: "rate_limit_exceeded" } });
        expect(
          database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
        ).toEqual({ count: 512 });
      } finally {
        await app.close();
      }
    },
  );

  it("returns the stable bounded error envelope for the per-client start limit", async () => {
    const { app, database, discover } = await openRouteHarness();

    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        expect(response.statusCode).toBe(303);
      }
      const limited = await app.inject({
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(limited.headers.pragma).toBe("no-cache");
      expect(limited.json()).toMatchObject({ error: { code: "rate_limit_exceeded" } });
      expect(discover).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it(
    "counts only start failures against the global audit-work budget",
    { timeout: 30_000 },
    async () => {
      const { app, database } = await openRouteHarness({ config: { trustProxyHops: 1 } });
      const invalidStartUrl =
        `/v1/auth/oidc/${providerId}/start?returnPath=` +
        encodeURIComponent("https://attacker.example/not-local");

      try {
        const preflight = await app.inject({
          headers: { "x-forwarded-for": "203.0.113.10" },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        const preflightBinding = preflight.cookies.find(
          ({ name }) => name === "__Host-omnifin_oidc_binding",
        );
        expect(preflight.statusCode).toBe(303);
        expect(preflightBinding?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const successfulStart = await app.inject({
          headers: {
            cookie: `${preflightBinding!.name}=${preflightBinding!.value}`,
            "x-forwarded-for": "203.0.113.10",
          },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        expect(successfulStart.statusCode).toBe(302);

        for (let index = 0; index < 512; index += 1) {
          await app.inject({ method: "GET", url: invalidStartUrl });
        }
        const changesAtAuditWorkLimit = totalChanges(database);
        expect(
          database.sqlite
            .prepare(
              `select suppressed_count as suppressedCount
               from audit_budget_scopes
               where scope = 'auth.oidc.failure:v1'`,
            )
            .get(),
        ).toEqual({ suppressedCount: 511 });

        for (let index = 0; index < 256; index += 1) {
          const response = await app.inject({
            headers: {
              "x-forwarded-for": `198.18.${Math.floor(index / 256)}.${index % 256}`,
            },
            method: "GET",
            url: invalidStartUrl,
          });
          expect(response.statusCode).toBe(303);
          expect(response.headers.location).toBe("/login?authError=invalid_request");
        }

        expect(totalChanges(database)).toBe(changesAtAuditWorkLimit);
        expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual(
          {
            count: 1,
          },
        );

        const valid = await app.inject({
          headers: {
            cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}`,
            "x-forwarded-for": "198.19.0.1",
          },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        expect(valid.statusCode).toBe(302);
        expect(new URL(valid.headers.location!).origin).toBe("https://identity.example.test");
        expect(
          database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
        ).toEqual({ count: 2 });
      } finally {
        await app.close();
      }
    },
  );

  it("returns the stable bounded error envelope for the callback limit", async () => {
    const { app, authorizationCodeGrant, database, discover } = await openRouteHarness();
    const unusedState = Buffer.alloc(32, 71).toString("base64url");

    try {
      for (let index = 0; index < 30; index += 1) {
        const response = await app.inject({
          headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
          method: "GET",
          url:
            `/v1/auth/oidc/callback/${providerId}?code=authorization-code` +
            `&state=${unusedState}`,
        });
        expect(response.statusCode).toBe(303);
        expect(response.headers.location).toBe("/login?authError=invalid_request");
      }
      const limited = await app.inject({
        headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
        method: "GET",
        url:
          `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${unusedState}`,
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(limited.headers.pragma).toBe("no-cache");
      expect(limited.json()).toMatchObject({ error: { code: "rate_limit_exceeded" } });
      expect(discover).not.toHaveBeenCalled();
      expect(authorizationCodeGrant).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
    } finally {
      await app.close();
    }
  });

  it(
    "bounds callback audit work server-wide without writes after durable saturation",
    { timeout: 30_000 },
    async () => {
      const { app, authorizationCodeGrant, database, discover } = await openRouteHarness({
        config: { trustProxyHops: 1 },
      });
      const audit = new OidcFailureAuditService(
        database,
        { encryptionKey: testConfig().encryptionKey },
        {
          clock: () => new Date(routeTime),
          createId: (() => {
            let identifier = 0;
            return () => `route-audit-saturation-${(identifier += 1)}`;
          })(),
        },
      );
      const invalidState = Buffer.alloc(32, 73).toString("base64url");

      try {
        const started = await app.inject({
          headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        const validState = new URL(started.headers.location!).searchParams.get("state");
        const validCallbackBinding = transactionBindingCookie(started, validState);
        for (let index = 0; index < OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW - 1; index += 1) {
          expect(
            audit.record({
              ipAddress: `2001:db8:feed:${index.toString(16)}::1`,
              outcome: "failure",
              reason: "callback_validation_failed",
            }),
          ).toBe("recorded");
        }
        expect(
          audit.record({
            ipAddress: "2001:db8:feed:ffff::1",
            outcome: "failure",
            reason: "callback_validation_failed",
          }),
        ).toBe("saturated");
        const changesAtSaturation = totalChanges(database);
        let redirected = 0;

        for (let index = 0; index < 2_000; index += 1) {
          const response = await app.inject({
            headers: {
              cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}`,
              "x-forwarded-for": `198.18.${Math.floor(index / 256)}.${index % 256}`,
            },
            method: "GET",
            url:
              `/v1/auth/oidc/callback/${providerId}?code=authorization-code` +
              `&state=${invalidState}`,
          });
          redirected += 1;
          expect(response.statusCode).toBe(303);
          expect(response.headers.location).toBe("/login?authError=invalid_request");
        }

        expect(redirected).toBe(2_000);
        expect(totalChanges(database)).toBe(changesAtSaturation);
        expect(discover).toHaveBeenCalledOnce();
        expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual(
          {
            count: OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW,
          },
        );

        const valid = await app.inject({
          headers: { cookie: validCallbackBinding },
          method: "GET",
          url:
            `/v1/auth/oidc/callback/${providerId}?code=valid-authorization-code` +
            `&state=${validState}`,
        });
        expect(valid.statusCode).toBe(303);
        expect(valid.headers.location).toBe("/link/jellyfin");
        expect(authorizationCodeGrant).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    },
  );

  it("does not turn callback rate-limit rejections into unbounded audit writes", async () => {
    const { app, database } = await openRouteHarness();
    const invalidState = Buffer.alloc(32, 79).toString("base64url");
    const callback = {
      headers: { cookie: `__Host-omnifin_oidc_binding=${browserBindingToken}` },
      method: "GET" as const,
      url:
        `/v1/auth/oidc/callback/${providerId}?code=authorization-code` + `&state=${invalidState}`,
    };

    try {
      for (let index = 0; index < 300; index += 1) await app.inject(callback);
      const changesAtGatewayLimit = totalChanges(database);

      for (let index = 0; index < 1_000; index += 1) {
        const limited = await app.inject(callback);
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBeTruthy();
        expect(limited.headers["cache-control"]).toBe("no-store");
        expect(limited.headers.pragma).toBe("no-cache");
      }

      expect(totalChanges(database)).toBe(changesAtGatewayLimit);
    } finally {
      await app.close();
    }
  });

  it("shares the start limit across one IPv6 /64 without merging a neighboring /64", async () => {
    const { app, database } = await openRouteHarness({ config: { trustProxyHops: 1 } });

    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await app.inject({
          headers: {
            cookie: `__Host-omnifin_oidc_binding=${indexedBindingToken(index + 1)}`,
            "x-forwarded-for": `2001:db8:abcd:1234::${(index + 1).toString(16)}`,
          },
          method: "GET",
          url: `/v1/auth/oidc/${providerId}/start`,
        });
        expect(response.statusCode).toBe(302);
      }
      const sameNetwork = await app.inject({
        headers: {
          cookie: `__Host-omnifin_oidc_binding=${indexedBindingToken(21)}`,
          "x-forwarded-for": "2001:db8:abcd:1234::ffff",
        },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });
      const neighboringNetwork = await app.inject({
        headers: {
          cookie: `__Host-omnifin_oidc_binding=${indexedBindingToken(22)}`,
          "x-forwarded-for": "2001:db8:abcd:1235::1",
        },
        method: "GET",
        url: `/v1/auth/oidc/${providerId}/start`,
      });

      expect(sameNetwork.statusCode).toBe(429);
      expect(sameNetwork.json()).toMatchObject({
        error: { code: "rate_limit_exceeded" },
      });
      expect(neighboringNetwork.statusCode).toBe(302);
      expect(
        database.sqlite.prepare("select count(*) as count from auth_transactions").get(),
      ).toEqual({ count: 21 });
    } finally {
      await app.close();
    }
  });
});
