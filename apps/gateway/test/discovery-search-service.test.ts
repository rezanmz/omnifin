import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type {
  DiscoveryMediaDetailResponse,
  DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { DiscoverySearchService } from "../src/discovery/search-service.js";
import type { DiscoverySearchError } from "../src/discovery/search-service.js";
import { connectorConfigs } from "../src/db/schema.js";
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

function principal(kind: "recovery" | "viewer" = "viewer"): SessionPrincipal {
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
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-26T06:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Viewer",
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
    permissions: ROLE_PERMISSIONS.viewer,
    role: "viewer",
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
    availability: "available",
    cast: [{ character: "Neo", name: "Keanu Reeves" }],
    crew: [{ name: "Lana Wachowski", role: "Director" }],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
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

function harness(options: { withConnector?: boolean } = {}) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  if (options.withConnector !== false) insertSeerr(database, config);
  const search = vi.fn(async () => normalizedResponse);
  const detail = vi.fn(async () => normalizedDetailResponse);
  const createAdapter = vi.fn(() => ({ detail, search }));
  const service = new DiscoverySearchService(database, config, {
    clock: () => now,
    createAdapter,
  });
  return { config, createAdapter, database, detail, search, service };
}

describe("discovery search service", () => {
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
