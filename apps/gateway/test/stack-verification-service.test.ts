import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type OidcProviderCapabilities,
  type Role,
} from "@omnifin/contracts/auth";
import type { ConnectorHealth, ManagedConnectorService } from "@omnifin/contracts/connectors";
import { stackVerificationResponseSchema } from "@omnifin/contracts/setup";
import { describe, expect, it } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, oidcProviders } from "../src/db/schema.js";
import { SafeHttpError } from "../src/http-error.js";
import { StackVerificationService } from "../src/setup/stack-verification-service.js";

const now = new Date("2026-08-01T12:00:00.000Z");

function principal(role: Role = "admin") {
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
        health: "linked",
        id: "private-jellyfin-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "administrator",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${role}-verification-session`,
    userId: `${role}-verification-user`,
  });
}

function insertConnector(
  database: DatabaseHandle,
  service: ManagedConnectorService,
  id = `${service}-private`,
  enabled = true,
) {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: `https://${service}.private.example.test/`,
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: `Private ${service}`,
      enabled,
      encryptedCredentials: "private-encrypted-value",
      healthState: "unknown",
      id,
      insecureHttpApproved: false,
      tlsPolicy: "strict",
      type: service,
      updatedAt: now,
    })
    .run();
}

function insertOidc(database: DatabaseHandle, enabled = true) {
  database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(["https://auth.private.example.test"]),
      clientId: "private-client",
      createdAt: now,
      discoveryCapabilitiesJson: "{}",
      discoveryCheckedAt: null,
      discoveryState: "unchecked",
      displayName: "Private identity provider",
      enabled,
      id: "oidc-private",
      issuer: "https://auth.private.example.test/application/o/omnifin/",
      slug: "private",
      tokenEndpointAuthMethod: "none",
      updatedAt: now,
    })
    .run();
}

function health(
  connectorId: string,
  service: ManagedConnectorService,
  overrides: Partial<ConnectorHealth> = {},
): ConnectorHealth {
  return {
    capabilities: ["connector.health", "connector.version"],
    checkedAt: now.toISOString(),
    connectorId,
    displayName: `Private ${service}`,
    failure: null,
    latencyMs: 8,
    service,
    status: "healthy",
    version: "1.2.3",
    ...overrides,
  };
}

function oidcCapabilities(): OidcProviderCapabilities {
  return {
    authorizationCodeFlow: true,
    idTokenSigningAlg: "RS256",
    logout: {
      backChannel: true,
      backChannelSession: true,
      frontChannel: true,
      frontChannelSession: false,
      rpInitiated: true,
    },
    pkceS256: true,
    schemaVersion: 1,
    tokenEndpointAuthMethod: "none",
    userInfo: true,
  };
}

function harness(
  overrides: Partial<ConstructorParameters<typeof StackVerificationService>[1]> = {},
) {
  const database = openDatabase(":memory:");
  database.migrate();
  const service = new StackVerificationService(database, {
    clock: () => now,
    probeConnector: async (connectorId) => {
      const row = database.sqlite
        .prepare("select type from connector_configs where id = ?")
        .get(connectorId) as { type: ManagedConnectorService };
      return { kind: "completed", value: health(connectorId, row.type) };
    },
    validateOidcProvider: async () => ({ kind: "completed", value: oidcCapabilities() }),
    ...overrides,
  });
  return { database, service };
}

describe("StackVerificationService", () => {
  it("returns only canonical aggregate service evidence", async () => {
    const fixture = harness();
    try {
      insertOidc(fixture.database);
      insertConnector(fixture.database, "jellyfin");
      insertConnector(fixture.database, "radarr");

      const report = await fixture.service.run({ principal: principal() });

      expect(stackVerificationResponseSchema.parse(report)).toEqual(report);
      expect(report).toMatchObject({
        configuredCount: 3,
        format: "omnifin-stack-verification",
        readyCount: 3,
        scope: "local_diagnostic",
        state: "ready",
      });
      expect(report.checks[0]).toMatchObject({
        capabilities: [
          "oidc.authorization_code",
          "oidc.pkce_s256",
          "oidc.userinfo",
          "oidc.logout.rp_initiated",
          "oidc.logout.front_channel",
          "oidc.logout.back_channel",
        ],
        id: "oidc",
        state: "ready",
      });
      expect(JSON.stringify(report)).not.toMatch(
        /private|example\.test|connectorId|displayName|issuer|client|latency|request/u,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("isolates failures, marks disabled services unavailable, and redacts hostile versions", async () => {
    const fixture = harness({
      probeConnector: async (connectorId) => {
        if (connectorId.startsWith("sonarr")) throw new Error("private upstream detail");
        return {
          kind: "completed",
          value: health(connectorId, "radarr", {
            version: "private-db01.local",
          }),
        };
      },
      validateOidcProvider: async () => ({
        finding: "configuration_invalid",
        kind: "unavailable",
      }),
    });
    try {
      insertOidc(fixture.database);
      insertConnector(fixture.database, "radarr", "radarr-private", false);
      insertConnector(fixture.database, "sonarr");

      const report = await fixture.service.run({ principal: principal() });

      expect(report.state).toBe("attention");
      expect(report.readyCount).toBe(0);
      expect(report.checks.find(({ id }) => id === "oidc")?.findings).toEqual([
        { code: "configuration_invalid", count: 1 },
      ]);
      expect(report.checks.find(({ id }) => id === "radarr")).toMatchObject({
        enabledCount: 0,
        findings: [
          { code: "disabled", count: 1 },
          { code: "version_redacted", count: 1 },
        ],
        versions: [],
      });
      expect(report.checks.find(({ id }) => id === "sonarr")?.findings).toEqual([
        { code: "verification_unavailable", count: 1 },
      ]);
      expect(JSON.stringify(report)).not.toContain("private-db01.local");
    } finally {
      fixture.database.close();
    }
  });

  it("reports partial readiness while preserving a normalized upstream failure", async () => {
    const fixture = harness({
      probeConnector: async (connectorId) =>
        connectorId === "radarr-ready"
          ? { kind: "completed", value: health(connectorId, "radarr") }
          : {
              kind: "completed",
              value: health(connectorId, "radarr", {
                failure: {
                  code: "timeout",
                  message: "Private upstream detail",
                  occurredAt: now.toISOString(),
                  operation: "connector.health",
                  retryable: true,
                  service: "radarr",
                },
                status: "unavailable",
                version: null,
              }),
            },
      validateOidcProvider: async () => ({
        kind: "completed",
        value: {
          ...oidcCapabilities(),
          logout: {
            backChannel: false,
            backChannelSession: false,
            frontChannel: false,
            frontChannelSession: false,
            rpInitiated: false,
          },
          userInfo: false,
        },
      }),
    });
    try {
      insertOidc(fixture.database);
      insertConnector(fixture.database, "radarr", "radarr-ready");
      insertConnector(fixture.database, "radarr", "radarr-timeout");

      const report = await fixture.service.run({ principal: principal() });

      expect(report.state).toBe("partial");
      expect(report.checks[0]?.capabilities).toEqual(["oidc.authorization_code", "oidc.pkce_s256"]);
      expect(report.checks.find(({ id }) => id === "radarr")).toMatchObject({
        configuredCount: 2,
        findings: [{ code: "timeout", count: 1 }],
        readyCount: 1,
        state: "partial",
        versions: ["1.2.3"],
      });
      expect(JSON.stringify(report)).not.toContain("Private upstream detail");
    } finally {
      fixture.database.close();
    }
  });

  it("bounds concurrent upstream work to four checks", async () => {
    let active = 0;
    let maximum = 0;
    const fixture = harness({
      probeConnector: async (connectorId) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { kind: "completed", value: health(connectorId, "radarr") };
      },
    });
    try {
      for (let index = 0; index < 8; index += 1) {
        insertConnector(fixture.database, "radarr", `radarr-${index}`);
      }

      await fixture.service.run({ principal: principal() });

      expect(maximum).toBe(4);
    } finally {
      fixture.database.close();
    }
  });

  it("contains a malformed completed provider result as one unavailable check", async () => {
    const fixture = harness({
      validateOidcProvider: async () => ({
        kind: "completed",
        value: { issuer: "https://private.example.test" } as unknown as OidcProviderCapabilities,
      }),
    });
    try {
      insertOidc(fixture.database);

      const report = await fixture.service.run({ principal: principal() });

      expect(report.checks[0]).toMatchObject({
        findings: [{ code: "verification_unavailable", count: 1 }],
        readyCount: 0,
        state: "attention",
      });
      expect(JSON.stringify(report)).not.toContain("private.example.test");
    } finally {
      fixture.database.close();
    }
  });

  it("requires full administrator permissions at the service boundary", async () => {
    const fixture = harness();
    try {
      await expect(fixture.service.run({ principal: principal("operator") })).rejects.toThrow(
        SafeHttpError,
      );
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when configuration storage cannot be read", async () => {
    const fixture = harness();
    fixture.database.close();

    await expect(fixture.service.run({ principal: principal() })).rejects.toMatchObject({
      reason: "storage_failure",
    });
  });
});
