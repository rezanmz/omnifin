import {
  JellyfinPlaybackClient,
  type JellyfinPlaybackBytesResult,
  type JellyfinPlaybackNegotiationInput,
  type JellyfinPlaybackResult,
  type JellyfinPlaybackSourceSelection,
  type JellyfinPlaybackTarget,
} from "@omnifin/connectors/media/jellyfin-playback-client";
import type { ConnectorTransport } from "@omnifin/connectors/types";
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
  MAX_PLAYBACK_ASSET_HANDLES_GLOBAL,
  MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION,
} from "../src/media/playback-limits.js";
import { playbackSourceReferenceId } from "../src/media/playback-source-reference.js";
import {
  PlaybackSessionService,
  type PlaybackSessionError,
  type PlaybackClientFactoryInput,
  type PlaybackSessionDependencies,
} from "../src/media/playback-session-service.js";
import { ExternalMutationJournal } from "../src/operations/external-mutation-journal.js";
import { EnvelopeCipher, privacyHash } from "../src/security/crypto.js";

const now = new Date("2026-07-28T06:00:00.000Z");
const privateAccessToken = "private-jellyfin-access-token";
const privateItemId = "private-upstream-episode";
const publicResolver = async () => [{ address: "1.1.1.1", family: 4 as const }];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

function insertSecondIdentity(database: DatabaseHandle, config: AppConfig) {
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Second media viewer",
      id: "second-user",
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
      deviceId: "second-device",
      encryptedAccessToken: new EnvelopeCipher(config.encryptionKey).encrypt(
        "second-private-jellyfin-access-token",
        "service_identity_access_token:jellyfin:second-link",
      ),
      externalDisplayName: "Second media viewer",
      externalServerId: "server-1",
      externalUserId: "second-external",
      externalUsername: "second-viewer",
      healthState: "linked",
      id: "second-link",
      lastVerifiedAt: now,
      revision: 3,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "second-user",
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

function hlsNegotiatedResult(): JellyfinPlaybackResult {
  return {
    ...negotiatedResult(),
    delivery: "hls",
    playMethod: "Transcode",
    upstreamTarget: {
      path: `videos/${privateItemId}/master.m3u8`,
      query: "",
    },
  };
}

function legacyAssetToken(config: AppConfig, sessionId: string) {
  const target = { path: `videos/${privateItemId}/segment.m4s`, query: "" };
  return `asset_${new EnvelopeCipher(config.encryptionKey).encrypt(
    JSON.stringify({ schemaVersion: 1, target }),
    `playback_asset:jellyfin:${sessionId}`,
  )}`;
}

function harness(
  createClientOverride?: NonNullable<PlaybackSessionDependencies["createClient"]>,
  referenceKind: "extra" | "movie" = "movie",
  dependencyOverrides: Pick<
    PlaybackSessionDependencies,
    | "beforeProgressCompletion"
    | "clock"
    | "createAssetToken"
    | "createToken"
    | "playbackTransferLimits"
  > = {},
) {
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
      episodeNumber: null,
      itemId: privateItemId,
      kind: referenceKind,
      seasonNumber: null,
      title: "The Far Meridian",
      year: 2026,
    },
  ])[0]!;
  const negotiate = vi.fn(async () => negotiatedResult());
  const readPlaybackTarget = vi.fn<JellyfinPlaybackClient["readPlaybackTarget"]>(async () => {
    throw new Error("Playback bytes were not expected in this service test.");
  });
  const readSubtitleStream = vi.fn<JellyfinPlaybackClient["readSubtitleStream"]>(async () => {
    throw new Error("Subtitle bytes were not expected in this service test.");
  });
  const streamPlaybackTarget = vi.fn<JellyfinPlaybackClient["streamPlaybackTarget"]>(async () => {
    throw new Error("Playback streams were not expected in this service test.");
  });
  const reportPlaybackEvent = vi.fn<JellyfinPlaybackClient["reportPlaybackEvent"]>(
    async () => undefined,
  );
  const resolvePlaybackTarget = vi.fn<JellyfinPlaybackClient["resolvePlaybackTarget"]>(
    (parent) => parent,
  );
  const mockedCreateClient = vi.fn((_input: PlaybackClientFactoryInput) => ({
    negotiate,
    readPlaybackTarget,
    readSubtitleStream,
    reportPlaybackEvent,
    resolvePlaybackTarget,
    streamPlaybackTarget,
  }));
  const createClient = createClientOverride ?? mockedCreateClient;
  const createAssetToken =
    dependencyOverrides.createAssetToken ??
    (() => {
      let index = 0;
      return () => {
        const current = index;
        index += 1;
        return current.toString(36).padStart(22, "a");
      };
    })();
  const service = new PlaybackSessionService(database, config, {
    ...dependencyOverrides,
    clock: dependencyOverrides.clock ?? (() => now),
    createClient,
    createAssetToken,
    createToken: dependencyOverrides.createToken ?? (() => "p".repeat(22)),
    ...(dependencyOverrides.playbackTransferLimits === undefined
      ? {}
      : { playbackTransferLimits: dependencyOverrides.playbackTransferLimits }),
  });
  return {
    config,
    createClient,
    database,
    negotiate,
    readPlaybackTarget,
    readSubtitleStream,
    reference,
    reportPlaybackEvent,
    service,
    streamPlaybackTarget,
    resolvePlaybackTarget,
  };
}

const negotiation = {
  audioStreamIndex: 1,
  maxStreamingBitrate: 20_000_000,
  mode: "auto" as const,
  positionSeconds: 900,
  subtitleStreamIndex: null,
};

function seedHandleRows(database: DatabaseHandle, sessionIds: readonly string[], count: number) {
  const sessionCases = sessionIds.map((_, index) => `when ${index} then ?`).join(" ");
  const timestamp = now.getTime();
  database.sqlite
    .prepare(
      `with recursive x(value) as (
         select 0 union all select value + 1 from x where value < 499
       ), y(value) as (
         select 0 union all select value + 1 from y where value < 499
       )
       insert into playback_asset_handles (
         id, playback_session_id, target_digest, encrypted_target,
         expires_at, last_used_at, created_at, updated_at
       )
       select
         'asset_h1.' || printf('%022d', x.value * 500 + y.value),
         case ((x.value * 500 + y.value) % ${sessionIds.length}) ${sessionCases} end,
         printf('%022d', x.value * 500 + y.value), 'x',
         ${timestamp + 60 * 60 * 1_000}, ${timestamp}, ${timestamp}, ${timestamp}
       from x cross join y
       where x.value * 500 + y.value < ${count}`,
    )
    .run(...sessionIds);
}

function seedProgressReservation(
  database: DatabaseHandle,
  config: AppConfig,
  sessionId: string,
  state: "dispatched" | "reserved",
) {
  const operationId = `playback_progress_operation_${"o".repeat(22)}`;
  const dispatchId = `mutation_dispatch_${"d".repeat(22)}`;
  const reserveNow = now.getTime() - 60_000;
  const leaseExpiresAt = state === "reserved" ? now.getTime() - 30_000 : now.getTime() + 30_000;
  database.sqlite
    .prepare(
      `insert into playback_progress_operations (
         id, playback_session_id, session_revision, user_id, connector_id,
         connector_instance_generation, connector_config_generation,
         position_seconds, state, created_at, updated_at
       ) values (?, ?, 1, 'viewer-user', 'jellyfin-main', 0, 0, 930, 'pending', ?, ?)`,
    )
    .run(operationId, sessionId, reserveNow, reserveNow);
  const journal = new ExternalMutationJournal(database.sqlite, config.encryptionKey);
  journal.reserve({
    connectorConfigGeneration: 0,
    connectorId: "jellyfin-main",
    connectorInstanceGeneration: 0,
    id: dispatchId,
    kind: "playback.progress",
    leaseExpiresAt,
    leaseOwner: "crashed-playback-worker",
    normalizedRequest: {
      event: "progress",
      playbackSessionId: sessionId,
      positionSeconds: 930,
      schemaVersion: 1,
      sessionRevision: 1,
    },
    now: reserveNow,
    parentOperationId: operationId,
    parentOperationType: "playback_progress_operation",
    targetDigest: "t".repeat(22),
    userId: "viewer-user",
  });
  if (state === "dispatched") {
    journal.markDispatched({
      id: dispatchId,
      leaseOwner: "crashed-playback-worker",
      now: reserveNow + 1,
    });
  }
}

describe("PlaybackSessionService", () => {
  it("uses one injected clock for playback and opaque media-reference resolution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now.getTime() + 8 * 24 * 60 * 60 * 1_000);
    const { database, reference, service } = harness();
    try {
      await expect(
        service.negotiate({ principal: principal() }, reference, negotiation),
      ).resolves.toMatchObject({
        mediaReferenceId: reference,
        sessionId: `playback_${"p".repeat(22)}`,
      });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it("negotiates through the exact linked identity and persists only encrypted upstream state", async () => {
    const { createClient, database, negotiate, reference, service } = harness();
    try {
      const response = await service.negotiate({ principal: principal() }, reference, negotiation);

      expect(playbackNegotiationResponseSchema.parse(response)).toEqual(response);
      expect(response).toMatchObject({
        delivery: "direct",
        media: { streamBitrate: 8_640_000 },
        mediaReferenceId: reference,
        playMethod: "direct_play",
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

  it("binds an opaque selected source to the current user and title reference", async () => {
    const { config, database, negotiate, reference, service } = harness();
    const sourceReferenceId = playbackSourceReferenceId(
      config.encryptionKey,
      reference,
      "private-media-source",
    );
    try {
      const response = await service.negotiate({ principal: principal() }, reference, {
        ...negotiation,
        sourceReferenceId,
      });

      expect(response.sourceReferenceId).toBe(sourceReferenceId);
      const [connectorInput, signal, selection] = negotiate.mock.calls[0] as unknown as [
        JellyfinPlaybackNegotiationInput,
        AbortSignal | undefined,
        JellyfinPlaybackSourceSelection,
      ];
      expect(connectorInput).toEqual({ ...negotiation, itemId: privateItemId });
      expect(signal).toBeUndefined();
      expect(selection.matchesSourceId("private-media-source")).toBe(true);
      expect(selection.matchesSourceId("different-private-source")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("persists the lowercase HLS target produced by the real Jellyfin connector", async () => {
    const privateApiKey = "private-returned-jellyfin-api-key";
    const capturedRequests: URL[] = [];
    const transport: ConnectorTransport = async (url) => {
      capturedRequests.push(new URL(url));
      return new Response(
        JSON.stringify({
          MediaSources: [
            {
              Bitrate: 9_300_000,
              Container: "mkv",
              DefaultAudioStreamIndex: 1,
              Id: "private-media-source",
              MediaStreams: [
                {
                  BitRate: 9_300_000,
                  Codec: "hevc",
                  Height: 1_606,
                  Index: 0,
                  Type: "Video",
                  Width: 3_840,
                },
                {
                  Channels: 6,
                  Codec: "eac3",
                  Index: 1,
                  IsDefault: true,
                  Language: "eng",
                  Type: "Audio",
                },
              ],
              RunTimeTicks: 27_000_000_000,
              SupportsDirectPlay: false,
              SupportsTranscoding: true,
              TranscodingContainer: "mp4",
              TranscodingSubProtocol: "hls",
              TranscodingUrl:
                `/videos/${privateItemId}/master.m3u8` +
                `?MediaSourceId=private-media-source&ApiKey=${privateApiKey}` +
                "&PlaySessionId=private-play-session",
            },
          ],
          PlaySessionId: "private-play-session",
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const createClient = vi.fn((input: PlaybackClientFactoryInput) => {
      const { accessToken, deviceId, ...target } = input;
      return new JellyfinPlaybackClient({
        accessToken,
        deviceId,
        target: { ...target, resolveHost: publicResolver, transport },
      });
    });
    const { config, database, reference, service } = harness(createClient);
    try {
      const response = await service.negotiate({ principal: principal() }, reference, negotiation);

      expect(response).toMatchObject({
        delivery: "hls",
        playMethod: "transcode",
        streamPath: `/v1/playback/${response.sessionId}/master.m3u8`,
      });
      expect(capturedRequests[0]?.pathname).toBe(`/Items/${privateItemId}/PlaybackInfo`);
      const row = database.sqlite
        .prepare("select encrypted_payload as encryptedPayload from playback_sessions")
        .get() as { encryptedPayload: string };
      const payload = JSON.parse(
        new EnvelopeCipher(config.encryptionKey).decrypt(
          row.encryptedPayload,
          `playback_session:jellyfin:${response.sessionId}`,
        ),
      ) as { upstreamTarget: { path: string; query: string } };
      expect(payload.upstreamTarget).toEqual({
        path: `videos/${privateItemId}/master.m3u8`,
        query: "MediaSourceId=private-media-source&PlaySessionId=private-play-session",
      });
      expect(JSON.stringify(payload)).not.toContain(privateApiKey);
      expect(JSON.stringify(row)).not.toMatch(/private-|ApiKey/iu);
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

  it("serializes concurrent progress and stop reports and rejects post-stop work before Jellyfin", async () => {
    const progressGate = deferred<void>();
    const { database, reference, reportPlaybackEvent, service } = harness();
    const events: string[] = [];
    reportPlaybackEvent.mockImplementation(async ({ event }) => {
      events.push(event);
      if (event === "progress") await progressGate.promise;
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });

      const progress = service.report({ principal: principal() }, playback.sessionId, {
        event: "progress",
        positionSeconds: 930,
      });
      await vi.waitFor(() => expect(events).toEqual(["started", "progress"]));
      const stop = service.report({ principal: principal() }, playback.sessionId, {
        event: "stopped",
        positionSeconds: 940,
      });
      const postStop = service.report({ principal: principal() }, playback.sessionId, {
        event: "progress",
        positionSeconds: 941,
      });
      const postStopResult = expect(postStop).rejects.toMatchObject({
        reason: "transition_invalid",
      });
      await Promise.resolve();
      expect(events).toEqual(["started", "progress"]);

      progressGate.resolve(undefined);
      await expect(progress).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });
      await expect(stop).resolves.toMatchObject({ positionSeconds: 940, state: "stopped" });
      await postStopResult;

      expect(events).toEqual(["started", "progress", "stopped"]);
      expect(
        database.sqlite
          .prepare("select state, position_seconds as positionSeconds from playback_sessions")
          .get(),
      ).toEqual({ positionSeconds: 940, state: "stopped" });
    } finally {
      database.close();
    }
  });

  it("runs a valid queued report after an earlier transition rejects", async () => {
    const { database, reference, reportPlaybackEvent, service } = harness();
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const invalid = service.report({ principal: principal() }, playback.sessionId, {
        event: "progress",
        positionSeconds: 904,
      });
      const started = service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });

      await expect(invalid).rejects.toMatchObject({ reason: "transition_invalid" });
      await expect(started).resolves.toMatchObject({ positionSeconds: 905, state: "playing" });
      expect(reportPlaybackEvent).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("accepts an uncertain progress report locally and runs its queued stop", async () => {
    const progressGate = deferred<void>();
    const { database, reference, reportPlaybackEvent, service } = harness();
    const events: string[] = [];
    reportPlaybackEvent.mockImplementation(async ({ event }) => {
      events.push(event);
      if (event === "progress") {
        await progressGate.promise;
        throw new Error("private progress failure");
      }
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      const progress = service.report({ principal: principal() }, playback.sessionId, {
        event: "progress",
        positionSeconds: 930,
      });
      await vi.waitFor(() => expect(events).toEqual(["started", "progress"]));
      const stop = service.report({ principal: principal() }, playback.sessionId, {
        event: "stopped",
        positionSeconds: 940,
      });

      progressGate.resolve(undefined);
      await expect(progress).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });
      await expect(stop).resolves.toMatchObject({ positionSeconds: 940, state: "stopped" });
      expect(events).toEqual(["started", "progress", "stopped"]);
      expect(
        database.sqlite
          .prepare(
            `select state, failure_code as failureCode
             from playback_progress_operations
             where position_seconds = 930`,
          )
          .get(),
      ).toEqual({ failureCode: "upstream_outcome_uncertain", state: "uncertain" });
      expect(
        database.sqlite
          .prepare(
            `select state, dispatch_attempt_count as dispatchAttemptCount
             from external_mutation_dispatches
             where state = 'uncertain'`,
          )
          .get(),
      ).toEqual({ dispatchAttemptCount: 1, state: "uncertain" });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from external_mutation_target_locks where target_scope = 'playback_progress'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("coalesces concurrent exact report replays without redispatching Jellyfin", async () => {
    const gate = deferred<void>();
    const { database, reference, reportPlaybackEvent, service } = harness();
    reportPlaybackEvent.mockImplementation(async ({ event, positionSeconds }) => {
      if (event === "progress" && positionSeconds === 930) await gate.promise;
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      const request = { event: "progress" as const, positionSeconds: 930 };
      const first = service.report({ principal: principal() }, playback.sessionId, request);
      await vi.waitFor(() => expect(reportPlaybackEvent).toHaveBeenCalledTimes(2));
      const replay = service.report({ principal: principal() }, playback.sessionId, request);

      gate.resolve(undefined);
      await expect(first).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });
      await expect(replay).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });
      expect(reportPlaybackEvent).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare("select revision, position_seconds as positionSeconds from playback_sessions")
          .get(),
      ).toEqual({ positionSeconds: 930, revision: 2 });
    } finally {
      database.close();
    }
  });

  it("does not resend a lost-response revision and allows the next ordered revision", async () => {
    const { database, reference, reportPlaybackEvent, service } = harness();
    let lost = true;
    reportPlaybackEvent.mockImplementation(async ({ event }) => {
      if (event === "progress" && lost) {
        lost = false;
        throw new Error("private disconnect after upstream acceptance");
      }
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      const request = { event: "progress" as const, positionSeconds: 930 };

      await expect(
        service.report({ principal: principal() }, playback.sessionId, request),
      ).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });
      await expect(
        service.report({ principal: principal() }, playback.sessionId, request),
      ).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });
      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "stopped",
          positionSeconds: 940,
        }),
      ).resolves.toMatchObject({ positionSeconds: 940, state: "stopped" });

      expect(reportPlaybackEvent.mock.calls.map(([input]) => input.event)).toEqual([
        "started",
        "progress",
        "stopped",
      ]);
      const audit = database.sqlite
        .prepare(
          `select event_type as eventType, outcome, metadata_json as metadataJson,
                  target_id as targetId
           from audit_events where event_type = 'playback.progress.delivery_uncertain'`,
        )
        .get() as
        { eventType: string; metadataJson: string; outcome: string; targetId: string } | undefined;
      expect(audit).toMatchObject({
        eventType: "playback.progress.delivery_uncertain",
        outcome: "failure",
        targetId: playback.sessionId,
      });
      expect(JSON.parse(audit!.metadataJson)).toEqual({
        event: "progress",
        failureCode: "upstream_outcome_uncertain",
        locallyAccepted: true,
        sessionRevision: 1,
      });
      expect(JSON.stringify(audit)).not.toMatch(/private|upstream-episode|media-source/u);
    } finally {
      database.close();
    }
  });

  it("terminalizes a crash-recovered dispatched revision without calling Jellyfin", async () => {
    const { config, database, reference, reportPlaybackEvent, service } = harness();
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      seedProgressReservation(database, config, playback.sessionId, "dispatched");

      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "progress",
          positionSeconds: 930,
        }),
      ).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });

      expect(reportPlaybackEvent).toHaveBeenCalledOnce();
      expect(
        database.sqlite
          .prepare(
            `select state, failure_code as failureCode
             from playback_progress_operations where session_revision = 1`,
          )
          .get(),
      ).toEqual({ failureCode: "interrupted_after_dispatch", state: "uncertain" });
      expect(
        database.sqlite
          .prepare("select revision, position_seconds as positionSeconds from playback_sessions")
          .get(),
      ).toEqual({ positionSeconds: 930, revision: 2 });
      expect(
        database.sqlite
          .prepare("select count(*) as count from external_mutation_target_locks")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("reclaims only a stale pre-dispatch reservation and dispatches it once", async () => {
    const { config, database, reference, reportPlaybackEvent, service } = harness();
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      seedProgressReservation(database, config, playback.sessionId, "reserved");

      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "progress",
          positionSeconds: 930,
        }),
      ).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });

      expect(reportPlaybackEvent).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare(
            `select state, dispatch_attempt_count as dispatchAttemptCount
             from external_mutation_dispatches where parent_operation_id = ?`,
          )
          .get(`playback_progress_operation_${"o".repeat(22)}`),
      ).toEqual({ dispatchAttemptCount: 1, state: "succeeded" });
    } finally {
      database.close();
    }
  });

  it("terminalizes a post-dispatch local completion failure without resending", async () => {
    let failNextSuccess = false;
    const { database, reference, reportPlaybackEvent, service } = harness(undefined, "movie", {
      beforeProgressCompletion: (state) => {
        if (state === "succeeded" && failNextSuccess) {
          failNextSuccess = false;
          throw new Error("private local commit failure");
        }
      },
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      failNextSuccess = true;
      const request = { event: "progress" as const, positionSeconds: 930 };

      await expect(
        service.report({ principal: principal() }, playback.sessionId, request),
      ).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });
      await expect(
        service.report({ principal: principal() }, playback.sessionId, request),
      ).resolves.toMatchObject({ positionSeconds: 930, state: "playing" });

      expect(reportPlaybackEvent).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare(
            `select state, failure_code as failureCode
             from playback_progress_operations where session_revision = 1`,
          )
          .get(),
      ).toEqual({ failureCode: "local_completion_failed", state: "uncertain" });
      expect(
        database.sqlite
          .prepare("select revision, position_seconds as positionSeconds from playback_sessions")
          .get(),
      ).toEqual({ positionSeconds: 930, revision: 2 });
    } finally {
      database.close();
    }
  });

  it("preserves stopped cleanup when the stop delivery is uncertain", async () => {
    const { database, reference, reportPlaybackEvent, service } = harness();
    reportPlaybackEvent.mockRejectedValueOnce(new Error("private stop disconnect"));
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      database.sqlite
        .prepare(
          `insert into playback_asset_handles (
             id, playback_session_id, target_digest, encrypted_target,
             expires_at, last_used_at, created_at, updated_at
           ) values (?, ?, ?, 'encrypted-private-target', ?, ?, ?, ?)`,
        )
        .run(
          `asset_h1.${"h".repeat(22)}`,
          playback.sessionId,
          "g".repeat(22),
          now.getTime() + 60_000,
          now.getTime(),
          now.getTime(),
          now.getTime(),
        );

      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "stopped",
          positionSeconds: 940,
        }),
      ).resolves.toMatchObject({ positionSeconds: 940, state: "stopped" });

      expect(
        database.sqlite
          .prepare("select state, revision from playback_sessions where id = ?")
          .get(playback.sessionId),
      ).toEqual({ revision: 1, state: "stopped" });
      expect(
        database.sqlite.prepare("select count(*) as count from playback_asset_handles").get(),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare("select count(*) as count from external_mutation_target_locks")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("atomically removes terminal playback evidence before deleting an expired session", async () => {
    let currentTime = now.getTime();
    const { database, reference, service } = harness(undefined, "movie", {
      clock: () => new Date(currentTime),
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      database.sqlite
        .prepare("update playback_sessions set expires_at = ? where id = ?")
        .run(++currentTime, playback.sessionId);
      currentTime += 1;

      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "progress",
          positionSeconds: 906,
        }),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(
        database.sqlite
          .prepare(
            `select
               (select count(*) from playback_sessions) as sessions,
               (select count(*) from playback_progress_operations) as operations,
               (select count(*) from external_mutation_dispatches) as dispatches,
               (select count(*) from external_mutation_target_locks) as locks`,
          )
          .get(),
      ).toEqual({ dispatches: 0, locks: 0, operations: 0, sessions: 0 });
    } finally {
      database.close();
    }
  });

  it("retains uncertain playback evidence when its session expires", async () => {
    let currentTime = now.getTime();
    const { database, reference, reportPlaybackEvent, service } = harness(undefined, "movie", {
      clock: () => new Date(currentTime),
    });
    reportPlaybackEvent.mockRejectedValueOnce(new Error("private lost playback response"));
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      database.sqlite
        .prepare("update playback_sessions set expires_at = ? where id = ?")
        .run(++currentTime, playback.sessionId);
      currentTime += 1;

      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "progress",
          positionSeconds: 906,
        }),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(
        database.sqlite
          .prepare(
            `select
               (select count(*) from playback_sessions) as sessions,
               (select count(*) from playback_progress_operations where state = 'uncertain') as operations,
               (select count(*) from external_mutation_dispatches where state = 'uncertain') as dispatches,
               (select count(*) from external_mutation_target_locks) as locks`,
          )
          .get(),
      ).toEqual({ dispatches: 1, locks: 1, operations: 1, sessions: 1 });
    } finally {
      database.close();
    }
  });

  it("fails a queued stale connector generation before Jellyfin dispatch", async () => {
    const gate = deferred<void>();
    const { database, reference, reportPlaybackEvent, service } = harness();
    reportPlaybackEvent.mockImplementation(async ({ event, positionSeconds }) => {
      if (event === "progress" && positionSeconds === 930) await gate.promise;
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 905,
      });
      const first = service.report({ principal: principal() }, playback.sessionId, {
        event: "progress",
        positionSeconds: 930,
      });
      await vi.waitFor(() => expect(reportPlaybackEvent).toHaveBeenCalledTimes(2));
      const stale = service.report({ principal: principal() }, playback.sessionId, {
        event: "progress",
        positionSeconds: 940,
      });
      database.sqlite
        .prepare("update connector_configs set config_generation = config_generation + 1")
        .run();

      gate.resolve(undefined);
      await expect(first).resolves.toMatchObject({ positionSeconds: 930 });
      await expect(stale).rejects.toMatchObject({ reason: "unavailable" });
      expect(reportPlaybackEvent).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite
          .prepare(
            `select state, failure_code as failureCode
             from playback_progress_operations where session_revision = 2`,
          )
          .get(),
      ).toEqual({ failureCode: "connector_generation_changed", state: "failed" });
      expect(
        database.sqlite
          .prepare(
            `select state, dispatch_attempt_count as dispatchAttemptCount
             from external_mutation_dispatches
             where parent_operation_id in (
               select id from playback_progress_operations where session_revision = 2
             )`,
          )
          .get(),
      ).toEqual({ dispatchAttemptCount: 0, state: "failed" });
    } finally {
      database.close();
    }
  });

  it("plays and reports a local extra against its own Jellyfin child item", async () => {
    const { database, negotiate, reference, reportPlaybackEvent, service } = harness(
      undefined,
      "extra",
    );
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await service.report({ principal: principal() }, playback.sessionId, {
        event: "started",
        positionSeconds: 12,
      });

      expect(negotiate).toHaveBeenCalledWith({ ...negotiation, itemId: privateItemId }, undefined);
      expect(reportPlaybackEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "started",
          session: expect.objectContaining({ itemId: privateItemId }),
        }),
        undefined,
      );
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

  it("rejects a series title reference before contacting Jellyfin playback", async () => {
    const { config, database, negotiate, service } = harness();
    const seriesReference = new MediaReferenceService(database, config, {
      clock: () => now,
      createToken: () => "s".repeat(22),
    }).createOrRefresh({ linkId: "viewer-link", linkRevision: 3, userId: "viewer-user" }, [
      {
        artwork: { backdropItemId: privateItemId, posterItemId: privateItemId },
        episodeNumber: null,
        itemId: "private-upstream-series",
        kind: "series",
        seasonNumber: null,
        title: "Northern Lights",
        year: 2026,
      },
    ])[0]!;

    try {
      await expect(
        service.negotiate({ principal: principal() }, seriesReference, negotiation),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(negotiate).not.toHaveBeenCalled();
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

  it("rejects an oversized playback path without evaluating a nested expression", async () => {
    const { database, negotiate, reference, service } = harness();
    negotiate.mockResolvedValueOnce({
      ...negotiatedResult(),
      upstreamTarget: {
        path: `Videos/${privateItemId}/${"!".repeat(32_768)}`,
        query: "",
      },
    });
    try {
      await expect(
        service.negotiate({ principal: principal() }, reference, negotiation),
      ).rejects.toMatchObject({
        reason: "unavailable",
        stage: "session_payload_validation",
      });
      expect(
        database.sqlite.prepare("select count(*) as count from playback_sessions").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it.each([
    `video/${privateItemId}/master.m3u8`,
    `videos.evil/${privateItemId}/master.m3u8`,
    `videos%2F../${privateItemId}/master.m3u8`,
    "videos/../master.m3u8",
    "videos/invalid id/master.m3u8",
    `videos/${privateItemId}/%2e%2e/master.m3u8`,
    `videos/${privateItemId}/%252e%252e/master.m3u8`,
    `videos/${privateItemId}/%2F/master.m3u8`,
    `videos/${privateItemId}//master.m3u8`,
    `https://attacker.example/videos/${privateItemId}/master.m3u8`,
  ])("rejects unsafe or near-match playback target %s", async (path) => {
    const { database, negotiate, reference, service } = harness();
    negotiate.mockResolvedValueOnce({
      ...negotiatedResult(),
      upstreamTarget: { path, query: "" },
    });
    try {
      await expect(
        service.negotiate({ principal: principal() }, reference, negotiation),
      ).rejects.toMatchObject({
        reason: "unavailable",
        stage: "session_payload_validation",
      });
      expect(
        database.sqlite.prepare("select count(*) as count from playback_sessions").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("exposes masked WebVTT paths and reads only text subtitles from the negotiated session", async () => {
    const vtt = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello");
    const { database, readSubtitleStream, reference, service } = harness();
    readSubtitleStream.mockResolvedValue({
      body: vtt,
      headers: new Headers({ "content-type": "text/vtt" }),
      status: 200,
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      expect(playback.subtitleTracks).toEqual([
        expect.objectContaining({
          codec: "vtt",
          delivery: "external",
          index: 2,
          subtitlePath: `/v1/playback/${playback.sessionId}/subtitle/2`,
        }),
      ]);

      const subtitle = await service.readSubtitle(
        { principal: principal() },
        playback.sessionId,
        2,
      );
      expect(subtitle).toEqual({ body: vtt, contentType: "text/vtt", status: 200 });
      expect(readSubtitleStream).toHaveBeenCalledWith({
        itemId: privateItemId,
        mediaSourceId: "private-media-source",
        subtitleIndex: 2,
      });

      await expect(
        service.readSubtitle({ principal: principal() }, playback.sessionId, 999),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(readSubtitleStream).toHaveBeenCalledTimes(1);

      database.sqlite
        .prepare("update playback_sessions set state = 'stopped' where id = ?")
        .run(playback.sessionId);
      await expect(
        service.readSubtitle({ principal: principal() }, playback.sessionId, 2),
      ).rejects.toMatchObject({ reason: "not_found" });
    } finally {
      database.close();
    }
  });

  it("enforces the default eight-transfer owner limit before upstream work", async () => {
    const upstreamGate = deferred<void>();
    const { database, readPlaybackTarget, reference, service } = harness();
    readPlaybackTarget.mockImplementation(async (): Promise<JellyfinPlaybackBytesResult> => {
      await upstreamGate.promise;
      return { body: new Uint8Array([1]), headers: new Headers(), status: 200 };
    });
    let settled: Promise<unknown> | undefined;
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const transfers = Array.from({ length: 9 }, () =>
        service.readDirect({ principal: principal() }, playback.sessionId, undefined),
      );
      settled = Promise.allSettled(transfers).then(() => undefined);

      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledTimes(8));
      await expect(transfers[8]).rejects.toMatchObject({ reason: "unavailable" });
    } finally {
      upstreamGate.resolve(undefined);
      await settled;
      database.close();
    }
  });

  it("rejects a per-owner exhausted lease without waiting or contacting upstream", async () => {
    const upstreamGate = deferred<void>();
    const { database, readPlaybackTarget, reference, service } = harness(undefined, "movie", {
      playbackTransferLimits: { global: 8, perUser: 1 },
    });
    readPlaybackTarget.mockImplementation(async (): Promise<JellyfinPlaybackBytesResult> => {
      await upstreamGate.promise;
      return { body: new Uint8Array([1]), headers: new Headers(), status: 200 };
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const first = service.readDirect({ principal: principal() }, playback.sessionId, undefined);
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledOnce());
      await expect(
        service.readDirect({ principal: principal() }, playback.sessionId, undefined),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(readPlaybackTarget).toHaveBeenCalledOnce();
      upstreamGate.resolve(undefined);
      await expect(first).resolves.toMatchObject({ status: 200 });
    } finally {
      upstreamGate.resolve(undefined);
      database.close();
    }
  });

  it("rejects a globally exhausted lease independently of the owner limit", async () => {
    const upstreamGate = deferred<void>();
    const { database, readPlaybackTarget, reference, service } = harness(undefined, "movie", {
      playbackTransferLimits: { global: 1, perUser: 8 },
    });
    readPlaybackTarget.mockImplementation(async (): Promise<JellyfinPlaybackBytesResult> => {
      await upstreamGate.promise;
      return { body: new Uint8Array([1]), headers: new Headers(), status: 200 };
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const first = service.readDirect({ principal: principal() }, playback.sessionId, undefined);
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledOnce());
      await expect(
        service.readDirect({ principal: principal() }, playback.sessionId, undefined),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(readPlaybackTarget).toHaveBeenCalledOnce();
      upstreamGate.resolve(undefined);
      await expect(first).resolves.toMatchObject({ status: 200 });
    } finally {
      upstreamGate.resolve(undefined);
      database.close();
    }
  });

  it("releases direct and manifest leases after upstream completion", async () => {
    const { database, negotiate, readPlaybackTarget, reference, service } = harness(
      undefined,
      "movie",
      {
        playbackTransferLimits: { global: 1, perUser: 1 },
      },
    );
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    readPlaybackTarget.mockResolvedValue({
      body: new TextEncoder().encode("#EXTM3U\n"),
      headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
      status: 200,
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).resolves.toMatchObject({ status: 200 });
      expect(readPlaybackTarget).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("releases a lease after an upstream failure", async () => {
    const { database, readPlaybackTarget, reference, service } = harness(undefined, "movie", {
      playbackTransferLimits: { global: 1, perUser: 1 },
    });
    readPlaybackTarget.mockRejectedValueOnce(new Error("private upstream failure"));
    readPlaybackTarget.mockResolvedValueOnce({
      body: new Uint8Array([1]),
      headers: new Headers(),
      status: 200,
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await expect(
        service.readDirect({ principal: principal() }, playback.sessionId, undefined),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        service.readDirect({ principal: principal() }, playback.sessionId, undefined),
      ).resolves.toMatchObject({ status: 200 });
      expect(readPlaybackTarget).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("holds an HLS asset lease until cancellation and releases it once", async () => {
    const { config, database, negotiate, reference, service, streamPlaybackTarget } = harness(
      undefined,
      "movie",
      { playbackTransferLimits: { global: 1, perUser: 1 } },
    );
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    let sourceCancelled = false;
    streamPlaybackTarget.mockResolvedValueOnce({
      body: new ReadableStream<Uint8Array>({
        cancel() {
          sourceCancelled = true;
        },
      }),
      headers: new Headers({ "content-type": "video/mp4" }),
      status: 200,
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const token = legacyAssetToken(config, playback.sessionId);
      const asset = await service.readAsset({ principal: principal() }, playback.sessionId, token);
      if (asset.kind !== "asset") throw new Error("Expected an HLS asset stream.");
      await expect(
        service.readAsset({ principal: principal() }, playback.sessionId, token),
      ).rejects.toMatchObject({ reason: "unavailable" });

      await asset.body.cancel("client abort");
      expect(sourceCancelled).toBe(true);
      await asset.body.cancel("duplicate client abort");

      streamPlaybackTarget.mockResolvedValueOnce({
        body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        headers: new Headers({ "content-type": "video/mp4" }),
        status: 200,
      });
      await expect(
        service.readAsset({ principal: principal() }, playback.sessionId, token),
      ).resolves.toMatchObject({ kind: "asset" });
    } finally {
      database.close();
    }
  });

  it("releases an HLS asset lease when the upstream body errors", async () => {
    const { config, database, negotiate, reference, service, streamPlaybackTarget } = harness(
      undefined,
      "movie",
      { playbackTransferLimits: { global: 1, perUser: 1 } },
    );
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    streamPlaybackTarget
      .mockResolvedValueOnce({
        body: new ReadableStream<Uint8Array>({
          start: (controller) => controller.error(new Error("private body failure")),
        }),
        headers: new Headers(),
        status: 200,
      })
      .mockResolvedValueOnce({
        body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        headers: new Headers(),
        status: 200,
      });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const token = legacyAssetToken(config, playback.sessionId);
      const asset = await service.readAsset({ principal: principal() }, playback.sessionId, token);
      if (asset.kind !== "asset") throw new Error("Expected an HLS asset stream.");
      await expect(asset.body.getReader().read()).rejects.toThrow();
      await expect(
        service.readAsset({ principal: principal() }, playback.sessionId, token),
      ).resolves.toMatchObject({ kind: "asset" });
      expect(streamPlaybackTarget).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("releases a direct lease when the client aborts upstream work", async () => {
    const { database, readPlaybackTarget, reference, service } = harness(undefined, "movie", {
      playbackTransferLimits: { global: 1, perUser: 1 },
    });
    readPlaybackTarget.mockImplementationOnce(async ({ signal }) => {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    readPlaybackTarget.mockResolvedValueOnce({
      body: new Uint8Array([1]),
      headers: new Headers(),
      status: 200,
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const controller = new AbortController();
      const pending = service.readDirect(
        { principal: principal() },
        playback.sessionId,
        undefined,
        controller.signal,
      );
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledOnce());
      controller.abort(new Error("client abort"));
      await expect(pending).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        service.readDirect({ principal: principal() }, playback.sessionId, undefined),
      ).resolves.toMatchObject({ status: 200 });
      expect(readPlaybackTarget).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("admits only one active subtitle transfer for an owner", async () => {
    const upstreamGate = deferred<void>();
    const { database, readSubtitleStream, reference, service } = harness(undefined, "movie", {
      playbackTransferLimits: { global: 2, perUser: 1 },
    });
    readSubtitleStream.mockImplementation(async (): Promise<JellyfinPlaybackBytesResult> => {
      await upstreamGate.promise;
      return {
        body: new TextEncoder().encode("WEBVTT\n"),
        headers: new Headers({ "content-type": "text/vtt" }),
        status: 200,
      };
    });
    let settled: Promise<unknown> | undefined;
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const first = service.readSubtitle({ principal: principal() }, playback.sessionId, 2);
      await vi.waitFor(() => expect(readSubtitleStream).toHaveBeenCalledOnce());
      const second = service.readSubtitle({ principal: principal() }, playback.sessionId, 2);
      settled = Promise.allSettled([first, second]).then(() => undefined);
      await Promise.resolve();
      expect(readSubtitleStream).toHaveBeenCalledOnce();
    } finally {
      upstreamGate.resolve(undefined);
      await settled;
      database.close();
    }
  });

  it("aggregates transfers across sessions per owner while isolating another owner", async () => {
    const upstreamGate = deferred<void>();
    const { config, database, readPlaybackTarget, reference, service } = harness(
      undefined,
      "movie",
      {
        createToken: (() => {
          let count = 0;
          return () => (++count === 1 ? "p" : count === 2 ? "q" : "r").repeat(22);
        })(),
        playbackTransferLimits: { global: 2, perUser: 1 },
      },
    );
    insertSecondIdentity(database, config);
    const secondReference = new MediaReferenceService(database, config, {
      clock: () => now,
      createToken: () => "n".repeat(22),
    }).createOrRefresh({ linkId: "second-link", linkRevision: 3, userId: "second-user" }, [
      {
        artwork: { backdropItemId: null, posterItemId: null },
        episodeNumber: null,
        itemId: privateItemId,
        kind: "movie",
        seasonNumber: null,
        title: "The Far Meridian",
        year: 2026,
      },
    ])[0]!;
    readPlaybackTarget.mockImplementation(async (): Promise<JellyfinPlaybackBytesResult> => {
      await upstreamGate.promise;
      return { body: new Uint8Array([1]), headers: new Headers(), status: 200 };
    });
    try {
      const firstPlayback = await service.negotiate(
        { principal: principal() },
        reference,
        negotiation,
      );
      const secondPlayback = await service.negotiate(
        { principal: principal() },
        reference,
        negotiation,
      );
      const otherPlayback = await service.negotiate(
        { principal: principal("second-user", "second-link") },
        secondReference,
        negotiation,
      );

      const first = service.readDirect(
        { principal: principal() },
        firstPlayback.sessionId,
        undefined,
      );
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledOnce());
      await expect(
        service.readDirect({ principal: principal() }, secondPlayback.sessionId, undefined),
      ).rejects.toMatchObject({ reason: "unavailable" });

      const other = service.readDirect(
        { principal: principal("second-user", "second-link") },
        otherPlayback.sessionId,
        undefined,
      );
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledTimes(2));
      upstreamGate.resolve(undefined);
      await expect(first).resolves.toMatchObject({ status: 200 });
      await expect(other).resolves.toMatchObject({ status: 200 });
    } finally {
      upstreamGate.resolve(undefined);
      database.close();
    }
  });

  it("releases subtitle leases after success, upstream error, and client abort", async () => {
    const { database, readSubtitleStream, reference, service } = harness(undefined, "movie", {
      playbackTransferLimits: { global: 1, perUser: 1 },
    });
    const subtitle = {
      body: new TextEncoder().encode("WEBVTT\n"),
      headers: new Headers({ "content-type": "text/vtt" }),
      status: 200 as const,
    };
    readSubtitleStream
      .mockResolvedValueOnce(subtitle)
      .mockResolvedValueOnce(subtitle)
      .mockRejectedValueOnce(new Error("private subtitle failure"))
      .mockResolvedValueOnce(subtitle)
      .mockImplementationOnce(async ({ signal }) => {
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      })
      .mockResolvedValueOnce(subtitle);
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      await expect(
        service.readSubtitle({ principal: principal() }, playback.sessionId, 2),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        service.readSubtitle({ principal: principal() }, playback.sessionId, 2),
      ).resolves.toMatchObject({ status: 200 });

      await expect(
        service.readSubtitle({ principal: principal() }, playback.sessionId, 2),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        service.readSubtitle({ principal: principal() }, playback.sessionId, 2),
      ).resolves.toMatchObject({ status: 200 });

      const controller = new AbortController();
      const pending = service.readSubtitle(
        { principal: principal() },
        playback.sessionId,
        2,
        controller.signal,
      );
      await vi.waitFor(() => expect(readSubtitleStream).toHaveBeenCalledTimes(5));
      controller.abort(new Error("client abort"));
      await expect(pending).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        service.readSubtitle({ principal: principal() }, playback.sessionId, 2),
      ).resolves.toMatchObject({ status: 200 });
      expect(readSubtitleStream).toHaveBeenCalledTimes(6);
    } finally {
      database.close();
    }
  });

  it("releases active playback leases when the session stops", async () => {
    const upstreamGate = deferred<void>();
    const { database, readPlaybackTarget, reference, service } = harness(undefined, "movie", {
      createToken: (() => {
        let count = 0;
        return () => (++count === 1 ? "p" : "q").repeat(22);
      })(),
      playbackTransferLimits: { global: 1, perUser: 1 },
    });
    readPlaybackTarget.mockImplementation(async (): Promise<JellyfinPlaybackBytesResult> => {
      await upstreamGate.promise;
      return { body: new Uint8Array([1]), headers: new Headers(), status: 200 };
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const first = service.readDirect({ principal: principal() }, playback.sessionId, undefined);
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledOnce());
      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "stopped",
          positionSeconds: 901,
        }),
      ).resolves.toMatchObject({ state: "stopped" });

      const secondPlayback = await service.negotiate(
        { principal: principal() },
        reference,
        negotiation,
      );
      await expect(
        service.readDirect({ principal: principal() }, secondPlayback.sessionId, undefined),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(readPlaybackTarget).toHaveBeenCalledOnce();
      upstreamGate.resolve(undefined);
      await expect(first).resolves.toMatchObject({ status: 200 });

      const second = service.readDirect(
        { principal: principal() },
        secondPlayback.sessionId,
        undefined,
      );
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledTimes(2));
      await expect(second).resolves.toMatchObject({ status: 200 });
    } finally {
      upstreamGate.resolve(undefined);
      database.close();
    }
  });

  it("plans mixed existing, new, and duplicate references before deterministic rendering", async () => {
    const { database, negotiate, readPlaybackTarget, reference, resolvePlaybackTarget, service } =
      harness();
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    resolvePlaybackTarget.mockImplementation((_parent: JellyfinPlaybackTarget, uri: string) => ({
      path: `videos/${privateItemId}/master.m3u8`,
      query: `segment=${uri}`,
    }));
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      readPlaybackTarget
        .mockResolvedValueOnce({
          body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\na.m4s\n"),
          headers: new Headers(),
          status: 200,
        })
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\na.m4s\nb.m4s\na.m4s\n',
          ),
          headers: new Headers(),
          status: 200,
        })
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\na.m4s\nb.m4s\na.m4s\n',
          ),
          headers: new Headers(),
          status: 200,
        });

      const first = await service.readManifest({ principal: principal() }, playback.sessionId);
      const second = await service.readManifest({ principal: principal() }, playback.sessionId);
      const third = await service.readManifest({ principal: principal() }, playback.sessionId);

      expect(second.body).toBe(third.body);
      expect(second.body).toContain('#EXT-X-MAP:URI="hls/');
      expect(second.body.match(/hls\/asset_h1\.[A-Za-z0-9_-]{22}/gu)).toHaveLength(4);
      expect(new Set(second.body.match(/hls\/asset_h1\.[A-Za-z0-9_-]{22}/gu))).toHaveProperty(
        "size",
        3,
      );
      expect(first.body).toMatch(/^#EXTM3U\n#EXTINF:4\.000,\nhls\/asset_h1\./u);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 3 });
    } finally {
      database.close();
    }
  });

  it("serializes identical concurrent manifests into one reusable handle set", async () => {
    const { database, negotiate, readPlaybackTarget, reference, service } = harness();
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    readPlaybackTarget.mockResolvedValue({
      body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\nsegment.m4s\n"),
      headers: new Headers(),
      status: 200,
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const [first, second] = await Promise.all([
        service.readManifest({ principal: principal() }, playback.sessionId),
        service.readManifest({ principal: principal() }, playback.sessionId),
      ]);

      expect(first.body).toBe(second.body);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("rolls back new allocation when an existing ciphertext no longer matches its digest", async () => {
    const {
      config,
      database,
      negotiate,
      readPlaybackTarget,
      reference,
      resolvePlaybackTarget,
      service,
    } = harness();
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    resolvePlaybackTarget.mockImplementation((_parent: JellyfinPlaybackTarget, uri: string) => ({
      path: `videos/${privateItemId}/master.m3u8`,
      query: `segment=${uri}`,
    }));
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\nsegment-a.m4s\n"),
        headers: new Headers(),
        status: 200,
      });
      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).resolves.toMatchObject({ status: 200 });

      const row = database.sqlite
        .prepare("select id from playback_asset_handles where playback_session_id = ?")
        .get(playback.sessionId) as { id: string };
      const corruptTarget = JSON.stringify({
        schemaVersion: 1,
        target: { path: `videos/${privateItemId}/master.m3u8`, query: "segment=corrupt" },
      });
      const targetBDigest = privacyHash(
        "playback_asset",
        `${playback.sessionId}\u0000${JSON.stringify({
          schemaVersion: 1,
          target: { path: `videos/${privateItemId}/master.m3u8`, query: "segment=segment-b.m4s" },
        })}`,
        config.encryptionKey,
      );
      database.sqlite
        .prepare("update playback_asset_handles set encrypted_target = ? where id = ?")
        .run(
          new EnvelopeCipher(config.encryptionKey).encrypt(
            corruptTarget,
            `playback_asset_handle:jellyfin:${playback.sessionId}:${row.id}`,
          ),
          row.id,
        );
      database.sqlite
        .prepare("update playback_asset_handles set target_digest = ? where id = ?")
        .run(targetBDigest, row.id);
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\nsegment-a.m4s\nsegment-b.m4s\n"),
        headers: new Headers(),
        status: 200,
      });

      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("enforces exact session quota boundaries without partial inserts", async () => {
    const { database, negotiate, readPlaybackTarget, reference, resolvePlaybackTarget, service } =
      harness();
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    resolvePlaybackTarget.mockImplementation((_parent: JellyfinPlaybackTarget, uri: string) => ({
      path: `videos/${privateItemId}/master.m3u8`,
      query: `segment=${uri}`,
    }));
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      seedHandleRows(database, [playback.sessionId], MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION - 1);
      const count = () =>
        database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId) as { count: number };

      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\nsegment-a.m4s\nsegment-b.m4s\n"),
        headers: new Headers(),
        status: 200,
      });
      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(count()).toEqual({ count: MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION - 1 });

      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\nsegment-a.m4s\n"),
        headers: new Headers(),
        status: 200,
      });
      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).resolves.toMatchObject({ status: 200 });
      expect(count()).toEqual({ count: MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION });

      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\nsegment-b.m4s\n"),
        headers: new Headers(),
        status: 200,
      });
      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(count()).toEqual({ count: MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION });
    } finally {
      database.close();
    }
  });

  it("enforces the global last slot with one safe concurrent winner", async () => {
    let tokenIndex = 0;
    const { database, negotiate, readPlaybackTarget, reference, resolvePlaybackTarget, service } =
      harness(undefined, "movie", {
        createToken: () => {
          const current = tokenIndex;
          tokenIndex += 1;
          return current.toString(36).padStart(22, "a");
        },
      });
    negotiate.mockResolvedValue(hlsNegotiatedResult());
    resolvePlaybackTarget.mockImplementation((_parent: JellyfinPlaybackTarget, uri: string) => ({
      path: `videos/${privateItemId}/master.m3u8`,
      query: `segment=${uri}`,
    }));
    try {
      const playbacks = [];
      for (let index = 0; index < 13; index += 1) {
        playbacks.push(await service.negotiate({ principal: principal() }, reference, negotiation));
      }
      seedHandleRows(
        database,
        playbacks.map(({ sessionId }) => sessionId),
        MAX_PLAYBACK_ASSET_HANDLES_GLOBAL - 1,
      );
      const globalCount = () =>
        database.sqlite.prepare("select count(*) as count from playback_asset_handles").get() as {
          count: number;
        };

      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\nsegment-a.m4s\nsegment-b.m4s\n"),
        headers: new Headers(),
        status: 200,
      });
      await expect(
        service.readManifest({ principal: principal() }, playbacks[0]!.sessionId),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(globalCount()).toEqual({ count: MAX_PLAYBACK_ASSET_HANDLES_GLOBAL - 1 });

      readPlaybackTarget.mockResolvedValue({
        body: new TextEncoder().encode("#EXTM3U\nsegment-c.m4s\n"),
        headers: new Headers(),
        status: 200,
      });
      const results = await Promise.allSettled([
        service.readManifest({ principal: principal() }, playbacks[11]!.sessionId),
        service.readManifest({ principal: principal() }, playbacks[12]!.sessionId),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const rejected = results.find(({ status }) => status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toMatchObject({ reason: "unavailable" });
      }
      expect(globalCount()).toEqual({ count: MAX_PLAYBACK_ASSET_HANDLES_GLOBAL });
    } finally {
      database.close();
    }
  }, 30_000);

  it("rolls back every handle when a later batched insert fails", async () => {
    const { database, negotiate, readPlaybackTarget, reference, resolvePlaybackTarget, service } =
      harness();
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    resolvePlaybackTarget.mockImplementation((_parent: JellyfinPlaybackTarget, uri: string) => ({
      path: `videos/${privateItemId}/master.m3u8`,
      query: `segment=${uri}`,
    }));
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      database.sqlite.exec(`
        create trigger playback_asset_handles_batch_failure
        before insert on playback_asset_handles
        when (select count(*) from playback_asset_handles where playback_session_id = new.playback_session_id) >= 100
        begin
          select raise(abort, 'deterministic playback handle failure');
        end
      `);
      const body = Array.from({ length: 101 }, (_, index) => `segment-${index}.m4s`).join("\n");
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode(`#EXTM3U\n${body}\n`),
        headers: new Headers(),
        status: 200,
      });
      const prepareSpy = vi.spyOn(database.sqlite, "prepare");

      await expect(
        service.readManifest({ principal: principal() }, playback.sessionId),
      ).rejects.toMatchObject({ reason: "unavailable" });
      const handleInsertStatements = prepareSpy.mock.calls.filter(([sql]) =>
        String(sql).includes("insert into playback_asset_handles"),
      );
      const candidateLookups = prepareSpy.mock.calls.filter(([sql]) =>
        String(sql).includes("select id from playback_asset_handles where id in"),
      );
      expect(handleInsertStatements).toHaveLength(2);
      expect(candidateLookups).toHaveLength(2);
      expect(
        prepareSpy.mock.calls.some(([sql]) =>
          String(sql).includes("select 1 from playback_asset_handles where id = ?"),
        ),
      ).toBe(false);
      expect(String(handleInsertStatements[0]?.[0])).toContain("), (?");
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("regenerates only database-colliding candidates after bounded ID lookup", async () => {
    const candidates = [`${"c".repeat(22)}`, `${"d".repeat(22)}`];
    const { database, negotiate, readPlaybackTarget, reference, service } = harness(
      undefined,
      "movie",
      { createAssetToken: () => candidates.shift() ?? "e".repeat(22) },
    );
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      database.sqlite
        .prepare(
          `insert into playback_asset_handles (
             id, playback_session_id, target_digest, encrypted_target,
             expires_at, last_used_at, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `asset_h1.${"c".repeat(22)}`,
          playback.sessionId,
          "z".repeat(22),
          "x",
          now.getTime() + 60_000,
          now.getTime(),
          now.getTime(),
          now.getTime(),
        );
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\nsegment.m4s\n"),
        headers: new Headers(),
        status: 200,
      });
      const prepareSpy = vi.spyOn(database.sqlite, "prepare");

      const response = await service.readManifest({ principal: principal() }, playback.sessionId);

      expect(response.body).toContain(`asset_h1.${"d".repeat(22)}`);
      expect(
        prepareSpy.mock.calls.filter(([sql]) =>
          String(sql).includes("select id from playback_asset_handles where id in"),
        ),
      ).toHaveLength(2);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("does not allocate handles when the session stops during manifest fetch", async () => {
    const fetchGate = deferred<void>();
    const { database, negotiate, readPlaybackTarget, reference, service } = harness();
    negotiate.mockResolvedValueOnce(hlsNegotiatedResult());
    readPlaybackTarget.mockImplementationOnce(async () => {
      await fetchGate.promise;
      return {
        body: new TextEncoder().encode("#EXTM3U\nsegment.m4s\n"),
        headers: new Headers(),
        status: 200,
      };
    });
    try {
      const playback = await service.negotiate({ principal: principal() }, reference, negotiation);
      const manifest = service.readManifest({ principal: principal() }, playback.sessionId);
      await vi.waitFor(() => expect(readPlaybackTarget).toHaveBeenCalledOnce());
      await expect(
        service.report({ principal: principal() }, playback.sessionId, {
          event: "stopped",
          positionSeconds: 901,
        }),
      ).resolves.toMatchObject({ state: "stopped" });
      fetchGate.resolve(undefined);

      await expect(manifest).rejects.toMatchObject({ reason: "not_found" });
      expect(
        database.sqlite.prepare("select count(*) as count from playback_asset_handles").get(),
      ).toEqual({ count: 0 });
    } finally {
      fetchGate.resolve(undefined);
      database.close();
    }
  });
});
