import {
  connectorListResponseSchema,
  connectorMutationResponseSchema,
  type ConnectorHealth,
} from "@omnifin/contracts/connectors";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { ConnectorAdapterFactoryInput } from "../src/connectors/admin-service.js";
import type { AppConfig } from "../src/config.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  users,
} from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-26T18:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 97),
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
    createId: () => `connector-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

async function harness() {
  const config = testConfig();
  let auditIdentifier = 0;
  const createAdapter = vi.fn((input: ConnectorAdapterFactoryInput) => ({
    capabilities: ["connector.health", "connector.version"] as const,
    probe: vi.fn(async (): Promise<ConnectorHealth> => ({
      capabilities: ["connector.health", "connector.version"],
      checkedAt: "2026-07-26T18:01:00.000Z",
      connectorId: input.connectorId,
      displayName: input.displayName,
      failure: null,
      latencyMs: 9,
      service: "radarr" as const,
      status: "healthy" as const,
      version: "5.25.0",
    })),
    service: "radarr" as const,
  }));
  const app = await createApp({
    config,
    connectorAdminDependencies: {
      clock: () => new Date(now),
      createAdapter,
      createId: () => `connector-route-audit-${++auditIdentifier}`,
    },
    sessionDependencies: sessionDependencies(),
  });

  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin-admin.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: "Administrator Jellyfin",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({ kind: "none" }),
        "connector_credentials:jellyfin:jellyfin-admin",
      ),
      healthState: "unknown",
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
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "admin-identity",
      oidcProviderId: "oidc-admin-user",
      serviceIdentityLinkId: "admin-jellyfin-link",
      userId: "admin-user",
    },
  });
  const recovery = app.sessionService.createSession({
    attribution: { authMethod: "recovery" },
  });
  return { app, config, createAdapter, recovery, session };
}

function authenticatedHeaders(session: Awaited<ReturnType<typeof harness>>["session"]) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    origin: baseUrl,
    [SESSION_CSRF_HEADER]: session.csrfToken,
    "user-agent": "connector administration test",
    "x-request-id": "connector-route-request-001",
  };
}

const connectorRequest = {
  baseUrl: "https://radarr.example.test/api",
  credentials: { apiKey: "route-private-api-key", kind: "api_key" as const },
  displayName: "Radarr",
  id: "radarr-main",
  insecureHttpApproved: false,
  service: "radarr" as const,
  tlsPolicy: "strict" as const,
};

describe("connector administration routes", () => {
  it("limits recovery access to identity-critical Jellyfin repair", async () => {
    const { app, recovery, session } = await harness();
    try {
      const created = await app.inject({
        body: connectorRequest,
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/connectors",
      });
      expect(created.statusCode, created.body).toBe(201);

      const recoveryList = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
        method: "GET",
        url: "/v1/admin/connectors?limit=10",
      });
      expect(recoveryList.statusCode, recoveryList.body).toBe(200);
      expect(connectorListResponseSchema.parse(recoveryList.json()).items).toEqual([
        expect.objectContaining({ id: "jellyfin-admin", service: "jellyfin" }),
      ]);

      const hiddenConnector = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
        method: "GET",
        url: "/v1/admin/connectors/radarr-main",
      });
      expect(hiddenConnector.statusCode).toBe(403);

      const deniedCreate = await app.inject({
        body: { ...connectorRequest, id: "radarr-recovery" },
        headers: authenticatedHeaders(recovery),
        method: "POST",
        url: "/v1/admin/connectors",
      });
      expect(deniedCreate.statusCode).toBe(403);

      const jellyfinResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
        method: "GET",
        url: "/v1/admin/connectors/jellyfin-admin",
      });
      const jellyfin = connectorMutationResponseSchema.parse(jellyfinResponse.json()).connector;
      const repaired = await app.inject({
        body: { displayName: "Recovered Jellyfin", revision: jellyfin.revision },
        headers: authenticatedHeaders(recovery),
        method: "PATCH",
        url: "/v1/admin/connectors/jellyfin-admin",
      });
      expect(repaired.statusCode, repaired.body).toBe(200);
      expect(connectorMutationResponseSchema.parse(repaired.json()).connector).toMatchObject({
        displayName: "Recovered Jellyfin",
        enabled: true,
        service: "jellyfin",
      });
    } finally {
      await app.close();
    }
  });

  it("creates, reads, and lists secret-free connector configuration", async () => {
    const { app, config, session } = await harness();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/v1/admin/connectors" });
      expect(anonymous.statusCode).toBe(401);

      const missingCsrf = await app.inject({
        body: connectorRequest,
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
          origin: baseUrl,
        },
        method: "POST",
        url: "/v1/admin/connectors",
      });
      expect(missingCsrf.statusCode).toBe(403);

      const response = await app.inject({
        body: connectorRequest,
        headers: authenticatedHeaders(session),
        method: "POST",
        url: "/v1/admin/connectors",
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.headers.location).toBe("/v1/admin/connectors/radarr-main");
      expect(response.headers["cache-control"]).toBe("no-store");
      const created = connectorMutationResponseSchema.parse(response.json()).connector;
      expect(created).toMatchObject({
        credentialKind: "api_key",
        credentialsConfigured: true,
        enabled: false,
      });
      expect(response.body).not.toContain(connectorRequest.credentials.apiKey);

      const stored = app.database.sqlite
        .prepare(
          "select encrypted_credentials as encryptedCredentials from connector_configs where id = ?",
        )
        .get(connectorRequest.id) as { encryptedCredentials: string };
      expect(stored.encryptedCredentials).not.toContain(connectorRequest.credentials.apiKey);
      expect(
        JSON.parse(
          new EnvelopeCipher(config.encryptionKey).decrypt(
            stored.encryptedCredentials,
            "connector_credentials:radarr:radarr-main",
          ),
        ),
      ).toEqual({ credentials: connectorRequest.credentials, schemaVersion: 1 });

      const listResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/admin/connectors?limit=10",
      });
      expect(listResponse.statusCode, listResponse.body).toBe(200);
      const list = connectorListResponseSchema.parse(listResponse.json());
      expect(list.items.map((connector) => connector.id)).toEqual([
        "jellyfin-admin",
        "radarr-main",
      ]);
      expect(listResponse.body).not.toContain(connectorRequest.credentials.apiKey);

      const getResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/admin/connectors/radarr-main",
      });
      expect(getResponse.statusCode).toBe(200);
      expect(connectorMutationResponseSchema.parse(getResponse.json()).connector).toEqual(created);

      const audit = app.database.sqlite
        .prepare(
          "select event_type as eventType, metadata_json as metadataJson from audit_events where target_id = ?",
        )
        .get(connectorRequest.id) as { eventType: string; metadataJson: string };
      expect(audit.eventType).toBe("connector.configuration.created");
      expect(audit.metadataJson).not.toContain(connectorRequest.credentials.apiKey);
    } finally {
      await app.close();
    }
  });

  it("probes before enablement, enforces revisions, and deletes only when disabled", async () => {
    const { app, createAdapter, session } = await harness();
    try {
      const headers = authenticatedHeaders(session);
      const createResponse = await app.inject({
        body: connectorRequest,
        headers,
        method: "POST",
        url: "/v1/admin/connectors",
      });
      const created = connectorMutationResponseSchema.parse(createResponse.json()).connector;

      const earlyEnable = await app.inject({
        body: { enabled: true, revision: created.revision },
        headers,
        method: "PATCH",
        url: "/v1/admin/connectors/radarr-main",
      });
      expect(earlyEnable.statusCode).toBe(409);
      expect(earlyEnable.json()).toMatchObject({
        error: { code: "connector_not_validated" },
      });

      const probeResponse = await app.inject({
        headers,
        method: "POST",
        url: "/v1/admin/connectors/radarr-main/probe",
      });
      expect(probeResponse.statusCode, probeResponse.body).toBe(200);
      const probed = connectorMutationResponseSchema.parse(probeResponse.json()).connector;
      expect(probed).toMatchObject({ healthState: "healthy", lastProbe: { status: "healthy" } });
      expect(probed.revision).toBe(created.revision);
      expect(createAdapter).toHaveBeenCalledOnce();

      const enableResponse = await app.inject({
        body: { enabled: true, revision: probed.revision },
        headers,
        method: "PATCH",
        url: "/v1/admin/connectors/radarr-main",
      });
      expect(enableResponse.statusCode, enableResponse.body).toBe(200);
      const enabled = connectorMutationResponseSchema.parse(enableResponse.json()).connector;
      expect(enabled.enabled).toBe(true);

      const staleUpdate = await app.inject({
        body: { displayName: "Stale update", revision: probed.revision },
        headers,
        method: "PATCH",
        url: "/v1/admin/connectors/radarr-main",
      });
      expect(staleUpdate.statusCode).toBe(409);
      expect(staleUpdate.json()).toMatchObject({
        error: { code: "connector_revision_conflict" },
      });

      const enabledDelete = await app.inject({
        headers,
        method: "DELETE",
        url: `/v1/admin/connectors/radarr-main?revision=${enabled.revision}`,
      });
      expect(enabledDelete.statusCode).toBe(409);
      expect(enabledDelete.json()).toMatchObject({
        error: { code: "connector_must_be_disabled" },
      });

      const disableResponse = await app.inject({
        body: { enabled: false, revision: enabled.revision },
        headers,
        method: "PATCH",
        url: "/v1/admin/connectors/radarr-main",
      });
      const disabled = connectorMutationResponseSchema.parse(disableResponse.json()).connector;
      const deleteResponse = await app.inject({
        headers,
        method: "DELETE",
        url: `/v1/admin/connectors/radarr-main?revision=${disabled.revision}`,
      });
      expect(deleteResponse.statusCode, deleteResponse.body).toBe(200);
      expect(deleteResponse.json()).toEqual({ deletedConnectorId: "radarr-main" });
      expect(
        app.database.sqlite
          .prepare("select count(*) as count from connector_configs where id = ?")
          .get("radarr-main"),
      ).toEqual({ count: 0 });

      const events = app.database.sqlite
        .prepare(
          "select event_type as eventType from audit_events where target_id = ? order by created_at, rowid",
        )
        .all("radarr-main") as { eventType: string }[];
      expect(events.map((event) => event.eventType)).toEqual([
        "connector.configuration.created",
        "connector.probed",
        "connector.configuration.updated",
        "connector.configuration.updated",
        "connector.configuration.deleted",
      ]);
    } finally {
      await app.close();
    }
  });

  it("returns safe validation, conflict, and not-found errors", async () => {
    const { app, session } = await harness();
    try {
      const headers = authenticatedHeaders(session);
      const insecure = await app.inject({
        body: { ...connectorRequest, baseUrl: "http://radarr.example.test/" },
        headers,
        method: "POST",
        url: "/v1/admin/connectors",
      });
      expect(insecure.statusCode).toBe(400);
      expect(insecure.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(insecure.body).not.toContain(connectorRequest.credentials.apiKey);

      const first = await app.inject({
        body: connectorRequest,
        headers,
        method: "POST",
        url: "/v1/admin/connectors",
      });
      expect(first.statusCode).toBe(201);
      const duplicate = await app.inject({
        body: connectorRequest,
        headers,
        method: "POST",
        url: "/v1/admin/connectors",
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        error: { code: "connector_configuration_conflict" },
      });
      expect(duplicate.body).not.toContain(connectorRequest.credentials.apiKey);

      const missing = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/admin/connectors/missing",
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: "connector_not_found" } });
    } finally {
      await app.close();
    }
  });
});
