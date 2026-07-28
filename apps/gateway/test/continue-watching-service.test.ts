import type { JellyfinContinueWatchingResult } from "@omnifin/connectors/media/jellyfin-user-media-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { continueWatchingResponseSchema } from "@omnifin/contracts/dashboard";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import {
  ContinueWatchingError,
  ContinueWatchingService,
  type ContinueWatchingClientFactoryInput,
} from "../src/media/continue-watching-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T05:00:00.000Z");
const privateAccessToken = "private-jellyfin-access-token";
const privateItemId = "private-upstream-episode";
const privateSeriesId = "private-upstream-series";

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

function principal(): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-27T05:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Media viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-28T06:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Media viewer",
        externalUserId: "viewer-external",
        health: "linked",
        id: "viewer-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "viewer",
      },
    ],
    permissions: ROLE_PERMISSIONS.viewer,
    role: "viewer",
    sessionId: "viewer-session",
    userId: "viewer-user",
  });
}

function insertIdentity(database: DatabaseHandle, config: AppConfig) {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: "Home Jellyfin",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:jellyfin-main",
      ),
      healthState: "healthy",
      id: "jellyfin-main",
      insecureHttpApproved: false,
      tlsPolicy: "strict",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Media viewer",
      id: "viewer-user",
      role: "viewer",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-main",
      createdAt: now,
      deviceId: "viewer-device",
      encryptedAccessToken: new EnvelopeCipher(config.encryptionKey).encrypt(
        privateAccessToken,
        "service_identity_access_token:jellyfin:viewer-link",
      ),
      externalDisplayName: "Media viewer",
      externalServerId: "server-1",
      externalUserId: "viewer-external",
      externalUsername: "viewer",
      healthState: "linked",
      id: "viewer-link",
      lastVerifiedAt: now,
      revision: 3,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "viewer-user",
    })
    .run();
}

function resumeResult(): JellyfinContinueWatchingResult {
  return {
    items: [
      {
        artwork: {
          backdrop: { itemId: privateSeriesId, type: "Backdrop" },
          poster: { itemId: privateSeriesId, type: "Primary" },
        },
        contentRating: "TV-14",
        externalId: privateItemId,
        kind: "episode",
        lastPlayedAt: "2026-07-28T04:45:00.000Z",
        overview: "A receiver resolves a signal beyond the ice.",
        positionSeconds: 900,
        runtimeSeconds: 2_700,
        subtitle: "S02E03 · The Long Meridian",
        title: "Northern Lights",
        year: 2026,
      },
    ],
    truncated: false,
  };
}

function harness(options: { withIdentity?: boolean } = {}) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  if (options.withIdentity !== false) insertIdentity(database, config);
  const readContinueWatching = vi.fn(async () => resumeResult());
  const createClient = vi.fn((_input: ContinueWatchingClientFactoryInput) => ({
    readContinueWatching,
  }));
  const service = new ContinueWatchingService(database, config, {
    clock: () => now,
    createClient,
    mediaReferences: {
      clock: () => now,
      createToken: () => "m".repeat(22),
    },
  });
  return { config, createClient, database, readContinueWatching, service };
}

describe("ContinueWatchingService", () => {
  it("decrypts the linked user's token and emits only stable opaque media references", async () => {
    const { createClient, database, service } = harness();
    try {
      const first = await service.read({ principal: principal() });
      const second = await service.read({ principal: principal() });

      expect(continueWatchingResponseSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        items: [
          {
            media: {
              artwork: {
                backdropPath: `/v1/media/media_${"m".repeat(22)}/images/backdrop`,
                posterPath: `/v1/media/media_${"m".repeat(22)}/images/poster`,
              },
              id: `media_${"m".repeat(22)}`,
              title: "Northern Lights",
            },
            progressPercent: 33.3,
          },
        ],
        state: "complete",
      });
      expect(second.items[0]?.media.id).toBe(first.items[0]?.media.id);
      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: privateAccessToken,
          connectorId: "jellyfin-main",
          deviceId: "viewer-device",
          tlsPolicy: "strict",
        }),
      );
      const serialized = JSON.stringify(first);
      expect(serialized).not.toMatch(/private-jellyfin|private-upstream/u);
      const stored = JSON.stringify(
        database.sqlite
          .prepare(
            "select id, item_digest as itemDigest, encrypted_payload as encryptedPayload from media_references",
          )
          .all(),
      );
      expect(stored).not.toMatch(/private-upstream/u);
    } finally {
      database.close();
    }
  });

  it("returns an explicit empty state without fabricating media", async () => {
    const { database, readContinueWatching, service } = harness();
    readContinueWatching.mockResolvedValueOnce({ items: [], truncated: false });
    try {
      await expect(service.read({ principal: principal() })).resolves.toMatchObject({
        failures: [],
        items: [],
        state: "empty",
        truncated: false,
      });
    } finally {
      database.close();
    }
  });

  it("converts upstream and encrypted-configuration failures into one safe unavailable source", async () => {
    const upstream = harness();
    upstream.readContinueWatching.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "timeout",
        message: "jellyfin did not respond before the deadline.",
        operation: "media.continue_watching",
        retryable: true,
        service: "jellyfin",
      }),
    );
    try {
      await expect(upstream.service.read({ principal: principal() })).resolves.toMatchObject({
        failures: [expect.objectContaining({ code: "timeout" })],
        items: [],
        state: "unavailable",
      });
    } finally {
      upstream.database.close();
    }

    const corrupt = harness();
    corrupt.database.sqlite
      .prepare("update service_identity_links set encrypted_access_token = ? where id = ?")
      .run("private-corrupt-token", "viewer-link");
    try {
      const response = await corrupt.service.read({ principal: principal() });
      expect(response.source.failure).toMatchObject({
        code: "configuration_invalid",
        retryable: false,
      });
      expect(JSON.stringify(response)).not.toContain("private-corrupt-token");
      expect(corrupt.createClient).not.toHaveBeenCalled();
    } finally {
      corrupt.database.close();
    }
  });

  it("rejects a principal whose exact current link cannot be resolved", async () => {
    const { database, service } = harness({ withIdentity: false });
    try {
      await expect(service.read({ principal: principal() })).rejects.toBeInstanceOf(
        ContinueWatchingError,
      );
    } finally {
      database.close();
    }
  });
});
