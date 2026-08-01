import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { ManagedConnectorService } from "@omnifin/contracts/connectors";
import { setupReadinessResponseSchema } from "@omnifin/contracts/setup";
import { describe, expect, it } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, oidcProviders } from "../src/db/schema.js";
import { SafeHttpError } from "../src/http-error.js";
import { SetupReadinessService, type SetupReadinessError } from "../src/setup/readiness-service.js";

const now = new Date("2026-08-01T12:00:00.000Z");

function principal(role: Role = "admin", health: "linked" | "unavailable" = "linked") {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-31T12:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Stack administrator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-08-01T13:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Stack administrator",
        externalUserId: "private-jellyfin-user",
        health,
        id: "private-jellyfin-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "administrator",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${role}-setup-session`,
    userId: `${role}-setup-user`,
  });
}

function healthySnapshot(id: string, service: ManagedConnectorService) {
  return JSON.stringify({
    health: {
      capabilities: ["connector.health"],
      checkedAt: now.toISOString(),
      connectorId: id,
      displayName: `Private ${service}`,
      failure: null,
      latencyMs: 8,
      service,
      status: "healthy",
      version: "1.0.0",
    },
    schemaVersion: 1,
  });
}

function insertConnector(
  database: DatabaseHandle,
  service: ManagedConnectorService,
  options: {
    enabled?: boolean;
    healthState?: "degraded" | "healthy" | "offline" | "unknown";
    id?: string;
    snapshot?: string;
  } = {},
) {
  const id = options.id ?? `${service}-main`;
  const healthState = options.healthState ?? "healthy";
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: `https://${service}.private.example.test/`,
      capabilitySnapshotJson:
        options.snapshot ??
        (healthState === "healthy"
          ? healthySnapshot(id, service)
          : JSON.stringify({ schemaVersion: 1 })),
      createdAt: now,
      displayName: `Private ${service}`,
      enabled: options.enabled ?? true,
      encryptedCredentials: `${service}-private-encrypted-credentials`,
      healthState,
      id,
      insecureHttpApproved: false,
      tlsPolicy: "strict",
      type: service,
      updatedAt: now,
    })
    .run();
}

function insertReadyOidcProvider(database: DatabaseHandle) {
  database.db
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
}

function harness() {
  const database = openDatabase(":memory:");
  database.migrate();
  return {
    database,
    service: new SetupReadinessService(database, { clock: () => now }),
  };
}

describe("SetupReadinessService", () => {
  it("returns only normalized readiness for the current administrator and configured stack", () => {
    const fixture = harness();
    try {
      insertConnector(fixture.database, "jellyfin");
      insertConnector(fixture.database, "radarr");
      insertConnector(fixture.database, "sonarr", { healthState: "offline" });
      insertReadyOidcProvider(fixture.database);

      const result = fixture.service.read({ principal: principal() });

      expect(setupReadinessResponseSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        coreReady: true,
        essentialCompleted: 2,
        optionalReady: 2,
        steps: [
          { configuredCount: 1, id: "identity", readyCount: 1, state: "ready" },
          { configuredCount: 1, id: "jellyfin", readyCount: 1, state: "ready" },
          { configuredCount: 1, id: "oidc", readyCount: 1, state: "ready" },
          { configuredCount: 0, id: "discovery", readyCount: 0, state: "not_configured" },
          { configuredCount: 2, id: "acquisition", readyCount: 1, state: "partial" },
          { configuredCount: 0, id: "indexers", readyCount: 0, state: "not_configured" },
          { configuredCount: 0, id: "subtitles", readyCount: 0, state: "not_configured" },
          { configuredCount: 0, id: "downloads", readyCount: 0, state: "not_configured" },
        ],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /private|example\.test|jellyfin-main|radarr-main|sonarr-main|provider-id/u,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("marks an unavailable identity and disabled service for attention", () => {
    const fixture = harness();
    try {
      insertConnector(fixture.database, "jellyfin", { enabled: false });

      const result = fixture.service.read({ principal: principal("admin", "unavailable") });

      expect(result.coreReady).toBe(false);
      expect(result.steps.slice(0, 2)).toEqual([
        { configuredCount: 1, id: "identity", readyCount: 0, state: "attention" },
        { configuredCount: 1, id: "jellyfin", readyCount: 0, state: "attention" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when a healthy database row carries another connector's snapshot", () => {
    const fixture = harness();
    try {
      insertConnector(fixture.database, "jellyfin", {
        snapshot: healthySnapshot("another-connector", "jellyfin"),
      });

      expect(() => fixture.service.read({ principal: principal() })).toThrowError(
        expect.objectContaining<Partial<SetupReadinessError>>({ reason: "integrity_failure" }),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("requires full administrator authority at the service boundary", () => {
    const fixture = harness();
    try {
      expect(() =>
        fixture.service.read({ principal: principal("operator") as SessionPrincipal }),
      ).toThrowError(SafeHttpError);
    } finally {
      fixture.database.close();
    }
  });

  it("normalizes database failures without exposing storage details", () => {
    const fixture = harness();
    fixture.database.close();

    expect(() => fixture.service.read({ principal: principal() })).toThrowError(
      expect.objectContaining<Partial<SetupReadinessError>>({ reason: "storage_failure" }),
    );
  });
});
