import { apiErrorSchema } from "@omnifin/contracts/errors";
import { setupReadinessResponseSchema } from "@omnifin/contracts/setup";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, oidcProviders, serviceIdentityLinks, users } from "../src/db/schema.js";

const now = new Date("2026-08-01T12:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 117),
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
    clock: () => now,
    createId: () => `setup-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

function healthyJellyfinSnapshot() {
  return JSON.stringify({
    health: {
      capabilities: ["connector.health"],
      checkedAt: now.toISOString(),
      connectorId: "private-jellyfin-connector",
      displayName: "Private Jellyfin",
      failure: null,
      latencyMs: 12,
      service: "jellyfin",
      status: "healthy",
      version: "10.10.7",
    },
    schemaVersion: 1,
  });
}

async function harness(options: { invalidClock?: boolean } = {}) {
  const app = await createApp({
    config: testConfig(),
    sessionDependencies: sessionDependencies(),
    setupReadinessDependencies: {
      clock: () => (options.invalidClock ? new Date(Number.NaN) : now),
    },
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.private.example.test/",
      capabilitySnapshotJson: healthyJellyfinSnapshot(),
      createdAt: now,
      displayName: "Private Jellyfin",
      enabled: true,
      encryptedCredentials: "private-encrypted-credentials",
      healthState: "healthy",
      id: "private-jellyfin-connector",
      insecureHttpApproved: false,
      tlsPolicy: "strict",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(["https://auth.private.example.test"]),
      clientId: "private-client-id",
      createdAt: now,
      discoveryCapabilitiesJson: JSON.stringify({ authorizationCode: true }),
      discoveryCheckedAt: now,
      discoveryState: "ready",
      displayName: "Private identity provider",
      enabled: true,
      id: "private-provider-id",
      issuer: "https://auth.private.example.test/application/o/omnifin/",
      slug: "private-provider",
      tokenEndpointAuthMethod: "none",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(users)
    .values([
      {
        createdAt: now,
        displayName: "Administrator",
        id: "admin-user",
        role: "admin",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
      {
        createdAt: now,
        displayName: "Viewer",
        id: "viewer-user",
        role: "viewer",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
    ])
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values(
      ["admin", "viewer"].map((role) => ({
        connectorId: "private-jellyfin-connector",
        createdAt: now,
        deviceId: `${role}-private-device`,
        encryptedAccessToken: `${role}-private-token`,
        externalDisplayName: role === "admin" ? "Administrator" : "Viewer",
        externalServerId: "private-jellyfin-server",
        externalUserId: `${role}-private-external-user`,
        externalUsername: role,
        healthState: "linked" as const,
        id: `${role}-link`,
        lastVerifiedAt: now,
        service: "jellyfin" as const,
        tokenCreatedAt: now,
        updatedAt: now,
        userId: `${role}-user`,
      })),
    )
    .run();
  const admin = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "admin-link",
      userId: "admin-user",
    },
  });
  const viewer = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  return { admin, app, viewer };
}

describe("setup readiness routes", () => {
  it("returns a strict no-store summary without service or identity details", async () => {
    const fixture = await harness();
    try {
      const response = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.admin.sessionToken}` },
        method: "GET",
        url: "/v1/admin/setup/readiness",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      const body = setupReadinessResponseSchema.parse(response.json());
      expect(body).toMatchObject({ coreReady: true, essentialCompleted: 2, optionalReady: 1 });
      expect(response.body).not.toMatch(
        /private|example\.test|jellyfin-connector|provider-id|client-id|external-user/u,
      );
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects anonymous and non-administrator sessions before reading configuration", async () => {
    const fixture = await harness();
    try {
      const anonymous = await fixture.app.inject({
        method: "GET",
        url: "/v1/admin/setup/readiness",
      });
      const viewer = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.viewer.sessionToken}` },
        method: "GET",
        url: "/v1/admin/setup/readiness",
      });

      expect(anonymous.statusCode).toBe(401);
      expect(apiErrorSchema.parse(anonymous.json()).error.code).toBe("authentication_required");
      expect(viewer.statusCode).toBe(403);
      expect(apiErrorSchema.parse(viewer.json()).error.code).toBe("permission_denied");
    } finally {
      await fixture.app.close();
    }
  });

  it("returns a safe retryable service error for invalid readiness state", async () => {
    const fixture = await harness({ invalidClock: true });
    try {
      const response = await fixture.app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.admin.sessionToken}` },
        method: "GET",
        url: "/v1/admin/setup/readiness",
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("setup_readiness_unavailable");
      expect(response.body).not.toMatch(/NaN|integrity_failure|stack|sqlite/u);
    } finally {
      await fixture.app.close();
    }
  });
});
