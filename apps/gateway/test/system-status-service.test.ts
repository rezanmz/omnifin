import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { systemStatusResponseSchema } from "@omnifin/contracts/system";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";
import {
  SystemStatusService,
  type SystemStatusAdapterFactoryInput,
} from "../src/system/status-service.js";

const now = new Date("2026-07-28T23:45:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 109),
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

function principal(role: Role = "operator"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-27T23:45:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Stack operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-29T00:45:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Stack operator",
        externalUserId: `${role}-external`,
        health: "linked",
        id: `${role}-link`,
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: role,
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${role}-system-session`,
    userId: `${role}-system-user`,
  });
}

function insertConnector(
  database: DatabaseHandle,
  config: AppConfig,
  service: "radarr" | "sonarr" | "prowlarr",
  id = `${service}-main`,
) {
  const apiKey = `${service}-private-api-key`;
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: `https://${service}.example.test/`,
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName:
        service === "radarr" ? "Cinema" : service === "sonarr" ? "Television" : "Indexers",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({ credentials: { apiKey, kind: "api_key" }, schemaVersion: 1 }),
        `connector_credentials:${service}:${id}`,
      ),
      healthState: "healthy",
      id,
      insecureHttpApproved: false,
      tlsPolicy: "strict",
      type: service,
      updatedAt: now,
    })
    .run();
}

function harness(options: { withConnectors?: boolean } = {}) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  if (options.withConnectors !== false) {
    insertConnector(database, config, "radarr");
    insertConnector(database, config, "sonarr");
    insertConnector(database, config, "prowlarr");
  }
  const readSystemHealth = {
    prowlarr: vi.fn(async () =>
      Promise.reject(
        new SafeConnectorError({
          code: "timeout",
          message: "prowlarr did not answer before the connector timeout.",
          operation: "system.health",
          retryable: true,
          service: "prowlarr",
        }),
      ),
    ),
    radarr: vi.fn(async () => [
      {
        externalId: "root-folder-warning",
        message: "A configured root folder is unavailable.",
        severity: "warning" as const,
        sourceLabel: "Root folder",
      },
    ]),
    sonarr: vi.fn(async () => []),
  };
  const readStorageCapacity = {
    radarr: vi.fn(async () => [
      {
        externalId: "/private/media/movies",
        freeBytes: 40_000_000_000,
        totalBytes: 1_000_000_000_000,
      },
    ]),
    sonarr: vi.fn(async () => [
      {
        externalId: "/private/media/television",
        freeBytes: 400_000_000_000,
        totalBytes: 1_000_000_000_000,
      },
    ]),
  };
  const createAdapter = vi.fn((input: SystemStatusAdapterFactoryInput) => ({
    readSystemHealth: readSystemHealth[input.service],
    ...(input.service === "prowlarr"
      ? {}
      : { readStorageCapacity: readStorageCapacity[input.service] }),
    service: input.service,
  }));
  const service = new SystemStatusService(database, config, {
    clock: () => now,
    createAdapter,
  });
  return { config, createAdapter, database, readStorageCapacity, readSystemHealth, service };
}

describe("system status service", () => {
  it("aggregates every Arr source while replacing connector, signal, and mount identifiers", async () => {
    const fixture = harness();
    try {
      const first = await fixture.service.read({ principal: principal() });
      const second = await fixture.service.read({ principal: principal() });

      expect(systemStatusResponseSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        state: "degraded",
        summary: {
          attentionSources: 1,
          criticalStorage: 1,
          errorSignals: 0,
          healthySources: 1,
          noticeSignals: 0,
          sources: 3,
          unavailableSources: 1,
          warningSignals: 1,
          warningStorage: 0,
        },
      });
      expect(first.sources.map((source) => source.service)).toEqual([
        "radarr",
        "sonarr",
        "prowlarr",
      ]);
      expect(first.sources.map((source) => source.id)).toEqual(
        second.sources.map((source) => source.id),
      );
      expect(first.sources[0]?.signals[0]?.id).toMatch(/^signal_[A-Za-z0-9_-]{22}$/u);
      expect(first.sources[0]?.storage[0]).toMatchObject({
        label: "Cinema storage 1",
        state: "critical",
      });
      expect(first.sources[2]).toMatchObject({
        failure: { code: "timeout", retryable: true },
        signals: [],
        status: "unavailable",
        storage: [],
      });
      expect(JSON.stringify(first)).not.toMatch(/private\/media|private-api-key|radarr-main/u);
      expect(fixture.createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "radarr-private-api-key", service: "radarr" }),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("preserves healthy telemetry when only one capacity read fails", async () => {
    const fixture = harness();
    fixture.readStorageCapacity.sonarr.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "unreachable",
        message: "sonarr could not be reached.",
        operation: "storage.read",
        retryable: true,
        service: "sonarr",
      }),
    );
    try {
      const response = await fixture.service.read({ principal: principal() });
      expect(response.sources[1]).toMatchObject({
        failure: { code: "unreachable", operation: "storage.read" },
        signals: [],
        status: "attention",
        storage: [],
      });
      expect(response.state).toBe("degraded");
    } finally {
      fixture.database.close();
    }
  });

  it("returns a deliberate unconfigured state and rejects non-operators", async () => {
    const fixture = harness({ withConnectors: false });
    try {
      await expect(fixture.service.read({ principal: principal("viewer") })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(fixture.service.read({ principal: principal() })).resolves.toMatchObject({
        sources: [],
        state: "unconfigured",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when configured source count exceeds the public response bound", async () => {
    const fixture = harness({ withConnectors: false });
    for (let index = 0; index <= 12; index += 1) {
      insertConnector(fixture.database, fixture.config, "radarr", `radarr-${index}`);
    }
    try {
      await expect(fixture.service.read({ principal: principal() })).rejects.toEqual(
        expect.objectContaining({ reason: "source_limit_exceeded" }),
      );
    } finally {
      fixture.database.close();
    }
  });
});
