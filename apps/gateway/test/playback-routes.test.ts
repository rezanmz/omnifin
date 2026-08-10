import type {
  JellyfinPlaybackBytesResult,
  JellyfinPlaybackResult,
} from "@omnifin/connectors/media/jellyfin-playback-client";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { playbackIssueSchema } from "@omnifin/contracts/issues";
import {
  playbackNegotiationResponseSchema,
  playbackProgressResponseSchema,
} from "@omnifin/contracts/playback";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import {
  connectorConfigs,
  externalIssueReferences,
  serviceIdentityLinks,
  users,
} from "../src/db/schema.js";
import {
  MAX_PLAYBACK_ASSET_TOKEN_LENGTH,
  MAX_PLAYBACK_MANIFEST_BYTES,
  MAX_PLAYBACK_MANIFEST_REFERENCES,
} from "../src/media/playback-limits.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T06:30:00.000Z");
const privateItemId = "route-private-playback-item";
const privateToken = "route-private-playback-token";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 114),
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

function playbackResult(): JellyfinPlaybackResult {
  return {
    audioTracks: [
      {
        channels: 2,
        codec: "aac",
        default: true,
        index: 1,
        language: "eng",
        selected: true,
        title: "English",
      },
    ],
    delivery: "hls",
    itemId: privateItemId,
    liveStreamId: null,
    media: {
      audioCodec: "aac",
      bitrate: 8_000_000,
      container: "mp4",
      durationSeconds: 7_200,
      height: 1080,
      videoCodec: "h264",
      width: 1920,
    },
    mediaSourceId: "private-media-source",
    playMethod: "Transcode",
    playSessionId: "private-upstream-play-session",
    positionSeconds: 1_200,
    subtitleTracks: [],
    upstreamTarget: {
      path: `videos/${privateItemId}/master.m3u8`,
      query: "MediaSourceId=private-media-source",
    },
  };
}

async function harness(
  options: {
    playbackIssueTokens?: readonly string[];
    playbackSessionTokens?: readonly string[];
  } = {},
) {
  const config = testConfig();
  const negotiate = vi.fn(async () => playbackResult());
  const readPlaybackTarget = vi.fn();
  const readSubtitleStream = vi.fn(async (): Promise<JellyfinPlaybackBytesResult> => {
    throw new Error("Subtitle bytes were not requested by this route test.");
  });
  const reportPlaybackEvent = vi.fn(async () => undefined);
  const streamPlaybackTarget = vi.fn();
  const resolvePlaybackTarget = vi.fn(
    (parent: { path: string; query: string }, candidate: string) => {
      const url = new URL(candidate, `https://jellyfin.example.test/base/${parent.path}`);
      url.searchParams.delete("api_key");
      return { path: url.pathname.slice("/base/".length), query: url.searchParams.toString() };
    },
  );
  const createPlaybackClient = vi.fn((_input: { maxResponseBytes?: number }) => ({
    negotiate,
    readPlaybackTarget,
    readSubtitleStream,
    reportPlaybackEvent,
    resolvePlaybackTarget,
    streamPlaybackTarget,
  }));
  let issueTokenIndex = 0;
  let playbackAssetToken = 0;
  let playbackSessionToken = 0;
  const app = await createApp({
    config,
    continueWatchingDependencies: {
      clock: () => now,
      createClient: () => ({
        readContinueWatching: async () => ({
          items: [
            {
              artwork: { accentColor: null, backdrop: null, blurHash: null, poster: null },
              contentRating: "PG-13",
              episodeNumber: null,
              externalId: privateItemId,
              kind: "movie" as const,
              lastPlayedAt: "2026-07-28T06:15:00.000Z",
              overview: null,
              positionSeconds: 1_200,
              runtimeSeconds: 7_200,
              seasonNumber: null,
              subtitle: null,
              title: "The Far Meridian",
              year: 2026,
            },
          ],
          truncated: false,
        }),
        readImage: async () => ({
          body: new Uint8Array([0xff, 0xd8]),
          contentType: "image/jpeg" as const,
        }),
      }),
      mediaReferences: { clock: () => now, createToken: () => "r".repeat(22) },
    },
    playbackDependencies: {
      clock: () => now,
      createAssetToken: () => {
        const token = Buffer.alloc(16);
        token.writeUInt32BE(++playbackAssetToken, 12);
        return token.toString("base64url");
      },
      createClient: createPlaybackClient,
      createToken: () => options.playbackSessionTokens?.[playbackSessionToken++] ?? "p".repeat(22),
    },
    playbackIssueDependencies: {
      clock: () => now,
      createAuditId: () => "playback-issue-audit-event",
      createToken: () => options.playbackIssueTokens?.[issueTokenIndex++] ?? "i".repeat(22),
    },
    sessionDependencies: {
      clock: () => now,
      createId: () => "playback-route-session",
      createToken: (() => {
        let token = 0;
        return () => Buffer.alloc(32, ++token).toString("base64url");
      })(),
    },
  });
  app.database.db
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
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Viewer",
      id: "viewer-user",
      role: "viewer",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-main",
      createdAt: now,
      deviceId: "viewer-device",
      encryptedAccessToken: new EnvelopeCipher(config.encryptionKey).encrypt(
        privateToken,
        "service_identity_access_token:jellyfin:viewer-link",
      ),
      externalDisplayName: "Viewer",
      externalServerId: "server-1",
      externalUserId: "viewer-external",
      externalUsername: "viewer",
      healthState: "linked",
      id: "viewer-link",
      lastVerifiedAt: now,
      revision: 2,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "viewer-user",
    })
    .run();
  const viewer = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  const cookie = `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`;
  const feed = await app.inject({
    headers: { cookie },
    method: "GET",
    url: "/v1/media/continue-watching",
  });
  expect(feed.statusCode, feed.body).toBe(200);
  const referenceId = feed.json().items[0].media.id as string;
  const headers = {
    [SESSION_CSRF_HEADER]: viewer.csrfToken,
    cookie,
    origin: "https://omnifin.example",
  };
  return {
    app,
    createPlaybackClient,
    headers,
    negotiate,
    readPlaybackTarget,
    readSubtitleStream,
    referenceId,
    reportPlaybackEvent,
    resolvePlaybackTarget,
    streamPlaybackTarget,
  };
}

const negotiation = {
  audioStreamIndex: 1,
  maxStreamingBitrate: 8_000_000,
  mode: "auto",
  positionSeconds: 1_200,
  subtitleStreamIndex: null,
};

function publicPlaybackPath(parentPath: string, reference: string) {
  return new URL(reference, `https://omnifin.example${parentPath}`).pathname;
}

function gatewayPlaybackPath(publicPath: string) {
  if (!publicPath.startsWith("/api/playback/")) throw new Error("Unsafe public playback path.");
  return publicPath.replace(/^\/api\//u, "/v1/");
}

function realisticJellyfinTranscodeQuery() {
  return new URLSearchParams({
    AudioBitrate: "384000",
    AudioCodec: "aac",
    AudioStreamIndex: "1",
    BreakOnNonKeyFrames: "False",
    CopyTimestamps: "true",
    DeviceId: "omnifin-route-fixture-device",
    EnableAudioVbrEncoding: "true",
    EnableAutoStreamCopy: "true",
    MaxAudioChannels: "8",
    MaxFramerate: "60",
    MaxHeight: "2160",
    MaxWidth: "3840",
    MediaSourceId: "route-private-playback-media-source",
    MinSegments: "2",
    PlaySessionId: "route-private-upstream-play-session",
    RequireAvc: "false",
    SegmentContainer: "mp4",
    StartTimeTicks: "12000000000",
    SubtitleStreamIndex: "2",
    TranscodingMaxAudioChannels: "2",
    VideoBitrate: "120000000",
    VideoCodec: "h264,hevc,av1",
    VideoStreamIndex: "0",
    "h264-level": "51",
    "h264-profile": "high,main,baseline,constrainedbaseline",
  }).toString();
}

function encryptedAssetTokenWithLength(length: number) {
  const prefix = "asset_v2.";
  const suffix = ".a.a";
  return `${prefix}${"a".repeat(length - prefix.length - suffix.length)}${suffix}`;
}

describe("playback routes", () => {
  it("records an encrypted, audited issue without exposing private media details", async () => {
    const { app, headers, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const description = "Dialogue drifts after the scene transition.";
      const response = await app.inject({
        headers,
        method: "POST",
        payload: { category: "sync", description, positionSeconds: 1_247 },
        url: `/v1/playback/${playback.sessionId}/issues`,
      });

      expect(response.statusCode, response.body).toBe(201);
      const issue = playbackIssueSchema.parse(response.json());
      expect(issue).toEqual({
        category: "sync",
        createdAt: now.toISOString(),
        id: `issue_${"i".repeat(22)}`,
        positionSeconds: 1_247,
        status: "open",
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(description);
      expect(response.body).not.toMatch(/private-|route-private/u);

      const stored = app.database.sqlite
        .prepare(
          `select encrypted_description as encryptedDescription,
                  media_reference_id as mediaReferenceId,
                  playback_session_id as playbackSessionId
           from media_issues where id = ?`,
        )
        .get(issue.id) as {
        encryptedDescription: string;
        mediaReferenceId: string;
        playbackSessionId: string;
      };
      expect(stored).toMatchObject({
        mediaReferenceId: referenceId,
        playbackSessionId: playback.sessionId,
      });
      expect(stored.encryptedDescription).not.toContain(description);
      expect(
        new EnvelopeCipher(testConfig().encryptionKey).decrypt(
          stored.encryptedDescription,
          `media_issue_description:${issue.id}`,
        ),
      ).toBe(description);

      const audit = app.database.sqlite
        .prepare(
          `select event_type as eventType, metadata_json as metadataJson,
                  target_id as targetId, target_type as targetType
           from audit_events where id = 'playback-issue-audit-event'`,
        )
        .get();
      expect(audit).toEqual({
        eventType: "media.issue.created",
        metadataJson: JSON.stringify({
          category: "sync",
          mediaReferenceId: referenceId,
          positionSeconds: 1_247,
        }),
        targetId: issue.id,
        targetType: "media_issue",
      });
    } finally {
      await app.close();
    }
  });

  it("keeps local and external issue references in one collision-free opaque namespace", async () => {
    const firstToken = "i".repeat(22);
    const secondToken = "j".repeat(22);
    const { app, headers, referenceId } = await harness({
      playbackIssueTokens: [firstToken, secondToken],
    });
    app.database.db
      .insert(externalIssueReferences)
      .values({
        connectorId: "jellyfin-main",
        createdAt: now,
        encryptedUpstreamId: "v2.external-issue-fixture",
        expiresAt: new Date(now.getTime() + 60_000),
        id: `issue_${firstToken}`,
        lastUsedAt: now,
        upstreamIdDigest: "d".repeat(22),
        updatedAt: now,
      })
      .run();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const response = await app.inject({
        headers,
        method: "POST",
        payload: { category: "other", description: null, positionSeconds: 1_200 },
        url: `/v1/playback/${playback.sessionId}/issues`,
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(playbackIssueSchema.parse(response.json()).id).toBe(`issue_${secondToken}`);
    } finally {
      await app.close();
    }
  });

  it("fails closed for missing CSRF, expired sessions, and unsafe issue descriptions", async () => {
    const { app, headers, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const issueUrl = `/v1/playback/${playback.sessionId}/issues`;
      const withoutCsrf = Object.fromEntries(
        Object.entries(headers).filter(([name]) => name !== SESSION_CSRF_HEADER),
      );
      const denied = await app.inject({
        headers: withoutCsrf,
        method: "POST",
        payload: { category: "audio", description: null, positionSeconds: 1_200 },
        url: issueUrl,
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("csrf_denied");

      const invalid = await app.inject({
        headers,
        method: "POST",
        payload: { category: "other", description: "unsafe\u0000detail", positionSeconds: 1_200 },
        url: issueUrl,
      });
      expect(invalid.statusCode).toBe(400);

      app.database.sqlite
        .prepare("update playback_sessions set created_at = ?, expires_at = ? where id = ?")
        .run(now.getTime() - 1, now.getTime(), playback.sessionId);
      const expired = await app.inject({
        headers,
        method: "POST",
        payload: { category: "buffering", description: null, positionSeconds: 1_200 },
        url: issueUrl,
      });
      expect(expired.statusCode).toBe(404);
      expect(apiErrorSchema.parse(expired.json()).error.code).toBe("playback_session_not_found");
      expect(
        app.database.sqlite.prepare("select count(*) as count from media_issues").get(),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("creates a private playback session and accepts progress with CSRF-bound auth", async () => {
    const { app, headers, negotiate, referenceId, reportPlaybackEvent } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      expect(playback).toMatchObject({
        mediaReferenceId: referenceId,
        sessionId: `playback_${"p".repeat(22)}`,
        streamPath: `/v1/playback/playback_${"p".repeat(22)}/master.m3u8`,
      });
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.body).not.toMatch(/private-/u);
      expect(negotiate).toHaveBeenCalledOnce();

      const progress = await app.inject({
        headers,
        method: "POST",
        payload: { event: "started", positionSeconds: 1_205 },
        url: `/v1/playback/${playback.sessionId}/progress`,
      });
      expect(progress.statusCode, progress.body).toBe(200);
      expect(playbackProgressResponseSchema.parse(progress.json())).toMatchObject({
        positionSeconds: 1_205,
        sessionId: playback.sessionId,
        state: "playing",
      });
      expect(reportPlaybackEvent).toHaveBeenCalledOnce();
      expect(progress.body).not.toMatch(/private-/u);
    } finally {
      await app.close();
    }
  });

  it("rejects missing CSRF and unknown references before playback negotiation", async () => {
    const { app, headers, negotiate } = await harness();
    try {
      const withoutCsrf = Object.fromEntries(
        Object.entries(headers).filter(([name]) => name !== SESSION_CSRF_HEADER),
      );
      const denied = await app.inject({
        headers: withoutCsrf,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/media_${"r".repeat(22)}/playback`,
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("csrf_denied");

      const missing = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/media_${"z".repeat(22)}/playback`,
      });
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error.code).toBe("playback_session_not_found");
      expect(negotiate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rewrites HLS manifests into opaque same-origin assets and proxies their bytes", async () => {
    const {
      app,
      headers,
      readPlaybackTarget,
      referenceId,
      resolvePlaybackTarget,
      streamPlaybackTarget,
    } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          '#EXTM3U\n#EXT-X-MAP:URI="hls1/main/init.mp4?api_key=private&part=init"\nhls1/main/0.m4s?api_key=private&segment=0\n',
        ),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });

      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      expect(manifest.statusCode, manifest.body).toBe(200);
      expect(manifest.headers["content-type"]).toMatch(/^application\/vnd\.apple\.mpegurl/u);
      expect(manifest.headers["cache-control"]).toBe("private, no-store");
      expect(manifest.body).toMatch(/(?:URI=")?hls\/asset_h1\.[A-Za-z0-9_-]{22}/u);
      expect(manifest.body).not.toContain("/v1/");
      expect(manifest.body).not.toContain("/api/");
      expect(manifest.body).not.toMatch(/private|route-private|media-source|upstream/u);
      expect(resolvePlaybackTarget).toHaveBeenCalledTimes(2);

      const assetReference = manifest.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(assetReference).toBeDefined();
      const assetPublicPath = publicPlaybackPath(
        `/api/playback/${playback.sessionId}/master.m3u8`,
        assetReference!,
      );
      expect(assetPublicPath).toMatch(
        new RegExp(`^/api/playback/${playback.sessionId}/hls/asset_h1\\.[A-Za-z0-9_-]{22}$`),
      );
      expect(
        publicPlaybackPath(`/v1/playback/${playback.sessionId}/master.m3u8`, assetReference!),
      ).toMatch(
        new RegExp(`^/v1/playback/${playback.sessionId}/hls/asset_h1\\.[A-Za-z0-9_-]{22}$`),
      );
      const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
      streamPlaybackTarget.mockResolvedValueOnce({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        headers: new Headers({ "content-type": "video/mp4" }),
        status: 200,
      });
      const asset = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: gatewayPlaybackPath(assetPublicPath),
      });
      expect(asset.statusCode, asset.body).toBe(200);
      expect(asset.rawPayload).toEqual(Buffer.from(bytes));
      expect(asset.headers["content-type"]).toMatch(/^video\/mp4/u);
      expect(streamPlaybackTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          maxResponseBytes: 512 * 1_024 * 1_024,
          target: {
            path: `videos/${privateItemId}/hls1/main/0.m4s`,
            query: "segment=0",
          },
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("keeps realistic Jellyfin transcode targets behind short encrypted handles", async () => {
    const { app, headers, readPlaybackTarget, referenceId, streamPlaybackTarget } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const query = realisticJellyfinTranscodeQuery();
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode(`#EXTM3U\n#EXTINF:4.000,\nhls1/main/0.m4s?${query}\n`),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });

      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      expect(manifest.statusCode, manifest.body).toBe(200);
      const assetReference = manifest.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(assetReference).toBeDefined();
      const assetToken = assetReference!.split("/").at(-1)!;
      expect(assetToken).toMatch(/^asset_h1\.[A-Za-z0-9_-]{22}$/u);
      expect(assetToken).toHaveLength(31);
      const storedHandle = app.database.sqlite
        .prepare(
          `select encrypted_target as encryptedTarget, target_digest as targetDigest
           from playback_asset_handles where id = ?`,
        )
        .get(assetToken) as { encryptedTarget: string; targetDigest: string };
      expect(storedHandle.targetDigest).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      expect(storedHandle.encryptedTarget).not.toMatch(/private|MediaSourceId|VideoBitrate/u);

      const bytes = new Uint8Array([0, 0, 0, 24, 109, 111, 111, 102]);
      streamPlaybackTarget.mockResolvedValueOnce({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        headers: new Headers({ "content-type": "video/mp4" }),
        status: 200,
      });
      const asset = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playback.sessionId}/${assetReference}`,
      });

      expect(asset.statusCode, asset.body).toBe(200);
      expect(asset.rawPayload).toEqual(Buffer.from(bytes));
      expect(streamPlaybackTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: {
            path: `videos/${privateItemId}/hls1/main/0.m4s`,
            query,
          },
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("reuses a session-bound handle for repeated manifest reads", async () => {
    const { app, headers, readPlaybackTarget, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const upstreamManifest = {
        body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\nhls1/main/0.m4s\n"),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      } as const;
      readPlaybackTarget
        .mockResolvedValueOnce(upstreamManifest)
        .mockResolvedValueOnce(upstreamManifest);

      const first = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      const second = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.body).toBe(first.body);
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("rewrites a realistic nested VOD manifest above one MiB with bounded unique handles", async () => {
    const {
      app,
      createPlaybackClient,
      headers,
      readPlaybackTarget,
      referenceId,
      resolvePlaybackTarget,
    } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const segments = Array.from(
        { length: 1_624 },
        (_, index) => `#EXTINF:6.000,\n${index}.m4s?${realisticJellyfinTranscodeQuery()}`,
      );
      const nestedBody = new TextEncoder().encode(
        `#EXTM3U\n#EXT-X-MAP:URI="init.mp4?uri=alternate"\n${segments.join("\n")}\n`,
      );
      expect(nestedBody.byteLength).toBeGreaterThan(1 * 1_024 * 1_024);
      expect(nestedBody.byteLength).toBeLessThanOrEqual(MAX_PLAYBACK_MANIFEST_BYTES);
      readPlaybackTarget
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nhls1/main/index.m3u8?${realisticJellyfinTranscodeQuery()}\n`,
          ),
          headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
          status: 200,
        })
        .mockResolvedValueOnce({
          body: nestedBody,
          headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
          status: 200,
        });

      const master = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      const nestedReference = master.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(master.statusCode, master.body).toBe(200);
      expect(nestedReference).toBeDefined();
      const nested = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: gatewayPlaybackPath(
          publicPlaybackPath(`/api/playback/${playback.sessionId}/master.m3u8`, nestedReference!),
        ),
      });

      expect(nested.statusCode, nested.body).toBe(200);
      const handles = nested.body
        .split("\n")
        .filter((line) => line.startsWith("./"))
        .map((line) => line.slice("./".length));
      expect(handles).toHaveLength(1_624);
      expect(new Set(handles).size).toBe(1_624);
      expect(handles.every((handle) => /^asset_h1\.[A-Za-z0-9_-]{22}$/u.test(handle))).toBe(true);
      expect(nested.body).toMatch(/#EXT-X-MAP:URI="\.\/asset_h1\.[A-Za-z0-9_-]{22}"/u);
      expect(nested.body).not.toMatch(/DeviceId|MediaSourceId|PlaySessionId|route-private/u);
      expect(resolvePlaybackTarget).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ path: expect.stringMatching(/hls1\/main\/index\.m3u8$/u) }),
        expect.stringMatching(/^0\.m4s\?/u),
      );
      expect(
        createPlaybackClient.mock.calls.flatMap(([input]) =>
          input.maxResponseBytes === undefined ? [] : [input.maxResponseBytes],
        ),
      ).toEqual([MAX_PLAYBACK_MANIFEST_BYTES, MAX_PLAYBACK_MANIFEST_BYTES]);
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 1_626 });
    } finally {
      await app.close();
    }
  });

  it("rejects manifests above the playback byte ceiling without allocating handles", async () => {
    const { app, headers, readPlaybackTarget, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const oversized = new Uint8Array(MAX_PLAYBACK_MANIFEST_BYTES + 1);
      oversized.set(new TextEncoder().encode("#EXTM3U\n"));
      readPlaybackTarget.mockResolvedValueOnce({
        body: oversized,
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });

      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });

      expect(manifest.statusCode).toBe(503);
      expect(apiErrorSchema.parse(manifest.json()).error.code).toBe("playback_unavailable");
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("rejects excessive repeated manifest references before allocating handles", async () => {
    const { app, headers, readPlaybackTarget, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const references = Array.from(
        { length: MAX_PLAYBACK_MANIFEST_REFERENCES + 1 },
        () => 'URI="0.ts"',
      ).join(",");
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode(`#EXTM3U\n#EXT-X-MEDIA:${references}\n`),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });

      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });

      expect(manifest.statusCode).toBe(503);
      expect(apiErrorSchema.parse(manifest.json()).error.code).toBe("playback_unavailable");
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("rejects mixed malformed URI declarations before allocating handles", async () => {
    const { app, headers, readPlaybackTarget, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          '#EXTM3U\n#EXT-X-MAP:URI="hls1/main/init.mp4",URI=private?ApiKey=secret\n',
        ),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });

      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });

      expect(manifest.statusCode).toBe(503);
      expect(apiErrorSchema.parse(manifest.json()).error.code).toBe("playback_unavailable");
      expect(manifest.body).not.toMatch(/ApiKey|private|secret/u);
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("rejects a valid HLS handle when it is replayed against another session", async () => {
    const { app, headers, readPlaybackTarget, referenceId, streamPlaybackTarget } = await harness({
      playbackSessionTokens: ["p".repeat(22), "q".repeat(22)],
    });
    try {
      const firstCreated = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const firstPlayback = playbackNegotiationResponseSchema.parse(firstCreated.json());
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\nhls1/main/0.m4s\n"),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });
      const firstManifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: firstPlayback.streamPath,
      });
      const firstAssetReference = firstManifest.body
        .split("\n")
        .find((line) => line.startsWith("hls/"));
      expect(firstAssetReference).toBeDefined();

      const secondCreated = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const secondPlayback = playbackNegotiationResponseSchema.parse(secondCreated.json());
      expect(secondPlayback.sessionId).not.toBe(firstPlayback.sessionId);

      const replayed = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${secondPlayback.sessionId}/${firstAssetReference}`,
      });

      expect(replayed.statusCode).toBe(404);
      expect(apiErrorSchema.parse(replayed.json()).error.code).toBe("playback_session_not_found");
      expect(streamPlaybackTarget).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serves concurrent segment retries through one persisted handle", async () => {
    const { app, headers, readPlaybackTarget, referenceId, streamPlaybackTarget } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\nhls1/main/0.m4s\n"),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });
      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      const assetReference = manifest.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(assetReference).toBeDefined();
      const bytes = new Uint8Array([0, 0, 0, 24, 109, 111, 111, 102]);
      streamPlaybackTarget.mockImplementation(async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        headers: new Headers({ "content-type": "video/mp4" }),
        status: 200,
      }));

      const responses = await Promise.all(
        Array.from({ length: 24 }, () =>
          app.inject({
            headers: { cookie: headers.cookie },
            method: "GET",
            url: `/v1/playback/${playback.sessionId}/${assetReference}`,
          }),
        ),
      );

      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(responses.every((response) => response.rawPayload.equals(Buffer.from(bytes)))).toBe(
        true,
      );
      expect(streamPlaybackTarget).toHaveBeenCalledTimes(24);
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("revokes persisted HLS handles as soon as playback stops", async () => {
    const { app, headers, readPlaybackTarget, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\nhls1/main/0.m4s\n"),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });
      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      const assetReference = manifest.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(assetReference).toBeDefined();

      const stopped = await app.inject({
        headers,
        method: "POST",
        payload: { event: "stopped", positionSeconds: 1_210 },
        url: `/v1/playback/${playback.sessionId}/progress`,
      });
      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 0 });

      const revoked = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playback.sessionId}/${assetReference}`,
      });
      expect(revoked.statusCode).toBe(404);
      expect(apiErrorSchema.parse(revoked.json()).error.code).toBe("playback_session_not_found");
    } finally {
      await app.close();
    }
  });

  it("isolates concurrent A/B playback recovery and revokes only stopped-session assets (#346)", async () => {
    const {
      app,
      headers,
      negotiate,
      readPlaybackTarget,
      referenceId,
      reportPlaybackEvent,
      streamPlaybackTarget,
    } = await harness({ playbackSessionTokens: ["a".repeat(22), "b".repeat(22)] });
    const playbackAResult = {
      ...playbackResult(),
      mediaSourceId: "media-source-a",
      playSessionId: "upstream-play-session-a",
      upstreamTarget: {
        path: `videos/${privateItemId}/a/master.m3u8`,
        query: "manifest=A",
      },
    } satisfies JellyfinPlaybackResult;
    const playbackBResult = {
      ...playbackResult(),
      mediaSourceId: "media-source-b",
      playSessionId: "upstream-play-session-b",
      upstreamTarget: {
        path: `videos/${privateItemId}/b/master.m3u8`,
        query: "manifest=B",
      },
    } satisfies JellyfinPlaybackResult;
    const segmentBytes = new Uint8Array([0, 0, 0, 24, 109, 111, 111, 102]);
    const segmentResponse = () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(segmentBytes);
          controller.close();
        },
      }),
      headers: new Headers({ "content-type": "video/mp4" }),
      status: 200 as const,
    });
    try {
      negotiate.mockResolvedValueOnce(playbackAResult).mockResolvedValueOnce(playbackBResult);
      const createdA = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playbackA = playbackNegotiationResponseSchema.parse(createdA.json());
      const manifestBodyA = "#EXTM3U\n#EXTINF:4.000,\n0.m4s?segment=A\n";
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode(manifestBodyA),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });
      const manifestA = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playbackA.streamPath,
      });
      expect(manifestA.statusCode, manifestA.body).toBe(200);
      const assetA = manifestA.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(assetA).toBeDefined();

      streamPlaybackTarget.mockResolvedValueOnce(segmentResponse());
      const segmentA = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playbackA.sessionId}/${assetA}`,
      });
      expect(segmentA.statusCode, segmentA.body).toBe(200);
      expect(segmentA.rawPayload).toEqual(Buffer.from(segmentBytes));

      readPlaybackTarget.mockRejectedValueOnce(new Error("A manifest upstream failure"));
      const failedManifestA = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playbackA.streamPath,
      });
      expect(failedManifestA.statusCode).toBe(503);
      expect(apiErrorSchema.parse(failedManifestA.json()).error.code).toBe("playback_unavailable");

      streamPlaybackTarget.mockRejectedValueOnce(new Error("A segment upstream failure"));
      const failedSegmentA = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playbackA.sessionId}/${assetA}`,
      });
      expect(failedSegmentA.statusCode).toBe(503);
      expect(apiErrorSchema.parse(failedSegmentA.json()).error.code).toBe("playback_unavailable");

      const createdB = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playbackB = playbackNegotiationResponseSchema.parse(createdB.json());
      expect(playbackB.sessionId).not.toBe(playbackA.sessionId);
      expect(playbackA.sessionId).toBe(`playback_${"a".repeat(22)}`);
      expect(playbackB.sessionId).toBe(`playback_${"b".repeat(22)}`);

      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\n0.m4s?segment=B\n"),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });
      const manifestB = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playbackB.streamPath,
      });
      expect(manifestB.statusCode, manifestB.body).toBe(200);
      const assetB = manifestB.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(assetB).toBeDefined();
      expect(assetB).not.toBe(assetA);

      streamPlaybackTarget.mockResolvedValueOnce(segmentResponse());
      const segmentB = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playbackB.sessionId}/${assetB}`,
      });
      expect(segmentB.statusCode, segmentB.body).toBe(200);
      expect(segmentB.rawPayload).toEqual(Buffer.from(segmentBytes));

      const encryptedPayloads = app.database.sqlite
        .prepare(
          "select id, encrypted_payload as encryptedPayload from playback_sessions where id in (?, ?)",
        )
        .all(playbackA.sessionId, playbackB.sessionId) as Array<{
        encryptedPayload: string;
        id: string;
      }>;
      const payloads = new Map(
        encryptedPayloads.map(({ encryptedPayload, id }) => [
          id,
          JSON.parse(
            new EnvelopeCipher(testConfig().encryptionKey).decrypt(
              encryptedPayload,
              `playback_session:jellyfin:${id}`,
            ),
          ),
        ]),
      );
      expect(payloads.get(playbackA.sessionId)).toMatchObject({
        mediaSourceId: "media-source-a",
        playSessionId: "upstream-play-session-a",
        upstreamTarget: playbackAResult.upstreamTarget,
      });
      expect(payloads.get(playbackB.sessionId)).toMatchObject({
        mediaSourceId: "media-source-b",
        playSessionId: "upstream-play-session-b",
        upstreamTarget: playbackBResult.upstreamTarget,
      });
      expect(readPlaybackTarget).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ target: playbackAResult.upstreamTarget }),
      );
      expect(readPlaybackTarget).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ target: playbackBResult.upstreamTarget }),
      );
      expect(streamPlaybackTarget).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          target: { path: `videos/${privateItemId}/a/0.m4s`, query: "segment=A" },
        }),
      );
      expect(streamPlaybackTarget).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          target: { path: `videos/${privateItemId}/b/0.m4s`, query: "segment=B" },
        }),
      );

      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playbackA.sessionId),
      ).toEqual({ count: 1 });
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playbackB.sessionId),
      ).toEqual({ count: 1 });

      const stoppedA = await app.inject({
        headers,
        method: "POST",
        payload: { event: "stopped", positionSeconds: 1_210 },
        url: `/v1/playback/${playbackA.sessionId}/progress`,
      });
      expect(stoppedA.statusCode, stoppedA.body).toBe(200);
      expect((reportPlaybackEvent.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
        event: "stopped",
        session: {
          mediaSourceId: "media-source-a",
          playSessionId: "upstream-play-session-a",
        },
      });
      expect(
        app.database.sqlite
          .prepare("select state from playback_sessions where id = ?")
          .get(playbackA.sessionId),
      ).toEqual({ state: "stopped" });
      expect(
        app.database.sqlite
          .prepare("select state from playback_sessions where id = ?")
          .get(playbackB.sessionId),
      ).toEqual({ state: "negotiated" });
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playbackA.sessionId),
      ).toEqual({ count: 0 });
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playbackB.sessionId),
      ).toEqual({ count: 1 });

      const revokedA = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playbackA.sessionId}/${assetA}`,
      });
      expect(revokedA.statusCode).toBe(404);
      expect(apiErrorSchema.parse(revokedA.json()).error.code).toBe("playback_session_not_found");

      streamPlaybackTarget.mockResolvedValueOnce(segmentResponse());
      const stillUsableB = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playbackB.sessionId}/${assetB}`,
      });
      expect(stillUsableB.statusCode, stillUsableB.body).toBe(200);
      expect(stillUsableB.rawPayload).toEqual(Buffer.from(segmentBytes));
      expect(streamPlaybackTarget).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          target: { path: `videos/${privateItemId}/b/0.m4s`, query: "segment=B" },
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("cascades HLS handle cleanup when the Jellyfin identity is unlinked", async () => {
    const { app, headers, readPlaybackTarget, referenceId } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\nhls1/main/0.m4s\n"),
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
        status: 200,
      });
      const manifest = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      expect(manifest.statusCode, manifest.body).toBe(200);
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 1 });

      app.database.sqlite.prepare("delete from service_identity_links").run();

      expect(
        app.database.sqlite
          .prepare("select count(*) as count from playback_sessions where id = ?")
          .get(playback.sessionId),
      ).toEqual({ count: 0 });
      expect(
        app.database.sqlite
          .prepare(
            "select count(*) as count from playback_asset_handles where playback_session_id = ?",
          )
          .get(playback.sessionId),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("honors legacy encrypted HLS assets until their playback session expires", async () => {
    const { app, headers, referenceId, streamPlaybackTarget } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const legacyTarget = {
        path: `videos/${privateItemId}/hls1/main/0.m4s`,
        query: "segment=0",
      };
      const legacyToken = `asset_${new EnvelopeCipher(testConfig().encryptionKey).encrypt(
        JSON.stringify({ schemaVersion: 1, target: legacyTarget }),
        `playback_asset:jellyfin:${playback.sessionId}`,
      )}`;
      const bytes = new Uint8Array([0, 0, 0, 24, 109, 111, 111, 102]);
      streamPlaybackTarget.mockResolvedValueOnce({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        headers: new Headers({ "content-type": "video/mp4" }),
        status: 200,
      });

      const asset = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playback.sessionId}/hls/${legacyToken}`,
      });

      expect(asset.statusCode, asset.body).toBe(200);
      expect(asset.rawPayload).toEqual(Buffer.from(bytes));
      expect(streamPlaybackTarget).toHaveBeenCalledWith(
        expect.objectContaining({ target: legacyTarget }),
      );
    } finally {
      await app.close();
    }
  });

  it("keeps legacy playback assets routable and bounded during rolling upgrades", async () => {
    const { app, headers } = await harness();
    const sessionId = `playback_${"p".repeat(22)}`;
    try {
      const maximum = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${sessionId}/hls/${encryptedAssetTokenWithLength(MAX_PLAYBACK_ASSET_TOKEN_LENGTH)}`,
      });
      expect(maximum.statusCode, maximum.body).toBe(404);
      expect(apiErrorSchema.parse(maximum.json()).error.code).toBe("playback_session_not_found");

      const oversized = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${sessionId}/hls/${encryptedAssetTokenWithLength(MAX_PLAYBACK_ASSET_TOKEN_LENGTH + 1)}`,
      });
      expect(oversized.statusCode).toBe(414);
    } finally {
      await app.close();
    }
  });

  it("keeps a master, nested manifest, and segment inside the public playback proxy", async () => {
    const { app, headers, readPlaybackTarget, referenceId, streamPlaybackTarget } = await harness();
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      readPlaybackTarget
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nhls1/variant.m3u8\n",
          ),
          headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
          status: 200,
        })
        .mockResolvedValueOnce({
          body: new TextEncoder().encode("#EXTM3U\n#EXTINF:4.000,\n0.ts\n"),
          headers: new Headers({ "content-type": "application/vnd.apple.mpegurl" }),
          status: 200,
        });

      const master = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: playback.streamPath,
      });
      const nestedReference = master.body.split("\n").find((line) => line.startsWith("hls/"));
      expect(nestedReference).toBeDefined();
      expect(master.body).not.toMatch(/\/(?:api|v1)\//u);
      const nestedPublicPath = publicPlaybackPath(
        `/api/playback/${playback.sessionId}/master.m3u8`,
        nestedReference!,
      );
      const nestedGatewayPath = publicPlaybackPath(
        `/v1/playback/${playback.sessionId}/master.m3u8`,
        nestedReference!,
      );
      expect(nestedGatewayPath).toMatch(
        new RegExp(`^/v1/playback/${playback.sessionId}/hls/asset_h1\\.[A-Za-z0-9_-]{22}$`),
      );

      const nested = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: gatewayPlaybackPath(nestedPublicPath),
      });
      expect(nested.statusCode, nested.body).toBe(200);
      expect(nested.headers["content-type"]).toMatch(/^application\/vnd\.apple\.mpegurl/u);
      expect(nested.body).toMatch(/^#EXTM3U\n#EXTINF:4\.000,\n\.\/asset_h1\.[A-Za-z0-9_-]{22}/u);
      expect(nested.body).not.toMatch(/\/(?:api|v1)\//u);
      expect(nested.body).not.toMatch(/private|variant\.m3u8|0\.ts/u);

      const segmentReference = nested.body.split("\n").find((line) => line.startsWith("./"));
      expect(segmentReference).toBeDefined();
      const segmentPublicPath = publicPlaybackPath(nestedPublicPath, segmentReference!);
      expect(segmentPublicPath).toMatch(
        new RegExp(`^/api/playback/${playback.sessionId}/hls/asset_h1\\.[A-Za-z0-9_-]{22}$`),
      );
      expect(publicPlaybackPath(nestedGatewayPath, segmentReference!)).toMatch(
        new RegExp(`^/v1/playback/${playback.sessionId}/hls/asset_h1\\.[A-Za-z0-9_-]{22}$`),
      );
      const bytes = new Uint8Array([0, 0, 0, 24, 109, 111, 111, 102]);
      streamPlaybackTarget.mockResolvedValueOnce({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        headers: new Headers({ "content-type": "video/mp4" }),
        status: 200,
      });
      const segment = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: gatewayPlaybackPath(segmentPublicPath),
      });
      expect(segment.statusCode, segment.body).toBe(200);
      expect(segment.rawPayload).toEqual(Buffer.from(bytes));

      const token = nestedReference!.split("/").at(-1)!;
      const tokenParts = token.split(".");
      const initializationVector = tokenParts[1]!;
      tokenParts[1] = `${initializationVector.startsWith("A") ? "B" : "A"}${initializationVector.slice(1)}`;
      const tamperedToken = tokenParts.join(".");
      const callsBeforeTamper = readPlaybackTarget.mock.calls.length;
      const tampered = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playback.sessionId}/hls/${tamperedToken}`,
      });
      expect(tampered.statusCode).toBe(404);
      expect(apiErrorSchema.parse(tampered.json()).error.code).toBe("playback_session_not_found");
      expect(readPlaybackTarget).toHaveBeenCalledTimes(callsBeforeTamper);
    } finally {
      await app.close();
    }
  });

  it.each(["DirectPlay", "DirectStream"] as const)(
    "bounds %s range requests and preserves safe range metadata",
    async (playMethod) => {
      const { app, headers, negotiate, readPlaybackTarget, referenceId } = await harness();
      negotiate.mockResolvedValueOnce({
        ...playbackResult(),
        delivery: "direct",
        playMethod,
        upstreamTarget: { path: `Videos/${privateItemId}/stream`, query: "static=true" },
      });
      try {
        const created = await app.inject({
          headers,
          method: "POST",
          payload: negotiation,
          url: `/v1/media/${referenceId}/playback`,
        });
        const playback = playbackNegotiationResponseSchema.parse(created.json());
        const bytes = new Uint8Array([1, 2, 3, 4]);
        readPlaybackTarget.mockResolvedValueOnce({
          body: bytes,
          headers: new Headers({
            "content-range": "bytes 1200-1203/72000000",
            "content-type": "video/mp4",
          }),
          status: 206,
        });

        const stream = await app.inject({
          headers: { cookie: headers.cookie, range: "bytes=1200-999999999" },
          method: "GET",
          url: playback.streamPath,
        });
        expect(stream.statusCode, stream.body).toBe(206);
        expect(stream.rawPayload).toEqual(Buffer.from(bytes));
        expect(stream.headers["accept-ranges"]).toBe("bytes");
        expect(stream.headers["content-range"]).toBe("bytes 1200-1203/72000000");
        expect(stream.headers.vary).toContain("Range");
        expect(readPlaybackTarget).toHaveBeenCalledWith(
          expect.objectContaining({ range: `bytes=1200-${1200 + 8 * 1_024 * 1_024 - 1}` }),
        );
      } finally {
        await app.close();
      }
    },
  );

  it("returns a safe 416 for malformed and unsatisfied direct-play ranges", async () => {
    const { app, headers, negotiate, readPlaybackTarget, referenceId } = await harness();
    negotiate.mockResolvedValueOnce({
      ...playbackResult(),
      delivery: "direct",
      playMethod: "DirectPlay",
      upstreamTarget: { path: `Videos/${privateItemId}/stream`, query: "static=true" },
    });
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      const malformed = await app.inject({
        headers: { cookie: headers.cookie, range: "bytes=-500" },
        method: "GET",
        url: playback.streamPath,
      });
      expect(malformed.statusCode).toBe(416);
      expect(apiErrorSchema.parse(malformed.json()).error.code).toBe("playback_range_invalid");
      expect(readPlaybackTarget).not.toHaveBeenCalled();

      readPlaybackTarget.mockResolvedValueOnce({
        body: new TextEncoder().encode("private upstream error"),
        headers: new Headers({ "content-range": "bytes */72000000" }),
        status: 416,
      });
      const unsatisfied = await app.inject({
        headers: { cookie: headers.cookie, range: "bytes=90000000-" },
        method: "GET",
        url: playback.streamPath,
      });
      expect(unsatisfied.statusCode).toBe(416);
      expect(unsatisfied.rawPayload).toHaveLength(0);
      expect(unsatisfied.body).not.toContain("private upstream error");
      expect(unsatisfied.headers["content-range"]).toBe("bytes */72000000");
    } finally {
      await app.close();
    }
  });

  it("serves masked WebVTT subtitles only for negotiated text tracks", async () => {
    const { app, headers, negotiate, readSubtitleStream, referenceId } = await harness();
    negotiate.mockResolvedValueOnce({
      ...playbackResult(),
      playMethod: "DirectPlay",
      subtitleTracks: [
        {
          codec: "webvtt",
          default: false,
          delivery: "external",
          forced: false,
          index: 5,
          language: "eng",
          selected: false,
          title: "English",
        },
      ],
      upstreamTarget: { path: `Videos/${privateItemId}/stream`, query: "static=true" },
    });
    try {
      const created = await app.inject({
        headers,
        method: "POST",
        payload: negotiation,
        url: `/v1/media/${referenceId}/playback`,
      });
      const playback = playbackNegotiationResponseSchema.parse(created.json());
      expect(playback.subtitleTracks[0]?.subtitlePath).toBe(
        `/v1/playback/${playback.sessionId}/subtitle/5`,
      );
      const vtt = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello");
      readSubtitleStream.mockResolvedValueOnce({
        body: vtt,
        headers: new Headers({ "content-type": "text/vtt" }),
        status: 200,
      });

      const subtitle = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playback.sessionId}/subtitle/5`,
      });
      expect(subtitle.statusCode).toBe(200);
      expect(subtitle.rawPayload).toEqual(Buffer.from(vtt));
      expect(subtitle.headers["content-type"]).toContain("text/vtt");
      expect(readSubtitleStream).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: privateItemId, subtitleIndex: 5 }),
      );

      const denied = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/playback/${playback.sessionId}/subtitle/999`,
      });
      expect(denied.statusCode).toBe(404);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("playback_session_not_found");
      expect(readSubtitleStream).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
