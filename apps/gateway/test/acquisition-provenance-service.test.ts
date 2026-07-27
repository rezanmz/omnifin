import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { AcquisitionProvenanceResponse } from "@omnifin/contracts/acquisition";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs } from "../src/db/schema.js";
import {
  AcquisitionProvenanceService,
  type AcquisitionProvenanceError,
} from "../src/acquisitions/provenance-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-27T18:30:00.000Z");
const privateApiKey = "acquisition-private-api-key";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 83),
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
    absoluteExpiresAt: "2026-08-26T18:30:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Acquisition operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-27T19:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Acquisition operator",
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
    sessionId: `${role}-session`,
    userId: `${role}-user`,
  });
}

const normalizedResponse: AcquisitionProvenanceResponse = {
  events: [
    {
      episodeNumbers: [],
      id: "radarr:history:81",
      kind: "grabbed",
      occurredAt: "2026-07-27T18:20:00.000Z",
      release: {
        downloadClient: "qBittorrent",
        indexer: "Cinema Index",
        protocol: "torrent",
        quality: "Bluray-2160p",
        sizeBytes: null,
        title: "A.Safe.Release",
      },
      seasonNumber: null,
      state: "success",
      summary: "Release was sent to the download client.",
    },
  ],
  failures: [],
  generatedAt: now.toISOString(),
  state: "complete",
  target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
};

function capabilitySnapshot(id: string, service: "radarr" | "sonarr") {
  return JSON.stringify({
    health: {
      capabilities: ["connector.health", "connector.version", "acquisition.history"],
      checkedAt: now.toISOString(),
      connectorId: id,
      displayName: service === "radarr" ? "Radarr" : "Sonarr",
      failure: null,
      latencyMs: 12,
      service,
      status: "healthy",
      version: "5.22.4",
    },
    schemaVersion: 1,
  });
}

function insertConnector(
  database: DatabaseHandle,
  config: AppConfig,
  service: "radarr" | "sonarr" = "radarr",
  id = `${service}-main`,
) {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: `https://${service}.example.test/`,
      capabilitySnapshotJson: capabilitySnapshot(id, service),
      createdAt: now,
      displayName: service === "radarr" ? "Radarr" : "Sonarr",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({
          credentials: { apiKey: privateApiKey, kind: "api_key" },
          schemaVersion: 1,
        }),
        `connector_credentials:${service}:${id}`,
      ),
      healthState: "healthy",
      id,
      type: service,
      updatedAt: now,
    })
    .run();
}

function harness(options: { withConnector?: boolean } = {}) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  if (options.withConnector !== false) insertConnector(database, config);
  const readAcquisitionProvenance = vi.fn(async () => normalizedResponse);
  const createAdapter = vi.fn(() => ({ readAcquisitionProvenance }));
  const service = new AcquisitionProvenanceService(database, config, {
    clock: () => now,
    createAdapter,
  });
  return { config, createAdapter, database, readAcquisitionProvenance, service };
}

describe("acquisition provenance service", () => {
  it("authorizes, decrypts one matching connector, and returns normalized provenance", async () => {
    const { createAdapter, database, readAcquisitionProvenance, service } = harness();
    try {
      const response = await service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );

      expect(response).toEqual(normalizedResponse);
      expect(createAdapter).toHaveBeenCalledWith(
        "radarr",
        expect.objectContaining({
          apiKey: privateApiKey,
          baseUrl: "https://radarr.example.test/",
          connectorId: "radarr-main",
          tlsPolicy: "strict",
        }),
      );
      expect(readAcquisitionProvenance).toHaveBeenCalledWith(
        { mediaId: 42, service: "radarr" },
        undefined,
      );
      expect(JSON.stringify(response)).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("denies viewers before reading connector configuration", async () => {
    const { database, service } = harness({ withConnector: false });
    try {
      await expect(
        service.read({ mediaId: 42, service: "radarr" }, { principal: principal("viewer") }),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
    } finally {
      database.close();
    }
  });

  it("distinguishes missing and ambiguous service connectors", async () => {
    const missing = harness({ withConnector: false });
    try {
      await expect(
        missing.service.read({ mediaId: 42, service: "radarr" }, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "connector_unconfigured" });
    } finally {
      missing.database.close();
    }

    const ambiguous = harness();
    try {
      insertConnector(ambiguous.database, ambiguous.config, "radarr", "radarr-secondary");
      await expect(
        ambiguous.service.read({ mediaId: 42, service: "radarr" }, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "connector_ambiguous" });
    } finally {
      ambiguous.database.close();
    }
  });

  it("rejects corrupt capability snapshots and encrypted credentials without exposing them", async () => {
    const snapshot = harness();
    try {
      snapshot.database.sqlite
        .prepare("update connector_configs set capability_snapshot_json = ? where id = ?")
        .run(JSON.stringify({ schemaVersion: 1 }), "radarr-main");
      await expect(
        snapshot.service.read({ mediaId: 42, service: "radarr" }, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "connector_integrity_failure" });
    } finally {
      snapshot.database.close();
    }

    const credentials = harness();
    const privateValue = "corrupted-acquisition-private-material";
    try {
      credentials.database.sqlite
        .prepare("update connector_configs set encrypted_credentials = ? where id = ?")
        .run(privateValue, "radarr-main");
      let failure: unknown;
      try {
        await credentials.service.read(
          { mediaId: 42, service: "radarr" },
          { principal: principal() },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject<Partial<AcquisitionProvenanceError>>({
        reason: "connector_integrity_failure",
      });
      expect(JSON.stringify(failure)).not.toContain(privateValue);
    } finally {
      credentials.database.close();
    }
  });
});
