import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type {
  AcquisitionMonitoringState,
  AcquisitionEvent,
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

const stalledResponse: AcquisitionProvenanceResponse = {
  ...normalizedResponse,
  events: [
    {
      ...normalizedResponse.events[0]!,
      id: "radarr:queue:91",
      kind: "stalled",
      release: {
        ...normalizedResponse.events[0]!.release,
        title: "Private.Release.Name.2026",
      },
      state: "warning",
      summary: "Download needs operator attention before import can continue.",
    },
  ],
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
        "acquisition.queue.mutate",
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

function harness(options: { clock?: () => Date; withConnector?: boolean } = {}) {
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
  const readAcquisitionQueue = vi.fn(
    async (): Promise<{ event: AcquisitionEvent; externalId: number }[]> => [],
  );
  const removeAndBlocklistAcquisitionQueueItem = vi.fn(async () => undefined);
  const updateAcquisitionMonitoring = vi.fn(async () => unmonitoredState);
  let identifier = 0;
  let recoveryIdentifier = 0;
  const createAdapter = vi.fn(() => ({
    queueAcquisitionSearch,
    readAcquisitionMonitoring,
    readAcquisitionQueue,
    readAcquisitionProvenance,
    removeAndBlocklistAcquisitionQueueItem,
    updateAcquisitionMonitoring,
  }));
  const service = new AcquisitionProvenanceService(database, config, {
    clock: options.clock ?? (() => now),
    createAdapter,
    createId: () => `acquisition-operation-${++identifier}`,
    createOperationId: () =>
      `acquisition_recovery_ABCDEFGHIJKLMNOPQRSTU${String.fromCharCode(86 + recoveryIdentifier++)}`,
    wait: async () => undefined,
  });
  return {
    config,
    createAdapter,
    database,
    queueAcquisitionSearch,
    readAcquisitionMonitoring,
    readAcquisitionQueue,
    readAcquisitionProvenance,
    removeAndBlocklistAcquisitionQueueItem,
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

      expect(response).toEqual({
        ...normalizedResponse,
        events: [
          {
            ...normalizedResponse.events[0],
            id: expect.stringMatching(/^acquisition_[A-Za-z0-9_-]{22}$/u),
          },
        ],
      });
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

  it("offers and idempotently completes exact stalled-queue recovery without persisting raw IDs", async () => {
    const {
      database,
      readAcquisitionProvenance,
      readAcquisitionQueue,
      removeAndBlocklistAcquisitionQueueItem,
      service,
    } = harness();
    try {
      readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const provenance = await service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      const event = provenance.events[0]!;
      expect(event.id).toMatch(/^acquisition_[A-Za-z0-9_-]{22}$/u);
      expect(event.recovery).toMatchObject({
        expiresAt: "2026-07-27T18:35:00.000Z",
        reference: expect.stringMatching(/^aqr_v2\./u),
      });
      expect(event.recovery?.reference).not.toBe("91");

      readAcquisitionQueue
        .mockResolvedValueOnce([{ event: stalledResponse.events[0]!, externalId: 91 }])
        .mockResolvedValueOnce([]);
      const context = {
        ipAddress: "192.0.2.21",
        principal: principal(),
        requestId: "queue-recovery-request",
      };
      const first = await service.recoverQueueItem(
        { reference: event.recovery!.reference },
        "queue-recovery-key-00000001",
        context,
      );
      const replay = await service.recoverQueueItem(
        { reference: event.recovery!.reference },
        "queue-recovery-key-00000001",
        context,
      );
      const alternateKeyReplay = await service.recoverQueueItem(
        { reference: event.recovery!.reference },
        "queue-recovery-alternate-key-0001",
        context,
      );

      expect(first).toEqual({
        recovery: {
          completedAt: now.toISOString(),
          eventId: event.id,
          operationId: "acquisition_recovery_ABCDEFGHIJKLMNOPQRSTUV",
          service: "radarr",
          state: "removed_and_blocklisted",
        },
        replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(alternateKeyReplay).toEqual({ ...first, replayed: true });

      readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const freshReference = (await service.read({ mediaId: 42, service: "radarr" }, context))
        .events[0]!.recovery!.reference;
      await expect(
        service.recoverQueueItem(
          { reference: freshReference },
          "queue-recovery-key-00000001",
          context,
        ),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      expect(removeAndBlocklistAcquisitionQueueItem).toHaveBeenCalledOnce();
      expect(removeAndBlocklistAcquisitionQueueItem).toHaveBeenCalledWith(
        91,
        undefined,
        expect.stringMatching(/^mutation_dispatch_[A-Za-z0-9_-]{22}$/u),
      );
      expect(readAcquisitionQueue).toHaveBeenCalledTimes(2);

      const stored = database.sqlite
        .prepare(
          `select event_id as eventId, event_snapshot_json as snapshot,
                  response_json as response, failure_code as failureCode
           from acquisition_queue_recovery_operations`,
        )
        .get() as {
        eventId: string;
        failureCode: string | null;
        response: string;
        snapshot: string;
      };
      expect(stored).toMatchObject({ eventId: event.id, failureCode: null });
      expect(JSON.stringify(stored)).not.toContain("Private.Release.Name");
      expect(JSON.stringify(stored)).not.toContain("radarr:queue:91");
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count from audit_events
             where event_type in (
               'acquisition.queue.recovery.requested',
               'acquisition.queue.recovery.completed'
             )`,
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("fails closed when a recovery reference is tampered with or the exact queue state changed", async () => {
    const {
      database,
      readAcquisitionProvenance,
      readAcquisitionQueue,
      removeAndBlocklistAcquisitionQueueItem,
      service,
    } = harness();
    try {
      readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const provenance = await service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      const reference = provenance.events[0]!.recovery!.reference;
      const tamperedReference = `${reference.slice(0, -1)}${reference.endsWith("A") ? "B" : "A"}`;
      await expect(
        service.recoverQueueItem({ reference: tamperedReference }, "queue-recovery-key-00000002", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "reference_invalid" });

      readAcquisitionQueue.mockResolvedValueOnce([
        {
          event: { ...stalledResponse.events[0]!, state: "failure" },
          externalId: 91,
        },
      ]);
      await expect(
        service.recoverQueueItem({ reference }, "queue-recovery-key-00000003", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "stale_state" });
      expect(removeAndBlocklistAcquisitionQueueItem).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("omits recovery offers without active identity and current mutation capability", async () => {
    const inactive = harness();
    try {
      inactive.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await inactive.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: { ...principal(), accountState: "pending_link" } },
      );
      expect(response.events[0]).not.toHaveProperty("recovery");
    } finally {
      inactive.database.close();
    }

    const incapable = harness();
    try {
      incapable.database.sqlite
        .prepare("update connector_configs set capability_snapshot_json = ? where id = ?")
        .run(
          capabilitySnapshot("radarr-main", "radarr").replace(',"acquisition.queue.mutate"', ""),
          "radarr-main",
        );
      incapable.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await incapable.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      expect(response.events[0]).not.toHaveProperty("recovery");
    } finally {
      incapable.database.close();
    }
  });

  it("rejects an expired recovery reference before reserving or reading the queue", async () => {
    let current = now;
    const snapshot = harness({ clock: () => current });
    try {
      snapshot.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await snapshot.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      current = new Date(now.getTime() + 5 * 60 * 1_000 + 1);
      await expect(
        snapshot.service.recoverQueueItem(
          { reference: response.events[0]!.recovery!.reference },
          "queue-recovery-expired-00000001",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "reference_expired" });
      expect(snapshot.readAcquisitionQueue).not.toHaveBeenCalled();
      expect(
        snapshot.database.sqlite
          .prepare("select count(*) as count from acquisition_queue_recovery_operations")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      snapshot.database.close();
    }
  });

  it("keeps one recovery reservation in flight across matching and alternate keys", async () => {
    const snapshot = harness();
    try {
      snapshot.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await snapshot.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      let resolveQueue!: (items: { event: AcquisitionEvent; externalId: number }[]) => void;
      snapshot.readAcquisitionQueue.mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            resolveQueue = resolve;
          }),
      );
      const reference = response.events[0]!.recovery!.reference;
      const first = snapshot.service.recoverQueueItem(
        { reference },
        "queue-recovery-concurrent-0001",
        { principal: principal() },
      );
      expect(snapshot.readAcquisitionQueue).toHaveBeenCalledOnce();

      await expect(
        snapshot.service.recoverQueueItem({ reference }, "queue-recovery-concurrent-0001", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "idempotency_in_progress" });
      await expect(
        snapshot.service.recoverQueueItem({ reference }, "queue-recovery-concurrent-0002", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "idempotency_in_progress" });
      expect(snapshot.removeAndBlocklistAcquisitionQueueItem).not.toHaveBeenCalled();

      resolveQueue([{ event: stalledResponse.events[0]!, externalId: 91 }]);
      await expect(first).resolves.toMatchObject({ replayed: false });
      expect(snapshot.removeAndBlocklistAcquisitionQueueItem).toHaveBeenCalledOnce();
    } finally {
      snapshot.database.close();
    }
  });

  it("records interruption safety before and after the upstream mutation boundary", async () => {
    const beforeMutation = harness();
    try {
      beforeMutation.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await beforeMutation.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      beforeMutation.readAcquisitionQueue.mockRejectedValueOnce(
        new DOMException("Aborted", "AbortError"),
      );
      await expect(
        beforeMutation.service.recoverQueueItem(
          { reference: response.events[0]!.recovery!.reference },
          "queue-recovery-abort-before-0001",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(
        beforeMutation.database.sqlite
          .prepare("select failure_code as failureCode from acquisition_queue_recovery_operations")
          .get(),
      ).toEqual({ failureCode: "temporarily_unavailable" });
    } finally {
      beforeMutation.database.close();
    }

    const afterMutation = harness();
    try {
      afterMutation.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await afterMutation.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      afterMutation.readAcquisitionQueue.mockResolvedValueOnce([
        { event: stalledResponse.events[0]!, externalId: 91 },
      ]);
      afterMutation.removeAndBlocklistAcquisitionQueueItem.mockRejectedValueOnce(
        new DOMException("Aborted", "AbortError"),
      );
      await expect(
        afterMutation.service.recoverQueueItem(
          { reference: response.events[0]!.recovery!.reference },
          "queue-recovery-abort-after-00001",
          { principal: principal() },
        ),
      ).resolves.toMatchObject({ recovery: { state: "removed_and_blocklisted" } });
      expect(
        afterMutation.database.sqlite
          .prepare("select failure_code as failureCode from acquisition_queue_recovery_operations")
          .get(),
      ).toEqual({ failureCode: null });
    } finally {
      afterMutation.database.close();
    }
  });

  it("does not retry an unconfirmed post-mutation outcome under any idempotency key", async () => {
    const snapshot = harness();
    try {
      snapshot.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await snapshot.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      const item = { event: stalledResponse.events[0]!, externalId: 91 };
      snapshot.readAcquisitionQueue.mockResolvedValue([item]);
      const reference = response.events[0]!.recovery!.reference;
      await expect(
        snapshot.service.recoverQueueItem({ reference }, "queue-recovery-unconfirmed-0001", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "outcome_uncertain" });
      expect(snapshot.readAcquisitionQueue).toHaveBeenCalledTimes(3);
      expect(snapshot.removeAndBlocklistAcquisitionQueueItem).toHaveBeenCalledTimes(2);
      expect(
        snapshot.database.sqlite
          .prepare(
            "select state, failure_code as failureCode from acquisition_queue_recovery_operations",
          )
          .get(),
      ).toEqual({ failureCode: "outcome_uncertain", state: "uncertain" });

      await expect(
        snapshot.service.recoverQueueItem({ reference }, "queue-recovery-new-key-0000001", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "outcome_uncertain" });
      expect(snapshot.removeAndBlocklistAcquisitionQueueItem).toHaveBeenCalledTimes(2);
    } finally {
      snapshot.database.close();
    }
  });

  it("quarantines a changed or recreated exact queue identifier without a proof retry", async () => {
    const snapshot = harness();
    try {
      snapshot.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await snapshot.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      const original = { event: stalledResponse.events[0]!, externalId: 91 };
      const recreated = {
        event: {
          ...stalledResponse.events[0]!,
          occurredAt: "2026-07-27T18:29:00.000Z",
          state: "failure" as const,
        },
        externalId: 91,
      };
      snapshot.readAcquisitionQueue
        .mockResolvedValueOnce([original])
        .mockResolvedValueOnce([recreated]);

      await expect(
        snapshot.service.recoverQueueItem(
          { reference: response.events[0]!.recovery!.reference },
          "queue-recovery-recreated-0001",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "outcome_uncertain" });
      expect(snapshot.removeAndBlocklistAcquisitionQueueItem).toHaveBeenCalledOnce();
      expect(
        snapshot.database.sqlite
          .prepare("select state, failure_code as failureCode from external_mutation_dispatches")
          .get(),
      ).toEqual({ failureCode: "outcome_uncertain", state: "uncertain" });
    } finally {
      snapshot.database.close();
    }
  });

  it("rejects duplicate exact queue evidence before mutation", async () => {
    const snapshot = harness();
    try {
      snapshot.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await snapshot.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      const item = { event: stalledResponse.events[0]!, externalId: 91 };
      snapshot.readAcquisitionQueue.mockResolvedValueOnce([item, item]);
      await expect(
        snapshot.service.recoverQueueItem(
          { reference: response.events[0]!.recovery!.reference },
          "queue-recovery-duplicate-00001",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "response_invalid" });
      expect(snapshot.removeAndBlocklistAcquisitionQueueItem).not.toHaveBeenCalled();
    } finally {
      snapshot.database.close();
    }
  });

  it("rechecks active identity and reference ownership before queue access", async () => {
    const snapshot = harness();
    try {
      snapshot.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await snapshot.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      const reference = response.events[0]!.recovery!.reference;
      await expect(
        snapshot.service.recoverQueueItem({ reference }, "queue-recovery-pending-identity", {
          principal: { ...principal(), accountState: "pending_link" },
        }),
      ).rejects.toMatchObject({ reason: "identity_required" });
      await expect(
        snapshot.service.recoverQueueItem({ reference }, "queue-recovery-other-identity", {
          principal: { ...principal(), userId: "other-operator-user" },
        }),
      ).rejects.toMatchObject({ reason: "reference_invalid" });
      expect(snapshot.readAcquisitionQueue).not.toHaveBeenCalled();
    } finally {
      snapshot.database.close();
    }
  });

  it("records safe pre-mutation failures when an exact item disappears or the connector throttles", async () => {
    const missing = harness();
    try {
      missing.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await missing.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      missing.readAcquisitionQueue.mockResolvedValueOnce([]);
      await expect(
        missing.service.recoverQueueItem(
          { reference: response.events[0]!.recovery!.reference },
          "queue-recovery-missing-0000001",
          { principal: principal() },
        ),
      ).resolves.toMatchObject({ recovery: { state: "removed_and_blocklisted" } });
      expect(missing.removeAndBlocklistAcquisitionQueueItem).not.toHaveBeenCalled();
    } finally {
      missing.database.close();
    }

    const throttled = harness();
    try {
      throttled.readAcquisitionProvenance.mockResolvedValueOnce(stalledResponse);
      const response = await throttled.service.read(
        { mediaId: 42, service: "radarr" },
        { principal: principal() },
      );
      throttled.readAcquisitionQueue.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "rate_limited",
          message: "Private upstream message.",
          operation: "acquisition.queue.read",
          retryable: true,
          service: "radarr",
        }),
      );
      await expect(
        throttled.service.recoverQueueItem(
          { reference: response.events[0]!.recovery!.reference },
          "queue-recovery-throttled-0001",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "rate_limited" });
      expect(
        throttled.database.sqlite
          .prepare("select failure_code as failureCode from acquisition_queue_recovery_operations")
          .get(),
      ).toEqual({ failureCode: "rate_limited" });
    } finally {
      throttled.database.close();
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
      expect(
        database.sqlite
          .prepare(
            `select kind, parent_operation_type as parentOperationType, state,
                    connector_instance_generation as instanceGeneration,
                    connector_config_generation as configGeneration,
                    dispatch_attempt_count as dispatchAttemptCount
             from external_mutation_dispatches`,
          )
          .get(),
      ).toEqual({
        configGeneration: 0,
        dispatchAttemptCount: 1,
        instanceGeneration: 0,
        kind: "acquisition.search",
        parentOperationType: "acquisition_search_operation",
        state: "succeeded",
      });
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

  it("atomically prunes an aged terminal automatic search before reserving another", async () => {
    let current = now;
    const { database, queueAcquisitionSearch, service } = harness({ clock: () => current });
    try {
      await service.queueSearch(
        { mediaId: 42, service: "radarr" },
        "acquisition-terminal-retention-0001",
        { principal: principal() },
      );
      const expiredParentId = database.sqlite
        .prepare("select id from acquisition_search_operations")
        .pluck()
        .get() as string;
      current = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1_000);

      await service.queueSearch(
        { mediaId: 43, service: "radarr" },
        "acquisition-terminal-retention-0002",
        { principal: principal() },
      );

      expect(queueAcquisitionSearch).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare("select count(*) as count from acquisition_search_operations where id = ?")
          .get(expiredParentId),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count from external_mutation_dispatches
             where parent_operation_type = 'acquisition_search_operation'
               and parent_operation_id = ?`,
          )
          .get(expiredParentId),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            `select kind, parent_operation_type as parentOperationType
             from external_mutation_dispatches`,
          )
          .all(),
      ).toEqual([
        { kind: "acquisition.search", parentOperationType: "acquisition_search_operation" },
      ]);
    } finally {
      database.close();
    }
  });

  it("retains aged unresolved automatic-search parent, dispatch, and target-lock evidence", async () => {
    let current = now;
    const { database, queueAcquisitionSearch, service } = harness({ clock: () => current });
    queueAcquisitionSearch.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "timeout",
        message: "Private lost automatic-search response",
        operation: "acquisition.search",
        retryable: true,
        service: "radarr",
      }),
    );
    try {
      await expect(
        service.queueSearch(
          { mediaId: 42, service: "radarr" },
          "acquisition-unresolved-retention-1",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "outcome_uncertain" });
      current = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1_000);

      await expect(
        service.queueSearch(
          { mediaId: 43, service: "radarr" },
          "acquisition-unresolved-retention-2",
          { principal: principal() },
        ),
      ).resolves.toMatchObject({ replayed: false, search: normalizedSearch });
      expect(queueAcquisitionSearch).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare(
            `select
               (select count(*) from acquisition_search_operations) as parents,
               (select count(*) from external_mutation_dispatches
                where parent_operation_type = 'acquisition_search_operation') as dispatches,
               (select count(*) from external_mutation_target_locks) as locks`,
          )
          .get(),
      ).toEqual({ dispatches: 2, locks: 1, parents: 2 });
      expect(
        database.sqlite
          .prepare(
            `select parent.state as parentState, dispatch.state as dispatchState,
                    dispatch.kind, dispatch.parent_operation_type as parentOperationType
             from acquisition_search_operations parent
             join external_mutation_dispatches dispatch on dispatch.parent_operation_id = parent.id
             where parent.state = 'uncertain'`,
          )
          .get(),
      ).toEqual({
        dispatchState: "uncertain",
        kind: "acquisition.search",
        parentOperationType: "acquisition_search_operation",
        parentState: "uncertain",
      });
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

  it("persists and audits sanitized uncertainty without automatic resubmission", async () => {
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
      ).rejects.toMatchObject({ reason: "outcome_uncertain" });
      await expect(
        service.queueSearch({ mediaId: 42, service: "radarr" }, key, {
          principal: principal(),
          requestId: "failure-request",
        }),
      ).rejects.toMatchObject({ reason: "outcome_uncertain" });
      await expect(
        service.queueSearch(
          { mediaId: 42, service: "radarr" },
          "acquisition-failure-new-key-0001",
          { principal: principal(), requestId: "failure-request" },
        ),
      ).rejects.toMatchObject({ reason: "outcome_uncertain" });
      expect(queueAcquisitionSearch).toHaveBeenCalledTimes(1);
      const stored = database.sqlite
        .prepare(
          `select state, failure_code as failureCode, response_json as responseJson
           from acquisition_search_operations`,
        )
        .get() as { failureCode: string; responseJson: null; state: string };
      expect(stored).toEqual({
        failureCode: "outcome_uncertain",
        responseJson: null,
        state: "uncertain",
      });
      expect(
        database.sqlite
          .prepare("select state, failure_code as failureCode from external_mutation_dispatches")
          .get(),
      ).toEqual({ failureCode: "outcome_uncertain", state: "uncertain" });
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
