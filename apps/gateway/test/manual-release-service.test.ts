import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { ManualReleaseCandidate } from "@omnifin/contracts/acquisition";
import { describe, expect, it, vi } from "vitest";

import {
  ManualReleaseService,
  type ManualReleaseError,
} from "../src/acquisitions/manual-release-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-27T18:30:00.000Z");
const privateApiKey = "manual-release-private-api-key";
const releaseId = "release_00000000000000000000000000000001";
const operationId = "release_grab_00000000000000000000000000000001";
const secondOperationId = "release_grab_00000000000000000000000000000002";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 93),
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

function principal(role: Role = "operator", userId = `${role}-user`): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-26T18:30:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Release operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-27T19:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Release operator",
        externalUserId: `${userId}-jellyfin-user`,
        health: "linked",
        id: `${userId}-jellyfin-link`,
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: userId,
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${userId}-session`,
    userId,
  });
}

const details: Omit<ManualReleaseCandidate, "id"> = {
  ageMinutes: 84,
  customFormats: ["HDR10"],
  customFormatScore: 1350,
  decision: "approved",
  downloadAllowed: true,
  episodeNumbers: [],
  fullSeason: false,
  indexer: "Northstar",
  languages: ["English"],
  leechers: 12,
  protocol: "torrent",
  publishedAt: "2026-07-27T17:06:00.000Z",
  quality: "WEBDL-2160p",
  rejectionReasons: [],
  releaseGroup: "Example",
  requiresOverride: false,
  seeders: 84,
  sizeBytes: 18_420_000_000,
  title: "Example.Movie.2026.2160p.WEB-DL",
};

function capabilitySnapshot(id = "radarr-main") {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        "acquisition.history",
        "acquisition.search",
        "acquisition.grab",
      ],
      checkedAt: now.toISOString(),
      connectorId: id,
      displayName: "Radarr",
      failure: null,
      latencyMs: 12,
      service: "radarr",
      status: "healthy",
      version: "6.3.0.10514",
    },
    schemaVersion: 1,
  });
}

function insertConnector(database: DatabaseHandle, config: AppConfig, id = "radarr-main") {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://radarr.example.test/",
      capabilitySnapshotJson: capabilitySnapshot(id),
      createdAt: now,
      displayName: "Radarr",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({
          credentials: { apiKey: privateApiKey, kind: "api_key" },
          schemaVersion: 1,
        }),
        `connector_credentials:radarr:${id}`,
      ),
      healthState: "healthy",
      id,
      type: "radarr",
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
    .values([
      {
        createdAt: now,
        displayName: "Operator",
        id: "operator-user",
        role: "operator",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
      {
        createdAt: now,
        displayName: "Second operator",
        id: "second-operator",
        role: "operator",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
    ])
    .run();
  if (options.withConnector !== false) insertConnector(database, config);
  const searchManualReleases = vi.fn(async () => ({
    candidates: [
      {
        details,
        reference: { guid: "private-release-guid", indexerId: 14 },
      },
    ],
    generatedAt: now.toISOString(),
    target: {
      episodeId: null,
      kind: "movie" as const,
      mediaId: 42,
      seasonNumber: null,
      service: "radarr" as const,
    },
  }));
  const grabManualRelease = vi.fn(async () => undefined);
  const createAdapter = vi.fn(() => ({ grabManualRelease, searchManualReleases }));
  let current = now;
  let operationSequence = 0;
  const service = new ManualReleaseService(database, config, {
    clock: () => current,
    createAdapter,
    createOperationId: () => (operationSequence++ === 0 ? operationId : secondOperationId),
    createReleaseId: () => releaseId,
  });
  return {
    advance(minutes: number) {
      current = new Date(current.getTime() + minutes * 60_000);
    },
    config,
    createAdapter,
    database,
    grabManualRelease,
    searchManualReleases,
    service,
  };
}

async function search(service: ManualReleaseService) {
  return service.search(
    { mediaId: 42, service: "radarr" },
    { principal: principal("operator", "operator-user") },
  );
}

describe("manual release service", () => {
  it("authorizes, decrypts, normalizes, and caches private release references per user", async () => {
    const { createAdapter, database, searchManualReleases, service } = harness();
    try {
      const response = await search(service);

      expect(response).toMatchObject({
        expiresAt: "2026-07-27T18:50:00.000Z",
        releases: [{ id: releaseId, title: details.title }],
      });
      expect(createAdapter).toHaveBeenCalledWith(
        "radarr",
        expect.objectContaining({ apiKey: privateApiKey, connectorId: "radarr-main" }),
      );
      expect(searchManualReleases).toHaveBeenCalledWith(
        { mediaId: 42, service: "radarr" },
        undefined,
      );
      expect(JSON.stringify(response)).not.toMatch(/private-release-guid|manual-release-private/u);

      await expect(
        service.grab(
          { overrideRejections: false, releaseId },
          "manual-grab-other-user-0123456789",
          { principal: principal("operator", "second-operator") },
        ),
      ).rejects.toMatchObject({ reason: "candidate_expired" });
    } finally {
      database.close();
    }
  });

  it("grabs, audits, and replays one idempotent release without retaining the raw reference", async () => {
    const { database, grabManualRelease, service } = harness();
    const context = {
      ipAddress: "198.51.100.24",
      principal: principal("operator", "operator-user"),
      requestId: "manual-release-request",
    };
    const key = "manual-grab-01234567-89ab-cdef-0123-456789abcdef";
    try {
      await search(service);
      const first = await service.grab(
        { overrideRejections: false, releaseId },
        key,
        context,
      );
      const replay = await service.grab(
        { overrideRejections: false, releaseId },
        key,
        context,
      );

      expect(first).toEqual({
        grab: {
          acceptedAt: now.toISOString(),
          operationId,
          releaseId,
          service: "radarr",
          state: "accepted",
        },
        replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(grabManualRelease).toHaveBeenCalledTimes(1);
      expect(grabManualRelease).toHaveBeenCalledWith(
        { guid: "private-release-guid", indexerId: 14 },
        undefined,
      );
      const operation = database.sqlite
        .prepare(
          `select state, response_json as responseJson, idempotency_key_hash as keyHash
           from acquisition_grab_operations`,
        )
        .get() as { keyHash: string; responseJson: string; state: string };
      expect(operation).toMatchObject({ state: "succeeded" });
      expect(operation.keyHash).toHaveLength(43);
      expect(operation.responseJson).not.toContain("private-release-guid");
      const audit = database.sqlite
        .prepare(
          `select event_type as eventType, outcome, metadata_json as metadataJson, ip_hash as ipHash
           from audit_events where event_type = 'acquisition.release.grabbed'`,
        )
        .get() as { eventType: string; ipHash: string; metadataJson: string; outcome: string };
      expect(audit).toMatchObject({
        eventType: "acquisition.release.grabbed",
        outcome: "success",
      });
      expect(audit.ipHash).toHaveLength(22);
      expect(audit.metadataJson).not.toMatch(/private-release-guid|manual-grab-/u);
    } finally {
      database.close();
    }
  });

  it("requires explicit rejection override and persists the safe failed outcome", async () => {
    const fixture = harness();
    fixture.searchManualReleases.mockResolvedValueOnce({
      candidates: [
        {
          details: {
            ...details,
            decision: "rejected",
            rejectionReasons: ["Quality profile rejected this release"],
            requiresOverride: true,
          },
          reference: { guid: "private-rejected-guid", indexerId: 18 },
        },
      ],
      generatedAt: now.toISOString(),
      target: {
        episodeId: null,
        kind: "movie",
        mediaId: 42,
        seasonNumber: null,
        service: "radarr",
      },
    });
    try {
      await search(fixture.service);
      await expect(
        fixture.service.grab(
          { overrideRejections: false, releaseId },
          "manual-grab-rejected-0123456789abcdef",
          { principal: principal("operator", "operator-user") },
        ),
      ).rejects.toMatchObject({ reason: "override_required" });
      expect(fixture.grabManualRelease).not.toHaveBeenCalled();
      const stored = fixture.database.sqlite
        .prepare(
          `select state, failure_code as failureCode, response_json as responseJson
           from acquisition_grab_operations`,
        )
        .get();
      expect(stored).toEqual({
        failureCode: "override_required",
        responseJson: null,
        state: "failed",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("expires references before connector access and never retries an uncertain mutation", async () => {
    const fixture = harness();
    try {
      await search(fixture.service);
      fixture.advance(21);
      await expect(
        fixture.service.grab(
          { overrideRejections: false, releaseId },
          "manual-grab-expired-0123456789abcdef",
          { principal: principal("operator", "operator-user") },
        ),
      ).rejects.toMatchObject({ reason: "candidate_expired" });
      expect(fixture.grabManualRelease).not.toHaveBeenCalled();

      fixture.advance(-21);
      fixture.searchManualReleases.mockResolvedValueOnce({
        candidates: [{ details, reference: { guid: "private-timeout-guid", indexerId: 14 } }],
        generatedAt: now.toISOString(),
        target: {
          episodeId: null,
          kind: "movie",
          mediaId: 42,
          seasonNumber: null,
          service: "radarr",
        },
      });
      await search(fixture.service);
      fixture.grabManualRelease.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "Private timeout at /private/path",
          operation: "acquisition.release.grab",
          retryable: true,
          service: "radarr",
        }),
      );
      const key = "manual-grab-timeout-0123456789abcdef";
      await expect(
        fixture.service.grab(
          { overrideRejections: false, releaseId },
          key,
          { principal: principal("operator", "operator-user") },
        ),
      ).rejects.toMatchObject({ reason: "temporarily_unavailable" });
      await expect(
        fixture.service.grab(
          { overrideRejections: false, releaseId },
          key,
          { principal: principal("operator", "operator-user") },
        ),
      ).rejects.toMatchObject({ reason: "temporarily_unavailable" });
      expect(fixture.grabManualRelease).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(
          fixture.database.sqlite
            .prepare("select failure_code from acquisition_grab_operations order by created_at")
            .all(),
        ),
      ).not.toContain("/private/path");
    } finally {
      fixture.database.close();
    }
  });

  it("denies viewers before connector storage and fails closed on corrupt capability evidence", async () => {
    const denied = harness({ withConnector: false });
    try {
      await expect(
        denied.service.search(
          { mediaId: 42, service: "radarr" },
          { principal: principal("viewer", "viewer-user") },
        ),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
    } finally {
      denied.database.close();
    }

    const corrupt = harness();
    try {
      corrupt.database.sqlite
        .prepare("update connector_configs set capability_snapshot_json = ? where id = ?")
        .run(JSON.stringify({ schemaVersion: 1 }), "radarr-main");
      let failure: unknown;
      try {
        await search(corrupt.service);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject<Partial<ManualReleaseError>>({
        reason: "connector_integrity_failure",
      });
      expect(JSON.stringify(failure)).not.toContain(privateApiKey);
    } finally {
      corrupt.database.close();
    }
  });
});
