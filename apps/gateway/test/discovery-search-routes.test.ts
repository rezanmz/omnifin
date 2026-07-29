import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  discoveryMediaDetailResponseSchema,
  type DiscoveryMediaDetailResponse,
  discoveryPersonDetailResponseSchema,
  type DiscoveryPersonDetailResponse,
  discoverySearchResponseSchema,
  type DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-27T06:30:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 79),
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
    createId: () => `discovery-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

const normalizedResponse: DiscoverySearchResponse = {
  generatedAt: now.toISOString(),
  items: [
    {
      availability: "available",
      id: "series:1396",
      kind: "series",
      originalTitle: "Breaking Bad",
      overview: "A chemistry teacher turns to manufacturing.",
      source: "seerr",
      title: "Breaking Bad",
      tmdbId: 1396,
      voteAverage: 8.9,
      year: 2008,
    },
  ],
  page: 1,
  query: "breaking bad",
  totalPages: 1,
  totalResults: 1,
};

const normalizedDetailResponse: DiscoveryMediaDetailResponse = {
  generatedAt: now.toISOString(),
  item: {
    availability: "available",
    cast: [],
    crew: [{ name: "Vince Gilligan", personId: 66633, role: "Creator" }],
    episodeCount: 62,
    genres: ["Drama"],
    id: "series:1396",
    kind: "series",
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
    originalTitle: "Breaking Bad",
    overview: "A chemistry teacher turns to manufacturing.",
    productionStatus: "Ended",
    runtimeMinutes: 48,
    seasonCount: 5,
    seasons: [{ episodeCount: 7, number: 1, title: "Season 1", year: 2008 }],
    source: "seerr",
    tagline: "All bad things must come to an end.",
    title: "Breaking Bad",
    tmdbId: 1396,
    voteAverage: 8.9,
    voteCount: 15_000,
    year: 2008,
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
    deathday: null,
    department: "Acting",
    id: "person:6384",
    name: "Keanu Reeves",
    source: "seerr",
    tmdbId: 6384,
  },
};

async function harness(
  searchImplementation = vi.fn(async () => normalizedResponse),
  personDetailImplementation = vi.fn(async () => normalizedPersonResponse),
) {
  const config = testConfig();
  const detailImplementation = vi.fn(async () => normalizedDetailResponse);
  const app = await createApp({
    config,
    discoverySearchDependencies: {
      clock: () => now,
      createAdapter: () => ({
        detail: detailImplementation,
        personDetail: personDetailImplementation,
        search: searchImplementation,
      }),
    },
    sessionDependencies: sessionDependencies(),
  });
  app.database.db
    .insert(connectorConfigs)
    .values([
      {
        baseUrl: "https://jellyfin.example.test/",
        capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
        createdAt: now,
        displayName: "Jellyfin",
        enabled: true,
        encryptedCredentials: "v2.fixture-jellyfin-credentials",
        healthState: "healthy",
        id: "jellyfin-main",
        type: "jellyfin",
        updatedAt: now,
      },
      {
        baseUrl: "https://seerr.example.test/",
        capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
        createdAt: now,
        displayName: "Seerr",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: "route-private-api-key", kind: "api_key" },
            schemaVersion: 1,
          }),
          "connector_credentials:seerr:seerr-main",
        ),
        healthState: "healthy",
        id: "seerr-main",
        type: "seerr",
        updatedAt: now,
      },
    ])
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
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Viewer",
      externalServerId: "jellyfin-server",
      externalUserId: "viewer-external",
      externalUsername: "viewer",
      healthState: "linked",
      id: "viewer-link",
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "viewer-user",
    })
    .run();
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  const recovery = app.sessionService.createSession({
    attribution: { authMethod: "recovery" },
  });
  return {
    app,
    detailImplementation,
    personDetailImplementation,
    recovery,
    searchImplementation,
    session,
  };
}

describe("discovery search routes", () => {
  it("serves private normalized details through a bounded media route", async () => {
    const { app, detailImplementation, recovery, session } = await harness();
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/discovery/details/series/1396",
      });
      expect(anonymous.statusCode).toBe(401);

      const deniedRecovery = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/details/series/1396",
      });
      expect(deniedRecovery.statusCode).toBe(403);

      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/details/series/1396?language=en-CA",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(discoveryMediaDetailResponseSchema.parse(response.json())).toEqual(
        normalizedDetailResponse,
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain("route-private-api-key");
      expect(detailImplementation).toHaveBeenCalledWith(
        { kind: "series", tmdbId: 1396 },
        { language: "en-CA" },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects invalid detail identifiers before invoking Seerr", async () => {
    const { app, detailImplementation, session } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/details/person/287",
      });
      expect(response.statusCode).toBe(400);
      expect(detailImplementation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serves a normalized person biography without upstream identifiers", async () => {
    const { app, personDetailImplementation, session } = await harness();
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/discovery/people/6384",
      });
      expect(anonymous.statusCode).toBe(401);

      const invalid = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/people/0",
      });
      expect(invalid.statusCode).toBe(400);
      expect(personDetailImplementation).not.toHaveBeenCalled();

      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/people/6384?language=en-CA",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(discoveryPersonDetailResponseSchema.parse(response.json())).toEqual(
        normalizedPersonResponse,
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain("route-private-api-key");
      expect(personDetailImplementation).toHaveBeenCalledWith(
        { tmdbId: 6384 },
        { language: "en-CA" },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("requires an active media session and returns a private normalized response", async () => {
    const { app, recovery, searchImplementation, session } = await harness();
    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/v1/discovery/search?query=breaking%20bad",
      });
      expect(anonymous.statusCode).toBe(401);

      const deniedRecovery = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${recovery.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/search?query=breaking%20bad",
      });
      expect(deniedRecovery.statusCode).toBe(403);

      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/search?query=breaking%20bad&language=en-CA&page=1",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(discoverySearchResponseSchema.parse(response.json())).toEqual(normalizedResponse);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toContain("route-private-api-key");
      expect(searchImplementation).toHaveBeenCalledWith(
        { language: "en-CA", page: 1, query: "breaking bad" },
        expect.any(AbortSignal),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects short queries before invoking the upstream connector", async () => {
    const { app, searchImplementation, session } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/search?query=x",
      });
      expect(response.statusCode).toBe(400);
      expect(searchImplementation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("distinguishes unconfigured discovery from upstream unavailability", async () => {
    const { app, session } = await harness();
    try {
      app.database.sqlite
        .prepare("update connector_configs set enabled = 0 where id = 'seerr-main'")
        .run();
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/search?query=matrix",
      });
      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("discovery_not_configured");
    } finally {
      await app.close();
    }
  });

  it("preserves bounded upstream retry guidance without leaking connector errors", async () => {
    const upstream = new SafeConnectorError({
      code: "rate_limited",
      message: "Private upstream details",
      operation: "discovery.search",
      retryAfterSeconds: 30,
      retryable: true,
      service: "seerr",
      status: 429,
    });
    const { app, session } = await harness(vi.fn(async () => Promise.reject(upstream)));
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/search?query=matrix",
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("30");
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("discovery_rate_limited");
      expect(response.body).not.toContain("Private upstream details");
    } finally {
      await app.close();
    }
  });

  it("normalizes person-service rate limits without exposing upstream details", async () => {
    const upstream = new SafeConnectorError({
      code: "rate_limited",
      message: "Private person upstream details",
      operation: "discovery.person_detail",
      retryable: true,
      service: "seerr",
      status: 429,
    });
    const { app, session } = await harness(
      undefined,
      vi.fn(async () => Promise.reject(upstream)),
    );
    try {
      const response = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
        method: "GET",
        url: "/v1/discovery/people/6384",
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBeUndefined();
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("discovery_rate_limited");
      expect(response.body).not.toContain("Private person upstream details");
    } finally {
      await app.close();
    }
  });
});
