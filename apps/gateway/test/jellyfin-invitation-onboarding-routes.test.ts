import { describe, expect, it } from "vitest";
import { apiErrorSchema } from "@omnifin/contracts/errors";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher, hashToken } from "../src/security/crypto.js";

const origin = "https://omnifin.example";
const inviteToken = Buffer.alloc(32, 91).toString("base64url");

function config(): AppConfig {
  return {
    baseUrl: new URL(origin),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 92),
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

function dependencies() {
  return {
    createClient: () => ({
      authenticateByName: async () => ({
        AccessToken: "private-invitation-access-token",
        ServerId: "server-1",
        User: { Id: "new-jellyfin-user", Name: "Invited", Policy: { IsAdministrator: false } },
      }),
      getPublicSystemInfo: async () => ({ Id: "server-1", ServerName: "Home", Version: "10" }),
    }),
    createDeviceId: () => "invitation-device",
  };
}

async function harness(options: { quickConnectAuthenticated?: boolean } = {}) {
  const app = await createApp({
    config: config(),
    jellyfinDependencies: dependencies(),
    jellyfinQuickConnectDependencies: {
      createBrowserBinding: () => Buffer.alloc(32, 93).toString("base64url"),
      createClient: () => ({
        authenticateWithQuickConnect: async () => ({
          AccessToken: "private-quick-connect-access-token",
          ServerId: "server-1",
          User: {
            Id: "quick-connect-user",
            Name: "Quick invited",
            Policy: { IsAdministrator: false },
          },
        }),
        getPublicSystemInfo: async () => ({ Id: "server-1", ServerName: "Home", Version: "10" }),
        initiateQuickConnect: async () => ({
          Authenticated: false,
          Code: "AB-1234",
          DateAdded: new Date().toISOString(),
          Secret: "private-quick-connect-secret",
        }),
        pollQuickConnect: async () => ({
          Authenticated: options.quickConnectAuthenticated ?? false,
          Code: "AB-1234",
          DateAdded: new Date().toISOString(),
          Secret: "private-quick-connect-secret",
        }),
        quickConnectEnabled: async () => true,
      }),
      createDeviceId: () => "quick-connect-device",
      createId: () => "quick-connect-invitation",
    },
  });
  const now = Date.now();
  app.database.sqlite
    .prepare("insert into invitations (id, token_hash, expires_at, created_at) values (?, ?, ?, ?)")
    .run("invite_jellyfin", hashToken(inviteToken), now + 60 * 60 * 1_000, now);
  const exchanged = await app.inject({
    body: { token: inviteToken },
    headers: { origin, "content-type": "application/json" },
    method: "POST",
    url: "/v1/auth/invitations/exchange",
  });
  expect(exchanged.statusCode).toBe(204);
  const cookie = String(exchanged.headers["set-cookie"]).split(";", 1)[0]!;
  return { app, cookie };
}

function seedExistingIdentity(
  app: Awaited<ReturnType<typeof createApp>>,
  externalUserId: string,
  historical = false,
) {
  app.database.db
    .insert(users)
    .values({
      displayName: "Existing Jellyfin user",
      id: `existing-${externalUserId}`,
      role: "viewer",
      roleSource: "default",
      status: "active",
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin",
      connectorInstanceGeneration: 0,
      deviceId: "existing-device",
      encryptedAccessToken: historical ? null : "v2.existing-token",
      externalDisplayName: "Existing Jellyfin user",
      externalServerId: "server-1",
      externalUserId,
      externalUsername: "existing",
      healthState: historical ? "relink_required" : "linked",
      id: `existing-link-${externalUserId}`,
      lastVerifiedAt: historical ? null : new Date(),
      service: "jellyfin",
      tokenCreatedAt: historical ? null : new Date(),
      userId: `existing-${externalUserId}`,
    })
    .run();
  if (historical) {
    app.database.db.update(connectorConfigs).set({ instanceGeneration: 1 }).run();
  }
}

function cookieHeader(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.map((entry) => entry.split(";", 1)[0]).join("; ");
}

function expectInvitationIdentityConflict(response: {
  body: string;
  headers: Record<string, unknown>;
  statusCode: number;
}) {
  expect(response.statusCode, response.body).toBe(409);
  expect(apiErrorSchema.parse(JSON.parse(response.body)).error).toMatchObject({
    code: "invitation_identity_already_exists",
    message: "This Jellyfin account is already linked to Omnifin and cannot use an invitation.",
  });
  expect(String(response.headers["set-cookie"])).not.toContain("Max-Age=0");
}

function expectHandoffUnchanged(app: Awaited<ReturnType<typeof createApp>>) {
  expect(
    app.database.sqlite
      .prepare(
        "select consumed_at as consumedAt, registration_handoff_hash as handoffHash from invitations",
      )
      .get(),
  ).toMatchObject({ consumedAt: null, handoffHash: expect.any(String) });
}

describe("Jellyfin invitation onboarding routes", () => {
  it("consumes the handoff only for a new password identity and clears it on success", async () => {
    const { app, cookie } = await harness();
    try {
      const response = await app.inject({
        body: { password: "private-password", username: "invited" },
        headers: { cookie, origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/password",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
      expect(response.body).not.toMatch(/private-password|private-invitation-access-token/);
      expect(
        app.database.sqlite.prepare("select consumed_at from invitations").get(),
      ).toMatchObject({
        consumed_at: expect.any(Number),
      });
    } finally {
      await app.close();
    }
  });

  it("stores only the invitation id in the encrypted Quick Connect payload", async () => {
    const { app, cookie } = await harness();
    try {
      const response = await app.inject({
        body: {},
        headers: { cookie, origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/quick-connect",
      });
      expect(response.statusCode, response.body).toBe(200);
      const started = response.json() as { transactionId: string };
      const row = app.database.sqlite
        .prepare(
          "select encrypted_payload as encryptedPayload from jellyfin_quick_connect_transactions where id = ?",
        )
        .get(started.transactionId) as { encryptedPayload: string };
      const plaintext = new EnvelopeCipher(config().encryptionKey).decrypt(
        row.encryptedPayload,
        `jellyfin-quick-connect:${started.transactionId}:payload`,
      );
      expect(JSON.parse(plaintext)).toMatchObject({
        invitationId: "invite_jellyfin",
        purpose: "invitation",
        schemaVersion: 6,
      });
      expect(plaintext).not.toContain("registration_handoff");
      expect(plaintext).not.toContain(inviteToken);
    } finally {
      await app.close();
    }
  });

  it("rejects a current password identity without consuming the invitation handoff", async () => {
    const { app, cookie } = await harness();
    try {
      seedExistingIdentity(app, "new-jellyfin-user");
      const response = await app.inject({
        body: { password: "private-password", username: "invited" },
        headers: { cookie, origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/password",
      });

      expectInvitationIdentityConflict(response);
      expectHandoffUnchanged(app);
      expect(app.database.sqlite.prepare("select count(*) as count from users").get()).toEqual({
        count: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a historical password identity without consuming the invitation handoff", async () => {
    const { app, cookie } = await harness();
    try {
      seedExistingIdentity(app, "new-jellyfin-user", true);
      const response = await app.inject({
        body: { password: "private-password", username: "invited" },
        headers: { cookie, origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/password",
      });

      expectInvitationIdentityConflict(response);
      expectHandoffUnchanged(app);
      expect(app.database.sqlite.prepare("select count(*) as count from users").get()).toEqual({
        count: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a current Quick Connect identity without consuming the invitation handoff", async () => {
    const { app, cookie } = await harness({ quickConnectAuthenticated: true });
    try {
      seedExistingIdentity(app, "quick-connect-user");
      const started = await app.inject({
        body: {},
        headers: { cookie, origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/quick-connect",
      });
      expect(started.statusCode, started.body).toBe(200);
      const transactionId = (started.json() as { transactionId: string }).transactionId;
      app.database.sqlite
        .prepare(
          "update jellyfin_quick_connect_transactions set next_poll_at = created_at where id = ?",
        )
        .run(transactionId);
      const response = await app.inject({
        body: {},
        headers: { cookie: `${cookie}; ${cookieHeader(started.headers["set-cookie"])}`, origin },
        method: "POST",
        url: `/v1/auth/invitations/jellyfin/quick-connect/${transactionId}/poll`,
      });
      expectInvitationIdentityConflict(response);
      expectHandoffUnchanged(app);
    } finally {
      await app.close();
    }
  });

  it("rejects a historical Quick Connect identity without consuming the invitation handoff", async () => {
    const { app, cookie } = await harness({ quickConnectAuthenticated: true });
    try {
      seedExistingIdentity(app, "quick-connect-user", true);
      const started = await app.inject({
        body: {},
        headers: { cookie, origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/quick-connect",
      });
      expect(started.statusCode, started.body).toBe(200);
      const transactionId = (started.json() as { transactionId: string }).transactionId;
      app.database.sqlite
        .prepare(
          "update jellyfin_quick_connect_transactions set next_poll_at = created_at where id = ?",
        )
        .run(transactionId);
      const response = await app.inject({
        body: {},
        headers: { cookie: `${cookie}; ${cookieHeader(started.headers["set-cookie"])}`, origin },
        method: "POST",
        url: `/v1/auth/invitations/jellyfin/quick-connect/${transactionId}/poll`,
      });

      expectInvitationIdentityConflict(response);
      expectHandoffUnchanged(app);
    } finally {
      await app.close();
    }
  });

  it("rejects forged onboarding cookies and keeps an early Quick Connect poll pending", async () => {
    const { app, cookie } = await harness();
    try {
      const forged = await app.inject({
        body: { password: "private-password", username: "invited" },
        headers: { cookie: "__Host-omnifin_registration_handoff=not-a-token", origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/password",
      });
      expect(forged.statusCode).toBe(400);
      expect(apiErrorSchema.parse(forged.json()).error).toMatchObject({
        code: "invitation_onboarding_invalid",
      });

      const started = await app.inject({
        body: {},
        headers: { cookie, origin },
        method: "POST",
        url: "/v1/auth/invitations/jellyfin/quick-connect",
      });
      expect(started.statusCode, started.body).toBe(200);
      const transactionId = (started.json() as { transactionId: string }).transactionId;
      const early = await app.inject({
        body: {},
        headers: {
          cookie: `${cookie}; ${cookieHeader(started.headers["set-cookie"])}`,
          origin,
        },
        method: "POST",
        url: `/v1/auth/invitations/jellyfin/quick-connect/${transactionId}/poll`,
      });
      expect(early.statusCode, early.body).toBe(200);
      expect(early.json()).toMatchObject({ status: "pending" });
      expect(early.json().pollAfterMs).toBeGreaterThanOrEqual(1_000);
      expect(early.json().pollAfterMs).toBeLessThanOrEqual(2_000);
      expectHandoffUnchanged(app);
    } finally {
      await app.close();
    }
  });
});
