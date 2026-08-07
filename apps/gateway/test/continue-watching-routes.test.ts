import type {
  JellyfinContinueWatchingResult,
  JellyfinLibraryExtrasResult,
  JellyfinLibrarySeasonEpisodesResult,
  JellyfinLibraryResult,
  JellyfinLibraryTitleResult,
  JellyfinPlaybackContextResult,
  JellyfinViewingHistoryResult,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { continueWatchingResponseSchema } from "@omnifin/contracts/dashboard";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import type { Role } from "@omnifin/contracts/auth";
import {
  libraryBrowseResponseSchema,
  libraryConnectedActionsResponseSchema,
  libraryExtrasResponseSchema,
  libraryRemovalOperationSchema,
  libraryRemovalPreviewSchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseSchema,
  viewingHistoryResponseSchema,
} from "@omnifin/contracts/library";
import { playbackContextResponseSchema } from "@omnifin/contracts/playback";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function harness(
  options: {
    canDelete?: boolean;
    providerIds?: { imdb: string | null; tmdb: number | null };
    radarrConnectorCount?: number;
    radarrEnabled?: boolean;
    resolveConnectedAction?: (
      input: {
        identity: JellyfinLibraryTitleResult["managementIdentity"];
        service: "radarr" | "sonarr";
      },
      signal?: AbortSignal,
    ) => Promise<{ publicUiUrl: string; titleSlug: string } | null>;
    resolveLibraryMovie?: (
      input: { imdb: string | null; tmdb: number | null },
      signal?: AbortSignal,
    ) => Promise<
      | (({ fileId: number; hasFile: true } | { fileId: null; hasFile: false }) & {
          mediaId: number;
          monitored: boolean;
          sizeBytes: number | null;
        })
      | null
    >;
    resolveManagedMovie?: () => Promise<
      | (({ fileId: number; hasFile: true } | { fileId: null; hasFile: false }) & {
          connectorId: string;
          mediaId: number;
          monitored: boolean;
          sizeBytes: number | null;
        })
      | null
    >;
    role?: Role;
  } = {},
) {
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
    totalResults: 46,
    truncated: true,
  }));
  const readImage = vi.fn(async () => ({
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    contentType: "image/png" as const,
  }));
  const readLibraryTitle = vi.fn(async (): Promise<JellyfinLibraryTitleResult> => ({
    item: (await readLibrary()).items[0]!,
    managementIdentity: {
      kind: "movie",
      providerIds: options.providerIds ?? { imdb: "tt1234567", tmdb: 98_765 },
    },
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
    providerReferences: [],
    removal: {
      canDelete: options.canDelete ?? true,
      providerIds: options.providerIds ?? { imdb: "tt1234567", tmdb: 98_765 },
      sizeBytes: 6_979_321_856,
    },
    seasons: [],
    seasonsTruncated: false,
    seriesCredits: null,
  }));
  const readLibrarySeasonEpisodes = vi.fn(
    async (): Promise<JellyfinLibrarySeasonEpisodesResult> => ({
      items: [],
      nextStartIndex: null,
      truncated: false,
    }),
  );
  const readLibraryPerson = vi.fn(async (input: { itemId: string }) => ({
    itemId: input.itemId,
    name: "Mara Voss",
    tmdbId: 12_345,
  }));
  const readLibraryExtras = vi.fn(async (): Promise<JellyfinLibraryExtrasResult> => ({
    catalogTmdbId: null,
    items: [
      {
        artwork: {
          accentColor: "#775544",
          backdrop: null,
          blurHash: null,
          poster: { itemId: "route-private-extra", type: "Primary" },
        },
        contentRating: null,
        externalId: "route-private-extra",
        extraType: "trailer",
        overview: "A local trailer.",
        played: false,
        positionSeconds: 0,
        runtimeSeconds: 118,
        title: "Official trailer",
        year: 2026,
      },
    ],
    nextStartIndex: 12,
  }));
  const readPlaybackContext = vi.fn(async (): Promise<JellyfinPlaybackContextResult> => ({
    current: {
      durationSeconds: 2_700,
      episodeNumber: 2,
      seasonNumber: 1,
      seriesId: "route-private-upstream-series",
    },
    nextEpisode: null,
    nextState: "end",
    segments: [{ endSeconds: 86, kind: "intro", startSeconds: 4 }],
    segmentsState: "ready",
  }));
  const updatePlaybackState = vi.fn(async () => ({
    durationSeconds: 7_200,
    played: true,
    positionSeconds: 0,
  }));
  const deleteLibraryItem = vi.fn(async () => undefined);
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
        readLibraryExtras,
        readLibraryPerson,
        readLibrarySeasonEpisodes,
        readLibraryTitle,
        readPlaybackContext,
        readViewingHistory,
        deleteLibraryItem,
        updatePlaybackState,
      }),
      createRemovalOperationToken: () => "o".repeat(22),
      createRemovalPreviewToken: () => "d".repeat(22),
      ...(options.resolveLibraryMovie === undefined
        ? {}
        : {
            createRadarrAdapter: () => ({
              deleteLibraryMovie: vi.fn(async () => undefined),
              deleteLibraryMovieFile: vi.fn(async () => undefined),
              resolveLibraryMovie: options.resolveLibraryMovie!,
              updateAcquisitionMonitoring: vi.fn(async (input) => ({
                monitored: input.monitored,
                target: { kind: "movie" as const, mediaId: input.mediaId, service: input.service },
                verifiedAt: now.toISOString(),
              })),
            }),
          }),
      createUserMediaStateOperationToken: () => String(++stateOperationIndex).padStart(22, "o"),
      mediaReferences: {
        clock: () => now,
        createToken: () => (mediaReferenceIndex++ === 0 ? "r" : "e").repeat(22),
      },
      ...(options.resolveManagedMovie === undefined
        ? {}
        : { resolveManagedMovie: options.resolveManagedMovie }),
      ...(options.resolveConnectedAction === undefined
        ? {}
        : { resolveConnectedAction: options.resolveConnectedAction }),
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
  if (options.resolveLibraryMovie !== undefined) {
    const connectorIds = ["radarr-main", "radarr-secondary"].slice(
      0,
      options.radarrConnectorCount ?? 1,
    );
    for (const connectorId of connectorIds) {
      app.database.db
        .insert(connectorConfigs)
        .values({
          baseUrl: "https://radarr.example.test/",
          capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
          createdAt: now,
          displayName: "Home Radarr",
          enabled: options.radarrEnabled ?? true,
          encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
            JSON.stringify({
              credentials: {
                apiKey: "route-private-radarr-key",
                kind: "api_key",
              },
              schemaVersion: 1,
            }),
            `connector_credentials:radarr:${connectorId}`,
          ),
          healthState: "healthy",
          id: connectorId,
          type: "radarr",
          updatedAt: now,
        })
        .run();
    }
  }
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Viewer",
      id: "viewer-user",
      role: options.role ?? "viewer",
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
    deleteLibraryItem,
    readContinueWatching,
    readImage,
    readLibrary,
    readLibraryExtras,
    readLibraryPerson,
    readLibrarySeasonEpisodes,
    readLibraryTitle,
    readPlaybackContext,
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

  it("serves bounded episode playback context through the private media route", async () => {
    const { app, readContinueWatching, readPlaybackContext, viewer } = await harness();
    readContinueWatching.mockResolvedValueOnce({
      items: [
        {
          artwork: {
            accentColor: "#336699",
            backdrop: null,
            blurHash: null,
            poster: null,
          },
          contentRating: "TV-14",
          episodeNumber: 2,
          externalId: privateItemId,
          kind: "episode",
          lastPlayedAt: "2026-07-28T05:15:00.000Z",
          overview: null,
          positionSeconds: 90,
          runtimeSeconds: 2_700,
          seasonNumber: 1,
          subtitle: "S01E02 · Aperture",
          title: "Northern Lights",
          year: 2026,
        },
      ],
      truncated: false,
    });

    try {
      const feedResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/continue-watching",
      });
      const referenceId = continueWatchingResponseSchema.parse(feedResponse.json()).items[0]!.media
        .id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/${referenceId}/playback-context`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(playbackContextResponseSchema.parse(response.json())).toMatchObject({
        mediaReferenceId: referenceId,
        nextEpisode: null,
        nextState: "end",
        segments: [{ endSeconds: 86, kind: "intro", startSeconds: 4 }],
        segmentsState: "ready",
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toContain("Cookie");
      expect(response.body).not.toMatch(/route-private|viewer-external|jellyfin\.example/iu);
      expect(readPlaybackContext).toHaveBeenCalledWith(
        { itemId: privateItemId, userId: "viewer-external" },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("maps stale and unavailable playback context to sanitized public failures", async () => {
    const { app, readContinueWatching, readPlaybackContext, viewer } = await harness();
    readContinueWatching.mockResolvedValueOnce({
      items: [
        {
          artwork: {
            accentColor: "#336699",
            backdrop: null,
            blurHash: null,
            poster: null,
          },
          contentRating: "TV-14",
          episodeNumber: 2,
          externalId: privateItemId,
          kind: "episode",
          lastPlayedAt: "2026-07-28T05:15:00.000Z",
          overview: null,
          positionSeconds: 90,
          runtimeSeconds: 2_700,
          seasonNumber: 1,
          subtitle: "S01E02 · Aperture",
          title: "Northern Lights",
          year: 2026,
        },
      ],
      truncated: false,
    });

    try {
      const cookie = `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`;
      const missing = await app.inject({
        headers: { cookie },
        method: "GET",
        url: `/v1/media/media_${"z".repeat(22)}/playback-context`,
      });
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error.code).toBe("playback_context_not_found");

      const feedResponse = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/media/continue-watching",
      });
      const referenceId = continueWatchingResponseSchema.parse(feedResponse.json()).items[0]!.media
        .id;
      readPlaybackContext.mockRejectedValueOnce(new Error("private upstream failure"));
      const unavailable = await app.inject({
        headers: { cookie },
        method: "GET",
        url: `/v1/media/${referenceId}/playback-context`,
      });
      expect(unavailable.statusCode).toBe(503);
      expect(apiErrorSchema.parse(unavailable.json()).error.code).toBe(
        "playback_context_unavailable",
      );
      expect(missing.body + unavailable.body).not.toMatch(/private upstream/iu);
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
        source: {
          failure: { code: "configuration_invalid" },
          status: "unavailable",
        },
        state: "unavailable",
      });
    } finally {
      await app.close();
    }
  });

  it("requires authentication before contacting Jellyfin", async () => {
    const { app, readContinueWatching } = await harness();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/media/continue-watching",
      });

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
            media: {
              id: `media_${"r".repeat(22)}`,
              kind: "movie",
              title: "The Far Meridian",
            },
            playback: { played: false, positionSeconds: 1_200 },
          },
        ],
        source: {
          displayName: "Home Jellyfin",
          failure: null,
          status: "healthy",
        },
        state: "complete",
        totalResults: 46,
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
    const { app, readImage, readLibrary, readLibraryPerson, readLibraryTitle, viewer } =
      await harness();
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
        managementIdentity: {
          kind: "movie",
          providerIds: { imdb: "tt1234567", tmdb: 98_765 },
        },
        movie: {
          cast: [
            {
              image: { itemId: "route-private-person", type: "Primary" },
              imagePath: null,
              name: "Mara Voss",
              person: { itemId: "route-private-person", tmdbId: 12_345 },
              personItemId: "route-private-person",
              personReferenceId: null,
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
        providerReferences: [
          { identifier: "tt1234567", mediaKind: "movie", provider: "imdb" },
          { identifier: 98_765, mediaKind: "movie", provider: "tmdb" },
        ],
        seasons: [],
        seasonsTruncated: false,
        seriesCredits: null,
      });

      const detailResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}`,
      });
      expect(detailResponse.statusCode, detailResponse.body).toBe(200);
      const detail = libraryTitleDetailResponseSchema.parse(detailResponse.json());
      const personPath = detail.movie?.cast[0]?.imagePath;
      const personReferenceId = detail.movie?.cast[0]?.personReferenceId;
      expect(detail.providerReferences).toEqual([
        { identifier: "tt1234567", mediaKind: "movie", provider: "imdb" },
        { identifier: 98_765, mediaKind: "movie", provider: "tmdb" },
      ]);
      expect(personPath).toMatch(new RegExp(`^/v1/media/${referenceId}/images/people/v2\\.`));
      expect(personReferenceId).toMatch(/^media_[A-Za-z0-9_-]{22}$/u);
      expect(detailResponse.body).not.toMatch(/route-private-person|viewer-external/iu);

      const profile = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/people/${personReferenceId}`,
      });
      expect(profile.statusCode, profile.body).toBe(200);
      expect(profile.json()).toMatchObject({
        name: "Mara Voss",
        tmdbId: 12_345,
      });
      expect(profile.body).not.toMatch(/route-private-person|viewer-external/iu);
      expect(readLibraryPerson).toHaveBeenCalledWith(
        { itemId: "route-private-person", userId: "viewer-external" },
        expect.any(AbortSignal),
      );

      readLibraryPerson.mockRejectedValueOnce(new Error("route-private-profile-failure"));
      const unavailableProfile = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/people/${personReferenceId}`,
      });
      expect(unavailableProfile.statusCode, unavailableProfile.body).toBe(503);
      expect(apiErrorSchema.parse(unavailableProfile.json()).error.code).toBe(
        "media_library_person_unavailable",
      );
      expect(unavailableProfile.body).not.toContain("route-private-profile-failure");

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
        expect.objectContaining({
          itemId: "route-private-person",
          maxWidth: 480,
          type: "Primary",
        }),
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

      app.database.sqlite
        .prepare("update service_identity_links set revision = revision + 1 where id = ?")
        .run("viewer-link");
      const staleProfile = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/people/${personReferenceId}`,
      });
      expect(staleProfile.statusCode, staleProfile.body).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("reauthorizes connected-service navigation and returns only an exact no-referrer redirect", async () => {
    const resolveConnectedAction = vi.fn(async () => ({
      publicUiUrl: "https://movies.example.test/radarr/",
      titleSlug: "the-far-meridian",
    }));
    const { app, viewer } = await harness({
      resolveConnectedAction,
      role: "operator",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const detail = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}`,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(libraryTitleDetailResponseSchema.parse(detail.json()).media.id).toBe(referenceId);
      expect(resolveConnectedAction).not.toHaveBeenCalled();

      const discovery = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/actions`,
      });
      expect(discovery.statusCode, discovery.body).toBe(200);
      expect(libraryConnectedActionsResponseSchema.parse(discovery.json())).toEqual({
        actions: [
          {
            href: `/v1/media/library/${referenceId}/actions/radarr`,
            kind: "service_navigation",
            label: "Open in Radarr",
            service: "radarr",
          },
        ],
        generatedAt: now.toISOString(),
        mediaKind: "movie",
        referenceId,
      });

      const redirect = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/actions/radarr`,
      });
      expect(redirect.statusCode, redirect.body).toBe(303);
      expect(redirect.headers.location).toBe(
        "https://movies.example.test/radarr/movie/the-far-meridian",
      );
      expect(redirect.headers["referrer-policy"]).toBe("no-referrer");
      expect(redirect.headers["cache-control"]).toBe("no-store");
      expect(redirect.body).not.toMatch(/jellyfin|api\/v3|private/iu);
      expect(resolveConnectedAction).toHaveBeenCalledTimes(2);

      const wrongService = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/actions/sonarr`,
      });
      expect(wrongService.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("denies connected-service navigation to viewers before resolving its target", async () => {
    const resolveConnectedAction = vi.fn(async () => ({
      publicUiUrl: "https://movies.example.test/radarr/",
      titleSlug: "the-far-meridian",
    }));
    const { app, viewer } = await harness({
      resolveConnectedAction,
      role: "viewer",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const denied = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/actions`,
      });
      expect(denied.statusCode).toBe(403);
      const deniedRedirect = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/actions/radarr`,
      });
      expect(deniedRedirect.statusCode).toBe(403);
      expect(resolveConnectedAction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a bounded unavailable response when connected-service resolution fails", async () => {
    const resolveConnectedAction = vi.fn(async () => {
      throw new Error("private https://radarr.lan/api/v3 sensitive-key");
    });
    const { app, viewer } = await harness({
      resolveConnectedAction,
      role: "operator",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/actions/radarr`,
      });
      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "library_connected_action_unavailable",
      );
      expect(response.body).not.toMatch(/radarr\.lan|api\/v3|sensitive-key/iu);
    } finally {
      await app.close();
    }
  });

  it("aborts connected-action discovery when the downstream response closes", async () => {
    const started = deferred<void>();
    let actionSignal: AbortSignal | undefined;
    const resolveConnectedAction = vi.fn(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          actionSignal = signal;
          started.resolve(undefined);
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { app, viewer } = await harness({
      resolveConnectedAction,
      role: "operator",
    });
    const downstream = new AbortController();
    let actionResponse: ServerResponse | undefined;
    const captureActionResponse = (request: IncomingMessage, response: ServerResponse) => {
      if (request.url?.endsWith("/actions")) actionResponse = response;
    };
    app.server.prependListener("request", captureActionResponse);
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const cookie = `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`;
      const catalogueResponse = await fetch(`${address}/v1/media/library?kind=movies&sort=title`, {
        headers: { cookie },
      });
      const referenceId = libraryBrowseResponseSchema.parse(await catalogueResponse.json())
        .items[0]!.media.id;
      const pending = fetch(`${address}/v1/media/library/${referenceId}/actions`, {
        headers: { cookie },
        signal: downstream.signal,
      }).catch(() => undefined);

      await started.promise;
      expect(actionResponse).toBeDefined();
      actionResponse!.emit("close");

      await vi.waitFor(() => expect(actionSignal?.aborted).toBe(true));
      downstream.abort();
      await pending;
    } finally {
      app.server.off("request", captureActionResponse);
      downstream.abort();
      await app.close();
    }
  });

  it("serves lazy parent-scoped extras through authenticated opaque references", async () => {
    const { app, readLibraryExtras, viewer } = await harness();
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const parentReferenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json())
        .items[0]!.media.id;

      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${parentReferenceId}/extras?limit=12`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const extras = libraryExtrasResponseSchema.parse(response.json());
      expect(extras).toMatchObject({
        items: [
          {
            extraType: "trailer",
            media: {
              id: `media_${"e".repeat(22)}`,
              kind: "other",
              title: "Official trailer",
            },
            source: "local",
          },
        ],
        parentReferenceId,
        state: "complete",
      });
      expect(extras.nextCursor).toMatch(/^v2\./u);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toContain("Cookie");
      expect(response.body).not.toMatch(/route-private|viewer-external|jellyfin\.example/iu);
      expect(readLibraryExtras).toHaveBeenCalledWith(
        {
          itemId: privateItemId,
          limit: 12,
          startIndex: 0,
          userId: "viewer-external",
        },
        expect.any(AbortSignal),
      );

      const invalidCursor = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${parentReferenceId}/extras?limit=12&cursor=${encodeURIComponent(`${extras.nextCursor!}tampered`)}`,
      });
      expect(invalidCursor.statusCode, invalidCursor.body).toBe(400);
      expect(apiErrorSchema.parse(invalidCursor.json()).error.code).toBe(
        "media_library_cursor_invalid",
      );

      const missingTitle = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/media_${"z".repeat(22)}/extras`,
      });
      expect(missingTitle.statusCode, missingTitle.body).toBe(404);
      expect(apiErrorSchema.parse(missingTitle.json()).error.code).toBe(
        "media_library_title_not_found",
      );

      const signedOut = await app.inject({
        method: "GET",
        url: `/v1/media/library/${parentReferenceId}/extras`,
      });
      expect(signedOut.statusCode).toBe(401);
      expect(readLibraryExtras).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("serves a private read-only removal preview only to a library deletion administrator", async () => {
    const resolveLibraryMovie = vi.fn(async () => ({
      fileId: 314,
      hasFile: true as const,
      mediaId: 42,
      monitored: true,
      sizeBytes: 6_979_321_856,
    }));
    const { app, viewer } = await harness({
      resolveLibraryMovie,
      role: "admin",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(libraryRemovalPreviewSchema.parse(response.json())).toMatchObject({
        options: [
          { mode: "delete_files_keep_monitored" },
          { mode: "delete_files_and_unmonitor" },
          { mode: "remove_from_radarr_and_delete_files" },
        ],
        referenceId,
        source: { kind: "managed", service: "radarr" },
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toMatch(/route-private|viewer-external|tt1234567|98765/iu);
      expect(resolveLibraryMovie).toHaveBeenCalledWith(
        { imdb: "tt1234567", tmdb: 98_765 },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("denies removal previews before ownership lookup without the destructive permission", async () => {
    const resolveManagedMovie = vi.fn(async () => null);
    const { app, viewer } = await harness({
      resolveManagedMovie,
      role: "operator",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("permission_denied");
      expect(resolveManagedMovie).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("fails closed when the paired Jellyfin user cannot delete the exact movie", async () => {
    const resolveManagedMovie = vi.fn(async () => null);
    const { app, viewer } = await harness({
      canDelete: false,
      resolveManagedMovie,
      role: "admin",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "library_removal_not_permitted",
      );
      expect(resolveManagedMovie).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("fails closed when Radarr ownership no longer confirms an organized file", async () => {
    const resolveManagedMovie = vi.fn(async () => ({
      connectorId: "radarr-main",
      fileId: null,
      hasFile: false as const,
      mediaId: 42,
      monitored: true,
      sizeBytes: null,
    }));
    const { app, viewer } = await harness({
      resolveManagedMovie,
      role: "admin",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "library_removal_preview_unavailable",
      );
    } finally {
      await app.close();
    }
  });

  it("does not misclassify a movie while a configured Radarr source is disabled", async () => {
    const resolveLibraryMovie = vi.fn(async () => null);
    const { app, viewer } = await harness({
      radarrEnabled: false,
      resolveLibraryMovie,
      role: "admin",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "library_removal_preview_unavailable",
      );
      expect(resolveLibraryMovie).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("previews a Jellyfin-owned movie when no Radarr source is configured", async () => {
    const { app, viewer } = await harness({ role: "admin" });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(libraryRemovalPreviewSchema.parse(response.json())).toMatchObject({
        options: [{ mode: "delete_unmanaged_files" }],
        source: { kind: "unmanaged", monitored: null, service: "jellyfin" },
      });
    } finally {
      await app.close();
    }
  });

  it("protects and idempotently commits an exact Jellyfin-owned removal", async () => {
    const { app, deleteLibraryItem, viewer } = await harness({ role: "admin" });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const previewResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });
      const preview = libraryRemovalPreviewSchema.parse(previewResponse.json());
      const storedPreview = app.database.sqlite
        .prepare("select encrypted_payload as encryptedPayload from library_removal_previews")
        .get() as { encryptedPayload: string };
      const previewCipher = new EnvelopeCipher(testConfig().encryptionKey);
      const persistedPayload = JSON.parse(
        previewCipher.decrypt(
          storedPreview.encryptedPayload,
          `library_removal_preview:${preview.previewId}`,
        ),
      ) as Record<string, unknown>;
      app.database.sqlite
        .prepare("update library_removal_previews set encrypted_payload = ?")
        .run(
          previewCipher.encrypt(
            JSON.stringify({ ...persistedPayload, schemaVersion: 1 }),
            `library_removal_preview:${preview.previewId}`,
          ),
        );
      const request = {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}`,
          "idempotency-key": "route-library-removal-0001",
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: viewer.csrfToken,
        },
        method: "POST" as const,
        payload: {
          confirmationTitle: preview.title,
          mode: "delete_unmanaged_files",
          previewId: preview.previewId,
        },
        url: `/v1/media/library/${referenceId}/removals`,
      };

      const missingCsrf = await app.inject({
        ...request,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => name !== SESSION_CSRF_HEADER),
        ),
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");

      const first = await app.inject(request);
      expect(first.statusCode, first.body).toBe(201);
      expect(first.headers["idempotency-replayed"]).toBe("false");
      const operation = libraryRemovalOperationSchema.parse(first.json());
      expect(operation).toMatchObject({
        mode: "delete_unmanaged_files",
        previewId: preview.previewId,
        referenceId,
        state: "succeeded",
      });
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.body).not.toMatch(/route-private|viewer-external|jellyfin\.example/iu);

      const replay = await app.inject(request);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(replay.json()).toEqual(first.json());
      expect(deleteLibraryItem).toHaveBeenCalledOnce();
      expect(deleteLibraryItem).toHaveBeenCalledWith(privateItemId, expect.any(AbortSignal));

      const status = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/removals/${operation.operationId}`,
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(libraryRemovalOperationSchema.parse(status.json())).toEqual(operation);
      expect(status.headers["cache-control"]).toBe("no-store");

      const missingStatus = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/removals/library_removal_operation_${"z".repeat(22)}`,
      });
      expect(missingStatus.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missingStatus.json()).error.code).toBe(
        "library_removal_not_found",
      );

      app.database.sqlite
        .prepare("update library_removal_operations set response_json = '{}' where id = ?")
        .run(operation.operationId);
      const corruptedStatus = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/removals/${operation.operationId}`,
      });
      expect(corruptedStatus.statusCode).toBe(503);
      expect(apiErrorSchema.parse(corruptedStatus.json()).error.code).toBe(
        "library_removal_unavailable",
      );
    } finally {
      await app.close();
    }
  });
  it("uses the Jellyfin path only after every configured Radarr confirms no match", async () => {
    const resolveLibraryMovie = vi.fn(async () => null);
    const { app, viewer } = await harness({
      resolveLibraryMovie,
      role: "admin",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(libraryRemovalPreviewSchema.parse(response.json()).source.kind).toBe("unmanaged");
      expect(resolveLibraryMovie).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("fails closed when configured Radarr ownership cannot be resolved by provider identity", async () => {
    const resolveLibraryMovie = vi.fn(async () => null);
    const { app, viewer } = await harness({
      providerIds: { imdb: null, tmdb: null },
      resolveLibraryMovie,
      role: "admin",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode).toBe(503);
      expect(resolveLibraryMovie).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("fails closed when more than one Radarr source claims the exact movie", async () => {
    const resolveLibraryMovie = vi.fn(async () => ({
      fileId: 314,
      hasFile: true as const,
      mediaId: 42,
      monitored: true,
      sizeBytes: 6_979_321_856,
    }));
    const { app, viewer } = await harness({
      radarrConnectorCount: 2,
      resolveLibraryMovie,
      role: "admin",
    });
    try {
      const catalogueResponse = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/media/library?kind=movies&sort=title",
      });
      const referenceId = libraryBrowseResponseSchema.parse(catalogueResponse.json()).items[0]!
        .media.id;
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: `/v1/media/library/${referenceId}/removal-preview`,
      });

      expect(response.statusCode).toBe(503);
      expect(resolveLibraryMovie).toHaveBeenCalledTimes(2);
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
    readLibrary.mockResolvedValueOnce({
      items: [series],
      nextStartIndex: null,
      totalResults: 1,
      truncated: false,
    });
    readLibraryTitle.mockResolvedValueOnce({
      item: series,
      managementIdentity: {
        kind: "series",
        providerIds: { tmdb: 1_042, tvdb: 401_337 },
      },
      movie: null,
      providerReferences: [],
      seasons: [
        {
          episodeCount: 8,
          playedEpisodeCount: 3,
          seasonNumber: 2,
          title: "Season 2",
        },
      ],
      seasonsTruncated: false,
      seriesCredits: {
        cast: [],
        castTruncated: false,
        crew: [],
        crewTruncated: false,
      },
    });
    readLibrarySeasonEpisodes.mockResolvedValueOnce({
      items: [
        {
          airDate: "2026-03-12",
          artwork: series.artwork,
          communityRating: 8.2,
          contentRating: "TV-14",
          credits: [
            {
              name: "Mara Voss",
              person: null,
              personItemId: null,
              personReferenceId: null,
              role: "Dr. Elian Vale",
              type: "cast",
            },
          ],
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
            credits: [{ name: "Mara Voss", personReferenceId: null }],
            media: {
              id: `media_${"e".repeat(22)}`,
              kind: "episode",
              title: "The Long Meridian",
            },
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

      const headersWithoutOrigin: Record<string, string> = {
        ...request.headers,
      };
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
      resolvePending({
        durationSeconds: 7_200,
        played: true,
        positionSeconds: 0,
      });
      expect((await firstPending).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("requires authentication and rejects tampered library cursors before upstream access", async () => {
    const { app, readLibrary, viewer } = await harness();
    try {
      const signedOut = await app.inject({
        method: "GET",
        url: "/v1/media/library",
      });
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
