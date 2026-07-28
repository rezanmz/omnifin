import type { ConnectorDownloadQueueResult } from "@omnifin/connectors/downloads";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { downloadQueueResponseSchema } from "@omnifin/contracts/downloads";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs } from "../src/db/schema.js";
import {
  DownloadQueueService,
  type DownloadQueueAdapterFactoryInput,
} from "../src/downloads/queue-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

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
        ...(capable ? ["download.queue.read"] : []),
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

function queueResult(service: "qbittorrent" | "sabnzbd"): ConnectorDownloadQueueResult {
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
  if (options.withConnectors !== false) {
    const connectorOptions = options.capable === undefined ? {} : { capable: options.capable };
    insertConnector(database, config, "qbittorrent", connectorOptions);
    insertConnector(database, config, "sabnzbd", connectorOptions);
  }
  const readers = {
    qbittorrent: vi.fn(async () => queueResult("qbittorrent")),
    sabnzbd: vi.fn(async () => queueResult("sabnzbd")),
  };
  const createAdapter = vi.fn((input: DownloadQueueAdapterFactoryInput) => ({
    readDownloadQueue: readers[input.service],
  }));
  const service = new DownloadQueueService(database, config, {
    clock: () => now,
    createAdapter,
  });
  return { config, createAdapter, database, readers, service };
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
});
