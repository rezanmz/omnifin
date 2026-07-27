import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type {
  IndexerApplication,
  IndexerFailure,
  IndexerIntelligenceItem,
} from "@omnifin/contracts/indexers";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, users } from "../src/db/schema.js";
import { IndexerIntelligenceService } from "../src/indexers/intelligence-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-27T18:30:00.000Z");
const privateApiKey = "prowlarr-private-api-key";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 91),
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
    displayName: "Indexer operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-27T19:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Indexer operator",
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

const item: IndexerIntelligenceItem = {
  disabledUntil: null,
  enabled: true,
  id: 4,
  initialFailureAt: null,
  mostRecentFailureAt: null,
  name: "Nebula",
  privacy: "private",
  protocol: "torrent",
  state: "healthy",
  statistics: {
    averageGrabResponseTimeMs: 210,
    averageQueryResponseTimeMs: 340,
    failedGrabs: 0,
    failedQueries: 2,
    grabs: 14,
    queries: 98,
    successRate: 96 / 98,
  },
  supportsRss: true,
  supportsSearch: true,
};

const application: IndexerApplication = {
  id: 2,
  implementation: "Radarr",
  name: "Movies",
  syncLevel: "full_sync",
};

const failure: IndexerFailure = {
  id: "prowlarr:history:22",
  indexerId: 4,
  kind: "query",
  latencyMs: 840,
  occurredAt: "2026-07-27T18:25:00.000Z",
  summary: "Search query failed",
};

function capabilitySnapshot() {
  return JSON.stringify({
    health: {
      capabilities: ["connector.health", "connector.version", "indexer.statistics", "indexer.test"],
      checkedAt: now.toISOString(),
      connectorId: "prowlarr-main",
      displayName: "Prowlarr",
      failure: null,
      latencyMs: 12,
      service: "prowlarr",
      status: "healthy",
      version: "2.5.2.5491",
    },
    schemaVersion: 1,
  });
}

function insertConnector(database: DatabaseHandle, config: AppConfig) {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://prowlarr.example.test/",
      capabilitySnapshotJson: capabilitySnapshot(),
      createdAt: now,
      displayName: "Prowlarr",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({
          credentials: { apiKey: privateApiKey, kind: "api_key" },
          schemaVersion: 1,
        }),
        "connector_credentials:prowlarr:prowlarr-main",
      ),
      healthState: "healthy",
      id: "prowlarr-main",
      type: "prowlarr",
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
      displayName: "Indexer operator",
      id: "operator-user",
      role: "operator",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  if (options.withConnector !== false) insertConnector(database, config);
  const readIndexerIntelligencePage = vi.fn(async () => ({
    failures: [],
    generatedAt: now.toISOString(),
    hasMore: true,
    items: [item],
    periodEndedAt: now.toISOString(),
    periodStartedAt: "2026-07-26T18:30:00.000Z",
    summary: { attention: 0, disabled: 0, enabled: 1, failedQueries: 2, queries: 98, total: 1 },
  }));
  const readApplicationPage = vi.fn(async () => ({
    generatedAt: now.toISOString(),
    hasMore: false,
    items: [application],
  }));
  const readFailurePage = vi.fn(async () => ({
    generatedAt: now.toISOString(),
    hasMore: true,
    items: [failure],
  }));
  const testIndexer = vi.fn(async (indexerId: number) => ({
    indexerId,
    outcome: "passed" as const,
    testedAt: now.toISOString(),
  }));
  let identifier = 0;
  const createAdapter = vi.fn(() => ({
    readApplicationPage,
    readFailurePage,
    readIndexerIntelligencePage,
    testIndexer,
  }));
  const service = new IndexerIntelligenceService(database, config, {
    clock: () => now,
    createAdapter,
    createId: () => `indexer-audit-${++identifier}`,
  });
  return {
    config,
    createAdapter,
    database,
    readApplicationPage,
    readFailurePage,
    readIndexerIntelligencePage,
    service,
    testIndexer,
  };
}

describe("indexer intelligence service", () => {
  it("decrypts one capable Prowlarr connector and returns cursor-paginated intelligence", async () => {
    const fixture = harness();
    try {
      const response = await fixture.service.readIndexers(
        { limit: 25 },
        { principal: principal() },
      );

      expect(response.items).toEqual([item]);
      expect(response.nextCursor).toBe(Buffer.from("id:4").toString("base64url"));
      expect(fixture.createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: privateApiKey,
          baseUrl: "https://prowlarr.example.test/",
          connectorId: "prowlarr-main",
          tlsPolicy: "strict",
        }),
      );
      expect(JSON.stringify(response)).not.toContain(privateApiKey);
    } finally {
      fixture.database.close();
    }
  });

  it("decodes stable application and failure cursors without exposing upstream page numbers", async () => {
    const fixture = harness();
    try {
      await fixture.service.readApplications(
        { cursor: Buffer.from("id:1").toString("base64url"), limit: 10 },
        { principal: principal() },
      );
      const response = await fixture.service.readFailures(
        { cursor: Buffer.from("page:2:10").toString("base64url"), limit: 10 },
        { principal: principal() },
      );

      expect(fixture.readApplicationPage).toHaveBeenCalledWith(
        { afterId: 1, limit: 10 },
        undefined,
      );
      expect(fixture.readFailurePage).toHaveBeenCalledWith({ limit: 10, page: 2 }, undefined);
      expect(response.nextCursor).toBe(Buffer.from("page:3:10").toString("base64url"));
    } finally {
      fixture.database.close();
    }
  });

  it("rejects malformed and cross-page-size cursors before calling Prowlarr", async () => {
    const fixture = harness();
    try {
      await expect(
        fixture.service.readFailures(
          { cursor: Buffer.from("page:2:10").toString("base64url"), limit: 20 },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
      expect(fixture.readFailurePage).not.toHaveBeenCalled();
    } finally {
      fixture.database.close();
    }
  });

  it("tests an indexer and writes a minimal, privacy-preserving audit event", async () => {
    const fixture = harness();
    try {
      const response = await fixture.service.testIndexer(
        { indexerId: 4 },
        { ipAddress: "198.51.100.30", principal: principal(), requestId: "indexer-request-1" },
      );

      expect(response).toEqual({ indexerId: 4, outcome: "passed", testedAt: now.toISOString() });
      const audit = fixture.database.sqlite
        .prepare(
          `select event_type as eventType, outcome, target_id as targetId,
             metadata_json as metadataJson, ip_hash as ipHash
           from audit_events where event_type = 'indexer.test.passed'`,
        )
        .get() as {
        eventType: string;
        ipHash: string;
        metadataJson: string;
        outcome: string;
        targetId: string;
      };
      expect(audit).toMatchObject({
        eventType: "indexer.test.passed",
        outcome: "success",
        targetId: "4",
      });
      expect(audit.ipHash).toHaveLength(22);
      expect(audit.metadataJson).toBe('{"indexerId":4}');
      expect(audit.metadataJson).not.toContain(privateApiKey);
    } finally {
      fixture.database.close();
    }
  });

  it("audits a sanitized failure while preserving the safe connector error", async () => {
    const fixture = harness();
    fixture.testIndexer.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "timeout",
        message: "Private upstream details must not be audited",
        operation: "indexer.test",
        retryable: true,
        service: "prowlarr",
      }),
    );
    try {
      await expect(
        fixture.service.testIndexer(
          { indexerId: 4 },
          { principal: principal(), requestId: "indexer-failure-1" },
        ),
      ).rejects.toMatchObject({ code: "timeout" });
      const audit = fixture.database.sqlite
        .prepare(
          `select metadata_json as metadataJson from audit_events
           where event_type = 'indexer.test.failed'`,
        )
        .get() as { metadataJson: string };
      expect(audit.metadataJson).toBe('{"failureCode":"timeout","indexerId":4}');
      expect(audit.metadataJson).not.toContain("Private upstream details");
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed for viewers, absent connectors, and invalid capability snapshots", async () => {
    const fixture = harness({ withConnector: false });
    try {
      await expect(
        fixture.service.readIndexers({ limit: 25 }, { principal: principal("viewer") }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        fixture.service.readIndexers({ limit: 25 }, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "connector_unconfigured" });
      expect(fixture.createAdapter).not.toHaveBeenCalled();
    } finally {
      fixture.database.close();
    }
  });
});
