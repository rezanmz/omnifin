import type {
  JellyfinContinueWatchingResult,
  JellyfinLibraryExtrasResult,
  JellyfinLibrarySeasonEpisodesResult,
  JellyfinLibraryResult,
  JellyfinLibraryTitleResult,
  JellyfinViewingHistoryResult,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { continueWatchingResponseSchema } from "@omnifin/contracts/dashboard";
import {
  libraryBrowseResponseSchema,
  libraryExtrasResponseSchema,
  libraryRemovalPreviewSchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseSchema,
  viewingHistoryResponseSchema,
} from "@omnifin/contracts/library";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { DiscoverySearchError } from "../src/discovery/search-service.js";
import {
  ContinueWatchingError,
  ContinueWatchingService,
  type ContinueWatchingClientFactoryInput,
  type MediaArtworkError,
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

function adminPrincipal(): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    ...principal(),
    displayName: "Library administrator",
    permissions: ROLE_PERMISSIONS.admin,
    role: "admin",
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
          accentColor: "#336699",
          backdrop: { itemId: privateSeriesId, type: "Backdrop" },
          blurHash: "005?}k",
          poster: { itemId: privateSeriesId, type: "Primary" },
        },
        contentRating: "TV-14",
        episodeNumber: 3,
        externalId: privateItemId,
        kind: "episode",
        lastPlayedAt: "2026-07-28T04:45:00.000Z",
        overview: "A receiver resolves a signal beyond the ice.",
        positionSeconds: 900,
        runtimeSeconds: 2_700,
        seasonNumber: 2,
        subtitle: "S02E03 · The Long Meridian",
        title: "Northern Lights",
        year: 2026,
      },
    ],
    truncated: false,
  };
}

function libraryResult(): JellyfinLibraryResult {
  return {
    items: [
      {
        artwork: {
          accentColor: "#336699",
          backdrop: { itemId: privateSeriesId, type: "Backdrop" },
          blurHash: "005?}k",
          poster: { itemId: privateSeriesId, type: "Primary" },
        },
        contentRating: "TV-14",
        externalId: privateSeriesId,
        kind: "series",
        overview: "A receiver resolves a signal beyond the ice.",
        played: false,
        positionSeconds: 0,
        runtimeSeconds: null,
        title: "Northern Lights",
        year: 2026,
      },
    ],
    nextStartIndex: 30,
    truncated: true,
  };
}

function harness(
  options: {
    resolveManagedMovie?: (input: {
      providerIds: { imdb: string | null; tmdb: number | null };
    }) => Promise<{
      hasFile: boolean;
      mediaId: number;
      monitored: boolean;
      sizeBytes: number | null;
    } | null>;
    withIdentity?: boolean;
  } = {},
) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  if (options.withIdentity !== false) insertIdentity(database, config);
  const readContinueWatching = vi.fn(async () => resumeResult());
  const readLibrary = vi.fn(async () => libraryResult());
  const readLibraryTitle = vi.fn(async (): Promise<JellyfinLibraryTitleResult> => ({
    item: libraryResult().items[0]!,
    movie: null,
    seasons: [{ episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 2, title: "Season 2" }],
    seasonsTruncated: false,
  }));
  const readLibraryExtras = vi.fn(async (): Promise<JellyfinLibraryExtrasResult> => ({
    catalogTmdbId: 1_042,
    items: [
      {
        artwork: {
          accentColor: "#775544",
          backdrop: { itemId: "private-extra-backdrop", type: "Backdrop" },
          blurHash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          poster: { itemId: "private-extra-poster", type: "Primary" },
        },
        contentRating: null,
        externalId: "private-upstream-trailer",
        extraType: "trailer",
        overview: "A local theatrical trailer.",
        played: false,
        positionSeconds: 15,
        runtimeSeconds: 142,
        title: "Official trailer",
        year: 2026,
      },
    ],
    nextStartIndex: 12,
  }));
  const readOnlineExtras = vi.fn(async () => ({
    displayName: "Home Seerr",
    items: [
      {
        id: "youtube:QdBZY2fkU-0",
        provider: "youtube" as const,
        resolution: 2160,
        title: "Official online trailer",
        type: "trailer" as const,
      },
    ],
  }));
  const readLibrarySeasonEpisodes = vi.fn(
    async (): Promise<JellyfinLibrarySeasonEpisodesResult> => ({
      items: [
        {
          ...resumeResult().items[0]!,
          airDate: "2025-02-14",
          communityRating: 8.4,
          credits: [
            { name: "Mara Voss", role: "Dr. Elian Vale", type: "cast" },
            { name: "Ari Chen", role: null, type: "writer" },
          ],
          creditsTruncated: false,
          criticRating: 91,
          genres: ["Drama", "Science fiction"],
          kind: "episode",
          played: false,
          studios: ["Northlight Pictures"],
          title: "The Long Meridian",
        },
      ],
      nextStartIndex: 30,
      truncated: true,
    }),
  );
  const readImage = vi.fn(async () => ({
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    contentType: "image/jpeg" as const,
  }));
  const updatePlaybackState = vi.fn(async () => ({
    durationSeconds: 2_700,
    played: false,
    positionSeconds: 0,
  }));
  const readViewingHistory = vi.fn(
    async (input: { afterItemId?: string }): Promise<JellyfinViewingHistoryResult> => ({
      boundaryFound: true,
      items:
        input.afterItemId === undefined
          ? [
              {
                ...resumeResult().items[0]!,
                kind: "episode",
                played: false,
              },
            ]
          : [],
      nextAfterItemId: input.afterItemId === undefined ? privateItemId : null,
    }),
  );
  const createClient = vi.fn((_input: ContinueWatchingClientFactoryInput) => ({
    readContinueWatching,
    readImage,
    readLibrary,
    readLibraryExtras,
    readLibrarySeasonEpisodes,
    readLibraryTitle,
    readViewingHistory,
    updatePlaybackState,
  }));
  let mediaReferenceIndex = 0;
  const service = new ContinueWatchingService(database, config, {
    clock: () => now,
    createClient,
    createRemovalPreviewToken: () => "d".repeat(22),
    createUserMediaStateOperationToken: () => "o".repeat(22),
    readOnlineExtras,
    mediaReferences: {
      clock: () => now,
      createToken: () => (mediaReferenceIndex++ === 0 ? "m" : "e").repeat(22),
    },
    ...(options.resolveManagedMovie === undefined
      ? {}
      : { resolveManagedMovie: options.resolveManagedMovie }),
  });
  return {
    config,
    createClient,
    database,
    readContinueWatching,
    readImage,
    readLibrary,
    readLibraryExtras,
    readLibrarySeasonEpisodes,
    readLibraryTitle,
    readOnlineExtras,
    readViewingHistory,
    service,
    updatePlaybackState,
  };
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
                accentColor: "#336699",
                backdropPath: `/v1/media/media_${"m".repeat(22)}/images/backdrop`,
                blurHash: "005?}k",
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

  it("previews exact Radarr-managed removal effects for an authorized administrator", async () => {
    const resolveManagedMovie = vi.fn(async () => ({
      hasFile: true,
      mediaId: 42,
      monitored: true,
      sizeBytes: 6_979_321_856,
    }));
    const { database, readLibrary, readLibraryTitle, service } = harness({
      resolveManagedMovie,
    });
    const movie = {
      ...libraryResult().items[0]!,
      externalId: "private-upstream-movie",
      kind: "movie" as const,
      runtimeSeconds: 7_080,
      title: "The Long Meridian",
      year: 2026,
    };
    readLibrary.mockResolvedValueOnce({ items: [movie], nextStartIndex: null, truncated: false });
    readLibraryTitle.mockResolvedValueOnce({
      item: movie,
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
      removal: {
        canDelete: true,
        providerIds: { imdb: "tt1234567", tmdb: 98_765 },
        sizeBytes: 6_979_321_856,
      },
      seasons: [],
      seasonsTruncated: false,
    });

    try {
      const catalogue = await service.browse(
        { kind: "movies", limit: 30, sort: "title" },
        { principal: adminPrincipal() },
      );
      const referenceId = catalogue.items[0]!.media.id;
      const preview = await service.previewLibraryRemoval(referenceId, {
        principal: adminPrincipal(),
      });

      expect(libraryRemovalPreviewSchema.parse(preview)).toEqual(preview);
      expect(preview).toMatchObject({
        confirmation: { expectedTitle: "The Long Meridian" },
        options: [
          { mode: "delete_files_keep_monitored" },
          { mode: "delete_files_and_unmonitor" },
          { mode: "remove_from_radarr_and_delete_files" },
        ],
        previewId: `library_removal_preview_${"d".repeat(22)}`,
        referenceId,
        sizeBytes: 6_979_321_856,
        source: { kind: "managed", monitored: true, service: "radarr" },
      });
      expect(resolveManagedMovie).toHaveBeenCalledWith(
        { providerIds: { imdb: "tt1234567", tmdb: 98_765 } },
        undefined,
      );
      expect(JSON.stringify(preview)).not.toMatch(
        /private-upstream|viewer-external|tt1234567|98765/iu,
      );
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

  it("browses only the paired Jellyfin user through encrypted query-bound cursors", async () => {
    const { createClient, database, readLibrary, service } = harness();
    try {
      const first = await service.browse(
        { kind: "all", limit: 30, query: "Meridian", sort: "recent" },
        { principal: principal() },
      );

      expect(libraryBrowseResponseSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        items: [
          {
            media: {
              id: `media_${"m".repeat(22)}`,
              kind: "series",
              title: "Northern Lights",
            },
            playback: null,
          },
        ],
        source: { displayName: "Home Jellyfin", failure: null, status: "healthy" },
        state: "complete",
      });
      expect(first.nextCursor).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
      expect(first.nextCursor).not.toContain("viewer-link");
      expect(first.nextCursor).not.toContain("Meridian");
      expect(JSON.stringify(first)).not.toMatch(
        /private-jellyfin|private-upstream|viewer-external/u,
      );
      expect(readLibrary).toHaveBeenCalledWith(
        {
          kind: "all",
          limit: 30,
          query: "Meridian",
          sort: "recent",
          startIndex: 0,
          userId: "viewer-external",
        },
        undefined,
      );
      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: privateAccessToken, deviceId: "viewer-device" }),
      );

      const longestQuery = await service.browse(
        { kind: "series", limit: 50, query: "m".repeat(100), sort: "year" },
        { principal: principal() },
      );
      expect(longestQuery.nextCursor?.length).toBeLessThanOrEqual(512);
      expect(libraryBrowseResponseSchema.parse(longestQuery)).toEqual(longestQuery);

      await service.browse(
        {
          cursor: first.nextCursor!,
          kind: "all",
          limit: 30,
          query: "Meridian",
          sort: "recent",
        },
        { principal: principal() },
      );
      expect(readLibrary).toHaveBeenLastCalledWith(
        expect.objectContaining({ startIndex: 30, userId: "viewer-external" }),
        undefined,
      );
    } finally {
      database.close();
    }
  });

  it("reads only the paired user's bounded history through filter-bound opaque cursors", async () => {
    const { database, readViewingHistory, service } = harness();
    try {
      const first = await service.readViewingHistory(
        { kind: "all", limit: 24, range: "30_days", state: "all" },
        { principal: principal() },
      );
      expect(viewingHistoryResponseSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        items: [
          {
            activity: "in_progress",
            media: {
              id: `media_${"m".repeat(22)}`,
              kind: "episode",
              title: "Northern Lights",
            },
            playback: { durationSeconds: 2_700, played: false, positionSeconds: 900 },
          },
        ],
        source: { displayName: "Home Jellyfin", failure: null, status: "healthy" },
        state: "complete",
      });
      expect(first.nextCursor).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
      expect(JSON.stringify(first)).not.toMatch(
        /private-jellyfin|private-upstream|viewer-external/u,
      );
      expect(readViewingHistory).toHaveBeenCalledWith(
        {
          kind: "all",
          limit: 24,
          since: "2026-06-28T05:00:00.000Z",
          state: "all",
          userId: "viewer-external",
        },
        undefined,
      );

      const second = await service.readViewingHistory(
        {
          cursor: first.nextCursor!,
          kind: "all",
          limit: 24,
          range: "30_days",
          state: "all",
        },
        { principal: principal() },
      );
      expect(second).toMatchObject({ items: [], nextCursor: null, state: "empty" });
      expect(readViewingHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          afterItemId: privateItemId,
          since: "2026-06-28T05:00:00.000Z",
          userId: "viewer-external",
        }),
        undefined,
      );

      await expect(
        service.readViewingHistory(
          {
            cursor: first.nextCursor!,
            kind: "movies",
            limit: 24,
            range: "30_days",
            state: "all",
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
    } finally {
      database.close();
    }
  });

  it("keeps an encrypted history boundary with a maximum valid Jellyfin item ID routable", async () => {
    const { database, readViewingHistory, service } = harness();
    const maximumItemId = "h".repeat(256);
    readViewingHistory.mockResolvedValueOnce({
      boundaryFound: true,
      items: [
        {
          ...resumeResult().items[0]!,
          externalId: maximumItemId,
          kind: "episode",
          played: false,
        },
      ],
      nextAfterItemId: maximumItemId,
    });
    try {
      const response = await service.readViewingHistory(
        { kind: "all", limit: 50, range: "1_year", state: "all" },
        { principal: principal() },
      );
      expect(response.nextCursor?.length).toBeLessThanOrEqual(1_024);
      expect(viewingHistoryResponseSchema.parse(response)).toEqual(response);
      expect(JSON.stringify(response)).not.toContain(maximumItemId);
    } finally {
      database.close();
    }
  });

  it("binds all supported history ranges and degrades connector failures without private detail", async () => {
    const { database, readViewingHistory, service } = harness();
    try {
      for (const [range, since] of [
        ["all", undefined],
        ["7_days", "2026-07-21T05:00:00.000Z"],
        ["90_days", "2026-04-29T05:00:00.000Z"],
      ] as const) {
        await service.readViewingHistory(
          { kind: "episodes", limit: 12, range, state: "in_progress" },
          { principal: principal() },
        );
        expect(readViewingHistory).toHaveBeenLastCalledWith(
          {
            kind: "episodes",
            limit: 12,
            ...(since === undefined ? {} : { since }),
            state: "in_progress",
            userId: "viewer-external",
          },
          undefined,
        );
      }

      readViewingHistory.mockRejectedValueOnce(
        new Error(`private ${privateItemId} ${privateAccessToken}`),
      );
      const unavailable = await service.readViewingHistory(
        { kind: "all", limit: 24, range: "30_days", state: "all" },
        { principal: principal() },
      );
      expect(unavailable).toMatchObject({
        items: [],
        source: {
          failure: {
            message: "Jellyfin viewing history is temporarily unavailable.",
            operation: "media.viewing_history",
          },
          status: "unavailable",
        },
        state: "unavailable",
      });
      expect(JSON.stringify(unavailable)).not.toMatch(/private-upstream|private-jellyfin/iu);
    } finally {
      database.close();
    }
  });

  it("opens a series title before paging its episodes through bound opaque references", async () => {
    const { database, readLibrarySeasonEpisodes, readLibraryTitle, service } = harness();
    try {
      const catalogue = await service.browse(
        { kind: "series", limit: 30, sort: "title" },
        { principal: principal() },
      );
      const referenceId = catalogue.items[0]!.media.id;
      const detail = await service.readLibraryTitle(referenceId, { principal: principal() });

      expect(libraryTitleDetailResponseSchema.parse(detail)).toEqual(detail);
      expect(detail).toMatchObject({
        media: { id: referenceId, kind: "series", title: "Northern Lights" },
        playback: null,
        seasons: [{ episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 2, title: "Season 2" }],
      });
      expect(readLibraryTitle).toHaveBeenCalledWith(
        { itemId: privateSeriesId, userId: "viewer-external" },
        undefined,
      );

      const episodes = await service.readLibrarySeasonEpisodes(
        referenceId,
        2,
        { limit: 30 },
        { principal: principal() },
      );
      expect(librarySeasonEpisodesResponseSchema.parse(episodes)).toEqual(episodes);
      expect(episodes).toMatchObject({
        items: [
          {
            airDate: "2025-02-14",
            communityRating: 8.4,
            credits: [
              { name: "Mara Voss", role: "Dr. Elian Vale", type: "cast" },
              { name: "Ari Chen", role: null, type: "writer" },
            ],
            criticRating: 91,
            genres: ["Drama", "Science fiction"],
            media: {
              id: `media_${"e".repeat(22)}`,
              kind: "episode",
              title: "The Long Meridian",
            },
            playback: { durationSeconds: 2_700, played: false, positionSeconds: 900 },
            studios: ["Northlight Pictures"],
          },
        ],
        seasonNumber: 2,
        titleReferenceId: referenceId,
      });
      expect(episodes.nextCursor).toMatch(/^v2\./u);
      expect(JSON.stringify({ detail, episodes })).not.toMatch(
        /private-jellyfin|private-upstream|viewer-external/u,
      );
      expect(readLibrarySeasonEpisodes).toHaveBeenCalledWith(
        {
          limit: 30,
          seasonNumber: 2,
          seriesId: privateSeriesId,
          startIndex: 0,
          userId: "viewer-external",
        },
        undefined,
      );

      await service.readLibrarySeasonEpisodes(
        referenceId,
        2,
        { cursor: episodes.nextCursor!, limit: 30 },
        { principal: principal() },
      );
      expect(readLibrarySeasonEpisodes).toHaveBeenLastCalledWith(
        expect.objectContaining({ startIndex: 30 }),
        undefined,
      );

      const calls = readLibrarySeasonEpisodes.mock.calls.length;
      await expect(
        service.readLibrarySeasonEpisodes(
          referenceId,
          3,
          { cursor: episodes.nextCursor!, limit: 30 },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
      expect(readLibrarySeasonEpisodes).toHaveBeenCalledTimes(calls);
    } finally {
      database.close();
    }
  });

  it("pages parent-scoped local extras without exposing Jellyfin identities", async () => {
    const { database, readLibraryExtras, readOnlineExtras, service } = harness();
    try {
      const catalogue = await service.browse(
        { kind: "series", limit: 30, sort: "title" },
        { principal: principal() },
      );
      const parentReferenceId = catalogue.items[0]!.media.id;
      const first = await service.readLibraryExtras(
        parentReferenceId,
        { limit: 12 },
        { principal: principal() },
      );

      expect(libraryExtrasResponseSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        items: [
          {
            extraType: "trailer",
            media: {
              artwork: {
                backdropPath: `/v1/media/media_${"e".repeat(22)}/images/backdrop`,
                posterPath: `/v1/media/media_${"e".repeat(22)}/images/poster`,
              },
              id: `media_${"e".repeat(22)}`,
              kind: "other",
              title: "Official trailer",
            },
            playback: { durationSeconds: 142, played: false, positionSeconds: 15 },
            source: "local",
          },
        ],
        parentReferenceId,
        onlineItems: [
          {
            id: "youtube:QdBZY2fkU-0",
            provider: "youtube",
            title: "Official online trailer",
          },
        ],
        onlineSource: { displayName: "Home Seerr", failure: null, status: "healthy" },
        onlineState: "ready",
        source: { displayName: "Home Jellyfin", failure: null, status: "healthy" },
        state: "complete",
      });
      expect(first.nextCursor).toMatch(/^v2\./u);
      expect(readOnlineExtras).toHaveBeenCalledWith(
        { kind: "series", principal: principal(), tmdbId: 1_042 },
        undefined,
      );
      expect(JSON.stringify(first)).not.toMatch(/private-|viewer-external|jellyfin-access/iu);
      expect(readLibraryExtras).toHaveBeenCalledWith(
        {
          itemId: privateSeriesId,
          limit: 12,
          startIndex: 0,
          userId: "viewer-external",
        },
        undefined,
      );

      await service.readLibraryExtras(
        parentReferenceId,
        { cursor: first.nextCursor!, limit: 12 },
        { principal: principal() },
      );
      expect(readLibraryExtras).toHaveBeenLastCalledWith(
        expect.objectContaining({ startIndex: 12 }),
        undefined,
      );

      const calls = readLibraryExtras.mock.calls.length;
      await expect(
        service.readLibraryExtras(
          parentReferenceId,
          { cursor: `${first.nextCursor!}tampered`, limit: 12 },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
      expect(readLibraryExtras).toHaveBeenCalledTimes(calls);

      readOnlineExtras.mockRejectedValueOnce(new Error("private Seerr detail payload"));
      const withoutOnline = await service.readLibraryExtras(
        parentReferenceId,
        { limit: 12 },
        { principal: principal() },
      );
      expect(withoutOnline).toMatchObject({
        items: [{ source: "local" }],
        onlineItems: [],
        onlineSource: {
          failure: {
            message: "Online trailers are temporarily unavailable.",
            operation: "discovery.detail",
            service: "seerr",
          },
          status: "unavailable",
        },
        onlineState: "unavailable",
        state: "complete",
      });
      expect(JSON.stringify(withoutOnline)).not.toContain("private Seerr");

      readLibraryExtras.mockRejectedValueOnce(
        new Error(`private ${privateAccessToken} ${privateItemId}`),
      );
      const unavailable = await service.readLibraryExtras(
        parentReferenceId,
        { limit: 12 },
        { principal: principal() },
      );
      expect(unavailable).toMatchObject({
        items: [],
        nextCursor: null,
        parentReferenceId,
        source: {
          failure: {
            message: "The Jellyfin library is temporarily unavailable.",
            operation: "media.library",
          },
          status: "unavailable",
        },
        state: "unavailable",
      });
      expect(JSON.stringify(unavailable)).not.toMatch(/private-upstream|private-jellyfin/iu);
    } finally {
      database.close();
    }
  });

  it("keeps optional extra sources explicit across empty, unconfigured, and invalid states", async () => {
    const { database, readLibraryExtras, readOnlineExtras, service } = harness();
    try {
      const catalogue = await service.browse(
        { kind: "series", limit: 30, sort: "title" },
        { principal: principal() },
      );
      const parentReferenceId = catalogue.items[0]!.media.id;

      readLibraryExtras.mockResolvedValueOnce({
        catalogTmdbId: null,
        items: [
          {
            artwork: {
              accentColor: null,
              backdrop: null,
              blurHash: null,
              poster: null,
            },
            contentRating: null,
            externalId: "private-local-featurette",
            extraType: "featurette",
            overview: null,
            played: true,
            positionSeconds: 0,
            runtimeSeconds: 45,
            title: "Behind the signal",
            year: null,
          },
        ],
        nextStartIndex: null,
      });
      const localOnly = await service.readLibraryExtras(
        parentReferenceId,
        { limit: 12 },
        { principal: principal() },
      );
      expect(localOnly).toMatchObject({
        items: [
          {
            media: {
              artwork: { backdropPath: null, posterPath: null },
              title: "Behind the signal",
            },
          },
        ],
        nextCursor: null,
        onlineItems: [],
        onlineSource: { status: "unconfigured" },
        onlineState: "unconfigured",
        state: "complete",
      });
      expect(readOnlineExtras).not.toHaveBeenCalled();

      readLibraryExtras.mockResolvedValueOnce({
        catalogTmdbId: 1_042,
        items: [],
        nextStartIndex: null,
      });
      readOnlineExtras.mockResolvedValueOnce({ displayName: "Home Seerr", items: [] });
      const empty = await service.readLibraryExtras(
        parentReferenceId,
        { limit: 12 },
        { principal: principal() },
      );
      expect(empty).toMatchObject({
        items: [],
        onlineItems: [],
        onlineSource: { displayName: "Home Seerr", status: "healthy" },
        onlineState: "empty",
        state: "empty",
      });

      readLibraryExtras.mockResolvedValueOnce({
        catalogTmdbId: 1_042,
        items: [],
        nextStartIndex: null,
      });
      readOnlineExtras.mockRejectedValueOnce(new DiscoverySearchError("connector_unconfigured"));
      const noDiscoveryConnector = await service.readLibraryExtras(
        parentReferenceId,
        { limit: 12 },
        { principal: principal() },
      );
      expect(noDiscoveryConnector).toMatchObject({
        onlineItems: [],
        onlineSource: { displayName: "Seerr", failure: null, status: "unconfigured" },
        onlineState: "unconfigured",
        state: "empty",
      });

      const localExtraReferenceId = localOnly.items[0]!.media.id;
      const calls = readLibraryExtras.mock.calls.length;
      await expect(
        service.readLibraryExtras(localExtraReferenceId, { limit: 12 }, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(readLibraryExtras).toHaveBeenCalledTimes(calls);
    } finally {
      database.close();
    }
  });

  it("returns explicit movie playback state and rejects episode browsing through a movie reference", async () => {
    const {
      database,
      readImage,
      readLibrary,
      readLibrarySeasonEpisodes,
      readLibraryTitle,
      service,
    } = harness();
    const movie = {
      ...libraryResult().items[0]!,
      artwork: { accentColor: "#775544", backdrop: null, blurHash: null, poster: null },
      externalId: "private-upstream-movie",
      kind: "movie" as const,
      played: false,
      positionSeconds: 1_200,
      runtimeSeconds: 7_080,
      title: "The Far Meridian",
    };
    readLibrary.mockResolvedValueOnce({ items: [movie], nextStartIndex: null, truncated: false });
    readLibraryTitle.mockResolvedValueOnce({
      item: movie,
      movie: {
        cast: [
          {
            image: { itemId: "private-person-1", type: "Primary" },
            imagePath: null,
            name: "Mara Voss",
            role: "Iris Vale",
            type: "cast",
          },
        ],
        castTruncated: false,
        communityRating: 8.4,
        crew: [
          {
            image: null,
            imagePath: null,
            name: "Jon Bell",
            role: null,
            type: "director",
          },
        ],
        crewTruncated: false,
        criticRating: 91,
        genres: ["Drama"],
        mediaSources: [
          {
            audio: [],
            audioTruncated: false,
            bitrateKbps: 9_250,
            container: "MKV",
            label: "4K · HEVC · MKV",
            sizeBytes: 6_979_321_856,
            subtitles: [],
            subtitlesTruncated: false,
            video: {
              bitrateKbps: 8_700,
              bitDepth: 10,
              codec: "HEVC",
              hdrFormat: "HDR10",
              height: 1_606,
              profile: "Main 10",
              width: 3_840,
            },
          },
        ],
        mediaSourcesTruncated: false,
        premiereDate: "2026-04-18",
        studios: ["Northlight Pictures"],
        tagline: "The horizon remembers.",
      },
      seasons: [],
      seasonsTruncated: false,
    });

    try {
      const catalogue = await service.browse(
        { kind: "movies", limit: 30, sort: "title" },
        { principal: principal() },
      );
      const referenceId = catalogue.items[0]!.media.id;

      const detail = await service.readLibraryTitle(referenceId, { principal: principal() });
      expect(detail).toMatchObject({
        media: {
          artwork: { backdropPath: null, posterPath: null },
          id: referenceId,
          kind: "movie",
          title: "The Far Meridian",
        },
        movie: {
          cast: [
            {
              imagePath: expect.stringMatching(
                new RegExp(`^/v1/media/${referenceId}/images/people/v2\\.`),
              ),
              name: "Mara Voss",
            },
          ],
          communityRating: 8.4,
          genres: ["Drama"],
          mediaSources: [{ label: "4K · HEVC · MKV", sizeBytes: 6_979_321_856 }],
          premiereDate: "2026-04-18",
        },
        playback: { durationSeconds: 7_080, played: false, positionSeconds: 1_200 },
        seasons: [],
      });
      expect(JSON.stringify(detail)).not.toMatch(/private-person|private-upstream/u);
      const personPath = detail.movie?.cast[0]?.imagePath;
      expect(personPath).toBeTruthy();
      const token = personPath!.split("/").at(-1)!;
      await expect(
        service.readPersonArtwork({ principal: principal() }, referenceId, token),
      ).resolves.toMatchObject({
        contentType: "image/jpeg",
        etag: expect.stringMatching(/^"person_/u),
      });
      expect(readImage).toHaveBeenLastCalledWith({
        itemId: "private-person-1",
        maxWidth: 480,
        type: "Primary",
      });
      await expect(
        service.readPersonArtwork({ principal: principal() }, referenceId, `${token}tampered`),
      ).rejects.toMatchObject({ reason: "not_found" });
      await expect(
        service.readLibrarySeasonEpisodes(
          referenceId,
          1,
          { limit: 30 },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(readLibrarySeasonEpisodes).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("updates only the paired user's opaque playback state and replays the result idempotently", async () => {
    const { database, service, updatePlaybackState } = harness();
    try {
      const feed = await service.read({ principal: principal() });
      const referenceId = feed.items[0]!.media.id;
      const first = await service.updatePlaybackState(
        referenceId,
        { action: "reset_progress" },
        "playback-state-1",
        { ipAddress: "198.51.100.24", principal: principal(), requestId: "request-state-1" },
      );
      const replay = await service.updatePlaybackState(
        referenceId,
        { action: "reset_progress" },
        "playback-state-1",
        { ipAddress: "198.51.100.24", principal: principal(), requestId: "request-state-1" },
      );

      expect(first).toEqual({
        replayed: false,
        response: {
          action: "reset_progress",
          playback: { durationSeconds: 2_700, played: false, positionSeconds: 0 },
          referenceId,
          updatedAt: now.toISOString(),
        },
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(updatePlaybackState).toHaveBeenCalledTimes(1);
      expect(updatePlaybackState).toHaveBeenCalledWith(
        {
          action: "reset_progress",
          itemId: privateItemId,
          userId: "viewer-external",
        },
        undefined,
      );
      const stored = JSON.stringify(
        database.sqlite
          .prepare(
            `select id, idempotency_key_hash as keyHash, fingerprint_hash as fingerprintHash,
                    response_json as responseJson, state
             from user_media_state_operations`,
          )
          .all(),
      );
      expect(stored).not.toMatch(/playback-state-1|private-upstream|viewer-external/u);
      expect(stored).toContain('"state":"succeeded"');
      const audits = database.sqlite
        .prepare(
          `select event_type as eventType, outcome, target_type as targetType,
                  target_id as targetId, request_id as requestId,
                  metadata_json as metadataJson, ip_hash as ipHash
           from audit_events
           where event_type = 'media.playback_state.changed'`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        eventType: "media.playback_state.changed",
        ipHash: expect.any(String),
        metadataJson: '{"action":"reset_progress"}',
        outcome: "success",
        requestId: "request-state-1",
        targetId: expect.stringMatching(/^user_media_state_[A-Za-z0-9_-]{22}$/u),
        targetType: "user_media_state_operation",
      });
      expect(JSON.stringify(audits)).not.toMatch(
        /198\.51\.100\.24|private-upstream|viewer-external|playback-state-1|Ember Coast/u,
      );
    } finally {
      database.close();
    }
  });

  it("rejects idempotency conflicts and references owned by another user before mutation", async () => {
    const { database, service, updatePlaybackState } = harness();
    updatePlaybackState.mockResolvedValueOnce({
      durationSeconds: 2_700,
      played: true,
      positionSeconds: 0,
    });
    try {
      const feed = await service.read({ principal: principal() });
      const referenceId = feed.items[0]!.media.id;
      await service.updatePlaybackState(
        referenceId,
        { action: "mark_watched" },
        "playback-state-2",
        { principal: principal() },
      );
      await expect(
        service.updatePlaybackState(referenceId, { action: "mark_unwatched" }, "playback-state-2", {
          principal: principal(),
        }),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      await expect(
        service.updatePlaybackState(
          `media_${"z".repeat(22)}`,
          { action: "mark_watched" },
          "playback-state-3",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(updatePlaybackState).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("allows a failed desired-state write to retry safely with the same idempotency key", async () => {
    const { database, service, updatePlaybackState } = harness();
    updatePlaybackState
      .mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "Jellyfin did not respond before the deadline.",
          operation: "media.playback_state",
          retryable: true,
          service: "jellyfin",
        }),
      )
      .mockResolvedValueOnce({ durationSeconds: 2_700, played: true, positionSeconds: 0 });
    try {
      const feed = await service.read({ principal: principal() });
      const referenceId = feed.items[0]!.media.id;
      await expect(
        service.updatePlaybackState(
          referenceId,
          { action: "mark_watched" },
          "playback-state-retry",
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        service.updatePlaybackState(
          referenceId,
          { action: "mark_watched" },
          "playback-state-retry",
          { principal: principal() },
        ),
      ).resolves.toMatchObject({
        replayed: false,
        response: { action: "mark_watched", playback: { played: true, positionSeconds: 0 } },
      });
      expect(updatePlaybackState).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("rejects tampered or cross-query library cursors before contacting Jellyfin", async () => {
    const { database, readLibrary, service } = harness();
    try {
      const first = await service.browse(
        { kind: "all", limit: 30, query: "Meridian", sort: "recent" },
        { principal: principal() },
      );
      const calls = readLibrary.mock.calls.length;
      const cursor = first.nextCursor!;

      await expect(
        service.browse(
          {
            cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
            kind: "all",
            limit: 30,
            query: "Meridian",
            sort: "recent",
          },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
      await expect(
        service.browse(
          { cursor, kind: "movies", limit: 30, query: "Meridian", sort: "recent" },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });

      database.sqlite
        .prepare("update service_identity_links set revision = revision + 1 where id = ?")
        .run("viewer-link");
      await expect(
        service.browse(
          { cursor, kind: "all", limit: 30, query: "Meridian", sort: "recent" },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
      expect(readLibrary).toHaveBeenCalledTimes(calls);
    } finally {
      database.close();
    }
  });

  it("returns a safe degraded catalogue without leaking upstream failures", async () => {
    const { database, readLibrary, service } = harness();
    readLibrary.mockRejectedValueOnce(new Error(`private ${privateItemId} ${privateAccessToken}`));
    try {
      const response = await service.browse(
        { kind: "all", limit: 30, sort: "recent" },
        { principal: principal() },
      );
      expect(response).toMatchObject({
        items: [],
        nextCursor: null,
        source: {
          failure: { operation: "media.library", service: "jellyfin" },
          status: "unavailable",
        },
        state: "unavailable",
      });
      expect(JSON.stringify(response)).not.toMatch(/private-jellyfin|private-upstream/u);
    } finally {
      database.close();
    }
  });

  it("distinguishes a healthy empty paired-user catalogue from an unavailable source", async () => {
    const { database, readLibrary, service } = harness();
    readLibrary.mockResolvedValueOnce({ items: [], nextStartIndex: null, truncated: false });
    try {
      await expect(
        service.browse({ kind: "all", limit: 30, sort: "recent" }, { principal: principal() }),
      ).resolves.toMatchObject({
        items: [],
        nextCursor: null,
        source: { failure: null, status: "healthy" },
        state: "empty",
      });
    } finally {
      database.close();
    }
  });

  it("resolves authenticated artwork through a user-bound opaque reference", async () => {
    const { createClient, database, readImage, service } = harness();
    try {
      const feed = await service.read({ principal: principal() });
      const artwork = await service.readArtwork(
        { principal: principal() },
        feed.items[0]!.media.id,
        "backdrop",
      );

      expect(artwork).toMatchObject({
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        contentType: "image/jpeg",
        etag: expect.stringMatching(/^"artwork_[A-Za-z0-9_-]{22}"$/u),
      });
      expect(createClient).toHaveBeenLastCalledWith(
        expect.objectContaining({ maxResponseBytes: 8 * 1_024 * 1_024 }),
      );
      expect(readImage).toHaveBeenCalledWith({
        itemId: privateSeriesId,
        maxWidth: 1_920,
        type: "Backdrop",
      });
      expect(JSON.stringify(artwork)).not.toContain(privateSeriesId);
    } finally {
      database.close();
    }
  });

  it("does not contact Jellyfin for an unknown or unbacked artwork reference", async () => {
    const { database, readImage, service } = harness();
    try {
      await expect(
        service.readArtwork({ principal: principal() }, `media_${"z".repeat(22)}`, "poster"),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(readImage).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("maps Jellyfin image failures to a safe artwork error", async () => {
    const { database, readImage, service } = harness();
    try {
      const feed = await service.read({ principal: principal() });
      readImage.mockRejectedValueOnce(new Error("private upstream artwork failure"));

      await expect(
        service.readArtwork({ principal: principal() }, feed.items[0]!.media.id, "poster"),
      ).rejects.toEqual(
        expect.objectContaining<Partial<MediaArtworkError>>({
          code: "media_artwork_unavailable",
          reason: "unavailable",
        }),
      );
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
