import type {
  JellyfinContinueWatchingResult,
  JellyfinLibrarySeasonEpisodesResult,
  JellyfinLibraryResult,
  JellyfinLibraryTitleResult,
  JellyfinViewingHistoryResult,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { continueWatchingResponseSchema } from "@omnifin/contracts/dashboard";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  libraryBrowseResponseSchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseSchema,
  viewingHistoryResponseSchema,
} from "@omnifin/contracts/library";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T05:30:00.000Z");
const privateToken = "route-private-jellyfin-token";
const privateItemId = "route-private-upstream-item";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 113),
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

function sessionDependencies() {
  let identifier = 0;
  let token = 0;
  return {
    clock: () => now,
    createId: () => `continue-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

async function harness() {
  const config = testConfig();
  const result: JellyfinContinueWatchingResult = {
    items: [
      {
        artwork: {
          accentColor: "#336699",
          backdrop: null,
          blurHash: "005?}k",
          poster: { itemId: privateItemId, type: "Primary" },
        },
        contentRating: "PG-13",
        episodeNumber: null,
        externalId: privateItemId,
        kind: "movie",
        lastPlayedAt: "2026-07-28T05:15:00.000Z",
        overview: "A signal crosses the horizon.",
        positionSeconds: 1_200,
        runtimeSeconds: 7_200,
        seasonNumber: null,
        subtitle: null,
        title: "The Far Meridian",
        year: 2026,
      },
    ],
    truncated: false,
  };
  const readContinueWatching = vi.fn(async () => result);
  const readLibrary = vi.fn(async (): Promise<JellyfinLibraryResult> => ({
    items: [
      {
        artwork: {
          accentColor: "#336699",
          backdrop: null,
          blurHash: "005?}k",
          poster: { itemId: privateItemId, type: "Primary" },
        },
        contentRating: "PG-13",
        externalId: privateItemId,
        kind: "movie",
        overview: "A signal crosses the horizon.",
        played: false,
        positionSeconds: 1_200,
        runtimeSeconds: 7_200,
        title: "The Far Meridian",
        year: 2026,
      },
    ],
    nextStartIndex: 1,
    truncated: true,
  }));
  const readImage = vi.fn(async () => ({
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    contentType: "image/png" as const,
  }));
  const readLibraryTitle = vi.fn(async (): Promise<JellyfinLibraryTitleResult> => ({
    item: (await readLibrary()).items[0]!,
    movie: {
      cast: [],
      castTruncated: false,
      communityRating: null,
      crew: [],
      crewTruncated: false,
      criticRating: null,
      genres: [],
      mediaSources: [],
      mediaSourcesTruncated: false,
      premiereDate: null,
      studios: [],
      tagline: null,
    },
    seasons: [],
    seasonsTruncated: false,
  }));
  const readLibrarySeasonEpisodes = vi.fn(
    async (): Promise<JellyfinLibrarySeasonEpisodesResult> => ({
      items: [],
      nextStartIndex: null,
      truncated: false,
    }),
  );
  const updatePlaybackState = vi.fn(async () => ({
    durationSeconds: 7_200,
    played: true,
    positionSeconds: 0,
  }));
  const readViewingHistory = vi.fn(async (): Promise<JellyfinViewingHistoryResult> => ({
    boundaryFound: true,
    items: [
      {
        ...result.items[0]!,
        kind: "movie",
        played: false,
      },
    ],
    nextAfterItemId: null,
  }));
  let mediaReferenceIndex = 0;
  let stateOperationIndex = 0;
  const app = await createApp({
    config,
    continueWatchingDependencies: {
      clock: () => now,
      createClient: () => ({
        readContinueWatching,
        readImage,
        readLibrary,
        readLibrarySeasonEpisodes,
        readLibraryTitle,
        readViewingHistory,
        updatePlaybackState,
      }),
      createUserMediaStateOperationToken: () => String(++stateOperationIndex).padStart(22, "o"),
      mediaReferences: {
        clock: () => now,
        createToken: () => (mediaReferenceIndex++ === 0 ? "r" : "e").repeat(22),
      },
    },
    sessionDependencies: sessionDependencies(),
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
  return {
    app,
    readContinueWatching,
    readImage,
    readLibrary,
    readLibrarySeasonEpisodes,
    readLibraryTitle,
    readViewingHistory,
    updatePlaybackState,
    viewer,
  };
}

describe("Continue Watching routes", () => {
  it("serves the authenticated viewer's normalized feed with private caching disabled", async () => {
    const { app, readContinueWatching, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/continue-watching",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(continueWatchingResponseSchema.parse(response.json())).toMatchObject({
        items: [
          {
            media: {
              artwork: { accentColor: "#336699", blurHash: "005?}k" },
              id: `media_${"r".repeat(22)}`,
            },
          },
        ],
        state: "complete",
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain(privateToken);
      expect(response.body).not.toContain(privateItemId);
      expect(readContinueWatching).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("serves private viewing history through the paired session without upstream identifiers", async () => {
    const { app, readViewingHistory, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/history?kind=movies&limit=24&range=30_days&state=in_progress",
      });
      expect(response.statusCode, response.body).toBe(200);
      const history = viewingHistoryResponseSchema.parse(response.json());
      expect(history).toMatchObject({
        items: [
          {
            activity: "in_progress",
            media: { kind: "movie", title: "The Far Meridian" },
          },
        ],
        state: "complete",
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toContain("Cookie");
      expect(response.body).not.toMatch(/route-private|viewer-external|jellyfin\.example/iu);
      expect(readViewingHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "movies",
          limit: 24,
          state: "in_progress",
          userId: "viewer-external",
        }),
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects stale history boundaries and reports a disabled paired source safely", async () => {
    const { app, readViewingHistory, viewer } = await harness();
    const initialHistory = await readViewingHistory();
    readViewingHistory.mockResolvedValueOnce({
      ...initialHistory,
      nextAfterItemId: privateItemId,
    });
    try {
      const first = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/history?kind=all&limit=24&range=all&state=all",
      });
      const cursor = viewingHistoryResponseSchema.parse(first.json()).nextCursor!;
      readViewingHistory.mockResolvedValueOnce({
        boundaryFound: false,
        items: [],
        nextAfterItemId: null,
      });
      const stale = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/history?kind=all&limit=24&range=all&state=all&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(stale.statusCode).toBe(400);
      expect(apiErrorSchema.parse(stale.json()).error.code).toBe("viewing_history_cursor_invalid");
      expect(stale.body).not.toContain(cursor);

      app.database.sqlite
        .prepare(
          "update service_identity_links set encrypted_access_token = 'invalid' where id = 'viewer-link'",
        )
        .run();
      const unavailable = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/history",
      });
      expect(unavailable.statusCode, unavailable.body).toBe(200);
      expect(viewingHistoryResponseSchema.parse(unavailable.json())).toMatchObject({
        items: [],
        source: { failure: { code: "configuration_invalid" }, status: "unavailable" },
        state: "unavailable",
      });
    } finally {
      await app.close();
    }
  });

  it("requires authentication before contacting Jellyfin", async () => {
    const { app, readContinueWatching } = await harness();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/media/continue-watching" });

      expect(response.statusCode).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("authentication_required");
      expect(readContinueWatching).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serves a private paired-user library page with an opaque continuation cursor", async () => {
    const { app, readLibrary, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&limit=1&query=Meridian&sort=title",
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = libraryBrowseResponseSchema.parse(response.json());
      expect(body).toMatchObject({
        items: [
          {
            media: { id: `media_${"r".repeat(22)}`, kind: "movie", title: "The Far Meridian" },
            playback: { played: false, positionSeconds: 1_200 },
          },
        ],
        source: { displayName: "Home Jellyfin", failure: null, status: "healthy" },
        state: "complete",
      });
      expect(body.nextCursor).toMatch(/^v2\./u);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toMatch(/route-private|viewer-external|jellyfin\.example/iu);
      expect(readLibrary).toHaveBeenCalledWith(
        {
          kind: "movies",
          limit: 1,
          query: "Meridian",
          sort: "title",
          startIndex: 0,
          userId: "viewer-external",
        },
        expect.any(AbortSignal),
      );

      const next = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library?cursor=${encodeURIComponent(body.nextCursor!)}&kind=movies&limit=1&query=Meridian&sort=title`,
      });
      expect(next.statusCode, next.body).toBe(200);
      expect(readLibrary).toHaveBeenLastCalledWith(
        expect.objectContaining({ startIndex: 1, userId: "viewer-external" }),
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("serves rich movie details and cast artwork through an opaque same-origin grant", async () => {
    const { app, readImage, readLibrary, readLibraryTitle, viewer } = await harness();
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const catalogue = libraryBrowseResponseSchema.parse(catalogueResponse.json());
      const referenceId = catalogue.items[0]!.media.id;
      const rawItem = (await readLibrary.mock.results[0]!.value).items[0]!;
      readLibraryTitle.mockResolvedValueOnce({
        item: rawItem,
        movie: {
          cast: [
            {
              image: { itemId: "route-private-person", type: "Primary" },
              imagePath: null,
              name: "Mara Voss",
              role: "Iris Vale",
              type: "cast",
            },
          ],
          castTruncated: false,
          communityRating: 8.4,
          crew: [],
          crewTruncated: false,
          criticRating: 91,
          genres: ["Drama"],
          mediaSources: [],
          mediaSourcesTruncated: false,
          premiereDate: "2026-04-18",
          studios: ["Northlight Pictures"],
          tagline: "The horizon remembers.",
        },
        seasons: [],
        seasonsTruncated: false,
      });

      const detailResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}`,
      });
      expect(detailResponse.statusCode, detailResponse.body).toBe(200);
      const detail = libraryTitleDetailResponseSchema.parse(detailResponse.json());
      const personPath = detail.movie?.cast[0]?.imagePath;
      expect(personPath).toMatch(new RegExp(`^/v1/media/${referenceId}/images/people/v2\\.`));
      expect(detailResponse.body).not.toMatch(/route-private-person|viewer-external/iu);

      const anonymousImage = await app.inject({
        method: "GET",
        url: personPath!,
      });
      expect(anonymousImage.statusCode, anonymousImage.body).toBe(401);
      expect(apiErrorSchema.parse(anonymousImage.json()).error.code).toBe(
        "authentication_required",
      );
      expect(readImage).not.toHaveBeenCalled();

      const imageResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: personPath!,
      });
      expect(imageResponse.statusCode, imageResponse.body).toBe(200);
      expect(imageResponse.headers["content-type"]).toContain("image/png");
      expect(imageResponse.headers["cache-control"]).toContain("private");
      expect(readImage).toHaveBeenLastCalledWith(
        expect.objectContaining({ itemId: "route-private-person", maxWidth: 480, type: "Primary" }),
      );

      const tampered = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `${personPath}tampered`,
      });
      expect(tampered.statusCode).toBe(404);
      expect(apiErrorSchema.parse(tampered.json()).error.code).toBe(
        "media_person_artwork_not_found",
      );
    } finally {
      await app.close();
    }
  });

  it("opens series details before serving an explicitly selected season", async () => {
    const { app, readLibrary, readLibrarySeasonEpisodes, readLibraryTitle, viewer } =
      await harness();
    const series = {
      artwork: {
        accentColor: "#557799",
        backdrop: { itemId: "route-private-series", type: "Backdrop" as const },
        blurHash: null,
        poster: { itemId: "route-private-series", type: "Primary" as const },
      },
      contentRating: "TV-14",
      externalId: "route-private-series",
      kind: "series" as const,
      overview: "A signal appears over the northern ice.",
      played: false,
      positionSeconds: 0,
      runtimeSeconds: null,
      title: "Northern Lights",
      year: 2026,
    };
    readLibrary.mockResolvedValueOnce({ items: [series], nextStartIndex: null, truncated: false });
    readLibraryTitle.mockResolvedValueOnce({
      item: series,
      movie: null,
      seasons: [{ episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 2, title: "Season 2" }],
      seasonsTruncated: false,
    });
    readLibrarySeasonEpisodes.mockResolvedValueOnce({
      items: [
        {
          airDate: "2026-03-12",
          artwork: series.artwork,
          communityRating: 8.2,
          contentRating: "TV-14",
          credits: [{ name: "Mara Voss", role: "Dr. Elian Vale", type: "cast" }],
          creditsTruncated: false,
          criticRating: null,
          episodeNumber: 3,
          externalId: "route-private-episode",
          genres: ["Drama"],
          kind: "episode",
          overview: "The observatory resolves the signal.",
          played: false,
          positionSeconds: 900,
          runtimeSeconds: 2_700,
          seasonNumber: 2,
          subtitle: "S02E03",
          studios: ["Northlight Pictures"],
          title: "The Long Meridian",
          year: 2026,
        },
      ],
      nextStartIndex: null,
      truncated: false,
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=series&sort=title",
      });
      const catalogue = libraryBrowseResponseSchema.parse(catalogueResponse.json());
      const referenceId = catalogue.items[0]!.media.id;

      const detailResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}`,
      });
      expect(detailResponse.statusCode, detailResponse.body).toBe(200);
      expect(libraryTitleDetailResponseSchema.parse(detailResponse.json())).toMatchObject({
        media: { id: referenceId, kind: "series", title: "Northern Lights" },
        playback: null,
        seasons: [{ seasonNumber: 2, title: "Season 2" }],
      });

      const episodesResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/seasons/2/episodes?limit=30`,
      });
      expect(episodesResponse.statusCode, episodesResponse.body).toBe(200);
      expect(librarySeasonEpisodesResponseSchema.parse(episodesResponse.json())).toMatchObject({
        items: [
          {
            media: { id: `media_${"e".repeat(22)}`, kind: "episode", title: "The Long Meridian" },
            playback: { positionSeconds: 900 },
          },
        ],
        seasonNumber: 2,
        titleReferenceId: referenceId,
      });
      expect(detailResponse.body + episodesResponse.body).not.toMatch(
        /route-private|viewer-external|jellyfin\.example/iu,
      );
    } finally {
      await app.close();
    }
  });

  it("protects idempotent playback-state writes with origin, CSRF, and opaque identity", async () => {
    const { app, updatePlaybackState, viewer } = await harness();
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const request = {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "idempotency-key": "route-playback-state-1",
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: viewer.csrfToken,
        },
        method: "POST" as const,
        payload: { action: "mark_watched" },
        url: `/v1/media/library/${referenceId}/playback-state`,
      };

      const headersWithoutOrigin: Record<string, string> = { ...request.headers };
      delete headersWithoutOrigin.origin;
      const missingOrigin = await app.inject({
        ...request,
        headers: headersWithoutOrigin,
      });
      expect(missingOrigin.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingOrigin.json()).error.code).toBe("origin_denied");

      const headersWithoutCsrf: Record<string, string> = { ...request.headers };
      delete headersWithoutCsrf[SESSION_CSRF_HEADER];
      const missingCsrf = await app.inject({
        ...request,
        headers: headersWithoutCsrf,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");

      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        action: "mark_watched",
        playback: { durationSeconds: 7_200, played: true, positionSeconds: 0 },
        referenceId,
        updatedAt: now.toISOString(),
      });
      expect(response.headers["idempotency-replayed"]).toBe("false");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toMatch(/route-private|viewer-external|jellyfin\.example/iu);
      expect(updatePlaybackState).toHaveBeenCalledWith(
        {
          action: "mark_watched",
          itemId: privateItemId,
          userId: "viewer-external",
        },
        expect.any(AbortSignal),
      );

      const replay = await app.inject(request);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(updatePlaybackState).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("maps playback-state conflicts and upstream outcomes to bounded public errors", async () => {
    const { app, updatePlaybackState, viewer } = await harness();
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const request = (key: string, action = "mark_watched") => ({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "idempotency-key": key,
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: viewer.csrfToken,
        },
        method: "POST" as const,
        payload: { action },
        url: `/v1/media/library/${referenceId}/playback-state`,
      });

      expect((await app.inject(request("route-conflict"))).statusCode).toBe(200);
      const conflict = await app.inject(request("route-conflict", "mark_unwatched"));
      expect(conflict.statusCode).toBe(409);
      expect(apiErrorSchema.parse(conflict.json()).error.code).toBe("idempotency_key_conflict");

      const missing = await app.inject({
        ...request("route-missing"),
        url: `/v1/media/library/media_${"z".repeat(22)}/playback-state`,
      });
      expect(apiErrorSchema.parse(missing.json()).error.code).toBe("media_library_title_not_found");
      expect(missing.statusCode).toBe(404);

      updatePlaybackState.mockResolvedValueOnce({
        durationSeconds: 7_200,
        played: false,
        positionSeconds: 0,
      });
      const invalid = await app.inject(request("route-invalid-response"));
      expect(invalid.statusCode).toBe(502);
      expect(apiErrorSchema.parse(invalid.json()).error.code).toBe(
        "media_playback_state_response_invalid",
      );

      updatePlaybackState.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "invalid_credentials",
          message: "private upstream denial",
          operation: "media.playback_state",
          retryable: false,
          service: "jellyfin",
          status: 403,
        }),
      );
      const denied = await app.inject(request("route-denied"));
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe(
        "media_playback_state_permission_denied",
      );

      updatePlaybackState.mockRejectedValueOnce(new Error("private upstream failure"));
      const unavailable = await app.inject(request("route-unavailable"));
      expect(unavailable.statusCode).toBe(503);
      expect(apiErrorSchema.parse(unavailable.json()).error.code).toBe(
        "media_playback_state_unavailable",
      );
      expect(conflict.body + invalid.body + denied.body + unavailable.body).not.toMatch(
        /private upstream/iu,
      );

      let resolvePending!: (playback: {
        durationSeconds: number;
        played: boolean;
        positionSeconds: number;
      }) => void;
      updatePlaybackState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          }),
      );
      const firstPending = app.inject(request("route-pending"));
      await vi.waitFor(() => expect(updatePlaybackState).toHaveBeenCalledTimes(5));
      const pending = await app.inject(request("route-pending"));
      expect(pending.statusCode).toBe(409);
      expect(pending.headers["retry-after"]).toBe("2");
      expect(apiErrorSchema.parse(pending.json()).error.code).toBe(
        "media_playback_state_outcome_pending",
      );
      resolvePending({ durationSeconds: 7_200, played: true, positionSeconds: 0 });
      expect((await firstPending).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("requires authentication and rejects tampered library cursors before upstream access", async () => {
    const { app, readLibrary, viewer } = await harness();
    try {
      const signedOut = await app.inject({ method: "GET", url: "/v1/media/library" });
      expect(signedOut.statusCode).toBe(401);
      expect(readLibrary).not.toHaveBeenCalled();

      const recovery = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const denied = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
        method: "GET",
        url: "/v1/media/library",
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("permission_denied");
      expect(readLibrary).not.toHaveBeenCalled();

      const first = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?limit=1",
      });
      const cursor = libraryBrowseResponseSchema.parse(first.json()).nextCursor!;
      const calls = readLibrary.mock.calls.length;
      const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
      const rejected = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library?cursor=${encodeURIComponent(tampered)}&limit=1`,
      });
      expect(rejected.statusCode).toBe(400);
      expect(apiErrorSchema.parse(rejected.json()).error.code).toBe("media_library_cursor_invalid");
      expect(rejected.body).not.toContain(cursor);
      expect(readLibrary).toHaveBeenCalledTimes(calls);
    } finally {
      await app.close();
    }
  });

  it("serves private artwork bytes with a validator and supports revalidation", async () => {
    const { app, readImage, viewer } = await harness();
    try {
      await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/continue-watching",
      });
      const url = `/v1/media/media_${"r".repeat(22)}/images/poster`;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(response.headers["content-type"]).toMatch(/^image\/png/u);
      expect(response.headers["cache-control"]).toBe(
        "private, max-age=3600, stale-while-revalidate=86400",
      );
      expect(response.headers.etag).toMatch(/^"artwork_[A-Za-z0-9_-]{22}"$/u);
      expect(response.headers.vary).toContain("Cookie");
      expect(response.headers.vary).toContain("Accept");
      expect(readImage).toHaveBeenCalledWith({
        itemId: privateItemId,
        maxWidth: 720,
        signal: expect.any(AbortSignal),
        type: "Primary",
      });

      const revalidated = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "if-none-match": response.headers.etag!,
        },
        method: "GET",
        url,
      });
      expect(revalidated.statusCode).toBe(304);
      expect(revalidated.rawPayload).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("returns a safe not-found response for another artwork reference", async () => {
    const { app, readImage, viewer } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/media_${"z".repeat(22)}/images/poster`,
      });

      expect(response.statusCode).toBe(404);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("media_artwork_not_found");
      expect(response.body).not.toContain(privateItemId);
      expect(readImage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires authentication before resolving an artwork reference", async () => {
    const { app, readImage } = await harness();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/media/media_${"r".repeat(22)}/images/poster`,
      });

      expect(response.statusCode).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("authentication_required");
      expect(readImage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
