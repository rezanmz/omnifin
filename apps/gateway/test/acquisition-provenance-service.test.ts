import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type {
  AcquisitionMonitoringState,
  AcquisitionProvenanceResponse,
  AcquisitionSearchResponse,
} from "@omnifin/contracts/acquisition";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, users } from "../src/db/schema.js";
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

const normalizedSearch: AcquisitionSearchResponse = {
  acceptedAt: now.toISOString(),
  operationId: "radarr:command:812",
  state: "queued",
  target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
};

const monitoredState: AcquisitionMonitoringState = {
  monitored: true,
  target: { kind: "movie", mediaId: 42, service: "radarr" },
  verifiedAt: now.toISOString(),
};

const unmonitoredState: AcquisitionMonitoringState = {
  ...monitoredState,
  monitored: false,
};

function capabilitySnapshot(id: string, service: "radarr" | "sonarr") {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        "acquisition.history",
        "acquisition.monitoring",
        "acquisition.search",
      ],
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
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Acquisition operator",
      id: "operator-user",
      role: "operator",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  if (options.withConnector !== false) insertConnector(database, config);
  const readAcquisitionProvenance = vi.fn(async () => normalizedResponse);
  const readAcquisitionMonitoring = vi.fn(async () => monitoredState);
  const queueAcquisitionSearch = vi.fn(async () => normalizedSearch);
  const updateAcquisitionMonitoring = vi.fn(async () => unmonitoredState);
  let identifier = 0;
  const createAdapter = vi.fn(() => ({
    queueAcquisitionSearch,
    readAcquisitionMonitoring,
    readAcquisitionProvenance,
    updateAcquisitionMonitoring,
  }));
  const service = new AcquisitionProvenanceService(database, config, {
    clock: () => now,
    createAdapter,
    createId: () => `acquisition-operation-${++identifier}`,
  });
  return {
    config,
    createAdapter,
    database,
    queueAcquisitionSearch,
    readAcquisitionMonitoring,
    readAcquisitionProvenance,
    service,
    updateAcquisitionMonitoring,
  };
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

  it("queues, audits, and safely replays one idempotent operator search", async () => {
    const { database, queueAcquisitionSearch, service } = harness();
    try {
      const context = {
        ipAddress: "198.51.100.24",
        principal: principal(),
        requestId: "route-request-1",
      };
      const first = await service.queueSearch(
        { mediaId: 42, service: "radarr" },
        "acquisition-01234567-89ab-cdef-0123-456789abcdef",
        context,
      );
      const replay = await service.queueSearch(
        { mediaId: 42, service: "radarr" },
        "acquisition-01234567-89ab-cdef-0123-456789abcdef",
        context,
      );

      expect(first).toEqual({ replayed: false, search: normalizedSearch });
      expect(replay).toEqual({ replayed: true, search: normalizedSearch });
      expect(queueAcquisitionSearch).toHaveBeenCalledTimes(1);
      const operation = database.sqlite
        .prepare(
          `select idempotency_key_hash as keyHash, fingerprint_hash as fingerprintHash,
             response_json as responseJson, state
           from acquisition_search_operations`,
        )
        .get() as {
        fingerprintHash: string;
        keyHash: string;
        responseJson: string;
        state: string;
      };
      expect(operation).toMatchObject({ state: "succeeded" });
      expect(operation.keyHash).toHaveLength(43);
      expect(operation.fingerprintHash).toHaveLength(43);
      expect(operation.responseJson).not.toContain("acquisition-01234567");
      const audits = database.sqlite
        .prepare(
          `select event_type as eventType, outcome, target_id as targetId, metadata_json as metadataJson,
             ip_hash as ipHash from audit_events where event_type = 'acquisition.search.queued'`,
        )
        .all() as {
        eventType: string;
        ipHash: string;
        metadataJson: string;
        outcome: string;
        targetId: string;
      }[];
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        eventType: "acquisition.search.queued",
        outcome: "success",
        targetId: "radarr:command:812",
      });
      expect(audits[0]?.ipHash).toHaveLength(22);
      expect(audits[0]?.metadataJson).not.toContain("acquisition-01234567");
    } finally {
      database.close();
    }
  });

  it("reads and updates exact-target monitoring with a bounded audit record", async () => {
    const { database, readAcquisitionMonitoring, service, updateAcquisitionMonitoring } = harness();
    try {
      const context = {
        ipAddress: "198.51.100.41",
        principal: principal(),
        requestId: "monitoring-request-1",
      };
      await expect(
        service.readMonitoring({ mediaId: 42, service: "radarr" }, context),
      ).resolves.toEqual(monitoredState);
      await expect(
        service.updateMonitoring(
          {
            expectedMonitored: true,
            mediaId: 42,
            monitored: false,
            service: "radarr",
          },
          context,
        ),
      ).resolves.toEqual(unmonitoredState);

      expect(readAcquisitionMonitoring).toHaveBeenCalledTimes(2);
      expect(updateAcquisitionMonitoring).toHaveBeenCalledWith(
        {
          expectedMonitored: true,
          mediaId: 42,
          monitored: false,
          service: "radarr",
        },
        undefined,
      );
      const audit = database.sqlite
        .prepare(
          `select event_type as eventType, outcome, target_type as targetType,
             target_id as targetId, metadata_json as metadataJson, ip_hash as ipHash
           from audit_events where event_type = 'acquisition.monitoring.updated'`,
        )
        .get() as {
        eventType: string;
        ipHash: string;
        metadataJson: string;
        outcome: string;
        targetId: string;
        targetType: string;
      };
      expect(audit).toMatchObject({
        eventType: "acquisition.monitoring.updated",
        outcome: "success",
        targetId: "radarr:42",
        targetType: "acquisition_monitoring",
      });
      expect(audit.ipHash).toHaveLength(22);
      expect(JSON.parse(audit.metadataJson)).toEqual({
        mediaId: 42,
        monitored: false,
        previousMonitored: true,
        replayed: false,
        service: "radarr",
      });
      const requestAudit = database.sqlite
        .prepare(
          `select event_type as eventType, outcome
           from audit_events where event_type = 'acquisition.monitoring.requested'`,
        )
        .get() as { eventType: string; outcome: string };
      expect(requestAudit).toEqual({
        eventType: "acquisition.monitoring.requested",
        outcome: "success",
      });
    } finally {
      database.close();
    }
  });

  it("persists monitoring intent before an upstream mutation and fails closed on audit storage loss", async () => {
    const { database, readAcquisitionMonitoring, service, updateAcquisitionMonitoring } = harness();
    readAcquisitionMonitoring.mockImplementationOnce(async () => {
      database.sqlite.exec("drop table audit_events");
      return monitoredState;
    });
    try {
      await expect(
        service.updateMonitoring(
          {
            expectedMonitored: true,
            mediaId: 42,
            monitored: false,
            service: "radarr",
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "storage_failure" });
      expect(updateAcquisitionMonitoring).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("replays an already-achieved monitoring state without a second mutation", async () => {
    const { database, readAcquisitionMonitoring, service, updateAcquisitionMonitoring } = harness();
    readAcquisitionMonitoring.mockResolvedValueOnce(unmonitoredState);
    try {
      await expect(
        service.updateMonitoring(
          {
            expectedMonitored: true,
            mediaId: 42,
            monitored: false,
            service: "radarr",
          },
          { principal: principal() },
        ),
      ).resolves.toEqual(unmonitoredState);
      expect(updateAcquisitionMonitoring).not.toHaveBeenCalled();
      const audit = database.sqlite
        .prepare(
          `select event_type as eventType, metadata_json as metadataJson
           from audit_events where event_type = 'acquisition.monitoring.replayed'`,
        )
        .get() as { eventType: string; metadataJson: string };
      expect(audit.eventType).toBe("acquisition.monitoring.replayed");
      expect(JSON.parse(audit.metadataJson)).toMatchObject({ replayed: true });
    } finally {
      database.close();
    }
  });

  it("rejects idempotency key reuse for a different target before a second mutation", async () => {
    const { database, queueAcquisitionSearch, service } = harness();
    try {
      const key = "acquisition-abcdef01-2345-6789-abcd-ef0123456789";
      await service.queueSearch({ mediaId: 42, service: "radarr" }, key, {
        principal: principal(),
      });
      await expect(
        service.queueSearch({ mediaId: 43, service: "radarr" }, key, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      expect(queueAcquisitionSearch).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("persists and audits a sanitized failed outcome without automatic resubmission", async () => {
    const { database, queueAcquisitionSearch, service } = harness();
    queueAcquisitionSearch.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "timeout",
        message: "Private Radarr timeout at /private/path",
        operation: "acquisition.search",
        retryable: true,
        service: "radarr",
      }),
    );
    const key = "acquisition-failure-0123456789abcdef";
    try {
      await expect(
        service.queueSearch({ mediaId: 42, service: "radarr" }, key, {
          principal: principal(),
          requestId: "failure-request",
        }),
      ).rejects.toMatchObject({ reason: "temporarily_unavailable" });
      await expect(
        service.queueSearch({ mediaId: 42, service: "radarr" }, key, {
          principal: principal(),
          requestId: "failure-request",
        }),
      ).rejects.toMatchObject({ reason: "temporarily_unavailable" });
      expect(queueAcquisitionSearch).toHaveBeenCalledTimes(1);
      const stored = database.sqlite
        .prepare(
          `select state, failure_code as failureCode, response_json as responseJson
           from acquisition_search_operations`,
        )
        .get() as { failureCode: string; responseJson: null; state: string };
      expect(stored).toEqual({
        failureCode: "temporarily_unavailable",
        responseJson: null,
        state: "failed",
      });
      const audit = database.sqlite
        .prepare(
          `select event_type as eventType, metadata_json as metadataJson, outcome
           from audit_events where event_type = 'acquisition.search.failed'`,
        )
        .get() as { eventType: string; metadataJson: string; outcome: string };
      expect(audit).toMatchObject({ eventType: "acquisition.search.failed", outcome: "failure" });
      expect(audit.metadataJson).not.toContain("Private Radarr");
      expect(JSON.stringify(stored)).not.toContain("/private/path");
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
