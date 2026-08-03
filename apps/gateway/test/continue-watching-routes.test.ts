import type {
  JellyfinContinueWatchingResult,
  JellyfinLibrarySeasonEpisodesResult,
  JellyfinLibraryResult,
  JellyfinLibraryTitleResult,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import { continueWatchingResponseSchema } from "@omnifin/contracts/dashboard";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  libraryBrowseResponseSchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseSchema,
} from "@omnifin/contracts/library";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
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
  let mediaReferenceIndex = 0;
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
      }),
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
