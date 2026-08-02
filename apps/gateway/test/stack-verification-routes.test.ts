import { apiErrorSchema } from "@omnifin/contracts/errors";
import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { stackVerificationResponseSchema } from "@omnifin/contracts/setup";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { connectorConfigs, oidcProviders, serviceIdentityLinks, users } from "../src/db/schema.js";

const now = new Date("2026-08-01T12:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: "/data/omnifin.db",
    encryptionKey: Buffer.alloc(32, 129),
    environment: "production",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    recoverySecretDigest: Buffer.alloc(32, 130),
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

function health(): ConnectorHealth {
  return {
    capabilities: ["connector.health", "media.library.read", "media.playback"],
    checkedAt: now.toISOString(),
    connectorId: "private-jellyfin-connector",
    displayName: "Private Jellyfin",
    failure: null,
    latencyMs: 12,
    service: "jellyfin",
    status: "healthy",
    version: "10.10.7",
  };
}

function sessionDependencies() {
  let identifier = 0;
  let token = 0;
  return {
    clock: () => now,
    createId: () => `verification-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

async function harness(
  overrides: {
    clock?: () => Date;
    probeConnector?: () => Promise<
      | { kind: "completed"; value: ConnectorHealth }
      | { finding: "verification_unavailable"; kind: "unavailable" }
    >;
  } = {},
) {
  const database = openDatabase(":memory:");
  const app = await createApp({
    config: testConfig(),
    database,
    sessionDependencies: sessionDependencies(),
    stackVerificationDependencies: {
      service: {
        clock: overrides.clock ?? (() => now),
        probeConnector:
          overrides.probeConnector ?? (async () => ({ kind: "completed", value: health() })),
        validateOidcProvider: async () => ({
          kind: "completed",
          value: {
            authorizationCodeFlow: true,
            idTokenSigningAlg: "RS256",
            logout: {
              backChannel: true,
              backChannelSession: true,
              frontChannel: true,
              frontChannelSession: true,
              rpInitiated: true,
            },
            pkceS256: true,
            schemaVersion: 1,
            tokenEndpointAuthMethod: "none",
            userInfo: true,
          },
        }),
      },
    },
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.private.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: "Private Jellyfin",
      enabled: true,
      encryptedCredentials: "private-encrypted-value",
      healthState: "unknown",
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
      clientId: "private-client",
      createdAt: now,
      discoveryCapabilitiesJson: "{}",
      discoveryCheckedAt: null,
      discoveryState: "unchecked",
      displayName: "Private identity provider",
      enabled: true,
      id: "private-oidc-provider",
      issuer: "https://auth.private.example.test/application/o/omnifin/",
      slug: "private",
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
        deviceId: `${role}-device`,
        encryptedAccessToken: `${role}-token`,
        externalDisplayName: role,
        externalServerId: "private-server",
        externalUserId: `${role}-external-user`,
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
  const recovery = app.sessionService.createSession({ attribution: { authMethod: "recovery" } });
  return { admin, app, recovery, viewer };
}

function requestHeaders(session: { csrfToken: string; sessionToken: string }) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    origin: "https://omnifin.example",
    "x-omnifin-csrf": session.csrfToken,
  };
}

describe("stack verification routes", () => {
  it("returns a strict no-store report without private deployment details", async () => {
    const fixture = await harness();
    try {
      const response = await fixture.app.inject({
        headers: requestHeaders(fixture.admin),
        method: "POST",
        url: "/v1/admin/setup/verification",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(stackVerificationResponseSchema.parse(response.json())).toMatchObject({
        configuredCount: 2,
        readyCount: 2,
        state: "ready",
      });
      expect(response.body).not.toMatch(
        /private|example\.test|issuer|client-id|latencyMs|external-user|private-server/u,
      );
    } finally {
      await fixture.app.close();
    }
  });

  it("requires exact-origin CSRF proof and rejects partial or recovery authority", async () => {
    const fixture = await harness();
    try {
      const noOrigin = await fixture.app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${fixture.admin.sessionToken}`,
          "x-omnifin-csrf": fixture.admin.csrfToken,
        },
        method: "POST",
        url: "/v1/admin/setup/verification",
      });
      const viewer = await fixture.app.inject({
        headers: requestHeaders(fixture.viewer),
        method: "POST",
        url: "/v1/admin/setup/verification",
      });
      const recovery = await fixture.app.inject({
        headers: requestHeaders(fixture.recovery),
        method: "POST",
        url: "/v1/admin/setup/verification",
      });

      expect(noOrigin.statusCode).toBe(403);
      expect(apiErrorSchema.parse(noOrigin.json()).error.code).toBe("origin_denied");
      expect(viewer.statusCode).toBe(403);
      expect(apiErrorSchema.parse(viewer.json()).error.code).toBe("permission_denied");
      expect(recovery.statusCode).toBe(403);
      expect(apiErrorSchema.parse(recovery.json()).error.code).toBe("permission_denied");
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects a second overlapping run for the same session", async () => {
    let releaseProbe: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fixture = await harness({
      probeConnector: async () => {
        markStarted?.();
        await hold;
        return { kind: "completed", value: health() };
      },
    });
    try {
      const first = fixture.app.inject({
        headers: requestHeaders(fixture.admin),
        method: "POST",
        url: "/v1/admin/setup/verification",
      });
      await started;
      const second = await fixture.app.inject({
        headers: requestHeaders(fixture.admin),
        method: "POST",
        url: "/v1/admin/setup/verification",
      });
      releaseProbe?.();

      expect(second.statusCode).toBe(409);
      expect(second.headers["retry-after"]).toBe("5");
      expect(apiErrorSchema.parse(second.json()).error.code).toBe("stack_verification_in_progress");
      expect((await first).statusCode).toBe(200);
    } finally {
      releaseProbe?.();
      await fixture.app.close();
    }
  });

  it("returns a bounded retryable failure when the report cannot be assembled", async () => {
    const fixture = await harness({ clock: () => new Date(Number.NaN) });
    try {
      const response = await fixture.app.inject({
        headers: requestHeaders(fixture.admin),
        method: "POST",
        url: "/v1/admin/setup/verification",
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "stack_verification_unavailable",
      );
    } finally {
      await fixture.app.close();
    }
  });
});
