import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type {
  SeerrDiscoveryBrowsePage,
  SeerrDiscoveryFeedPage,
} from "@omnifin/connectors/adapters/seerr";
import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type {
  DiscoveryFeedRailKind,
  DiscoveryMediaDetailResponse,
  DiscoveryPersonCreditsResponse,
  DiscoveryPersonDetailResponse,
  DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  DiscoveryArtworkError,
  DiscoverySearchService,
  type DiscoverySearchAdapter,
  type DiscoverySearchDependencies,
} from "../src/discovery/search-service.js";
import type { DiscoverySearchError } from "../src/discovery/search-service.js";
import { connectorConfigs, users } from "../src/db/schema.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-27T06:00:00.000Z");
const privateApiKey = "discovery-private-api-key";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 71),
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

function principal(kind: "operator" | "recovery" | "viewer" = "viewer"): SessionPrincipal {
  if (kind === "recovery") {
    return sessionPrincipalSchema.parse({
      absoluteExpiresAt: "2026-07-27T06:15:00.000Z",
      accountState: "recovery",
      authenticationMethod: { kind: "recovery" },
      displayName: "Recovery access",
      externalIdentity: null,
      inactivityExpiresAt: "2026-07-27T06:15:00.000Z",
      issuedAt: now.toISOString(),
      linkedServices: [],
      permissions: RECOVERY_PERMISSIONS,
      role: "admin",
      sessionId: "recovery-session",
      userId: null,
    });
  }
  const role = kind === "operator" ? "operator" : "viewer";
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-26T06:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: role === "operator" ? "Operator" : "Viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-27T07:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Viewer",
        externalUserId: "viewer-external",
        health: "linked",
        id: "viewer-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "viewer",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: "viewer-session",
    userId: "viewer-user",
  });
}

const normalizedResponse: DiscoverySearchResponse = {
  generatedAt: now.toISOString(),
  items: [
    {
      availability: "unavailable",
      id: "movie:603",
      kind: "movie",
      originalTitle: "The Matrix",
      overview: "A hacker discovers the nature of reality.",
      source: "seerr",
      title: "The Matrix",
      tmdbId: 603,
      voteAverage: 8.2,
      year: 1999,
    },
  ],
  page: 1,
  query: "matrix",
  totalPages: 1,
  totalResults: 1,
};

const normalizedDetailResponse: DiscoveryMediaDetailResponse = {
  generatedAt: now.toISOString(),
  item: {
    artwork: { backdropPath: null, posterPath: null },
    availability: "available",
    cast: [{ character: "Neo", name: "Keanu Reeves", personId: 6384, profilePath: null }],
    crew: [{ name: "Lana Wachowski", personId: 9340, role: "Director" }],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
    originalTitle: "The Matrix",
    overview: "A hacker discovers the nature of reality.",
    productionStatus: "Released",
    runtimeMinutes: 136,
    source: "seerr",
    tagline: "Free your mind.",
    title: "The Matrix",
    tmdbId: 603,
    voteAverage: 8.2,
    voteCount: 27_000,
    year: 1999,
  },
};

const normalizedPersonResponse: DiscoveryPersonDetailResponse = {
  generatedAt: now.toISOString(),
  item: {
    biography: "A performer known for precise genre work.",
    birthday: "1964-09-02",
    birthplace: "Beirut, Lebanon",
    credits: [],
    creditsState: "empty",
    creditsTotal: 0,
    deathday: null,
    department: "Acting",
    id: "person:6384",
    name: "Keanu Reeves",
    profilePath: null,
    source: "seerr",
    tmdbId: 6384,
  },
};

const normalizedPersonCreditsResponse: DiscoveryPersonCreditsResponse = {
  generatedAt: now.toISOString(),
  items: Array.from({ length: 6 }, (_, index) => ({
    availability: "available",
    kind: "movie",
    role: `Role ${index + 25}`,
    title: `Movie ${index + 25}`,
    tmdbId: 1_000 + index,
    voteAverage: 7,
    year: 2024,
  })),
  page: 2,
  pageSize: 24,
  totalPages: 2,
  totalResults: 30,
};

function insertSeerr(database: DatabaseHandle, config: AppConfig, id = "seerr-main") {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://seerr.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: "Seerr",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({
          credentials: { apiKey: privateApiKey, kind: "api_key" },
          schemaVersion: 1,
        }),
        `connector_credentials:seerr:${id}`,
      ),
      healthState: "healthy",
      id,
      type: "seerr",
      updatedAt: now,
    })
    .run();
}

function harness(
  options: {
    resolveConnectedAction?: NonNullable<DiscoverySearchDependencies["resolveConnectedAction"]>;
    withArtwork?: boolean;
    withBrowse?: boolean;
    withConnector?: boolean;
    withFeed?: boolean;
  } = {},
) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  database.db
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
  if (options.withConnector !== false) insertSeerr(database, config);
  const search = vi.fn(async () => normalizedResponse);
  const detail = vi.fn(async () => ({
    artwork: {
      backdropPath: null as string | null,
      castProfilePaths: [null] as Array<string | null>,
      posterPath: null as string | null,
    },
    response: normalizedDetailResponse,
  }));
  const personDetail = vi.fn(async () => ({
    profilePath: null as string | null,
    response: normalizedPersonResponse,
  }));
  const personCredits = vi.fn(async () => normalizedPersonCreditsResponse);
  const discover = vi.fn(async (kind: DiscoveryFeedRailKind): Promise<SeerrDiscoveryFeedPage> => ({
    items: [
      {
        artwork: {
          backdropPath: `/private/${kind}-backdrop.jpg`,
          posterPath: `/private/${kind}-poster.webp`,
        },
        media: {
          availability: kind === "upcoming" ? "unavailable" : "available",
          id: `movie:${kind.length + 100}`,
          kind: "movie",
          originalTitle: null,
          overview: `${kind} overview`,
          source: "seerr",
          title: `${kind} title`,
          tmdbId: kind.length + 100,
          voteAverage: 8.1,
          year: 2026,
        },
      },
    ],
    totalResults: 1,
  }));
  const browse = vi.fn(
    async (input: {
      kind: "movie" | "series";
      page: number;
    }): Promise<SeerrDiscoveryBrowsePage> => ({
      items: [
        {
          artwork: {
            backdropPath: "/private/browse-backdrop.jpg",
            posterPath: "/private/browse-poster.webp",
          },
          media: {
            availability: "unavailable",
            id: `${input.kind}:${input.kind === "movie" ? 603 : 1396}`,
            kind: input.kind,
            originalTitle: null,
            overview: "A bounded browse result.",
            source: "seerr",
            title: "Browse result",
            tmdbId: input.kind === "movie" ? 603 : 1396,
            voteAverage: 8.2,
            year: 1999,
          },
        },
      ],
      page: input.page,
      totalPages: 4,
      totalResults: 65,
    }),
  );
  const readDiscoveryArtwork = vi.fn(async () => ({
    body: Uint8Array.from([1, 2, 3, 4]),
    contentType: "image/webp" as const,
  }));
  const createAdapter = vi.fn((): DiscoverySearchAdapter => ({
    ...(options.withBrowse === false ? {} : { browse }),
    detail,
    ...(options.withFeed === false ? {} : { discover }),
    personDetail,
    personCredits,
    ...(options.withArtwork === false ? {} : { readDiscoveryArtwork }),
    search,
  }));
  const service = new DiscoverySearchService(database, config, {
    clock: () => now,
    createAdapter,
    ...(options.resolveConnectedAction
      ? { resolveConnectedAction: options.resolveConnectedAction }
      : {}),
  });
  return {
    config,
    browse,
    createAdapter,
    database,
    detail,
    discover,
    personDetail,
    personCredits,
    readDiscoveryArtwork,
    search,
    service,
  };
}

describe("discovery search service", () => {
  it("returns only reviewed trailer metadata without allocating artwork references", async () => {
    const { database, detail, service } = harness();
    detail.mockResolvedValueOnce({
      artwork: { backdropPath: "/private/backdrop.jpg", castProfilePaths: [], posterPath: null },
      response: {
        ...normalizedDetailResponse,
        item: {
          ...normalizedDetailResponse.item,
          cast: [],
          intelligence: {
            ...normalizedDetailResponse.item.intelligence,
            trailers: [
              {
                id: "youtube:QdBZY2fkU-0",
                provider: "youtube",
                resolution: 2160,
                title: "Official trailer",
                type: "trailer",
              },
            ],
          },
        },
      },
    });
    try {
      await expect(
        service.trailers({ kind: "movie", tmdbId: 603 }, { principal: principal() }),
      ).resolves.toEqual({
        displayName: "Seerr",
        items: [
          {
            id: "youtube:QdBZY2fkU-0",
            provider: "youtube",
            resolution: 2160,
            title: "Official trailer",
            type: "trailer",
          },
        ],
      });
      expect(detail).toHaveBeenCalledWith(
        { kind: "movie", tmdbId: 603 },
        { language: "en" },
        undefined,
      );
      expect(
        database.sqlite.prepare("select count(*) as count from discovery_artwork_references").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("normalizes browse criteria and replaces every upstream artwork path", async () => {
    const { browse, database, service } = harness();
    try {
      const response = await service.browse(
        {
          availability: "requestable",
          genre: "science-fiction",
          kind: "movie",
          locale: "en-CA",
          page: 2,
          sort: "rating",
        },
        { principal: principal() },
      );

      expect(response).toMatchObject({
        criteria: {
          availability: "requestable",
          genre: "science-fiction",
          kind: "movie",
          locale: "en-CA",
          page: 2,
          sort: "rating",
        },
        page: 2,
        totalPages: 4,
        totalResults: 65,
      });
      expect(browse).toHaveBeenCalledWith(response.criteria, undefined);
      expect(response.items[0]?.artwork.backdropPath).toMatch(
        /^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u,
      );
      expect(response.items[0]?.artwork.posterPath).toMatch(
        /^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u,
      );
      expect(JSON.stringify(response)).not.toContain("/private/");
    } finally {
      database.close();
    }
  });

  it("bounds an upstream browse page ceiling without discarding valid results", async () => {
    const { browse, database, service } = harness();
    browse.mockResolvedValueOnce({
      items: [
        {
          artwork: { backdropPath: null, posterPath: null },
          media: {
            availability: "unavailable",
            id: "movie:603",
            kind: "movie",
            originalTitle: null,
            overview: "A valid result from a very large catalogue.",
            source: "seerr",
            title: "Large catalogue result",
            tmdbId: 603,
            voteAverage: 8.2,
            year: 1999,
          },
        },
      ],
      page: 1,
      totalPages: 61_307,
      totalResults: 1_226_132,
    });
    try {
      await expect(
        service.browse(
          {
            availability: "any",
            kind: "movie",
            locale: "en-CA",
            page: 1,
            sort: "popularity",
          },
          { principal: principal() },
        ),
      ).resolves.toMatchObject({
        items: [{ id: "movie:603" }],
        page: 1,
        totalPages: 500,
        totalResults: 1_226_132,
      });
    } finally {
      database.close();
    }
  });

  it("fails closed when the connector lacks browse capability", async () => {
    const test = harness({ withBrowse: false });
    try {
      await expect(
        test.service.browse(
          { availability: "any", kind: "movie", locale: "en", page: 1, sort: "popularity" },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "connector_integrity_failure" });
    } finally {
      test.database.close();
    }
  });

  it("fans out four feed rails and replaces every upstream artwork path", async () => {
    const { database, discover, readDiscoveryArtwork, service } = harness();
    try {
      const response = await service.feed({ language: "en-CA" }, { principal: principal() });

      expect(response.state).toBe("complete");
      expect(response.rails.map(({ kind }) => kind)).toEqual([
        "trending",
        "popular_movies",
        "popular_series",
        "upcoming",
      ]);
      expect(discover).toHaveBeenCalledTimes(4);
      for (const kind of ["trending", "popular_movies", "popular_series", "upcoming"] as const) {
        expect(discover).toHaveBeenCalledWith(kind, { language: "en-CA" }, undefined);
      }
      expect(JSON.stringify(response)).not.toContain("/private/");
      const reference = response.rails[0]!.items[0]!.artwork.backdropPath;
      expect(reference).toMatch(/^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u);
      const artwork = await service.readArtwork(
        { principal: principal() },
        reference!.split("/").at(-1)!,
      );
      expect(artwork).toMatchObject({ contentType: "image/webp" });
      expect(artwork.body).toEqual(Uint8Array.from([1, 2, 3, 4]));
      expect(artwork.etag).toMatch(/^"discovery_artwork_[A-Za-z0-9_-]{22}"$/u);
      expect(readDiscoveryArtwork).toHaveBeenCalledWith(
        "/private/trending-backdrop.jpg",
        "backdrop",
        undefined,
      );
    } finally {
      database.close();
    }
  });

  it("preserves healthy rails when one feed source is unavailable", async () => {
    const test = harness();
    const upstream = new SafeConnectorError({
      code: "timeout",
      message: "private upstream timeout",
      operation: "discovery.feed.popular_series",
      retryable: true,
      service: "seerr",
    });
    test.discover.mockImplementation(async (kind) => {
      if (kind === "popular_series") throw upstream;
      return {
        items: [],
        totalResults: 0,
      };
    });
    try {
      const response = await test.service.feed({ language: "en" }, { principal: principal() });
      expect(response.state).toBe("degraded");
      expect(response.failures).toHaveLength(1);
      expect(response.failures[0]).toMatchObject({
        code: "timeout",
        operation: "discovery.feed.popular_series",
        retryable: true,
        service: "seerr",
      });
      expect(response.rails.find(({ kind }) => kind === "popular_series")).toMatchObject({
        failure: expect.objectContaining({ code: "timeout" }),
        items: [],
        totalResults: 0,
      });
      expect(JSON.stringify(response)).not.toContain("private upstream timeout");
    } finally {
      test.database.close();
    }
  });

  it("reports an unavailable feed with bounded retry guidance when every rail fails", async () => {
    const test = harness();
    test.discover.mockRejectedValue(
      new SafeConnectorError({
        code: "rate_limited",
        message: "private rate-limit response",
        operation: "private operation",
        retryAfterSeconds: 12,
        retryable: true,
        service: "seerr",
        status: 429,
      }),
    );
    try {
      const response = await test.service.feed({ language: "en" }, { principal: principal() });
      expect(response.state).toBe("unavailable");
      expect(response.failures).toHaveLength(4);
      expect(response.failures.every(({ retryAfterSeconds }) => retryAfterSeconds === 12)).toBe(
        true,
      );
      expect(
        response.failures.every(
          ({ message }) => message === "The discovery rail could not be loaded.",
        ),
      ).toBe(true);
      expect(JSON.stringify(response)).not.toContain("private rate-limit response");
      expect(JSON.stringify(response)).not.toContain("private operation");
    } finally {
      test.database.close();
    }
  });

  it("supports complete feeds whose media has no usable artwork", async () => {
    const test = harness();
    test.discover.mockImplementation(async (kind) => ({
      items: [
        {
          artwork: { backdropPath: null, posterPath: null },
          media: {
            availability: "unknown",
            id: `series:${kind.length + 200}`,
            kind: "series",
            originalTitle: null,
            overview: null,
            source: "seerr",
            title: `${kind} without artwork`,
            tmdbId: kind.length + 200,
            voteAverage: null,
            year: null,
          },
        },
      ],
      totalResults: 1,
    }));
    try {
      const response = await test.service.feed({ language: "en" }, { principal: principal() });
      expect(response.state).toBe("complete");
      expect(
        response.rails.every(({ items }) =>
          items.every(
            ({ artwork }) => artwork.backdropPath === null && artwork.posterPath === null,
          ),
        ),
      ).toBe(true);
      expect(
        test.database.sqlite
          .prepare("select count(*) as count from discovery_artwork_references")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      test.database.close();
    }
  });

  it("returns an explicit empty feed when every healthy rail has no media", async () => {
    const test = harness();
    test.discover.mockResolvedValue({ items: [], totalResults: 0 });
    try {
      const response = await test.service.feed({ language: "en" }, { principal: principal() });
      expect(response).toMatchObject({ failures: [], state: "empty" });
      expect(response.rails.every(({ failure }) => failure === null)).toBe(true);
    } finally {
      test.database.close();
    }
  });

  it("normalizes unknown feed failures while preserving cancellation", async () => {
    const test = harness();
    test.discover.mockImplementation(async (kind) => {
      if (kind === "trending") throw new Error("private unknown failure");
      return { items: [], totalResults: 0 };
    });
    try {
      const response = await test.service.feed({ language: "en" }, { principal: principal() });
      expect(response.state).toBe("degraded");
      expect(response.failures[0]).toMatchObject({
        code: "upstream_error",
        message: "The discovery rail could not be loaded.",
        retryable: false,
      });
      expect(JSON.stringify(response)).not.toContain("private unknown failure");

      const abort = new DOMException("Aborted", "AbortError");
      test.discover.mockRejectedValue(abort);
      await expect(test.service.feed({ language: "en" }, { principal: principal() })).rejects.toBe(
        abort,
      );
    } finally {
      test.database.close();
    }
  });

  it("wraps artwork failures without swallowing request cancellation", async () => {
    const test = harness();
    try {
      const feed = await test.service.feed({ language: "en" }, { principal: principal() });
      const reference = feed.rails[0]!.items[0]!.artwork.posterPath!.split("/").at(-1)!;
      test.readDiscoveryArtwork.mockRejectedValueOnce(new Error("private image failure"));
      await expect(
        test.service.readArtwork({ principal: principal() }, reference),
      ).rejects.toMatchObject({ reason: "unavailable" });

      const abort = new DOMException("Aborted", "AbortError");
      test.readDiscoveryArtwork.mockRejectedValueOnce(abort);
      await expect(test.service.readArtwork({ principal: principal() }, reference)).rejects.toBe(
        abort,
      );
    } finally {
      test.database.close();
    }
  });

  it("fails safely when a configured adapter lacks a required live-feed capability", async () => {
    const missingFeed = harness({ withFeed: false });
    try {
      await expect(
        missingFeed.service.feed({ language: "en" }, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "connector_integrity_failure" });
    } finally {
      missingFeed.database.close();
    }

    const missingArtwork = harness({ withArtwork: false });
    try {
      const feed = await missingArtwork.service.feed(
        { language: "en" },
        { principal: principal() },
      );
      const reference = feed.rails[0]!.items[0]!.artwork.backdropPath!.split("/").at(-1)!;
      await expect(
        missingArtwork.service.readArtwork({ principal: principal() }, reference),
      ).rejects.toBeInstanceOf(DiscoveryArtworkError);
    } finally {
      missingArtwork.database.close();
    }
  });

  it("authorizes and returns only normalized media details", async () => {
    const { database, detail, service } = harness();
    try {
      await expect(
        service.detail(
          { kind: "movie", tmdbId: 603 },
          { language: "en-CA" },
          { principal: principal() },
        ),
      ).resolves.toEqual(normalizedDetailResponse);
      expect(detail).toHaveBeenCalledWith(
        { kind: "movie", tmdbId: 603 },
        { language: "en-CA" },
        undefined,
      );
      expect(JSON.stringify(normalizedDetailResponse)).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("offers an exact connected-service action only to acquisition operators", async () => {
    const resolveConnectedAction = vi.fn(async () => ({
      publicUiUrl: "https://movies.example.test/radarr/",
      service: "radarr" as const,
      titleSlug: "the-matrix",
    }));
    const test = harness({ resolveConnectedAction });
    try {
      await expect(
        test.service.readConnectedActions(
          { kind: "movie", tmdbId: 603 },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
      expect(resolveConnectedAction).not.toHaveBeenCalled();

      const actions = await test.service.readConnectedActions(
        { kind: "movie", tmdbId: 603 },
        { principal: principal("operator") },
      );
      expect(actions.actions).toEqual([
        {
          href: "/v1/discovery/details/movie/603/actions/radarr",
          kind: "service_navigation",
          label: "Open in Radarr",
          service: "radarr",
        },
      ]);
      expect(resolveConnectedAction).toHaveBeenCalledWith(
        { kind: "movie", providerIds: { imdb: null, tmdb: 603 } },
        expect.any(AbortSignal),
      );
      expect(JSON.stringify(actions)).not.toContain("movies.example.test");

      await expect(
        test.service.openConnectedAction({ kind: "movie", tmdbId: 603 }, "radarr", {
          principal: principal("operator"),
        }),
      ).resolves.toEqual(new URL("https://movies.example.test/radarr/movie/the-matrix"));
      await expect(
        test.service.openConnectedAction({ kind: "movie", tmdbId: 603 }, "sonarr", {
          principal: principal("operator"),
        }),
      ).rejects.toMatchObject({ reason: "not_found" });
    } finally {
      test.database.close();
    }
  });

  it("keeps detail available when connected navigation degrades and fails redirects closed", async () => {
    const unavailable = harness({
      resolveConnectedAction: async () => {
        throw new Error("private upstream failure");
      },
    });
    try {
      await expect(
        unavailable.service.detail(
          { kind: "movie", tmdbId: 603 },
          { language: "en" },
          { principal: principal("operator") },
        ),
      ).resolves.toMatchObject({ item: { kind: "movie", tmdbId: 603 } });
      await expect(
        unavailable.service.readConnectedActions(
          { kind: "movie", tmdbId: 603 },
          { principal: principal("operator") },
        ),
      ).resolves.toMatchObject({ actions: [] });
      await expect(
        unavailable.service.openConnectedAction({ kind: "movie", tmdbId: 603 }, "radarr", {
          principal: principal("operator"),
        }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    } finally {
      unavailable.database.close();
    }

    const missing = harness({ resolveConnectedAction: async () => null });
    try {
      await expect(
        missing.service.openConnectedAction({ kind: "movie", tmdbId: 603 }, "radarr", {
          principal: principal("operator"),
        }),
      ).rejects.toMatchObject({ reason: "not_found" });
    } finally {
      missing.database.close();
    }

    const unsafe = harness({
      resolveConnectedAction: async () => ({
        publicUiUrl: "https://movies.example.test/radarr/",
        service: "radarr",
        titleSlug: "../private",
      }),
    });
    try {
      await expect(
        unsafe.service.openConnectedAction({ kind: "movie", tmdbId: 603 }, "radarr", {
          principal: principal("operator"),
        }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    } finally {
      unsafe.database.close();
    }
  });

  it("replaces title and cast artwork with user-scoped opaque references", async () => {
    const test = harness();
    test.detail.mockResolvedValueOnce({
      artwork: {
        backdropPath: "/private/title-backdrop.jpg",
        castProfilePaths: ["/private/person-profile.jpg"],
        posterPath: "/private/title-poster.jpg",
      },
      response: normalizedDetailResponse,
    });
    try {
      const response = await test.service.detail(
        { kind: "movie", tmdbId: 603 },
        { language: "en" },
        { principal: principal() },
      );
      expect(response.item.artwork.backdropPath).toMatch(
        /^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u,
      );
      expect(response.item.artwork.posterPath).toMatch(
        /^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u,
      );
      expect(response.item.cast[0]?.profilePath).toMatch(
        /^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u,
      );
      expect(JSON.stringify(response)).not.toContain("/private/");

      const profileReference = response.item.cast[0]!.profilePath!.split("/").at(-1)!;
      await test.service.readArtwork({ principal: principal() }, profileReference);
      expect(test.readDiscoveryArtwork).toHaveBeenLastCalledWith(
        "/private/person-profile.jpg",
        "profile",
        undefined,
      );
    } finally {
      test.database.close();
    }
  });

  it("authorizes and returns only normalized person context", async () => {
    const { database, personDetail, service } = harness();
    try {
      await expect(
        service.personDetail({ tmdbId: 6384 }, { language: "en-CA" }, { principal: principal() }),
      ).resolves.toEqual(normalizedPersonResponse);
      expect(personDetail).toHaveBeenCalledWith({ tmdbId: 6384 }, { language: "en-CA" }, undefined);
      expect(JSON.stringify(normalizedPersonResponse)).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("authorizes and returns one bounded person-credit page", async () => {
    const { database, personCredits, service } = harness();
    try {
      await expect(
        service.personCredits(
          { tmdbId: 6384 },
          { language: "en-CA", page: 2 },
          { principal: principal() },
        ),
      ).resolves.toEqual(normalizedPersonCreditsResponse);
      expect(personCredits).toHaveBeenCalledWith(
        { tmdbId: 6384 },
        { language: "en-CA", page: 2 },
        undefined,
      );
    } finally {
      database.close();
    }
  });

  it("proxies a person portrait without exposing its upstream path", async () => {
    const test = harness();
    test.personDetail.mockResolvedValueOnce({
      profilePath: "/private/person-portrait.webp",
      response: normalizedPersonResponse,
    });
    try {
      const response = await test.service.personDetail(
        { tmdbId: 6384 },
        { language: "en" },
        { principal: principal() },
      );
      expect(response.item.profilePath).toMatch(
        /^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u,
      );
      expect(JSON.stringify(response)).not.toContain("/private/");
    } finally {
      test.database.close();
    }
  });

  it("decrypts one enabled Seerr connector and returns only normalized results", async () => {
    const { createAdapter, database, search, service } = harness();
    try {
      const response = await service.search(
        { language: "en-CA", page: 1, query: "  matrix  " },
        { principal: principal() },
      );

      expect(response).toEqual(normalizedResponse);
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: privateApiKey,
          baseUrl: "https://seerr.example.test/",
          connectorId: "seerr-main",
          tlsPolicy: "strict",
        }),
      );
      expect(search).toHaveBeenCalledWith(
        { language: "en-CA", page: 1, query: "matrix" },
        undefined,
      );
      expect(JSON.stringify(response)).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("authorizes media access before reading connector state", async () => {
    const { database, service } = harness({ withConnector: false });
    try {
      await expect(
        service.search(
          { language: "en", page: 1, query: "matrix" },
          { principal: principal("recovery") },
        ),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
    } finally {
      database.close();
    }
  });

  it("authorizes person context before reading connector state", async () => {
    const { database, service } = harness({ withConnector: false });
    try {
      await expect(
        service.personDetail(
          { tmdbId: 6384 },
          { language: "en" },
          { principal: principal("recovery") },
        ),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
    } finally {
      database.close();
    }
  });

  it("reports missing and ambiguous enabled discovery connectors safely", async () => {
    const missing = harness({ withConnector: false });
    try {
      await expect(
        missing.service.search(
          { language: "en", page: 1, query: "matrix" },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "connector_unconfigured" });
    } finally {
      missing.database.close();
    }

    const ambiguous = harness();
    try {
      insertSeerr(ambiguous.database, ambiguous.config, "seerr-secondary");
      await expect(
        ambiguous.service.search(
          { language: "en", page: 1, query: "matrix" },
          { principal: principal() },
        ),
      ).rejects.toMatchObject({ reason: "connector_ambiguous" });
    } finally {
      ambiguous.database.close();
    }
  });

  it("does not expose corrupted encrypted connector material", async () => {
    const { database, service } = harness();
    const privateValue = "corrupted-private-material";
    try {
      database.sqlite
        .prepare("update connector_configs set encrypted_credentials = ? where id = 'seerr-main'")
        .run(privateValue);
      let failure: unknown;
      try {
        await service.search(
          { language: "en", page: 1, query: "matrix" },
          { principal: principal() },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject<Partial<DiscoverySearchError>>({
        reason: "connector_integrity_failure",
      });
      expect(JSON.stringify(failure)).not.toContain(privateValue);
    } finally {
      database.close();
    }
  });
});
