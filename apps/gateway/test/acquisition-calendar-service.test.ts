import type { AcquisitionCalendarSourceResult } from "@omnifin/connectors/calendar";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { acquisitionCalendarResponseSchema } from "@omnifin/contracts/calendar";
import { describe, expect, it, vi } from "vitest";

import {
  AcquisitionCalendarService,
  type AcquisitionCalendarAdapterFactoryInput,
} from "../src/acquisitions/calendar-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T04:00:00.000Z");
const RADARR_API_KEY = "private-radarr-calendar-key";
const SONARR_API_KEY = "private-sonarr-calendar-key";
const UPSTREAM_MOVIE_ID = "movie:private-upstream-movie";
const UPSTREAM_EPISODE_ID = "episode:private-upstream-episode";
const query = {
  end: "2026-08-03T04:00:00.000Z",
  limit: 50,
  start: "2026-07-27T04:00:00.000Z",
};

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 103),
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

function principal(role: Role = "viewer"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-27T04:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Calendar viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-28T05:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Calendar viewer",
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
    sessionId: `${role}-calendar-session`,
    userId: `${role}-calendar-user`,
  });
}

function capabilitySnapshot(id: string, service: "radarr" | "sonarr", capable = true) {
  return JSON.stringify({
    health: {
      capabilities: [
        "connector.health",
        "connector.version",
        ...(capable ? ["acquisition.calendar"] : []),
      ],
      checkedAt: now.toISOString(),
      connectorId: id,
      displayName: service === "radarr" ? "Radarr · Cinema" : "Sonarr · Television",
      failure: null,
      latencyMs: 9,
      service,
      status: "healthy",
      version: "6.3.0",
    },
    schemaVersion: 1,
  });
}

function insertConnector(
  database: DatabaseHandle,
  config: AppConfig,
  service: "radarr" | "sonarr",
  options: { capable?: boolean; id?: string } = {},
) {
  const id = options.id ?? `${service}-main`;
  const apiKey = service === "radarr" ? RADARR_API_KEY : SONARR_API_KEY;
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: `https://${service}.example.test/`,
      capabilitySnapshotJson: capabilitySnapshot(id, service, options.capable),
      createdAt: now,
      displayName: service === "radarr" ? "Radarr · Cinema" : "Sonarr · Television",
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

function calendarResult(service: "radarr" | "sonarr"): AcquisitionCalendarSourceResult {
  return {
    events: [
      service === "radarr"
        ? {
            availability: "monitored",
            endAt: null,
            episodeNumber: null,
            eventAt: "2026-07-30T04:00:00.000Z",
            externalId: UPSTREAM_MOVIE_ID,
            kind: "movie",
            monitored: true,
            overview: "A signal reaches the edge of known space.",
            releaseKind: "digital",
            runtimeMinutes: 128,
            seasonNumber: null,
            service: "radarr",
            subtitle: "Digital release",
            title: "The Far Meridian",
            year: 2026,
          }
        : {
            availability: "queued",
            endAt: "2026-07-31T00:46:00.000Z",
            episodeNumber: 7,
            eventAt: "2026-07-31T00:00:00.000Z",
            externalId: UPSTREAM_EPISODE_ID,
            kind: "episode",
            monitored: true,
            overview: "The receiver resolves a second signal.",
            releaseKind: "episode",
            runtimeMinutes: 46,
            seasonNumber: 1,
            service: "sonarr",
            subtitle: "S01E07 · Carrier",
            title: "Signal",
            year: 2026,
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
    insertConnector(database, config, "radarr", connectorOptions);
    insertConnector(database, config, "sonarr", connectorOptions);
  }
  const readers = {
    radarr: vi.fn(async () => calendarResult("radarr")),
    sonarr: vi.fn(async () => calendarResult("sonarr")),
  };
  const createAdapter = vi.fn((input: AcquisitionCalendarAdapterFactoryInput) => ({
    readAcquisitionCalendar: readers[input.service],
  }));
  const service = new AcquisitionCalendarService(database, config, {
    clock: () => now,
    createAdapter,
  });
  return { config, createAdapter, database, readers, service };
}

describe("acquisition calendar service", () => {
  it("authorizes viewers, decrypts sources, and replaces every internal identifier", async () => {
    const { createAdapter, database, service } = harness();
    try {
      const first = await service.read(query, { principal: principal() });
      const second = await service.read(query, { principal: principal() });

      expect(acquisitionCalendarResponseSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        state: "complete",
        summary: { episodes: 1, movies: 1, queued: 1, total: 2 },
      });
      expect(first.events.map((event) => event.id)).toEqual(second.events.map((event) => event.id));
      expect(first.events.map((event) => event.id)).toEqual([
        expect.stringMatching(/^calendar_[A-Za-z0-9_-]{22}$/u),
        expect.stringMatching(/^calendar_[A-Za-z0-9_-]{22}$/u),
      ]);
      expect(first.sources.map((source) => source.id)).toEqual([
        expect.stringMatching(/^calendar_source_[A-Za-z0-9_-]{22}$/u),
        expect.stringMatching(/^calendar_source_[A-Za-z0-9_-]{22}$/u),
      ]);
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: RADARR_API_KEY, service: "radarr" }),
      );
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: SONARR_API_KEY, service: "sonarr" }),
      );
      const serialized = JSON.stringify(first);
      for (const secret of [
        RADARR_API_KEY,
        SONARR_API_KEY,
        UPSTREAM_MOVIE_ID,
        UPSTREAM_EPISODE_ID,
        "radarr-main",
        "sonarr-main",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      database.close();
    }
  });

  it("paginates in stable order with a range-bound signed cursor", async () => {
    const { database, service } = harness();
    try {
      const first = await service.read({ ...query, limit: 1 }, { principal: principal() });
      expect(first.events).toHaveLength(1);
      expect(first.nextCursor).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u));

      const second = await service.read(
        { ...query, cursor: first.nextCursor!, limit: 1 },
        { principal: principal() },
      );
      expect(second.events).toHaveLength(1);
      expect(second.events[0]?.id).not.toBe(first.events[0]?.id);
      expect(second.nextCursor).toBeNull();

      await expect(
        service.read(
          { ...query, cursor: `${first.nextCursor!.slice(0, -1)}x`, limit: 1 },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
      await expect(
        service.read(
          { ...query, cursor: first.nextCursor!, end: "2026-08-04T04:00:00.000Z", limit: 1 },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
    } finally {
      database.close();
    }
  });

  it("preserves healthy events when one source is temporarily unavailable", async () => {
    const { database, readers, service } = harness();
    readers.sonarr.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "timeout",
        message: "Sonarr did not respond before the deadline.",
        operation: "acquisition.calendar",
        retryable: true,
        service: "sonarr",
      }),
    );
    try {
      const response = await service.read(query, { principal: principal() });

      expect(response.state).toBe("degraded");
      expect(response.events).toHaveLength(1);
      expect(response.sources).toEqual([
        expect.objectContaining({ service: "radarr", status: "healthy" }),
        expect.objectContaining({
          failure: expect.objectContaining({ code: "timeout", retryable: true }),
          service: "sonarr",
          status: "unavailable",
        }),
      ]);
      expect(response.failures).toEqual([response.sources[1]?.failure]);
    } finally {
      database.close();
    }
  });

  it("fails one corrupt source closed without exposing encrypted configuration", async () => {
    const { database, service } = harness();
    database.sqlite
      .prepare("update connector_configs set encrypted_credentials = ? where id = ?")
      .run("private-corrupt-envelope", "sonarr-main");
    try {
      const response = await service.read(query, { principal: principal() });

      expect(response.state).toBe("degraded");
      expect(response.sources[1]?.failure).toMatchObject({
        code: "configuration_invalid",
        retryable: false,
      });
      expect(JSON.stringify(response)).not.toContain("private-corrupt-envelope");
    } finally {
      database.close();
    }
  });

  it("returns an honest unconfigured state without a validated calendar capability", async () => {
    const { createAdapter, database, service } = harness({ capable: false });
    try {
      await expect(service.read(query, { principal: principal() })).resolves.toMatchObject({
        events: [],
        failures: [],
        sources: [],
        state: "unconfigured",
      });
      expect(createAdapter).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("turns duplicate normalized identifiers into one safe source failure", async () => {
    const { database, readers, service } = harness();
    const item = calendarResult("radarr").events[0]!;
    readers.radarr.mockResolvedValueOnce({ events: [item, item], truncated: false });
    try {
      const response = await service.read(query, { principal: principal() });

      expect(response.state).toBe("degraded");
      expect(response.sources[0]?.failure).toMatchObject({ code: "response_invalid" });
      expect(response.events).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
