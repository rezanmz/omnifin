import type { JellyfinPlaybackResult } from "@omnifin/connectors/media/jellyfin-playback-client";
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
      path: `Videos/${privateItemId}/master.m3u8`,
      query: "MediaSourceId=private-media-source",
    },
  };
}

async function harness(options: { playbackIssueTokens?: readonly string[] } = {}) {
  const config = testConfig();
  const negotiate = vi.fn(async () => playbackResult());
  const readPlaybackTarget = vi.fn();
  const reportPlaybackEvent = vi.fn(async () => undefined);
  const streamPlaybackTarget = vi.fn();
  const resolvePlaybackTarget = vi.fn(
    (parent: { path: string; query: string }, candidate: string) => {
      const url = new URL(candidate, `https://jellyfin.example.test/base/${parent.path}`);
      url.searchParams.delete("api_key");
      return { path: url.pathname.slice("/base/".length), query: url.searchParams.toString() };
    },
  );
  let issueTokenIndex = 0;
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
      createClient: () => ({
        negotiate,
        readPlaybackTarget,
        reportPlaybackEvent,
        resolvePlaybackTarget,
        streamPlaybackTarget,
      }),
      createToken: () => "p".repeat(22),
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
    headers,
    negotiate,
    readPlaybackTarget,
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
      expect(manifest.body).toMatch(
        new RegExp(`/v1/playback/${playback.sessionId}/hls/asset_v2\\.`),
      );
      expect(manifest.body).not.toMatch(/private|route-private|media-source|upstream/u);
      expect(resolvePlaybackTarget).toHaveBeenCalledTimes(2);

      const assetPath = manifest.body
        .split("\n")
        .find((line) => line.startsWith(`/v1/playback/${playback.sessionId}/hls/`));
      expect(assetPath).toBeDefined();
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
        url: assetPath!,
      });
      expect(asset.statusCode, asset.body).toBe(200);
      expect(asset.rawPayload).toEqual(Buffer.from(bytes));
      expect(asset.headers["content-type"]).toMatch(/^video\/mp4/u);
      expect(streamPlaybackTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          maxResponseBytes: 512 * 1_024 * 1_024,
          target: {
            path: `Videos/${privateItemId}/hls1/main/0.m4s`,
            query: "segment=0",
          },
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("rewrites nested HLS manifests and rejects tampered asset tokens before upstream access", async () => {
    const { app, headers, readPlaybackTarget, referenceId } = await harness();
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
      const nestedPath = master.body
        .split("\n")
        .find((line) => line.startsWith(`/v1/playback/${playback.sessionId}/hls/`));
      expect(nestedPath).toBeDefined();

      const nested = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: nestedPath!,
      });
      expect(nested.statusCode, nested.body).toBe(200);
      expect(nested.headers["content-type"]).toMatch(/^application\/vnd\.apple\.mpegurl/u);
      expect(nested.body).toMatch(new RegExp(`/v1/playback/${playback.sessionId}/hls/asset_v2\\.`));
      expect(nested.body).not.toMatch(/private|variant\.m3u8|0\.ts/u);

      const token = nestedPath!.split("/").at(-1)!;
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

  it("bounds direct-play range requests and preserves safe range metadata", async () => {
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
  });

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
});
