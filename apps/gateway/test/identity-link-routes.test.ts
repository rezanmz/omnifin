import {
  identityLinkRevocationResponseSchema,
  identityLinksResponseSchema,
} from "@omnifin/contracts/auth";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  users,
} from "../src/db/schema.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const EARLIER = new Date("2026-07-25T12:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 92),
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

function seedIdentity(app: Awaited<ReturnType<typeof createApp>>) {
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: EARLIER,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: EARLIER,
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: EARLIER,
      displayName: "Riley",
      id: "user-1",
      role: "requester",
      roleSource: "oidc_mapping",
      status: "active",
      updatedAt: EARLIER,
    })
    .run();
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
    .insert(externalIdentities)
    .values({
      createdAt: EARLIER,
      displayClaimsJson: JSON.stringify({ displayName: "Riley" }),
      id: "oidc-identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: EARLIER,
      providerId: "oidc-home",
      subject: "immutable-oidc-subject",
      updatedAt: EARLIER,
      userId: "user-1",
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: EARLIER,
      deviceId: "jellyfin-device-1",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Riley",
      externalServerId: "jellyfin-server-1",
      externalUserId: "jellyfin-user-1",
      externalUsername: "riley",
      healthState: "linked",
      id: "jellyfin-link-1",
      lastVerifiedAt: EARLIER,
      service: "jellyfin",
      tokenCreatedAt: EARLIER,
      updatedAt: EARLIER,
      userId: "user-1",
    })
    .run();
  return app.sessionService.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "oidc-identity-1",
      oidcProviderId: "oidc-home",
      serviceIdentityLinkId: "jellyfin-link-1",
      userId: "user-1",
    },
  });
}

function cookie(token: string) {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

describe("identity-link routes", () => {
  it("returns browser-safe link status only to an authenticated owner", async () => {
    const app = await createApp({
      config: config(),
      identityLinkDependencies: { clock: () => new Date(NOW) },
      sessionDependencies: { clock: () => new Date(NOW) },
    });
    try {
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/v1/auth/identity-links",
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(apiErrorSchema.parse(unauthenticated.json()).error.code).toBe(
        "authentication_required",
      );

      const issued = seedIdentity(app);
      const response = await app.inject({
        headers: { cookie: cookie(issued.sessionToken) },
        method: "GET",
        url: "/v1/auth/identity-links",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(identityLinksResponseSchema.parse(response.json())).toEqual({
        links: [
          expect.objectContaining({
            externalUserId: "jellyfin-user-1",
            health: "linked",
            id: "jellyfin-link-1",
          }),
        ],
      });
      expect(response.body).not.toContain("v2.fixture-access-token");
    } finally {
      await app.close();
    }
  });

  it("requires CSRF, revokes the owned link, and retains a reduced OIDC session", async () => {
    const app = await createApp({
      config: config(),
      identityLinkDependencies: {
        clock: () => new Date(NOW),
        createId: () => "identity-link-route-audit-1",
      },
      sessionDependencies: { clock: () => new Date(NOW) },
    });
    try {
      const issued = seedIdentity(app);
      const sessionCookie = cookie(issued.sessionToken);
      const denied = await app.inject({
        headers: { cookie: sessionCookie, origin: "https://omnifin.example" },
        method: "DELETE",
        url: "/v1/auth/identity-links/jellyfin-link-1",
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("csrf_denied");
      expect(app.database.db.select().from(serviceIdentityLinks).get()).toMatchObject({
        encryptedAccessToken: "v2.fixture-access-token",
        healthState: "linked",
      });
      const extended = await app.inject({
        headers: {
          cookie: sessionCookie,
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: issued.csrfToken,
        },
        method: "DELETE",
        payload: {},
        url: "/v1/auth/identity-links/jellyfin-link-1",
      });
      expect(extended.statusCode).toBe(400);
      expect(apiErrorSchema.parse(extended.json()).error.code).toBe("invalid_request");

      const response = await app.inject({
        headers: {
          cookie: sessionCookie,
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: issued.csrfToken,
        },
        method: "DELETE",
        url: "/v1/auth/identity-links/jellyfin-link-1",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(identityLinkRevocationResponseSchema.parse(response.json())).toMatchObject({
        link: { health: "revoked", id: "jellyfin-link-1" },
        principal: {
          accountState: "pending_link",
          authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
          linkedServices: [],
        },
      });
      expect(response.body).not.toContain("v2.fixture-access-token");

      const after = await app.inject({
        headers: { cookie: sessionCookie },
        method: "GET",
        url: "/v1/auth/identity-links",
      });
      expect(identityLinksResponseSchema.parse(after.json())).toMatchObject({
        links: [{ health: "revoked", id: "jellyfin-link-1" }],
      });
    } finally {
      await app.close();
    }
  });

  it("returns a generic not-found response for a different link identifier", async () => {
    const app = await createApp({
      config: config(),
      identityLinkDependencies: { clock: () => new Date(NOW) },
      sessionDependencies: { clock: () => new Date(NOW) },
    });
    try {
      const issued = seedIdentity(app);
      const response = await app.inject({
        headers: {
          cookie: cookie(issued.sessionToken),
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: issued.csrfToken,
        },
        method: "DELETE",
        url: "/v1/auth/identity-links/another-link",
      });

      expect(response.statusCode).toBe(404);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("identity_link_not_found");
      expect(app.database.db.select().from(serviceIdentityLinks).get()).toMatchObject({
        healthState: "linked",
      });
    } finally {
      await app.close();
    }
  });
});
