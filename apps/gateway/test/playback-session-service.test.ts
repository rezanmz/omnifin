import {
  JellyfinPlaybackClient,
  type JellyfinPlaybackBytesResult,
  type JellyfinPlaybackNegotiationInput,
  type JellyfinPlaybackResult,
  type JellyfinPlaybackSourceSelection,
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
import { playbackSourceReferenceId } from "../src/media/playback-source-reference.js";
import {
  PlaybackSessionService,
  type PlaybackSessionError,
  type PlaybackClientFactoryInput,
  type PlaybackSessionDependencies,
} from "../src/media/playback-session-service.js";
import { ExternalMutationJournal } from "../src/operations/external-mutation-journal.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

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

function harness(
  createClientOverride?: NonNullable<PlaybackSessionDependencies["createClient"]>,
  referenceKind: "extra" | "movie" = "movie",
  dependencyOverrides: Pick<PlaybackSessionDependencies, "beforeProgressCompletion" | "clock"> = {},
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
  const readPlaybackTarget = vi.fn(async () => {
    throw new Error("Playback bytes were not expected in this service test.");
  });
  const readSubtitleStream = vi.fn(async (): Promise<JellyfinPlaybackBytesResult> => {
    throw new Error("Subtitle bytes were not expected in this service test.");
  });
  const streamPlaybackTarget = vi.fn(async () => {
    throw new Error("Playback streams were not expected in this service test.");
  });
  const reportPlaybackEvent = vi.fn<JellyfinPlaybackClient["reportPlaybackEvent"]>(
    async () => undefined,
  );
  const resolvePlaybackTarget = vi.fn((parent) => parent);
  const mockedCreateClient = vi.fn((_input: PlaybackClientFactoryInput) => ({
    negotiate,
    readPlaybackTarget,
    readSubtitleStream,
    reportPlaybackEvent,
    resolvePlaybackTarget,
    streamPlaybackTarget,
  }));
  const createClient = createClientOverride ?? mockedCreateClient;
  const service = new PlaybackSessionService(database, config, {
    ...dependencyOverrides,
    clock: dependencyOverrides.clock ?? (() => now),
    createClient,
    createToken: () => "p".repeat(22),
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
  };
}

const negotiation = {
  audioStreamIndex: 1,
  maxStreamingBitrate: 20_000_000,
  mode: "auto" as const,
  positionSeconds: 900,
  subtitleStreamIndex: null,
};

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
});
