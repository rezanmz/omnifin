import type { JellyfinPlaybackResult } from "@omnifin/connectors/media/jellyfin-playback-client";
import { ROLE_PERMISSIONS, sessionPrincipalSchema } from "@omnifin/contracts/auth";
import {
  playbackNegotiationResponseSchema,
  playbackProgressResponseSchema,
} from "@omnifin/contracts/playback";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import {
  PlaybackSessionService,
  type PlaybackSessionError,
  type PlaybackClientFactoryInput,
} from "../src/media/playback-session-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T06:00:00.000Z");
const privateAccessToken = "private-jellyfin-access-token";
const privateItemId = "private-upstream-episode";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 110),
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

function principal(userId = "viewer-user", linkId = "viewer-link") {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-27T06:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Media viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-28T07:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Media viewer",
        externalUserId: "viewer-external",
        health: "linked",
        id: linkId,
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "viewer",
      },
    ],
    permissions: ROLE_PERMISSIONS.viewer,
    role: "viewer",
    sessionId: "viewer-session",
    userId,
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

function negotiatedResult(): JellyfinPlaybackResult {
  return {
    audioTracks: [
      {
        channels: 6,
        codec: "aac",
        default: true,
        index: 1,
        language: "eng",
        selected: true,
        title: "English · 5.1",
      },
    ],
    delivery: "direct",
    itemId: privateItemId,
    liveStreamId: null,
    media: {
      audioCodec: "aac",
      bitrate: 8_640_000,
      container: "mp4",
      durationSeconds: 2_700,
      height: 1080,
      videoCodec: "h264",
      width: 1920,
    },
    mediaSourceId: "private-media-source",
    playMethod: "DirectPlay",
    playSessionId: "private-play-session",
    positionSeconds: 900,
    subtitleTracks: [
      {
        codec: "vtt",
        default: false,
        delivery: "external",
        forced: false,
        index: 2,
        language: "eng",
        selected: false,
        title: "English",
      },
    ],
    upstreamTarget: {
      path: `Videos/${privateItemId}/stream`,
      query: "private=upstream-query",
    },
  };
}

function harness() {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  insertIdentity(database, config);
  const reference = new MediaReferenceService(database, config, {
    clock: () => now,
    createToken: () => "m".repeat(22),
  }).createOrRefresh({ linkId: "viewer-link", linkRevision: 3, userId: "viewer-user" }, [
    {
      artwork: { backdropItemId: null, posterItemId: null },
      itemId: privateItemId,
    },
  ])[0]!;
  const negotiate = vi.fn(async () => negotiatedResult());
  const readPlaybackTarget = vi.fn(async () => {
    throw new Error("Playback bytes were not expected in this service test.");
  });
  const reportPlaybackEvent = vi.fn(async () => undefined);
  const resolvePlaybackTarget = vi.fn((parent) => parent);
  const createClient = vi.fn((_input: PlaybackClientFactoryInput) => ({
    negotiate,
    readPlaybackTarget,
    reportPlaybackEvent,
    resolvePlaybackTarget,
  }));
  const service = new PlaybackSessionService(database, config, {
    clock: () => now,
    createClient,
    createToken: () => "p".repeat(22),
  });
  return { config, createClient, database, negotiate, reference, reportPlaybackEvent, service };
}

const negotiation = {
  audioStreamIndex: 1,
  maxStreamingBitrate: 20_000_000,
  mode: "auto" as const,
  positionSeconds: 900,
  subtitleStreamIndex: null,
};

describe("PlaybackSessionService", () => {
  it("negotiates through the exact linked identity and persists only encrypted upstream state", async () => {
    const { createClient, database, negotiate, reference, service } = harness();
    try {
      const response = await service.negotiate({ principal: principal() }, reference, negotiation);

      expect(playbackNegotiationResponseSchema.parse(response)).toEqual(response);
      expect(response).toMatchObject({
        delivery: "direct",
        mediaReferenceId: reference,
        sessionId: `playback_${"p".repeat(22)}`,
        streamPath: `/v1/playback/playback_${"p".repeat(22)}/stream`,
      });
      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: privateAccessToken,
          connectorId: "jellyfin-main",
          deviceId: "viewer-device",
          tlsPolicy: "strict",
        }),
      );
      expect(negotiate).toHaveBeenCalledWith({ ...negotiation, itemId: privateItemId }, undefined);
      expect(JSON.stringify(response)).not.toMatch(/private-/u);

      const row = database.sqlite
        .prepare(
          `select id, encrypted_payload as encryptedPayload, state, position_seconds as positionSeconds
           from playback_sessions`,
        )
        .get();
      expect(row).toMatchObject({
        id: response.sessionId,
        positionSeconds: 900,
        state: "negotiated",
      });
      expect(JSON.stringify(row)).not.toMatch(/private-|upstream-query/u);
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("reports bounded state transitions with the encrypted Jellyfin session", async () => {
    const { database, reference, reportPlaybackEvent, service } = harness();
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const started = await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      const paused = await service.report({ principal: principal() }, playback.sessionId, {
        event: "paused",
        positionSeconds: 930,
      });
      const stopped = await service.report({ principal: principal() }, playback.sessionId, {
        event: "stopped",
        positionSeconds: 940,
      });

      expect(playbackProgressResponseSchema.parse(started)).toEqual(started);
      expect([started.state, paused.state, stopped.state]).toEqual([
        "playing",
        "paused",
        "stopped",
      ]);
      expect(reportPlaybackEvent).toHaveBeenNthCalledWith(
        1,
        {
          event: "started",
          positionSeconds: 905,
          session: {
            audioStreamIndex: 1,
            itemId: privateItemId,
            mediaSourceId: "private-media-source",
            playMethod: "DirectPlay",
            playSessionId: "private-play-session",
            subtitleStreamIndex: null,
          },
        },
        undefined,
      );
      expect(
        database.sqlite
          .prepare(
            "select state, position_seconds as positionSeconds from playback_sessions where id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ positionSeconds: 940, state: "stopped" });
    } finally {
      database.close();
    }
  });

  it("rejects cross-user, stale-link, expired, and invalid-transition access before Jellyfin", async () => {
    const { database, reference, reportPlaybackEvent, service } = harness();
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await expect(
        service.report({ principal: principal("other-user", "viewer-link") }, playback.sessionId, {
          event: "started",
          positionSeconds: 905,
        }),
      ).rejects.toMatchObject({ reason: "not_found" });

      database.sqlite
        .prepare("update service_identity_links set revision = 4 where id = 'viewer-link'")
        .run();
      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "started",
          positionSeconds: 905,
        }),
      ).rejects.toMatchObject({ reason: "not_found" });
      database.sqlite
        .prepare("update service_identity_links set revision = 3 where id = 'viewer-link'")
        .run();

      await service.report({ principal: principal() }, playback.sessionId, {
        event: "stopped",
        positionSeconds: 905,
      });
      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "progress",
          positionSeconds: 906,
        }),
      ).rejects.toMatchObject({ reason: "transition_invalid" });
      expect(reportPlaybackEvent).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("returns one safe unavailable error without persisting connector failures", async () => {
    const { database, negotiate, reference, service } = harness();
    negotiate.mockRejectedValueOnce(new Error("private upstream playback failure"));
    try {
      await expect(
        service.negotiate({ principal: principal() }, reference, negotiation),
      ).rejects.toEqual(
        expect.objectContaining<Partial<PlaybackSessionError>>({ reason: "unavailable" }),
      );
      expect(
        database.sqlite.prepare("select count(*) as count from playback_sessions").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects a connector result that changes the resolved upstream item", async () => {
    const { database, negotiate, reference, service } = harness();
    negotiate.mockResolvedValueOnce({ ...negotiatedResult(), itemId: "different-private-item" });
    try {
      await expect(
        service.negotiate({ principal: principal() }, reference, negotiation),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(
        database.sqlite.prepare("select count(*) as count from playback_sessions").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
