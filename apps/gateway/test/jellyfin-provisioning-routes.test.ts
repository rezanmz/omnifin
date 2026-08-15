import {
  jellyfinProvisioningConfigSchema,
  jellyfinProvisioningTemplatesResponseSchema,
} from "@omnifin/contracts/connectors";
import { describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

import { createApp } from "../src/app.js";
import { JellyfinProvisioningService } from "../src/connectors/jellyfin-provisioning-service.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { JellyfinProvisioningAdminClient } from "@omnifin/connectors/auth/jellyfin-provisioning-admin-client";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-01T12:00:00.000Z");
const baseUrl = "https://omnifin.example";

function config(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 121),
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

const jellyfinServerId = "fixture-jellyfin-server";
const jellyfinIdentityHash = createHmac("sha256", config().encryptionKey)
  .update("omnifin:v1:connector-instance-identity\0", "utf8")
  .update(jellyfinServerId, "utf8")
  .digest("base64url");

async function harness() {
  let sessionId = 0;
  let sessionToken = 0;
  let auditId = 0;
  let provisioningNow = now;
  const fakeClient = {
    authenticateAdministrator: vi.fn(async () => ({
      AccessToken: "validated-admin-access-token",
      User: {
        Id: "admin",
        Name: "Administrator",
        Policy: { IsAdministrator: true, IsDisabled: false, EnableAllFolders: true },
      },
    })),
    readPublicSystemInfo: vi.fn(async () => ({
      protocolVersion: "10.11" as const,
      serverId: jellyfinServerId,
    })),
    validateAdministratorCredential: vi.fn(async () => ({ protocolVersion: "10.11" as const })),
    listTemplateUsers: vi.fn(async () => [
      {
        Id: "template-user",
        Name: "Template user",
        Policy: { IsAdministrator: false, IsDisabled: false, EnableAllFolders: true },
      },
      {
        Id: "disabled-user",
        Name: "Disabled user",
        Policy: { IsAdministrator: false, IsDisabled: true },
      },
      {
        Id: "other-admin",
        Name: "Other administrator",
        Policy: { IsAdministrator: true, IsDisabled: false },
      },
    ]),
    readTemplateUser: vi.fn(async ({ userId }: { userId: string }) => ({
      Id: userId,
      Name: "Template user",
      Policy: {
        AccessSchedules: [
          {
            DayOfWeek: "Weekday",
            EndHour: 22,
            Id: 7,
            StartHour: 8,
            UserId: "123e4567-e89b-12d3-a456-426614174000",
          },
        ],
        IsAdministrator: false,
        IsDisabled: false,
        EnableAllFolders: true,
      },
    })),
    validateAdministratorApiKey: vi.fn(async () => ({
      Id: "admin",
      Name: "Administrator",
      Policy: { IsAdministrator: true, IsDisabled: false, EnableAllFolders: true },
    })),
  };
  const app = await createApp({
    config: config(),
    jellyfinProvisioningDependencies: {
      clock: () => new Date(provisioningNow),
      createClient: () => fakeClient as unknown as JellyfinProvisioningAdminClient,
      createId: () => `provisioning-audit-${++auditId}`,
    },
    sessionDependencies: {
      clock: () => new Date(now),
      createId: () => `provisioning-session-${++sessionId}`,
      createToken: () => Buffer.alloc(32, ++sessionToken).toString("base64url"),
    },
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      configGeneration: 0,
      createdAt: now,
      displayName: "Home Jellyfin",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config().encryptionKey).encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:jellyfin-home",
      ),
      healthState: "healthy",
      id: "jellyfin-home",
      instanceGeneration: 0,
      instanceIdentityHash: jellyfinIdentityHash,
      updatedAt: now,
      type: "jellyfin",
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Administrator",
      id: "admin-user",
      role: "admin",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: now,
      deviceId: "admin-device",
      encryptedAccessToken: "v2.admin-token",
      externalDisplayName: "Administrator",
      externalServerId: "server-1",
      externalUserId: "admin-user",
      externalUsername: "admin",
      healthState: "linked",
      id: "admin-link",
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "admin-user",
    })
    .run();
  const session = await app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "admin-link",
      userId: "admin-user",
    },
  });
  return {
    app,
    fakeClient,
    session,
    setProvisioningNow: (value: Date) => (provisioningNow = value),
  };
}

function headers(session: Awaited<ReturnType<typeof harness>>["session"]) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    origin: baseUrl,
    [SESSION_CSRF_HEADER]: session.csrfToken,
    "user-agent": "jellyfin provisioning configuration test",
  };
}

describe("Jellyfin provisioning configuration routes", () => {
  it("validates admin credentials, stores no password, and exposes only safe configuration", async () => {
    const { app, fakeClient, session, setProvisioningNow } = await harness();
    try {
      const initial = await app.inject({
        headers: headers(session),
        method: "GET",
        url: "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning",
      });
      expect(initial.statusCode, initial.body).toBe(200);
      expect(jellyfinProvisioningConfigSchema.parse(initial.json())).toMatchObject({
        credentialConfigured: false,
        enabled: false,
        revision: 0,
        validationState: "unvalidated",
      });

      const configured = await app.inject({
        body: {
          credential: {
            kind: "replace_password",
            password: "private-password",
            username: "administrator",
          },
          enabled: true,
          revision: 0,
          templateUserId: "template-user",
        },
        headers: headers(session),
        method: "PUT",
        url: "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning",
      });
      expect(configured.statusCode, configured.body).toBe(200);
      expect(configured.headers["cache-control"]).toBe("no-store");
      expect(configured.body).not.toContain("private-password");
      expect(configured.body).not.toContain("validated-admin-access-token");
      expect(jellyfinProvisioningConfigSchema.parse(configured.json())).toEqual({
        connectorId: "jellyfin-home",
        credentialConfigured: true,
        credentialKind: "access_token",
        enabled: true,
        revision: 1,
        template: { displayName: "Template user", id: "template-user" },
        validatedAt: now.toISOString(),
        validationState: "valid",
      });
      expect(fakeClient.authenticateAdministrator).toHaveBeenCalledTimes(1);
      expect(fakeClient.readPublicSystemInfo).toHaveBeenCalledTimes(1);
      expect(fakeClient.readTemplateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "validated-admin-access-token",
          userId: "template-user",
        }),
      );
      const encrypted = app.database.sqlite
        .prepare("select encrypted_configuration as value from jellyfin_provisioning_configs")
        .get() as { value: string };
      expect(encrypted.value).not.toContain("private-password");
      expect(encrypted.value).not.toContain("validated-admin-access-token");
      const stored = JSON.parse(
        new EnvelopeCipher(config().encryptionKey).decrypt(
          encrypted.value,
          `jellyfin_provisioning:jellyfin-home:${createHash("sha256")
            .update("jellyfin\0jellyfin-home\0" + "0", "utf8")
            .digest("base64url")}:0:${jellyfinIdentityHash}`,
        ),
      ) as { template: { policy: { AccessSchedules: Array<Record<string, unknown>> } } };
      expect(stored.template.policy.AccessSchedules).toEqual([
        { DayOfWeek: "Weekday", EndHour: 22, StartHour: 8 },
      ]);
      const audit = app.database.sqlite
        .prepare(
          "select metadata_json as metadata from audit_events where event_type = 'connector.jellyfin_provisioning.updated'",
        )
        .get() as { metadata: string };
      expect(audit.metadata).not.toContain("private-password");
      expect(audit.metadata).not.toContain("template-user");
      expect(audit.metadata).not.toContain("EnableAllFolders");

      const validatedAt = jellyfinProvisioningConfigSchema.parse(configured.json()).validatedAt;
      const disabledAt = new Date(now.getTime() + 60_000);
      setProvisioningNow(disabledAt);
      const disabled = await app.inject({
        body: {
          credential: { kind: "retain" },
          enabled: false,
          revision: 1,
          templateUserId: "template-user",
        },
        headers: headers(session),
        method: "PUT",
        url: "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning",
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(jellyfinProvisioningConfigSchema.parse(disabled.json())).toMatchObject({
        credentialConfigured: true,
        enabled: false,
        revision: 2,
        validatedAt,
      });

      const templates = await app.inject({
        headers: headers(session),
        method: "GET",
        url: "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning/templates",
      });
      expect(templates.statusCode, templates.body).toBe(200);
      expect(jellyfinProvisioningTemplatesResponseSchema.parse(templates.json())).toEqual({
        templates: [{ displayName: "Template user", id: "template-user" }],
      });
      expect(templates.body).not.toContain("IsAdministrator");
      expect(templates.body).not.toContain("EnableAllFolders");
    } finally {
      await app.close();
    }
  });

  it("refuses provisioning credentials on an HTTP connector before calling Jellyfin", async () => {
    const { app, fakeClient, session } = await harness();
    try {
      app.database.sqlite
        .prepare(
          "update connector_configs set base_url = ?, insecure_http_approved = 1 where id = ?",
        )
        .run("http://jellyfin.example.test/", "jellyfin-home");

      const response = await app.inject({
        body: {
          credential: { apiKey: "private-key", kind: "replace_api_key" },
          enabled: true,
          revision: 0,
          templateUserId: "template-user",
        },
        headers: headers(session),
        method: "PUT",
        url: "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning",
      });

      expect(response.statusCode).toBe(422);
      expect(fakeClient.validateAdministratorCredential).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("binds administrator credential validation to the configured Jellyfin instance", async () => {
    const { app, fakeClient, session } = await harness();
    try {
      const expectedServerId = "expected-jellyfin-server";
      const identityHash = createHmac("sha256", config().encryptionKey)
        .update("omnifin:v1:connector-instance-identity\0", "utf8")
        .update(expectedServerId, "utf8")
        .digest("base64url");
      app.database.sqlite
        .prepare("update connector_configs set instance_identity_hash = ? where id = ?")
        .run(identityHash, "jellyfin-home");

      const response = await app.inject({
        body: {
          credential: { apiKey: "private-key", kind: "replace_api_key" },
          enabled: true,
          revision: 0,
          templateUserId: "template-user",
        },
        headers: headers(session),
        method: "PUT",
        url: "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning",
      });

      expect(response.statusCode, response.body).toBe(200);
      const calls = fakeClient.validateAdministratorCredential.mock.calls as unknown as Array<
        [{ verifyServerIdentity?: (serverId: string) => boolean }]
      >;
      const call = calls[0]?.[0];
      expect(call?.verifyServerIdentity?.("unexpected-jellyfin-server")).toBe(false);
      expect(call?.verifyServerIdentity?.(expectedServerId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects injected fields, missing CSRF, invalid templates, and stale revisions", async () => {
    const { app, fakeClient, session } = await harness();
    try {
      const url = "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning";
      const injected = await app.inject({
        body: {
          credential: { kind: "replace_api_key", apiKey: "private-key" },
          enabled: false,
          revision: 0,
          templateUserId: null,
          upstreamUrl: "https://attacker.example",
        },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(injected.statusCode).toBe(400);

      const missingCsrf = await app.inject({
        body: { credential: { kind: "clear" }, enabled: false, revision: 0, templateUserId: null },
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`, origin: baseUrl },
        method: "PUT",
        url,
      });
      expect(missingCsrf.statusCode).toBe(403);

      fakeClient.readTemplateUser.mockResolvedValueOnce({
        Id: "administrator-template",
        Name: "Administrator template",
        Policy: {
          AccessSchedules: [],
          IsAdministrator: true,
          IsDisabled: false,
          EnableAllFolders: true,
        },
      });
      const adminTemplate = await app.inject({
        body: {
          credential: { kind: "replace_api_key", apiKey: "private-key" },
          enabled: false,
          revision: 0,
          templateUserId: "administrator-template",
        },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(adminTemplate.statusCode).toBe(422);

      const stale = await app.inject({
        body: { credential: { kind: "clear" }, enabled: false, revision: 9, templateUserId: null },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("persists staged credentials, performs local disable/clear, and tombstones revisions", async () => {
    const { app, fakeClient, session } = await harness();
    try {
      const url = "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning";
      const staged = await app.inject({
        body: {
          credential: { kind: "replace_api_key", apiKey: "private-key" },
          enabled: false,
          revision: 0,
          templateUserId: null,
        },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(staged.statusCode, staged.body).toBe(200);
      expect(staged.json()).toMatchObject({
        credentialConfigured: true,
        enabled: false,
        revision: 1,
        template: null,
        validationState: "valid",
      });

      const validateCalls = fakeClient.validateAdministratorCredential.mock.calls.length;
      fakeClient.validateAdministratorCredential.mockRejectedValueOnce(new Error("no network"));
      const disabled = await app.inject({
        body: {
          credential: { kind: "retain" },
          enabled: false,
          revision: 1,
          templateUserId: null,
        },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(fakeClient.validateAdministratorCredential).toHaveBeenCalledTimes(validateCalls);

      const cleared = await app.inject({
        body: {
          credential: { kind: "clear" },
          enabled: false,
          revision: 2,
          templateUserId: null,
        },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json()).toMatchObject({
        credentialConfigured: false,
        enabled: false,
        revision: 3,
        template: null,
        validationState: "unvalidated",
      });

      const stale = await app.inject({
        body: {
          credential: { kind: "replace_api_key", apiKey: "new-key" },
          enabled: false,
          revision: 0,
          templateUserId: null,
        },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("rejects disabled connectors before decrypting provisioning credentials", async () => {
    const { app, fakeClient, session } = await harness();
    try {
      app.database.sqlite
        .prepare("update connector_configs set enabled = 0 where id = ?")
        .run("jellyfin-home");
      const provisioning = new JellyfinProvisioningService(app.database, config(), {
        createClient: () => fakeClient as unknown as JellyfinProvisioningAdminClient,
      });
      await expect(
        provisioning.listTemplates("jellyfin-home", { principal: session.principal }),
      ).rejects.toMatchObject({ reason: "connector_disabled" });
      expect(fakeClient.listTemplateUsers).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not use a restored provisioning credential before the connector is probed", async () => {
    const { app, fakeClient, session } = await harness();
    try {
      const url = "/v1/admin/connectors/jellyfin-home/jellyfin-provisioning";
      const staged = await app.inject({
        body: {
          credential: { kind: "replace_api_key", apiKey: "restored-secret" },
          enabled: false,
          revision: 0,
          templateUserId: null,
        },
        headers: headers(session),
        method: "PUT",
        url,
      });
      expect(staged.statusCode, staged.body).toBe(200);
      const validationCalls = fakeClient.validateAdministratorCredential.mock.calls.length;
      app.database.sqlite
        .prepare("update connector_configs set instance_identity_hash = null where id = ?")
        .run("jellyfin-home");
      app.database.sqlite
        .prepare(
          "update jellyfin_provisioning_configs set connector_instance_identity_hash = null where connector_id = ?",
        )
        .run("jellyfin-home");

      await expect(
        new JellyfinProvisioningService(app.database, config(), {
          createClient: () => fakeClient as unknown as JellyfinProvisioningAdminClient,
        }).listTemplates("jellyfin-home", { principal: session.principal }),
      ).rejects.toMatchObject({ reason: "connector_not_verified" });
      expect(fakeClient.validateAdministratorCredential).toHaveBeenCalledTimes(validationCalls);
      expect(fakeClient.listTemplateUsers).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
