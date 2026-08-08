import type { ConnectorDownloadQueueResult } from "@omnifin/connectors/downloads";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import {
  downloadQueueBulkActionResponseSchema,
  downloadQueuePromotionResponseSchema,
  downloadQueueRemovalResponseSchema,
  downloadQueueResponseSchema,
} from "@omnifin/contracts/downloads";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, users } from "../src/db/schema.js";
import {
  DownloadQueueService,
  type DownloadQueueAdapterFactoryInput,
} from "../src/downloads/queue-service.js";
import { EnvelopeCipher, hashToken } from "../src/security/crypto.js";

const now = new Date("2026-07-28T02:30:00.000Z");
const QB_PASSWORD = "private-qbittorrent-password";
const SAB_API_KEY = "private-sabnzbd-api-key";
const UPSTREAM_ID = "private-upstream-download-id";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 97),
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
    absoluteExpiresAt: "2026-08-27T02:30:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Queue operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-28T03:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Queue operator",
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

function capabilitySnapshot(id: string, service: "qbittorrent" | "sabnzbd", capable = true) {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        ...(capable ? ["download.queue.read", "download.queue.mutate"] : []),
      ],
      checkedAt: now.toISOString(),
      connectorId: id,
      displayName: service === "qbittorrent" ? "qBittorrent" : "SABnzbd / Main",
      failure: null,
      latencyMs: 8,
      service,
      status: "healthy",
      version: "5.1.2",
    },
    schemaVersion: 1,
  });
}

function insertConnector(
  database: DatabaseHandle,
  config: AppConfig,
  service: "qbittorrent" | "sabnzbd",
  options: { capable?: boolean; id?: string } = {},
) {
  const id = options.id ?? `${service}-main`;
  const credentials =
    service === "qbittorrent"
      ? { kind: "username_password" as const, password: QB_PASSWORD, username: "operator" }
      : { apiKey: SAB_API_KEY, kind: "api_key" as const };
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: `https://${service}.example.test/`,
      capabilitySnapshotJson: capabilitySnapshot(id, service, options.capable),
      createdAt: now,
      displayName: service === "qbittorrent" ? "qBittorrent" : "SABnzbd / Main",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({ credentials, schemaVersion: 1 }),
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

function queueResult(
  service: "qbittorrent" | "sabnzbd",
  queuePosition: number | null = 1,
): ConnectorDownloadQueueResult {
  return {
    generatedAt: now.toISOString(),
    items: [
      {
        addedAt: service === "qbittorrent" ? "2026-07-28T02:00:00.000Z" : null,
        category: service === "qbittorrent" ? "movies" : "series",
        etaSeconds: service === "qbittorrent" ? 120 : 600,
        externalId: UPSTREAM_ID,
        leechers: service === "qbittorrent" ? 2 : null,
        progress: service === "qbittorrent" ? 0.75 : 0.5,
        queuePosition,
        rateBytesPerSecond: service === "qbittorrent" ? 4_096 : 0,
        remainingBytes: service === "qbittorrent" ? 256 : 512,
        seeders: service === "qbittorrent" ? 31 : null,
        sizeBytes: service === "qbittorrent" ? 1_024 : 1_024,
        state: service === "qbittorrent" ? "downloading" : "paused",
        title: service === "qbittorrent" ? "The.Far.Meridian.2160p" : "Signal.S01E07",
      },
    ],
    truncated: false,
  };
}

function harness(options: { capable?: boolean; withConnectors?: boolean } = {}) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Queue operator",
      id: "operator-user",
      role: "operator",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  if (options.withConnectors !== false) {
    const connectorOptions = options.capable === undefined ? {} : { capable: options.capable };
    insertConnector(database, config, "qbittorrent", connectorOptions);
    insertConnector(database, config, "sabnzbd", connectorOptions);
  }
  const readers = {
    qbittorrent: vi.fn(async () => queueResult("qbittorrent")),
    sabnzbd: vi.fn(async () => queueResult("sabnzbd")),
  };
  const actions = {
    qbittorrent: vi.fn(async () => undefined),
    sabnzbd: vi.fn(async () => undefined),
  };
  const removals = {
    qbittorrent: vi.fn(async () => undefined),
    sabnzbd: vi.fn(async () => undefined),
  };
  const promotions = {
    qbittorrent: vi.fn(async () => undefined),
    sabnzbd: vi.fn(async () => undefined),
  };
  const createAdapter = vi.fn((input: DownloadQueueAdapterFactoryInput) => ({
    promoteDownloadQueueItem: promotions[input.service],
    readDownloadQueue: readers[input.service],
    removeDownloadQueueItem: removals[input.service],
    updateDownloadQueueItem: actions[input.service],
  }));
  let identifier = 0;
  let removalIdentifier = 0;
  const wait = vi.fn(async () => undefined);
  const service = new DownloadQueueService(database, config, {
    clock: () => now,
    createAdapter,
    createBulkOperationId: () => "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
    createId: () => `download-action-audit-${++identifier}`,
    createOperationId: () =>
      removalIdentifier++ === 0
        ? "download_removal_ABCDEFGHIJKLMNOPQRSTUV"
        : `download_removal_${removalIdentifier.toString().padStart(22, "0")}`,
    wait,
  });
  return {
    actions,
    config,
    createAdapter,
    database,
    promotions,
    readers,
    removals,
    service,
    wait,
  };
}

describe("download queue service", () => {
  it("authorizes, decrypts, aggregates, and replaces upstream identifiers with stable opaque IDs", async () => {
    const { createAdapter, database, service } = harness();
    try {
      const first = await service.read({ principal: principal() });
      const second = await service.read({ principal: principal() });

      expect(downloadQueueResponseSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        state: "complete",
        summary: {
          attention: 0,
          downloading: 1,
          paused: 1,
          queued: 0,
          remainingBytes: 768,
          total: 2,
          totalRateBytesPerSecond: 4_096,
        },
        truncated: false,
      });
      expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
      expect(first.items.map((item) => item.id)).toEqual([
        expect.stringMatching(/^download_[A-Za-z0-9_-]{22}$/u),
        expect.stringMatching(/^download_[A-Za-z0-9_-]{22}$/u),
      ]);
      expect(first.items[0]?.id).not.toBe(first.items[1]?.id);
      expect(first.clients[1]?.displayName).toBe("SABnzbd / Main");
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: {
            kind: "username_password",
            password: QB_PASSWORD,
            username: "operator",
          },
          service: "qbittorrent",
        }),
      );
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: { apiKey: SAB_API_KEY, kind: "api_key" },
          service: "sabnzbd",
        }),
      );
      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain(UPSTREAM_ID);
      expect(serialized).not.toContain(QB_PASSWORD);
      expect(serialized).not.toContain(SAB_API_KEY);
    } finally {
      database.close();
    }
  });

  it("preserves healthy client data when another client is temporarily unavailable", async () => {
    const { database, readers, service } = harness();
    readers.sabnzbd.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "timeout",
        message: "SABnzbd did not respond before the deadline.",
        operation: "download.queue",
        retryable: true,
        service: "sabnzbd",
      }),
    );
    try {
      const response = await service.read({ principal: principal() });

      expect(response.state).toBe("degraded");
      expect(response.items).toHaveLength(1);
      expect(response.clients).toEqual([
        expect.objectContaining({ service: "qbittorrent", status: "healthy" }),
        expect.objectContaining({
          failure: expect.objectContaining({ code: "timeout", retryable: true }),
          service: "sabnzbd",
          status: "unavailable",
        }),
      ]);
      expect(response.failures).toEqual([response.clients[1]?.failure]);
    } finally {
      database.close();
    }
  });

  it("fails one corrupt connector closed without exposing encrypted configuration", async () => {
    const { database, service } = harness();
    database.sqlite
      .prepare("update connector_configs set encrypted_credentials = ? where id = ?")
      .run("private-corrupt-envelope", "sabnzbd-main");
    try {
      const response = await service.read({ principal: principal() });

      expect(response.state).toBe("degraded");
      expect(response.clients[1]?.failure).toMatchObject({
        code: "configuration_invalid",
        retryable: false,
      });
      expect(JSON.stringify(response)).not.toContain("private-corrupt-envelope");
    } finally {
      database.close();
    }
  });

  it("returns an honest unconfigured state when no validated queue capability exists", async () => {
    const { createAdapter, database, service } = harness({ capable: false });
    try {
      await expect(service.read({ principal: principal() })).resolves.toMatchObject({
        clients: [],
        failures: [],
        items: [],
        state: "unconfigured",
      });
      expect(createAdapter).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("bounds configured clients and marks the aggregate as truncated", async () => {
    const { config, database, service } = harness();
    for (let index = 0; index < 19; index += 1) {
      insertConnector(database, config, "qbittorrent", {
        id: `qbittorrent-secondary-${index.toString().padStart(2, "0")}`,
      });
    }
    try {
      const response = await service.read({ principal: principal() });

      expect(response.clients).toHaveLength(20);
      expect(response.items).toHaveLength(20);
      expect(response.truncated).toBe(true);
    } finally {
      database.close();
    }
  });

  it("denies viewers before decrypting configuration or contacting a client", async () => {
    const { createAdapter, database, service } = harness();
    try {
      await expect(service.read({ principal: principal("viewer") })).rejects.toMatchObject({
        code: "permission_denied",
      });
      expect(createAdapter).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("turns an invalid normalized item into one safe per-client failure", async () => {
    const { database, readers, service } = harness();
    readers.qbittorrent.mockResolvedValueOnce({
      ...queueResult("qbittorrent"),
      items: [{ ...queueResult("qbittorrent").items[0]!, title: "/private/media/release" }],
    });
    try {
      const response = await service.read({ principal: principal() });

      expect(response.state).toBe("degraded");
      expect(response.clients[0]?.failure).toMatchObject({ code: "response_invalid" });
      expect(response.items).toHaveLength(1);
      expect(JSON.stringify(response)).not.toContain("/private/media/release");
    } finally {
      database.close();
    }
  });

  it("pauses one opaque queue target, verifies it, and records the request before mutation", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const queue = await service.read({ principal: principal() });
      const item = queue.items.find(({ connectorId }) => connectorId === "qbittorrent-main")!;
      readers.qbittorrent.mockResolvedValueOnce(queueResult("qbittorrent")).mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [
          {
            ...queueResult("qbittorrent").items[0]!,
            rateBytesPerSecond: 0,
            state: "paused",
          },
        ],
      });

      const result = await service.update(
        {
          action: "pause",
          connectorId: item.connectorId,
          expectedState: "downloading",
          itemId: item.id,
        },
        { ipAddress: "203.0.113.4", principal: principal(), requestId: "request-1" },
      );

      expect(result).toMatchObject({
        action: "pause",
        item: { id: item.id, state: "paused" },
        previousState: "downloading",
        replayed: false,
      });
      expect(actions.qbittorrent).toHaveBeenCalledWith(
        { action: "pause", externalId: UPSTREAM_ID },
        undefined,
      );
      const audit = database.sqlite
        .prepare(
          "select event_type as eventType, target_id as targetId, metadata_json as metadataJson from audit_events order by created_at asc, id asc",
        )
        .all() as { eventType: string; metadataJson: string; targetId: string }[];
      expect(audit.map(({ eventType }) => eventType)).toEqual([
        "download.queue.action.requested",
        "download.queue.action.updated",
      ]);
      expect(audit.every(({ targetId }) => targetId === item.id)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(UPSTREAM_ID);
      expect(JSON.parse(audit[0]!.metadataJson)).toMatchObject({
        action: "pause",
        connectorId: "qbittorrent-main",
        previousState: "downloading",
      });
    } finally {
      database.close();
    }
  });

  it("durably replays an exact action key without reconstructing an adapter", async () => {
    const { actions, createAdapter, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent.mockResolvedValueOnce(queueResult("qbittorrent")).mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [
          {
            ...queueResult("qbittorrent").items[0]!,
            rateBytesPerSecond: 0,
            state: "paused",
          },
        ],
      });
      const input = {
        action: "pause" as const,
        connectorId: item.connectorId,
        expectedState: "downloading" as const,
        itemId: item.id,
      };

      const completed = await service.update(
        input,
        { principal: principal() },
        undefined,
        "durable-exact-action-key",
      );
      createAdapter.mockClear();
      readers.qbittorrent.mockClear();
      const replayed = await service.update(
        input,
        { principal: principal() },
        undefined,
        "durable-exact-action-key",
      );

      expect(replayed).toEqual(completed);
      expect(service.operationReceipt(replayed)).toMatchObject({ replayed: true });
      expect(actions.qbittorrent).toHaveBeenCalledOnce();
      expect(createAdapter).not.toHaveBeenCalled();
      expect(readers.qbittorrent).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            `select item.state as itemState, dispatch.state as dispatchState,
                    item.connector_instance_generation as instanceGeneration,
                    item.connector_config_generation as configGeneration
             from download_queue_item_operations item
             join external_mutation_dispatches dispatch
               on dispatch.parent_operation_id = item.id`,
          )
          .get(),
      ).toEqual({
        configGeneration: 0,
        dispatchState: "succeeded",
        instanceGeneration: 0,
        itemState: "succeeded",
      });
    } finally {
      database.close();
    }
  });

  it("reconciles a lost exact-action response and succeeds from the desired postcondition", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent.mockResolvedValueOnce(queueResult("qbittorrent")).mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [{ ...queueResult("qbittorrent").items[0]!, state: "paused" }],
      });
      actions.qbittorrent.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "private lost response",
          operation: "download.queue.action",
          retryable: true,
          service: "qbittorrent",
        }),
      );

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
          undefined,
          "lost-action-response-key",
        ),
      ).resolves.toMatchObject({ item: { state: "paused" } });
      expect(actions.qbittorrent).toHaveBeenCalledOnce();
      expect(
        database.sqlite.prepare("select state from external_mutation_dispatches").pluck().get(),
      ).toBe("succeeded");
    } finally {
      database.close();
    }
  });

  it("keeps a read-after-dispatch failure reconcilable and locks new keys", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        action: "pause" as const,
        connectorId: item.connectorId,
        expectedState: "downloading" as const,
        itemId: item.id,
      };
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockRejectedValueOnce(new Error("private postcondition read failure"));

      await expect(
        service.update(input, { principal: principal() }, undefined, "reconcile-action-key"),
      ).rejects.toMatchObject({ reason: "reconciliation_required" });
      readers.qbittorrent.mockClear();
      await expect(
        service.update(input, { principal: principal() }, undefined, "reconcile-action-key"),
      ).rejects.toMatchObject({ reason: "reconciliation_required", replayed: true });
      await expect(
        service.update(input, { principal: principal() }, undefined, "new-locked-action-key"),
      ).rejects.toMatchObject({ reason: "target_locked" });

      expect(actions.qbittorrent).toHaveBeenCalledOnce();
      expect(readers.qbittorrent).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            `select item.state as itemState, dispatch.state as dispatchState,
                    dispatch.dispatch_attempt_count as attempts
             from download_queue_item_operations item
             join external_mutation_dispatches dispatch
               on dispatch.parent_operation_id = item.id
             where item.failure_code = 'read_after_write_required'`,
          )
          .get(),
      ).toEqual({
        attempts: 1,
        dispatchState: "reconcile_required",
        itemState: "reconcile_required",
      });
    } finally {
      database.close();
    }
  });

  it("serializes concurrent keys on the exact queue target", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        action: "pause" as const,
        connectorId: item.connectorId,
        expectedState: "downloading" as const,
        itemId: item.id,
      };
      readers.qbittorrent.mockResolvedValueOnce(queueResult("qbittorrent")).mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [{ ...queueResult("qbittorrent").items[0]!, state: "paused" }],
      });
      let releaseMutation!: () => void;
      actions.qbittorrent.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseMutation = () => resolve(undefined);
          }),
      );

      const first = service.update(
        input,
        { principal: principal() },
        undefined,
        "concurrent-action-first-key",
      );
      await vi.waitFor(() => expect(actions.qbittorrent).toHaveBeenCalledOnce());
      await expect(
        service.update(
          input,
          { principal: principal() },
          undefined,
          "concurrent-action-second-key",
        ),
      ).rejects.toMatchObject({ reason: "target_locked" });
      releaseMutation();
      await expect(first).resolves.toMatchObject({ item: { state: "paused" } });
      expect(actions.qbittorrent).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("fails a connector generation change before dispatch", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent.mockImplementationOnce(async () => {
        database.sqlite
          .prepare("update connector_configs set config_generation = 1 where id = ?")
          .run(item.connectorId);
        return queueResult("qbittorrent");
      });

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
          undefined,
          "generation-change-action-key",
        ),
      ).rejects.toMatchObject({ reason: "generation_mismatch" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select state from external_mutation_dispatches").pluck().get(),
      ).toBe("failed");
    } finally {
      database.close();
    }
  });

  it("rejects stale state without contacting the upstream mutation endpoint", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent.mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [{ ...queueResult("qbittorrent").items[0]!, state: "queued" }],
      });

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "stale_state" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      const audit = database.sqlite
        .prepare("select event_type as eventType, metadata_json as metadataJson from audit_events")
        .get() as { eventType: string; metadataJson: string };
      expect(audit.eventType).toBe("download.queue.action.failed");
      expect(JSON.parse(audit.metadataJson)).toMatchObject({ failureCode: "stale_state" });
    } finally {
      database.close();
    }
  });

  it("replays an already-achieved pause without mutating upstream", async () => {
    const { actions, database, readers, service } = harness();
    readers.qbittorrent.mockResolvedValue({
      ...queueResult("qbittorrent"),
      items: [
        {
          ...queueResult("qbittorrent").items[0]!,
          rateBytesPerSecond: 0,
          state: "paused",
        },
      ],
    });
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const result = await service.update(
        {
          action: "pause",
          connectorId: item.connectorId,
          expectedState: "downloading",
          itemId: item.id,
        },
        { principal: principal() },
      );

      expect(result).toMatchObject({ replayed: true, previousState: "paused" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("select event_type from audit_events").pluck().get()).toBe(
        "download.queue.action.replayed",
      );
    } finally {
      database.close();
    }
  });

  it("prunes an aged pre-dispatch no-op before allowing the next exact mutation", async () => {
    const { actions, database, readers, service } = harness();
    readers.qbittorrent.mockResolvedValue({
      ...queueResult("qbittorrent"),
      items: [
        {
          ...queueResult("qbittorrent").items[0]!,
          rateBytesPerSecond: 0,
          state: "paused",
        },
      ],
    });
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        action: "pause" as const,
        connectorId: item.connectorId,
        expectedState: "downloading" as const,
        itemId: item.id,
      };
      await expect(service.update(input, { principal: principal() })).resolves.toMatchObject({
        replayed: true,
      });
      const oldParentId = database.sqlite
        .prepare("select id from download_queue_item_operations")
        .pluck()
        .get() as string;
      const expiredAt = now.getTime() - 31 * 24 * 60 * 60 * 1_000;
      database.sqlite
        .prepare(
          `update download_queue_item_operations
           set created_at = ?, completed_at = ?, updated_at = ? where id = ?`,
        )
        .run(expiredAt, expiredAt, expiredAt, oldParentId);
      database.sqlite
        .prepare(
          `update external_mutation_dispatches
           set created_at = ?, completed_at = ?, updated_at = ?
           where parent_operation_type = 'download_queue_item_operation'
             and parent_operation_id = ?`,
        )
        .run(expiredAt, expiredAt, expiredAt, oldParentId);

      await expect(service.update(input, { principal: principal() })).resolves.toMatchObject({
        replayed: true,
      });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare("select count(*) as count from download_queue_item_operations where id = ?")
          .get(oldParentId),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count from external_mutation_dispatches
             where parent_operation_type = 'download_queue_item_operation'
               and parent_operation_id = ?`,
          )
          .get(oldParentId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("fails closed before mutation when the requested audit event cannot be stored", async () => {
    const { actions, database, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      database.sqlite.exec("drop table audit_events");

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "storage_failure" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("resumes one paused item and accepts a verified active state", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items.find(
        ({ connectorId }) => connectorId === "sabnzbd-main",
      )!;
      readers.sabnzbd.mockResolvedValueOnce(queueResult("sabnzbd")).mockResolvedValueOnce({
        ...queueResult("sabnzbd"),
        items: [
          {
            ...queueResult("sabnzbd").items[0]!,
            etaSeconds: 300,
            rateBytesPerSecond: 2_048,
            state: "downloading",
          },
        ],
      });

      const result = await service.update(
        {
          action: "resume",
          connectorId: item.connectorId,
          expectedState: "paused",
          itemId: item.id,
        },
        { principal: principal() },
      );

      expect(result.item.state).toBe("downloading");
      expect(actions.sabnzbd).toHaveBeenCalledWith(
        { action: "resume", externalId: UPSTREAM_ID },
        undefined,
      );
    } finally {
      database.close();
    }
  });

  it("applies one idempotent bulk pause across qBittorrent and SABnzbd exact targets", async () => {
    const { actions, database, readers, service } = harness();
    const activeSabQueue = {
      ...queueResult("sabnzbd"),
      items: [
        {
          ...queueResult("sabnzbd").items[0]!,
          rateBytesPerSecond: 2_048,
          state: "downloading" as const,
        },
      ],
    };
    const pausedQbittorrentQueue = {
      ...queueResult("qbittorrent"),
      items: [
        {
          ...queueResult("qbittorrent").items[0]!,
          rateBytesPerSecond: 0,
          state: "paused" as const,
        },
      ],
    };
    const pausedSabQueue = {
      ...activeSabQueue,
      items: [{ ...activeSabQueue.items[0]!, rateBytesPerSecond: 0, state: "paused" as const }],
    };
    readers.sabnzbd.mockResolvedValue(activeSabQueue);
    try {
      const items = (await service.read({ principal: principal() })).items;
      const input = {
        action: "pause" as const,
        targets: items.map((item) => ({
          connectorId: item.connectorId,
          expectedState: "downloading" as const,
          itemId: item.id,
        })),
      };
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockResolvedValueOnce(pausedQbittorrentQueue);
      readers.sabnzbd.mockResolvedValueOnce(activeSabQueue).mockResolvedValueOnce(pausedSabQueue);

      const result = await service.bulkUpdate(input, "bulk-pause-both-clients", {
        ipAddress: "203.0.113.12",
        principal: principal(),
        requestId: "bulk-request-1",
      });

      expect(downloadQueueBulkActionResponseSchema.parse(result)).toMatchObject({
        action: "pause",
        operationId: "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
        replayed: false,
        state: "complete",
        summary: { failed: 0, requested: 2, succeeded: 2 },
      });
      expect(result.results.map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
      expect(actions.qbittorrent).toHaveBeenCalledWith(
        { action: "pause", externalId: UPSTREAM_ID },
        undefined,
      );
      expect(actions.sabnzbd).toHaveBeenCalledWith(
        { action: "pause", externalId: UPSTREAM_ID },
        undefined,
      );
      expect(
        database.sqlite.prepare("select state from download_queue_bulk_operations").pluck().get(),
      ).toBe("succeeded");
      const auditTypes = database.sqlite
        .prepare("select event_type from audit_events order by rowid")
        .pluck()
        .all() as string[];
      expect(auditTypes[0]).toBe("download.queue.bulk.requested");
      expect(auditTypes.at(-1)).toBe("download.queue.bulk.completed");
      expect(JSON.stringify(result)).not.toContain(UPSTREAM_ID);

      const replayed = await service.bulkUpdate(input, "bulk-pause-both-clients", {
        principal: principal(),
      });
      expect(replayed.replayed).toBe(true);
      expect(actions.qbittorrent).toHaveBeenCalledOnce();
      expect(actions.sabnzbd).toHaveBeenCalledOnce();
      expect(
        database.sqlite
          .prepare("select count(*) from download_queue_item_operations")
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        database.sqlite
          .prepare(
            `select count(*) from external_mutation_dispatches
             where parent_operation_type = 'download_queue_item_operation'`,
          )
          .pluck()
          .get(),
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  it("reports honest per-target bulk failures while completing safe targets", async () => {
    const { actions, database, readers, service } = harness();
    const activeSabQueue = {
      ...queueResult("sabnzbd"),
      items: [
        {
          ...queueResult("sabnzbd").items[0]!,
          rateBytesPerSecond: 2_048,
          state: "downloading" as const,
        },
      ],
    };
    readers.sabnzbd.mockResolvedValue(activeSabQueue);
    try {
      const items = (await service.read({ principal: principal() })).items;
      readers.qbittorrent.mockResolvedValueOnce(queueResult("qbittorrent")).mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [
          {
            ...queueResult("qbittorrent").items[0]!,
            rateBytesPerSecond: 0,
            state: "paused",
          },
        ],
      });
      readers.sabnzbd.mockResolvedValueOnce({
        ...activeSabQueue,
        items: [{ ...activeSabQueue.items[0]!, state: "queued" }],
      });

      const result = await service.bulkUpdate(
        {
          action: "pause",
          targets: items.map((item) => ({
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          })),
        },
        "bulk-partial-fixture",
        { principal: principal() },
      );

      expect(result).toMatchObject({
        state: "partial",
        summary: { failed: 1, requested: 2, succeeded: 1 },
      });
      expect(result.results[0]).toMatchObject({ status: "succeeded" });
      expect(result.results[1]).toMatchObject({
        code: "state_changed",
        retryable: false,
        status: "failed",
      });
      expect(actions.qbittorrent).toHaveBeenCalledOnce();
      expect(actions.sabnzbd).not.toHaveBeenCalled();
      const stored = database.sqlite
        .prepare("select response_json as responseJson from download_queue_bulk_operations")
        .get() as { responseJson: string };
      expect(downloadQueueBulkActionResponseSchema.parse(JSON.parse(stored.responseJson))).toEqual(
        result,
      );
    } finally {
      database.close();
    }
  });

  it("never redispatches a quarantined restored bulk idempotency key", async () => {
    const { actions, database, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        action: "pause" as const,
        targets: [
          {
            connectorId: item.connectorId,
            expectedState: "downloading" as const,
            itemId: item.id,
          },
        ],
      };
      const idempotencyKey = "quarantined-bulk-fixture";
      database.sqlite
        .prepare(
          `insert into download_queue_bulk_operations (
             id, user_id, idempotency_key_hash, fingerprint_hash, state,
             request_json, results_json, completed_at, created_at, updated_at
           ) values (?, ?, ?, ?, 'quarantined', ?, '[]', ?, ?, ?)`,
        )
        .run(
          "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
          "operator-user",
          hashToken(`operator-user\u0000download_queue_bulk_action\u0000${idempotencyKey}`),
          hashToken(JSON.stringify({ input, version: 1 })),
          JSON.stringify(input),
          now.getTime(),
          now.getTime() - 1,
          now.getTime(),
        );

      await expect(
        service.bulkUpdate(input, idempotencyKey, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "operation_failed" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      expect(actions.sabnzbd).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            "select state from download_queue_bulk_operations where idempotency_key_hash = ?",
          )
          .pluck()
          .get(hashToken(`operator-user\u0000download_queue_bulk_action\u0000${idempotencyKey}`)),
      ).toBe("quarantined");
    } finally {
      database.close();
    }
  });

  it("recovers an expired bulk lease from persisted per-target progress", async () => {
    const { actions, database, readers, service } = harness();
    const activeSabQueue = {
      ...queueResult("sabnzbd"),
      items: [
        {
          ...queueResult("sabnzbd").items[0]!,
          rateBytesPerSecond: 2_048,
          state: "downloading" as const,
        },
      ],
    };
    readers.sabnzbd.mockResolvedValue(activeSabQueue);
    try {
      const items = (await service.read({ principal: principal() })).items;
      const input = {
        action: "pause" as const,
        targets: items.map((item) => ({
          connectorId: item.connectorId,
          expectedState: "downloading" as const,
          itemId: item.id,
        })),
      };
      const idempotencyKey = "bulk-recovery-fixture";
      const persistedResult = {
        code: "state_changed" as const,
        retryable: false,
        status: "failed" as const,
        target: input.targets[0]!,
      };
      database.sqlite
        .prepare(
          `insert into download_queue_bulk_operations (
             id, user_id, idempotency_key_hash, fingerprint_hash, state,
             request_json, results_json, created_at, updated_at
           ) values (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
          "operator-user",
          hashToken(`operator-user\u0000download_queue_bulk_action\u0000${idempotencyKey}`),
          hashToken(JSON.stringify({ input, version: 1 })),
          JSON.stringify(input),
          JSON.stringify([persistedResult]),
          now.getTime() - 31_000,
          now.getTime() - 31_000,
        );
      readers.sabnzbd.mockResolvedValueOnce(activeSabQueue).mockResolvedValueOnce({
        ...activeSabQueue,
        items: [{ ...activeSabQueue.items[0]!, rateBytesPerSecond: 0, state: "paused" }],
      });

      const result = await service.bulkUpdate(input, idempotencyKey, {
        principal: principal(),
      });

      expect(result).toMatchObject({
        operationId: "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
        state: "partial",
        summary: { failed: 1, requested: 2, succeeded: 1 },
      });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      expect(actions.sabnzbd).toHaveBeenCalledOnce();
      expect(result.results[0]).toEqual(persistedResult);
      expect(result.results[1]).toMatchObject({ status: "succeeded" });
    } finally {
      database.close();
    }
  });

  it("recovers a crashed bulk parent only through its reconcilable exact child", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items.find(
        ({ connectorId }) => connectorId === "qbittorrent-main",
      )!;
      const input = {
        action: "pause" as const,
        targets: [
          {
            connectorId: item.connectorId,
            expectedState: "downloading" as const,
            itemId: item.id,
          },
        ],
      };
      const controller = new AbortController();
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockImplementationOnce(async () => {
          controller.abort();
          throw new Error("simulated crash after dispatch");
        });

      await expect(
        service.bulkUpdate(
          input,
          "bulk-child-crash-key",
          { principal: principal() },
          controller.signal,
        ),
      ).rejects.toMatchObject({ reason: "reconciliation_required" });
      expect(actions.qbittorrent).toHaveBeenCalledOnce();
      expect(
        database.sqlite
          .prepare(
            `select parent.state as parentState, child.state as childState,
                    dispatch.state as dispatchState
             from download_queue_bulk_operations parent
             join download_queue_item_operations child on child.bulk_operation_id = parent.id
             join external_mutation_dispatches dispatch on dispatch.parent_operation_id = child.id`,
          )
          .get(),
      ).toEqual({
        childState: "reconcile_required",
        dispatchState: "reconcile_required",
        parentState: "pending",
      });

      database.sqlite
        .prepare("update download_queue_bulk_operations set updated_at = ?")
        .run(now.getTime() - 31_000);
      readers.qbittorrent.mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [{ ...queueResult("qbittorrent").items[0]!, state: "paused" }],
      });
      const recovered = await service.bulkUpdate(input, "bulk-child-crash-key", {
        principal: principal(),
      });

      expect(recovered).toMatchObject({ state: "complete", summary: { succeeded: 1 } });
      expect(actions.qbittorrent).toHaveBeenCalledOnce();
      expect(
        database.sqlite
          .prepare(
            `select child.state as childState, dispatch.state as dispatchState
             from download_queue_item_operations child
             join external_mutation_dispatches dispatch on dispatch.parent_operation_id = child.id`,
          )
          .get(),
      ).toEqual({ childState: "succeeded", dispatchState: "succeeded" });
    } finally {
      database.close();
    }
  });

  it("fails closed when persisted bulk progress is rebound to another observed state", async () => {
    const { actions, database, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        action: "pause" as const,
        targets: [
          {
            connectorId: item.connectorId,
            expectedState: "downloading" as const,
            itemId: item.id,
          },
        ],
      };
      const idempotencyKey = "bulk-progress-rebinding-fixture";
      database.sqlite
        .prepare(
          `insert into download_queue_bulk_operations (
             id, user_id, idempotency_key_hash, fingerprint_hash, state,
             request_json, results_json, created_at, updated_at
           ) values (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
          "operator-user",
          hashToken(`operator-user\u0000download_queue_bulk_action\u0000${idempotencyKey}`),
          hashToken(JSON.stringify({ input, version: 1 })),
          JSON.stringify(input),
          JSON.stringify([
            {
              code: "state_changed",
              retryable: false,
              status: "failed",
              target: { ...input.targets[0], expectedState: "queued" },
            },
          ]),
          now.getTime() - 31_000,
          now.getTime() - 31_000,
        );

      await expect(
        service.bulkUpdate(input, idempotencyKey, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "storage_failure" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("promotes one opaque queue target, verifies first position, and audits both boundaries", async () => {
    const { database, promotions, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent", 1))
        .mockResolvedValueOnce(queueResult("qbittorrent", 0));

      const result = await service.promote(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        { ipAddress: "203.0.113.8", principal: principal(), requestId: "promotion-request-1" },
      );

      expect(downloadQueuePromotionResponseSchema.parse(result)).toMatchObject({
        item: { id: item.id },
        position: 0,
        previousPosition: 1,
        replayed: false,
      });
      expect(promotions.qbittorrent).toHaveBeenCalledWith({ externalId: UPSTREAM_ID }, undefined);
      expect(
        database.sqlite
          .prepare("select event_type from audit_events order by created_at asc, id asc")
          .pluck()
          .all(),
      ).toEqual(["download.queue.promotion.requested", "download.queue.promotion.completed"]);
      expect(JSON.stringify(result)).not.toContain(UPSTREAM_ID);
    } finally {
      database.close();
    }
  });

  it("replays an already-first promotion and rejects unavailable queue ordering", async () => {
    const { database, promotions, readers, service } = harness();
    try {
      readers.qbittorrent.mockResolvedValue(queueResult("qbittorrent", 0));
      const item = (await service.read({ principal: principal() })).items[0]!;
      const replayed = await service.promote(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        { principal: principal() },
      );

      expect(replayed).toMatchObject({ position: 0, previousPosition: 0, replayed: true });
      expect(promotions.qbittorrent).not.toHaveBeenCalled();

      readers.qbittorrent.mockResolvedValue(queueResult("qbittorrent", null));
      await expect(
        service.promote(
          {
            connectorId: item.connectorId,
            expectedState: item.state,
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "queue_order_unavailable" });
      expect(promotions.qbittorrent).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("fails a stale promotion before mutation and records only normalized audit metadata", async () => {
    const { database, promotions, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const staleQueue = queueResult("qbittorrent", 1);
      staleQueue.items[0] = { ...staleQueue.items[0]!, state: "paused" };
      readers.qbittorrent.mockResolvedValueOnce(staleQueue);

      await expect(
        service.promote(
          {
            connectorId: item.connectorId,
            expectedState: item.state,
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "stale_state" });

      expect(promotions.qbittorrent).not.toHaveBeenCalled();
      const audit = database.sqlite
        .prepare("select event_type as eventType, metadata_json as metadataJson from audit_events")
        .get() as { eventType: string; metadataJson: string };
      expect(audit.eventType).toBe("download.queue.promotion.failed");
      expect(JSON.parse(audit.metadataJson)).toMatchObject({
        connectorId: item.connectorId,
        failureCode: "stale_state",
        previousPosition: 1,
      });
      expect(audit.metadataJson).not.toContain(UPSTREAM_ID);
    } finally {
      database.close();
    }
  });

  it("does not let an opaque item identifier cross connector boundaries", async () => {
    const { actions, database, service } = harness();
    try {
      const queue = await service.read({ principal: principal() });
      const qBittorrentItem = queue.items.find(
        ({ connectorId }) => connectorId === "qbittorrent-main",
      )!;

      await expect(
        service.update(
          {
            action: "resume",
            connectorId: "sabnzbd-main",
            expectedState: "paused",
            itemId: qBittorrentItem.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "target_not_found" });
      expect(actions.sabnzbd).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("permits one proof-based state-set retry and retains an uncertain outcome", async () => {
    const { actions, database, readers, service, wait } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent.mockResolvedValue(queueResult("qbittorrent"));

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "operation_uncertain" });
      expect(actions.qbittorrent).toHaveBeenCalledTimes(2);
      expect(wait).not.toHaveBeenCalled();
      const auditTypes = database.sqlite
        .prepare("select event_type from audit_events order by id")
        .pluck()
        .all();
      expect(auditTypes).toEqual([
        "download.queue.action.requested",
        "download.queue.action.failed",
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects a connector without a healthy mutation capability before decryption", async () => {
    const { actions, createAdapter, database, service } = harness();
    try {
      const queue = await service.read({ principal: principal() });
      const item = queue.items[0]!;
      database.sqlite
        .prepare("update connector_configs set capability_snapshot_json = ? where id = ?")
        .run(capabilitySnapshot("qbittorrent-main", "qbittorrent", false), "qbittorrent-main");
      createAdapter.mockClear();

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "connector_unavailable" });
      expect(createAdapter).not.toHaveBeenCalled();
      expect(actions.qbittorrent).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("requires the selected connector to retain both read and mutation capabilities", async () => {
    const { actions, createAdapter, database, service } = harness();
    try {
      const queue = await service.read({ principal: principal() });
      const item = queue.items[0]!;
      const snapshot = JSON.parse(capabilitySnapshot("qbittorrent-main", "qbittorrent")) as Record<
        string,
        Record<string, unknown>
      >;
      snapshot.health!.capabilities = [
        "connector.health",
        "connector.version",
        "download.queue.mutate",
      ];
      database.sqlite
        .prepare("update connector_configs set capability_snapshot_json = ? where id = ?")
        .run(JSON.stringify(snapshot), "qbittorrent-main");
      createAdapter.mockClear();

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "connector_unavailable" });
      expect(createAdapter).not.toHaveBeenCalled();
      expect(actions.qbittorrent).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("rejects duplicate upstream identifiers as an invalid exact-target response", async () => {
    const { actions, database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const upstreamItem = queueResult("qbittorrent").items[0]!;
      readers.qbittorrent.mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [upstreamItem, { ...upstreamItem, title: "Duplicate release" }],
      });

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "response_invalid" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      const audit = database.sqlite
        .prepare("select metadata_json from audit_events")
        .pluck()
        .get() as string;
      expect(JSON.parse(audit)).toMatchObject({ failureCode: "response_invalid" });
    } finally {
      database.close();
    }
  });

  it("maps adapter-construction failure to a safe audited unavailable state", async () => {
    const { actions, createAdapter, database, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      createAdapter.mockImplementationOnce(() => {
        throw new Error("private adapter detail");
      });

      await expect(
        service.update(
          {
            action: "pause",
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "connector_unavailable" });
      expect(actions.qbittorrent).not.toHaveBeenCalled();
      const audit = database.sqlite
        .prepare("select metadata_json from audit_events")
        .pluck()
        .get() as string;
      expect(JSON.stringify(audit)).not.toContain("private adapter detail");
      expect(JSON.parse(audit)).toMatchObject({ failureCode: "connector_unavailable" });
    } finally {
      database.close();
    }
  });

  it("recovers a stale in-flight removal when the exact item is already absent", async () => {
    const { database, readers, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      };
      const idempotencyKey = "stale-removal-recovery-fixture";
      const operationId = "download_removal_ABCDEFGHIJKLMNOPQRSTUV";
      const staleAt = now.getTime() - 60_000;
      database.sqlite
        .prepare(
          `insert into download_queue_removal_operations (
             id, user_id, connector_id, item_id, idempotency_key_hash, fingerprint_hash,
             state, item_snapshot_json, mutation_started_at, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          "operator-user",
          input.connectorId,
          input.itemId,
          hashToken(`operator-user\u0000download_queue_removal\u0000${idempotencyKey}`),
          hashToken(JSON.stringify({ contentDisposition: "preserved", input, version: 1 })),
          JSON.stringify(item),
          staleAt,
          staleAt,
          staleAt,
        );
      readers.qbittorrent.mockResolvedValueOnce({
        generatedAt: now.toISOString(),
        items: [],
        truncated: false,
      });

      const result = await service.remove(input, idempotencyKey, { principal: principal() });

      expect(downloadQueueRemovalResponseSchema.parse(result)).toMatchObject({
        item: { id: item.id },
        operationId,
        replayed: true,
      });
      expect(removals.qbittorrent).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("durably completes, replays without reconstructing the adapter, and conflict-checks an exact removal", async () => {
    const { createAdapter, database, readers, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      };
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockResolvedValueOnce({ generatedAt: now.toISOString(), items: [], truncated: false });

      const completed = await service.remove(input, "durable-removal-fixture", {
        ipAddress: "203.0.113.8",
        principal: principal(),
        requestId: "removal-request",
      });
      createAdapter.mockImplementationOnce(() => {
        throw new Error("adapter should not be reconstructed for a replay");
      });
      const replayed = await service.remove(input, "durable-removal-fixture", {
        principal: principal(),
      });

      expect(downloadQueueRemovalResponseSchema.parse(completed)).toMatchObject({
        item: { id: item.id },
        replayed: false,
      });
      expect(replayed).toMatchObject({ operationId: completed.operationId, replayed: true });
      expect(removals.qbittorrent).toHaveBeenCalledOnce();
      expect(
        database.sqlite
          .prepare(
            "select state, failure_code as failureCode from download_queue_removal_operations",
          )
          .get(),
      ).toEqual({ failureCode: null, state: "succeeded" });
      expect(
        database.sqlite
          .prepare("select event_type as eventType from audit_events order by created_at, id")
          .all(),
      ).toEqual([
        { eventType: "download.queue.removal.requested" },
        { eventType: "download.queue.removal.completed" },
      ]);

      await expect(
        service.remove({ ...input, expectedState: "paused" }, "durable-removal-fixture", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
    } finally {
      database.close();
    }
  });

  it("proves a lost removal response from exact absence without redispatch", async () => {
    const { database, readers, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockResolvedValueOnce({ generatedAt: now.toISOString(), items: [], truncated: false });
      removals.qbittorrent.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "private lost removal response",
          operation: "download.queue.remove",
          retryable: true,
          service: "qbittorrent",
        }),
      );

      await expect(
        service.remove(
          { connectorId: item.connectorId, expectedState: item.state, itemId: item.id },
          "lost-removal-response-key",
          { principal: principal() },
        ),
      ).resolves.toMatchObject({ item: { id: item.id } });
      expect(removals.qbittorrent).toHaveBeenCalledOnce();
      expect(
        database.sqlite.prepare("select state from external_mutation_dispatches").pluck().get(),
      ).toBe("succeeded");
    } finally {
      database.close();
    }
  });

  it("retries an identical removal target once and then proves absence", async () => {
    const { database, readers, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockResolvedValueOnce({ generatedAt: now.toISOString(), items: [], truncated: false });

      await expect(
        service.remove(
          { connectorId: item.connectorId, expectedState: item.state, itemId: item.id },
          "proof-retry-removal-key",
          { principal: principal() },
        ),
      ).resolves.toMatchObject({ item: { id: item.id } });
      expect(removals.qbittorrent).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare("select dispatch_attempt_count from external_mutation_dispatches")
          .pluck()
          .get(),
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  it("retains a changed removal target as uncertain and blocks another key", async () => {
    const { database, readers, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = { connectorId: item.connectorId, expectedState: item.state, itemId: item.id };
      readers.qbittorrent.mockResolvedValueOnce(queueResult("qbittorrent")).mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [{ ...queueResult("qbittorrent").items[0]!, title: "Recreated release" }],
      });

      await expect(
        service.remove(input, "changed-removal-target-key", { principal: principal() }),
      ).rejects.toMatchObject({ reason: "operation_uncertain" });
      readers.qbittorrent.mockClear();
      await expect(
        service.remove(input, "changed-removal-target-key", { principal: principal() }),
      ).rejects.toMatchObject({ reason: "operation_uncertain", replayed: true });
      await expect(
        service.remove(input, "new-removal-target-key", { principal: principal() }),
      ).rejects.toMatchObject({ reason: "target_locked" });

      expect(removals.qbittorrent).toHaveBeenCalledOnce();
      expect(readers.qbittorrent).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            `select removal.state as removalState, dispatch.state as dispatchState,
                    removal.failure_code as failureCode
             from download_queue_removal_operations removal
             join external_mutation_dispatches dispatch
               on dispatch.parent_operation_id = removal.id
             where removal.idempotency_key_hash = ?`,
          )
          .get(
            hashToken(`operator-user\u0000download_queue_removal\u0000changed-removal-target-key`),
          ),
      ).toEqual({
        dispatchState: "uncertain",
        failureCode: "target_changed",
        removalState: "uncertain",
      });
    } finally {
      database.close();
    }
  });

  it("prunes expired completed removal operations before reserving another", async () => {
    const { database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const expiredAt = now.getTime() - 31 * 24 * 60 * 60 * 1_000;
      database.sqlite
        .prepare(
          `insert into download_queue_removal_operations (
             id, user_id, connector_id, item_id, idempotency_key_hash, fingerprint_hash,
             state, item_snapshot_json, response_json, mutation_started_at, completed_at,
             created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "download_removal_0000000000000000000000",
          "operator-user",
          item.connectorId,
          item.id,
          hashToken("expired-removal-idempotency-key"),
          hashToken("expired-removal-fingerprint"),
          JSON.stringify(item),
          JSON.stringify({
            contentDisposition: "preserved",
            item,
            operationId: "download_removal_0000000000000000000000",
            removedAt: new Date(expiredAt).toISOString(),
            replayed: false,
          }),
          expiredAt,
          expiredAt,
          expiredAt,
          expiredAt,
        );
      readers.qbittorrent
        .mockResolvedValueOnce(queueResult("qbittorrent"))
        .mockResolvedValueOnce({ generatedAt: now.toISOString(), items: [], truncated: false });

      await service.remove(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        "new-removal-after-retention-window",
        { principal: principal() },
      );

      expect(
        database.sqlite
          .prepare("select count(*) as count from download_queue_removal_operations where id = ?")
          .get("download_removal_0000000000000000000000"),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("records a missing exact target once and replays the bounded failure", async () => {
    const { database, readers, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      };
      readers.qbittorrent.mockResolvedValueOnce({
        generatedAt: now.toISOString(),
        items: [],
        truncated: false,
      });

      await expect(
        service.remove(input, "missing-removal-fixture", { principal: principal() }),
      ).rejects.toMatchObject({ reason: "target_not_found" });
      await expect(
        service.remove(input, "missing-removal-fixture", { principal: principal() }),
      ).rejects.toMatchObject({ reason: "operation_failed" });

      expect(removals.qbittorrent).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            "select state, failure_code as failureCode from download_queue_removal_operations",
          )
          .get(),
      ).toEqual({ failureCode: "target_not_found", state: "failed" });
    } finally {
      database.close();
    }
  });

  it("retains uncertainty when one proof-based removal retry leaves the target present", async () => {
    const { database, removals, service, wait } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;

      await expect(
        service.remove(
          {
            connectorId: item.connectorId,
            expectedState: item.state,
            itemId: item.id,
          },
          "unconfirmed-removal-fixture",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "operation_uncertain" });

      expect(removals.qbittorrent).toHaveBeenCalledTimes(2);
      expect(wait).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            "select state, failure_code as failureCode from download_queue_removal_operations",
          )
          .get(),
      ).toEqual({ failureCode: "retry_unconfirmed", state: "uncertain" });
    } finally {
      database.close();
    }
  });

  it("never converts a post-dispatch lost removal response into an ordinary failure", async () => {
    const { database, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      };
      removals.qbittorrent.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "private removal transport outcome",
          operation: "download.queue.remove",
          retryable: true,
          service: "qbittorrent",
        }),
      );

      await expect(
        service.remove(input, "uncertain-removal-fixture", { principal: principal() }),
      ).rejects.toMatchObject({ reason: "operation_uncertain" });
      expect(
        database.sqlite
          .prepare(
            "select state, failure_code as failureCode from download_queue_removal_operations",
          )
          .get(),
      ).toEqual({ failureCode: "retry_unconfirmed", state: "uncertain" });
      await expect(
        service.remove(input, "uncertain-removal-fixture", { principal: principal() }),
      ).rejects.toMatchObject({ reason: "operation_uncertain" });
      expect(removals.qbittorrent).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("does not join a recently leased removal operation", async () => {
    const { database, readers, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      };
      const idempotencyKey = "leased-removal-fixture";
      database.sqlite
        .prepare(
          `insert into download_queue_removal_operations (
             id, user_id, connector_id, item_id, idempotency_key_hash, fingerprint_hash,
             state, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          "download_removal_ABCDEFGHIJKLMNOPQRSTUV",
          "operator-user",
          input.connectorId,
          input.itemId,
          hashToken(`operator-user\u0000download_queue_removal\u0000${idempotencyKey}`),
          hashToken(JSON.stringify({ contentDisposition: "preserved", input, version: 1 })),
          now.getTime(),
          now.getTime(),
        );
      readers.qbittorrent.mockClear();

      await expect(
        service.remove(input, idempotencyKey, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "idempotency_in_progress" });
      expect(readers.qbittorrent).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("retains uncertainty when a recovered upstream identifier describes another item", async () => {
    const { database, readers, removals, service } = harness();
    try {
      const item = (await service.read({ principal: principal() })).items[0]!;
      const input = {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      };
      const idempotencyKey = "stale-target-recovery-fixture";
      const staleAt = now.getTime() - 60_000;
      database.sqlite
        .prepare(
          `insert into download_queue_removal_operations (
             id, user_id, connector_id, item_id, idempotency_key_hash, fingerprint_hash,
             state, item_snapshot_json, mutation_started_at, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          "download_removal_ABCDEFGHIJKLMNOPQRSTUV",
          "operator-user",
          input.connectorId,
          input.itemId,
          hashToken(`operator-user\u0000download_queue_removal\u0000${idempotencyKey}`),
          hashToken(JSON.stringify({ contentDisposition: "preserved", input, version: 1 })),
          JSON.stringify(item),
          staleAt,
          staleAt,
          staleAt,
        );
      readers.qbittorrent.mockResolvedValueOnce({
        ...queueResult("qbittorrent"),
        items: [{ ...queueResult("qbittorrent").items[0]!, title: "Different release" }],
      });

      await expect(
        service.remove(input, idempotencyKey, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "operation_uncertain" });
      expect(removals.qbittorrent).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            "select state, failure_code as failureCode from download_queue_removal_operations",
          )
          .get(),
      ).toEqual({ failureCode: "target_changed", state: "uncertain" });
    } finally {
      database.close();
    }
  });
});
