import { appearanceUpdateResponseSchema, sessionResponseSchema } from "@omnifin/contracts/auth";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { externalIdentities, oidcProviders, users } from "../src/db/schema.js";

const NOW = new Date("2026-07-26T10:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 12),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 60 * 60 * 1_000,
      inactivityTtlMs: 10 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

async function identifiedApp() {
  const app = await createApp({
    config: config(),
    sessionDependencies: { clock: () => new Date(NOW) },
  });
  app.database.db
    .insert(oidcProviders)
    .values({
      clientId: "omnifin-client",
      displayName: "Home identity",
      id: "oidc-home",
      issuer: "https://id.example.test/application/o/omnifin/",
      slug: "home",
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      displayName: "Riley",
      id: "viewer-1",
      role: "requester",
      roleSource: "oidc_mapping",
      status: "pending_link",
    })
    .run();
  app.database.db
    .insert(externalIdentities)
    .values({
      displayClaimsJson: JSON.stringify({ displayName: "Riley" }),
      id: "oidc-identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: NOW,
      providerId: "oidc-home",
      subject: "immutable-oidc-subject",
      userId: "viewer-1",
    })
    .run();
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "oidc-identity-1",
      oidcProviderId: "oidc-home",
      userId: "viewer-1",
    },
  });
  return { app, session };
}

describe("appearance routes", () => {
  const origin = { origin: "https://omnifin.example" };

  it("returns a system theme by default and reflects updates via the session", async () => {
    const { app, session } = await identifiedApp();
    try {
      const cookie = `${SESSION_COOKIE_NAME}=${session.sessionToken}`;
      const issued = await app.inject({
        method: "GET",
        url: "/v1/auth/session",
        headers: { cookie },
      });
      expect(sessionResponseSchema.parse(issued.json())).toEqual({
        csrfToken: session.csrfToken,
        principal: expect.any(Object),
        theme: "system",
      });

      const read = await app.inject({
        method: "GET",
        url: "/v1/profile/appearance",
        headers: { cookie },
      });
      expect(read.statusCode).toBe(200);
      expect(appearanceUpdateResponseSchema.parse(read.json())).toEqual({ theme: "system" });

      const updated = await app.inject({
        method: "PATCH",
        url: "/v1/profile/appearance",
        headers: { cookie, [SESSION_CSRF_HEADER]: session.csrfToken, ...origin },
        payload: { theme: "dark" },
      });
      expect(updated.statusCode).toBe(200);
      expect(appearanceUpdateResponseSchema.parse(updated.json())).toEqual({ theme: "dark" });

      const reissued = await app.inject({
        method: "GET",
        url: "/v1/auth/session",
        headers: { cookie },
      });
      expect(sessionResponseSchema.parse(reissued.json())).toEqual({
        csrfToken: session.csrfToken,
        principal: expect.any(Object),
        theme: "dark",
      });
    } finally {
      await app.close();
    }
  });

  it("requires a session to inspect the appearance preference", async () => {
    const app = await createApp({
      config: config(),
      sessionDependencies: { clock: () => new Date(NOW) },
    });
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/profile/appearance",
      });
      expect(anonymous.statusCode).toBe(401);
      expect(apiErrorSchema.parse(anonymous.json()).error.code).toBe("authentication_required");
    } finally {
      await app.close();
    }
  });

  it("rejects appearance updates without a session or CSRF proof", async () => {
    const { app, session } = await identifiedApp();
    try {
      const cookie = `${SESSION_COOKIE_NAME}=${session.sessionToken}`;
      const anonymous = await app.inject({
        method: "PATCH",
        url: "/v1/profile/appearance",
        headers: { ...origin },
        payload: { theme: "dark" },
      });
      expect(anonymous.statusCode).toBe(403);
      expect(apiErrorSchema.parse(anonymous.json()).error.code).toBe("csrf_denied");

      const withoutCsrf = await app.inject({
        method: "PATCH",
        url: "/v1/profile/appearance",
        headers: { cookie, ...origin },
        payload: { theme: "dark" },
      });
      expect(withoutCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(withoutCsrf.json()).error.code).toBe("csrf_denied");
    } finally {
      await app.close();
    }
  });

  it("rejects unsupported theme values and clears the preference with system", async () => {
    const { app, session } = await identifiedApp();
    try {
      const cookie = `${SESSION_COOKIE_NAME}=${session.sessionToken}`;
      app.database.sqlite
        .prepare("update users set theme_preference = 'dark' where id = 'viewer-1'")
        .run();
      const invalid = await app.inject({
        method: "PATCH",
        url: "/v1/profile/appearance",
        headers: { cookie, [SESSION_CSRF_HEADER]: session.csrfToken, ...origin },
        payload: { theme: "sepia" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(apiErrorSchema.parse(invalid.json()).error.code).toBe("invalid_request");

      const system = await app.inject({
        method: "PATCH",
        url: "/v1/profile/appearance",
        headers: { cookie, [SESSION_CSRF_HEADER]: session.csrfToken, ...origin },
        payload: { theme: "system" },
      });
      expect(system.statusCode).toBe(200);
      expect(appearanceUpdateResponseSchema.parse(system.json())).toEqual({ theme: "system" });
    } finally {
      await app.close();
    }
  });
});
