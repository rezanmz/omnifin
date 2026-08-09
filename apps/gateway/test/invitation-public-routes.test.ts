import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs } from "../src/db/schema.js";
import { hashToken } from "../src/security/crypto.js";

const origin = "https://omnifin.example";
const now = new Date("2026-08-01T00:00:00.000Z");
const inviteToken = Buffer.alloc(32, 11).toString("base64url");

function config(secureCookies = true): AppConfig {
  return {
    baseUrl: new URL(`${origin}/`),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 12),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

async function harness(secureCookies = true) {
  let handoffNumber = 0;
  const app = await createApp({
    config: config(secureCookies),
    invitationPublicDependencies: {
      clock: () => now,
      createHandoffToken: () => Buffer.alloc(32, ++handoffNumber).toString("base64url"),
    },
  });
  app.database.sqlite
    .prepare(
      `insert into invitations (id, token_hash, expires_at, created_at)
       values (?, ?, ?, ?)`,
    )
    .run(
      "invite_public_test",
      hashToken(inviteToken),
      now.getTime() + 60 * 60 * 1_000,
      now.getTime(),
    );
  return app;
}

function exchangeHeaders() {
  return { "content-type": "application/json", origin };
}

describe("public invitation exchange route", () => {
  it("rotates a cookie without consuming the invitation and applies safe headers", async () => {
    const app = await harness();
    try {
      const first = await app.inject({
        body: { token: inviteToken },
        headers: exchangeHeaders(),
        method: "POST",
        url: "/v1/auth/invitations/exchange",
      });
      expect(first.statusCode, first.body).toBe(204);
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.headers["referrer-policy"]).toBe("no-referrer");
      const firstCookie = String(first.headers["set-cookie"]);
      expect(firstCookie).toContain("__Host-omnifin_registration_handoff=");
      expect(firstCookie).toContain("HttpOnly");
      expect(firstCookie).toContain("Secure");
      expect(firstCookie).toContain("Path=/");
      expect(firstCookie).toContain("SameSite=Lax");
      expect(firstCookie).toContain("Expires=Sat, 01 Aug 2026 00:15:00 GMT");
      expect(firstCookie).not.toContain(inviteToken);

      const rowBefore = app.database.sqlite
        .prepare(
          "select consumed_at as consumedAt, registration_handoff_hash as handoffHash from invitations",
        )
        .get();
      expect(rowBefore).toEqual(expect.objectContaining({ consumedAt: null }));
      expect(rowBefore).toHaveProperty("handoffHash");

      const second = await app.inject({
        body: { token: inviteToken },
        headers: exchangeHeaders(),
        method: "POST",
        url: "/v1/auth/invitations/exchange",
      });
      expect(String(second.headers["set-cookie"])).not.toBe(firstCookie);
      expect(app.database.sqlite.prepare("select consumed_at from invitations").get()).toEqual({
        consumed_at: null,
      });
    } finally {
      await app.close();
    }
  });

  it("returns one uniform response for malformed, wrong-origin, and invalid invitations", async () => {
    const app = await harness();
    try {
      const malformed = await app.inject({
        body: { extra: true, token: inviteToken },
        headers: exchangeHeaders(),
        method: "POST",
        url: "/v1/auth/invitations/exchange",
      });
      const invalid = await app.inject({
        body: { token: Buffer.alloc(32, 99).toString("base64url") },
        headers: exchangeHeaders(),
        method: "POST",
        url: "/v1/auth/invitations/exchange",
      });
      const wrongOrigin = await app.inject({
        body: { token: inviteToken },
        headers: { ...exchangeHeaders(), origin: "https://evil.example" },
        method: "POST",
        url: "/v1/auth/invitations/exchange",
      });
      expect(malformed.statusCode).toBe(invalid.statusCode);
      expect(malformed.json().error).toMatchObject({
        code: "invitation_exchange_invalid",
        message: "The invitation could not be accepted.",
      });
      expect(invalid.json().error).toMatchObject({
        code: "invitation_exchange_invalid",
        message: "The invitation could not be accepted.",
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(malformed.body).not.toContain(inviteToken);
      expect(malformed.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("rejects non-JSON exchange attempts before parsing or touching the invitation", async () => {
    const app = await harness();
    try {
      const responses = await Promise.all([
        app.inject({
          body: { token: inviteToken },
          headers: { "content-type": "text/plain", origin },
          method: "POST",
          url: "/v1/auth/invitations/exchange",
        }),
        app.inject({
          body: { token: inviteToken },
          headers: { "content-type": "text/plain", origin },
          method: "POST",
          url: "/v1/auth/invitations/exchange",
        }),
        app.inject({
          headers: { "content-type": "application/json; charset=iso-8859-1", origin },
          method: "POST",
          payload: '{"token":"short"}',
          url: "/v1/auth/invitations/exchange",
        }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: { code: "invitation_exchange_invalid" },
        });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
      }
      expect(
        app.database.sqlite.prepare("select registration_handoff_hash from invitations").get(),
      ).toEqual({ registration_handoff_hash: null });
    } finally {
      await app.close();
    }
  });

  it("rejects an active local session before exchanging", async () => {
    const app = await harness();
    try {
      app.database.db
        .insert(connectorConfigs)
        .values({
          baseUrl: "https://jellyfin.example.test",
          createdAt: now,
          displayName: "Jellyfin",
          encryptedCredentials: "v2.public-session-connector",
          healthState: "healthy",
          id: "missing-connector",
          type: "jellyfin",
          updatedAt: now,
        })
        .run();
      app.database.sqlite
        .prepare(
          `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
           values ('public-session-user', 'Public Session User', 'viewer', 'default', 'active', ?, ?)`,
        )
        .run(now.getTime(), now.getTime());
      app.database.sqlite
        .prepare(
          `insert into service_identity_links (
             id, user_id, service, connector_id, external_user_id, external_display_name,
             external_username, external_server_id, device_id, encrypted_access_token,
             health_state, token_created_at, last_verified_at, created_at, updated_at
           ) values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?, ?, ?)`,
        )
        .run(
          "public-session-link",
          "public-session-user",
          "missing-connector",
          "public-session-external",
          "Public Session User",
          "public-session-user",
          "public-session-server",
          "public-session-device",
          "v2.public-session-token",
          now.getTime(),
          now.getTime(),
          now.getTime(),
          now.getTime(),
        );
      const session = app.sessionService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "public-session-link",
          userId: "public-session-user",
        },
      });
      const response = await app.inject({
        body: { token: inviteToken },
        headers: {
          ...exchangeHeaders(),
          cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
        },
        method: "POST",
        url: "/v1/auth/invitations/exchange",
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("invitation_exchange_invalid");
      expect(
        app.database.sqlite.prepare("select registration_handoff_hash from invitations").get(),
      ).toEqual({
        registration_handoff_hash: null,
      });
    } finally {
      await app.close();
    }
  });
});
