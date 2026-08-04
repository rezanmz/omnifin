import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  ConnectedServiceNavigationError,
  ConnectedServiceNavigationService,
  connectedServiceDestination,
} from "../src/connectors/service-navigation.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-04T12:00:00.000Z");
const privateApiKey = "private-service-navigation-key";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 82),
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

function insertConnector(
  database: DatabaseHandle,
  config: AppConfig,
  input: {
    id: string;
    publicUiUrl?: string | null;
    type: "radarr" | "sonarr";
  },
) {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: `https://${input.id}.example.test/`,
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: input.type === "radarr" ? "Radarr" : "Sonarr",
      enabled: true,
      encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
        JSON.stringify({
          credentials: { apiKey: privateApiKey, kind: "api_key" },
          schemaVersion: 1,
        }),
        `connector_credentials:${input.type}:${input.id}`,
      ),
      healthState: "healthy",
      id: input.id,
      publicUiUrl: input.publicUiUrl ?? null,
      type: input.type,
      updatedAt: now,
    })
    .run();
}

function harness() {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  return { config, database };
}

describe("connected service navigation", () => {
  it("resolves one exact Radarr title without exposing connector credentials", async () => {
    const { config, database } = harness();
    insertConnector(database, config, {
      id: "radarr-main",
      publicUiUrl: "https://media.example.test/radarr/",
      type: "radarr",
    });
    const resolveLibraryMovieNavigation = vi.fn(async () => ({
      mediaId: 42,
      titleSlug: "the-matrix",
    }));
    const createRadarrAdapter = vi.fn(() => ({ resolveLibraryMovieNavigation }));
    const service = new ConnectedServiceNavigationService(database, config, {
      clock: () => now,
      createRadarrAdapter,
    });
    try {
      await expect(
        service.resolve({
          kind: "movie",
          providerIds: { imdb: "tt0133093", tmdb: 603 },
        }),
      ).resolves.toEqual({
        publicUiUrl: "https://media.example.test/radarr/",
        service: "radarr",
        titleSlug: "the-matrix",
      });
      expect(resolveLibraryMovieNavigation).toHaveBeenCalledWith(
        { imdb: "tt0133093", tmdb: 603 },
        undefined,
      );
      expect(createRadarrAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: privateApiKey,
          baseUrl: "https://radarr-main.example.test/",
          connectorId: "radarr-main",
        }),
      );
    } finally {
      database.close();
    }
  });

  it("resolves one exact Sonarr series and returns null for missing mappings", async () => {
    const { config, database } = harness();
    insertConnector(database, config, {
      id: "sonarr-main",
      publicUiUrl: "https://media.example.test/sonarr/",
      type: "sonarr",
    });
    const resolveLibrarySeriesNavigation = vi
      .fn()
      .mockResolvedValueOnce({ mediaId: 17, titleSlug: "northern-lights" })
      .mockResolvedValueOnce(null);
    const service = new ConnectedServiceNavigationService(database, config, {
      createSonarrAdapter: () => ({ resolveLibrarySeriesNavigation }),
    });
    try {
      await expect(
        service.resolve({ kind: "series", providerIds: { tmdb: 13_963, tvdb: null } }),
      ).resolves.toMatchObject({ service: "sonarr", titleSlug: "northern-lights" });
      await expect(
        service.resolve({ kind: "series", providerIds: { tmdb: 98_765, tvdb: null } }),
      ).resolves.toBeNull();
      await expect(
        service.resolve({ kind: "series", providerIds: { tmdb: null, tvdb: null } }),
      ).resolves.toBeNull();
      expect(resolveLibrarySeriesNavigation).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("returns null when no browser-facing service is configured", async () => {
    const { config, database } = harness();
    insertConnector(database, config, { id: "radarr-main", type: "radarr" });
    const createRadarrAdapter = vi.fn();
    const service = new ConnectedServiceNavigationService(database, config, {
      createRadarrAdapter,
    });
    try {
      await expect(
        service.resolve({ kind: "movie", providerIds: { imdb: null, tmdb: 603 } }),
      ).resolves.toBeNull();
      expect(createRadarrAdapter).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("rejects ambiguous mappings and corrupted encrypted connector material", async () => {
    const ambiguous = harness();
    insertConnector(ambiguous.database, ambiguous.config, {
      id: "radarr-first",
      publicUiUrl: "https://first.example.test/radarr/",
      type: "radarr",
    });
    insertConnector(ambiguous.database, ambiguous.config, {
      id: "radarr-second",
      publicUiUrl: "https://second.example.test/radarr/",
      type: "radarr",
    });
    try {
      const service = new ConnectedServiceNavigationService(ambiguous.database, ambiguous.config, {
        createRadarrAdapter: () => ({
          resolveLibraryMovieNavigation: async () => ({
            mediaId: 42,
            titleSlug: "the-matrix",
          }),
        }),
      });
      await expect(
        service.resolve({ kind: "movie", providerIds: { imdb: null, tmdb: 603 } }),
      ).rejects.toBeInstanceOf(ConnectedServiceNavigationError);
    } finally {
      ambiguous.database.close();
    }

    const corrupted = harness();
    insertConnector(corrupted.database, corrupted.config, {
      id: "sonarr-main",
      publicUiUrl: "https://media.example.test/sonarr/",
      type: "sonarr",
    });
    corrupted.database.sqlite
      .prepare("update connector_configs set encrypted_credentials = ? where id = ?")
      .run("private-corrupted-material", "sonarr-main");
    try {
      const service = new ConnectedServiceNavigationService(corrupted.database, corrupted.config);
      let failure: unknown;
      try {
        await service.resolve({
          kind: "series",
          providerIds: { tmdb: 13_963, tvdb: null },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConnectedServiceNavigationError);
      expect(JSON.stringify(failure)).not.toContain("private-corrupted-material");
    } finally {
      corrupted.database.close();
    }
  });

  it("constructs only the expected bounded service destination", () => {
    expect(
      connectedServiceDestination(
        {
          publicUiUrl: "https://media.example.test/radarr/",
          service: "radarr",
          titleSlug: "the-matrix",
        },
        "radarr",
      ).href,
    ).toBe("https://media.example.test/radarr/movie/the-matrix");
    expect(() =>
      connectedServiceDestination(
        {
          publicUiUrl: "https://media.example.test/radarr/",
          service: "radarr",
          titleSlug: "../private",
        },
        "radarr",
      ),
    ).toThrow(ConnectedServiceNavigationError);
    expect(() =>
      connectedServiceDestination(
        {
          publicUiUrl: "https://media.example.test/sonarr/",
          service: "sonarr",
          titleSlug: "northern-lights",
        },
        "radarr",
      ),
    ).toThrow(ConnectedServiceNavigationError);
  });
});
