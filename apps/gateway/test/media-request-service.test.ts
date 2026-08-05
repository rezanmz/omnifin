import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { MediaRequestResponse } from "@omnifin/contracts/requests";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import {
  MediaRequestService,
  type MediaRequestAdapter,
  type MediaRequestFailureCode,
} from "../src/requests/media-request-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-27T16:30:00.000Z");
const privateApiKey = "request-private-api-key";

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

function principal(
  role: "admin" | "requester" | "viewer" = "requester",
  userId = "viewer-user",
  linkId = "viewer-link",
): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-26T16:30:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-27T17:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Viewer",
        externalUserId: "jellyfin-user-1",
        health: "linked",
        id: linkId,
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "viewer",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${userId}-${role}-session`,
    userId,
  });
}

const createdRequest: MediaRequestResponse = {
  createdAt: now.toISOString(),
  id: "request:91",
  is4k: false,
  kind: "series",
  qualityProfile: "1080p",
  seasons: [1, 3],
  source: "seerr",
  status: "approved",
  tmdbId: 1399,
};

function insertFoundation(database: DatabaseHandle, config: AppConfig) {
  database.db
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
        capabilitySnapshotJson: JSON.stringify({
          health: {
            capabilities: [
              "connector.health",
              "connector.version",
              "request.configure",
              "request.create",
            ],
            checkedAt: now.toISOString(),
            connectorId: "seerr-main",
            displayName: "Seerr",
            failure: null,
            latencyMs: 12,
            service: "seerr",
            status: "healthy",
            version: "2.7.3",
          },
          schemaVersion: 1,
        }),
        createdAt: now,
        displayName: "Seerr",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: privateApiKey, kind: "api_key" },
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
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Viewer",
      id: "viewer-user",
      role: "requester",
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
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Viewer",
      externalServerId: "jellyfin-server",
      externalUserId: "jellyfin-user-1",
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
}

function harness(
  options: {
    clock?: () => Date;
    createMediaRequest?: MediaRequestAdapter["createMediaRequest"];
    listRequestRouting?: MediaRequestAdapter["listRequestRouting"];
    resolveUser?: MediaRequestAdapter["resolveUser"];
  } = {},
) {
  const config = testConfig();
  const database = openDatabase(":memory:");
  database.migrate();
  insertFoundation(database, config);
  const resolveUser =
    options.resolveUser ?? vi.fn<MediaRequestAdapter["resolveUser"]>(async () => 42);
  const createMediaRequest =
    options.createMediaRequest ??
    vi.fn<MediaRequestAdapter["createMediaRequest"]>(async () => createdRequest);
  const listRequestRouting =
    options.listRequestRouting ??
    vi.fn<MediaRequestAdapter["listRequestRouting"]>(async (kind, is4k) => ({
      destinations: [
        {
          activeDirectory: "/srv/media/movies",
          activeLanguageProfileId: null,
          activeProfileId: 4,
          id: 1,
          isDefault: true,
          label: "Cinema",
          languageProfiles: [],
          profiles: [{ id: 4, label: "1080p" }],
          rootFolders: [
            {
              availableBytes: 800_000_000_000,
              capacityBytes: 2_000_000_000_000,
              path: "/srv/media/movies",
            },
          ],
        },
      ],
      failures: [],
      is4k,
      kind,
    }));
  let id = 0;
  const service = new MediaRequestService(database, config, {
    clock: options.clock ?? (() => now),
    createAdapter: vi.fn(() => ({ createMediaRequest, listRequestRouting, resolveUser })),
    createId: () => `media-request-id-${String(++id).padStart(2, "0")}`,
  });
  return { createMediaRequest, database, listRequestRouting, resolveUser, service };
}

const context = () => ({
  ipAddress: "203.0.113.8",
  principal: principal(),
  requestId: "request-correlation-01",
});

describe("media request service", () => {
  it("issues path-safe routing references and resolves them only inside the gateway", async () => {
    const { createMediaRequest, database, listRequestRouting, resolveUser, service } = harness();
    try {
      const options = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      const destination = options.destinations[0]!;
      expect(destination).toMatchObject({
        isDefault: true,
        label: "Cinema",
        service: "radarr",
      });
      expect(destination.rootFolders[0]).toMatchObject({
        availableBytes: 800_000_000_000,
        isDefault: true,
        label: "movies",
      });
      expect(JSON.stringify(options)).not.toContain("/srv/media");
      expect(listRequestRouting).toHaveBeenCalledWith("movie", false, undefined);

      const routing = {
        destination: destination.id,
        languageProfile: null,
        qualityProfile: destination.qualityProfiles[0]!.id,
        rootFolder: destination.rootFolders[0]!.id,
      };
      await service.create(
        { is4k: false, kind: "movie", routing, tmdbId: 550 },
        "request-key-routing-01",
        context(),
      );

      expect(resolveUser).toHaveBeenCalledTimes(2);
      expect(createMediaRequest).toHaveBeenCalledWith(
        { is4k: false, kind: "movie", tmdbId: 550 },
        42,
        undefined,
        { profileId: 4, rootFolder: "/srv/media/movies", serverId: 1 },
      );
    } finally {
      database.close();
    }
  });

  it("rejects a profile removed after selection before contacting Seerr", async () => {
    let catalogLoad = 0;
    const listRequestRouting = vi.fn<MediaRequestAdapter["listRequestRouting"]>(
      async (kind, is4k) => {
        catalogLoad += 1;
        return {
          destinations: [
            {
              activeDirectory: "/srv/media/movies",
              activeLanguageProfileId: null,
              activeProfileId: catalogLoad === 1 ? 4 : 7,
              id: 1,
              isDefault: true,
              label: "Cinema",
              languageProfiles: [],
              profiles:
                catalogLoad === 1 ? [{ id: 4, label: "1080p" }] : [{ id: 7, label: "Balanced" }],
              rootFolders: [
                {
                  availableBytes: null,
                  capacityBytes: null,
                  path: "/srv/media/movies",
                },
              ],
            },
          ],
          failures: [],
          is4k,
          kind,
        };
      },
    );
    const { createMediaRequest, database, service } = harness({ listRequestRouting });
    try {
      const options = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      const destination = options.destinations[0]!;

      await expect(
        service.create(
          {
            is4k: false,
            kind: "movie",
            routing: {
              destination: destination.id,
              languageProfile: null,
              qualityProfile: destination.qualityProfiles[0]!.id,
              rootFolder: destination.rootFolders[0]!.id,
            },
            tmdbId: 550,
          },
          "request-key-routing-removed",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "routing_invalid" });
      expect(listRequestRouting).toHaveBeenCalledTimes(2);
      expect(createMediaRequest).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("returns and audits the current upstream profile label after a rename", async () => {
    let catalogLoad = 0;
    const listRequestRouting = vi.fn<MediaRequestAdapter["listRequestRouting"]>(
      async (kind, is4k) => {
        catalogLoad += 1;
        return {
          destinations: [
            {
              activeDirectory: "/srv/media/movies",
              activeLanguageProfileId: null,
              activeProfileId: 4,
              id: 1,
              isDefault: true,
              label: "Cinema",
              languageProfiles: [],
              profiles: [{ id: 4, label: catalogLoad === 1 ? "1080p" : "Balanced" }],
              rootFolders: [
                {
                  availableBytes: null,
                  capacityBytes: null,
                  path: "/srv/media/movies",
                },
              ],
            },
          ],
          failures: [],
          is4k,
          kind,
        };
      },
    );
    const { database, service } = harness({ listRequestRouting });
    try {
      const options = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      const destination = options.destinations[0]!;
      const result = await service.create(
        {
          is4k: false,
          kind: "movie",
          routing: {
            destination: destination.id,
            languageProfile: null,
            qualityProfile: destination.qualityProfiles[0]!.id,
            rootFolder: destination.rootFolders[0]!.id,
          },
          tmdbId: 550,
        },
        "request-key-routing-renamed",
        context(),
      );

      expect(result.request.qualityProfile).toBe("Balanced");
      const audit = database.sqlite
        .prepare(
          "select metadata_json as metadataJson from audit_events where event_type = 'media.request.created'",
        )
        .get() as { metadataJson: string };
      expect(JSON.parse(audit.metadataJson)).toMatchObject({ qualityProfile: "Balanced" });
    } finally {
      database.close();
    }
  });

  it("applies an administrator profile preference without persisting browser references", async () => {
    const listRequestRouting = vi.fn<MediaRequestAdapter["listRequestRouting"]>(
      async (kind, is4k) => ({
        destinations: [
          {
            activeDirectory: "/srv/media/movies",
            activeLanguageProfileId: null,
            activeProfileId: 4,
            id: 1,
            isDefault: true,
            label: "Cinema",
            languageProfiles: [],
            profiles: [
              { id: 4, label: "1080p" },
              { id: 7, label: "Balanced" },
            ],
            rootFolders: [
              {
                availableBytes: null,
                capacityBytes: null,
                path: "/srv/media/movies",
              },
            ],
          },
        ],
        failures: [],
        is4k,
        kind,
      }),
    );
    const { database, service } = harness({ listRequestRouting });
    try {
      const adminContext = { ...context(), principal: principal("admin") };
      const initial = await service.routingOptions({ is4k: false, kind: "movie" }, adminContext);
      const destination = initial.destinations[0]!;
      await service.setRoutingPreference(
        {
          is4k: false,
          kind: "movie",
          routing: {
            destination: destination.id,
            languageProfile: null,
            qualityProfile: destination.qualityProfiles[1]!.id,
            rootFolder: destination.rootFolders[0]!.id,
          },
        },
        adminContext,
      );

      const preferred = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      expect(preferred.destinations[0]?.qualityProfiles).toEqual([
        expect.objectContaining({ isDefault: false, label: "1080p" }),
        expect.objectContaining({ isDefault: true, label: "Balanced" }),
      ]);
      const stored = database.sqlite
        .prepare(
          "select connector_id as connectorId, destination_id as destinationId, profile_id as profileId from media_request_profile_preferences",
        )
        .get();
      expect(stored).toEqual({ connectorId: "seerr-main", destinationId: 1, profileId: 7 });
      expect(JSON.stringify(stored)).not.toContain("routing-v1");
    } finally {
      database.close();
    }
  });

  it("falls back to the current upstream default when a saved profile is removed", async () => {
    let includePreferredProfile = true;
    const listRequestRouting = vi.fn<MediaRequestAdapter["listRequestRouting"]>(
      async (kind, is4k) => ({
        destinations: [
          {
            activeDirectory: "/srv/media/movies",
            activeLanguageProfileId: null,
            activeProfileId: 4,
            id: 1,
            isDefault: true,
            label: "Cinema",
            languageProfiles: [],
            profiles: [
              { id: 4, label: "1080p" },
              ...(includePreferredProfile ? [{ id: 7, label: "Balanced" }] : []),
            ],
            rootFolders: [
              {
                availableBytes: null,
                capacityBytes: null,
                path: "/srv/media/movies",
              },
            ],
          },
        ],
        failures: [],
        is4k,
        kind,
      }),
    );
    const { database, service } = harness({ listRequestRouting });
    try {
      const adminContext = { ...context(), principal: principal("admin") };
      const initial = await service.routingOptions({ is4k: false, kind: "movie" }, adminContext);
      const destination = initial.destinations[0]!;
      await service.setRoutingPreference(
        {
          is4k: false,
          kind: "movie",
          routing: {
            destination: destination.id,
            languageProfile: null,
            qualityProfile: destination.qualityProfiles[1]!.id,
            rootFolder: destination.rootFolders[0]!.id,
          },
        },
        adminContext,
      );

      includePreferredProfile = false;
      const fallback = await service.routingOptions({ is4k: false, kind: "movie" }, context());

      expect(fallback.destinations[0]?.qualityProfiles).toEqual([
        expect.objectContaining({ isDefault: true, label: "1080p" }),
      ]);
    } finally {
      database.close();
    }
  });

  it("disambiguates duplicate terminal storage labels without exposing parent paths", async () => {
    const listRequestRouting = vi.fn<MediaRequestAdapter["listRequestRouting"]>(
      async (kind, is4k) => ({
        destinations: [
          {
            activeDirectory: "/srv/primary/movies",
            activeLanguageProfileId: null,
            activeProfileId: 4,
            id: 1,
            isDefault: true,
            label: "Cinema",
            languageProfiles: [],
            profiles: [{ id: 4, label: "1080p" }],
            rootFolders: [
              {
                availableBytes: null,
                capacityBytes: null,
                path: "/srv/primary/movies",
              },
              {
                availableBytes: null,
                capacityBytes: null,
                path: "/mnt/archive/movies",
              },
            ],
          },
        ],
        failures: [],
        is4k,
        kind,
      }),
    );
    const { database, service } = harness({ listRequestRouting });
    try {
      const options = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      expect(options.destinations[0]?.rootFolders.map((folder) => folder.label)).toEqual([
        "movies · 1",
        "movies · 2",
      ]);
      expect(JSON.stringify(options)).not.toMatch(/\/srv\/|\/mnt\//u);
    } finally {
      database.close();
    }
  });

  it("rejects a modified routing reference without contacting Seerr", async () => {
    const { createMediaRequest, database, service } = harness();
    try {
      const options = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      const destination = options.destinations[0]!;
      const rootReference = destination.rootFolders[0]!.id;
      const modifiedRoot = `${rootReference.slice(0, -1)}${rootReference.endsWith("A") ? "B" : "A"}`;
      await expect(
        service.create(
          {
            is4k: false,
            kind: "movie",
            routing: {
              destination: destination.id,
              languageProfile: null,
              qualityProfile: destination.qualityProfiles[0]!.id,
              rootFolder: modifiedRoot,
            },
            tmdbId: 550,
          },
          "request-key-routing-02",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "routing_invalid" });
      expect(createMediaRequest).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("expires routing references and rejects reuse across format intent", async () => {
    let clock = new Date(now);
    const { createMediaRequest, database, service } = harness({ clock: () => clock });
    try {
      const expiredOptions = await service.routingOptions(
        { is4k: false, kind: "movie" },
        context(),
      );
      const expiredDestination = expiredOptions.destinations[0]!;
      clock = new Date(now.getTime() + 15 * 60 * 1_000);
      await expect(
        service.create(
          {
            is4k: false,
            kind: "movie",
            routing: {
              destination: expiredDestination.id,
              languageProfile: null,
              qualityProfile: expiredDestination.qualityProfiles[0]!.id,
              rootFolder: expiredDestination.rootFolders[0]!.id,
            },
            tmdbId: 550,
          },
          "request-key-routing-expired",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "routing_invalid" });

      const formatOptions = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      const formatDestination = formatOptions.destinations[0]!;
      await expect(
        service.create(
          {
            is4k: true,
            kind: "movie",
            routing: {
              destination: formatDestination.id,
              languageProfile: null,
              qualityProfile: formatDestination.qualityProfiles[0]!.id,
              rootFolder: formatDestination.rootFolders[0]!.id,
            },
            tmdbId: 550,
          },
          "request-key-routing-format",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "routing_invalid" });
      expect(createMediaRequest).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("binds routing references to the requesting local user", async () => {
    const { createMediaRequest, database, service } = harness();
    try {
      const options = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      database.db
        .insert(users)
        .values({
          createdAt: now,
          displayName: "Alternate viewer",
          id: "alternate-user",
          role: "requester",
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
          deviceId: "alternate-device",
          encryptedAccessToken: "v2.fixture-alternate-access-token",
          externalDisplayName: "Alternate viewer",
          externalServerId: "jellyfin-server",
          externalUserId: "jellyfin-user-2",
          externalUsername: "alternate",
          healthState: "linked",
          id: "alternate-link",
          lastVerifiedAt: now,
          service: "jellyfin",
          tokenCreatedAt: now,
          updatedAt: now,
          userId: "alternate-user",
        })
        .run();
      const alternatePrincipal = principal("requester", "alternate-user", "alternate-link");
      alternatePrincipal.linkedServices[0]!.externalUserId = "jellyfin-user-2";
      alternatePrincipal.linkedServices[0]!.username = "alternate";
      const destination = options.destinations[0]!;

      await expect(
        service.create(
          {
            is4k: false,
            kind: "movie",
            routing: {
              destination: destination.id,
              languageProfile: null,
              qualityProfile: destination.qualityProfiles[0]!.id,
              rootFolder: destination.rootFolders[0]!.id,
            },
            tmdbId: 550,
          },
          "request-key-routing-user",
          { ...context(), principal: alternatePrincipal },
        ),
      ).rejects.toMatchObject({ reason: "routing_invalid" });
      expect(createMediaRequest).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("rejects routing references replayed by another session for the same user", async () => {
    const { createMediaRequest, database, service } = harness();
    try {
      const options = await service.routingOptions({ is4k: false, kind: "movie" }, context());
      const destination = options.destinations[0]!;
      const nextSessionPrincipal = principal();
      nextSessionPrincipal.sessionId = "viewer-user-requester-session-next";

      await expect(
        service.create(
          {
            is4k: false,
            kind: "movie",
            routing: {
              destination: destination.id,
              languageProfile: null,
              qualityProfile: destination.qualityProfiles[0]!.id,
              rootFolder: destination.rootFolders[0]!.id,
            },
            tmdbId: 550,
          },
          "request-key-routing-session",
          { ...context(), principal: nextSessionPrincipal },
        ),
      ).rejects.toMatchObject({ reason: "routing_invalid" });
      expect(createMediaRequest).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("delegates to the exact Jellyfin-linked Seerr user and durably replays success", async () => {
    const { createMediaRequest, database, resolveUser, service } = harness();
    try {
      const first = await service.create(
        { is4k: false, kind: "series", seasons: [3, 1], tmdbId: 1399 },
        "request-key-0001",
        context(),
      );
      const replay = await service.create(
        { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
        "request-key-0001",
        context(),
      );

      expect(first).toEqual({ replayed: false, request: createdRequest });
      expect(replay).toEqual({ replayed: true, request: createdRequest });
      expect(resolveUser).toHaveBeenCalledTimes(1);
      expect(resolveUser).toHaveBeenCalledWith(
        { jellyfinUserId: "jellyfin-user-1", jellyfinUsername: "viewer" },
        { is4k: false, kind: "series" },
        undefined,
      );
      expect(createMediaRequest).toHaveBeenCalledTimes(1);
      expect(createMediaRequest).toHaveBeenCalledWith(
        { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
        42,
        undefined,
        { profileId: 4, rootFolder: "/srv/media/movies", serverId: 1 },
      );
      const operation = database.sqlite
        .prepare(
          "select state, response_json as responseJson, idempotency_key_hash as keyHash from media_request_operations",
        )
        .get() as { keyHash: string; responseJson: string; state: string };
      expect(operation.state).toBe("succeeded");
      expect(operation.keyHash).toHaveLength(43);
      expect(operation.keyHash).not.toContain("request-key-0001");
      expect(JSON.parse(operation.responseJson)).toEqual(createdRequest);
      const audit = database.sqlite
        .prepare(
          "select event_type as eventType, outcome, target_id as targetId, metadata_json as metadataJson from audit_events where event_type = 'media.request.created'",
        )
        .get() as Record<string, string>;
      expect(audit).toMatchObject({
        eventType: "media.request.created",
        outcome: "success",
        targetId: "request:91",
      });
      expect(JSON.parse(audit.metadataJson!)).toEqual({
        is4k: false,
        kind: "series",
        qualityProfile: "1080p",
        tmdbId: 1399,
      });
      expect(JSON.stringify({ audit, operation })).not.toContain(privateApiKey);
    } finally {
      database.close();
    }
  });

  it("replays a success persisted before profile labels were recorded", async () => {
    const { createMediaRequest, database, service } = harness();
    try {
      await service.create(
        { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
        "request-key-legacy-response",
        context(),
      );
      database.sqlite
        .prepare("update media_request_operations set response_json = ? where state = 'succeeded'")
        .run(
          JSON.stringify({
            createdAt: createdRequest.createdAt,
            id: createdRequest.id,
            is4k: createdRequest.is4k,
            kind: createdRequest.kind,
            seasons: createdRequest.seasons,
            source: createdRequest.source,
            status: createdRequest.status,
            tmdbId: createdRequest.tmdbId,
          }),
        );

      await expect(
        service.create(
          { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
          "request-key-legacy-response",
          context(),
        ),
      ).resolves.toMatchObject({
        replayed: true,
        request: { qualityProfile: "Profile unavailable" },
      });
      expect(createMediaRequest).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("blocks an unroutable default format before creating a Seerr request", async () => {
    const listRequestRouting = vi.fn<MediaRequestAdapter["listRequestRouting"]>(
      async (kind, is4k) => ({
        destinations: [],
        failures: [],
        is4k,
        kind,
      }),
    );
    const { createMediaRequest, database, service } = harness({ listRequestRouting });
    try {
      await expect(
        service.create(
          { is4k: true, kind: "movie", tmdbId: 278 },
          "request-key-no-default",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "routing_unavailable" });
      expect(createMediaRequest).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare(
            "select failure_code as failureCode, state from media_request_operations where idempotency_key_hash is not null",
          )
          .get(),
      ).toEqual({ failureCode: "routing_unavailable", state: "failed" });
    } finally {
      database.close();
    }
  });

  it("rejects reuse of an idempotency key for a different canonical request", async () => {
    const { createMediaRequest, database, service } = harness();
    try {
      await service.create(
        { is4k: false, kind: "series", seasons: [1, 3], tmdbId: 1399 },
        "request-key-0002",
        context(),
      );
      await expect(
        service.create(
          { is4k: true, kind: "series", seasons: [1, 3], tmdbId: 1399 },
          "request-key-0002",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      expect(createMediaRequest).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("persists and replays a sanitized upstream failure without retrying the mutation", async () => {
    const privateMessage = "private upstream failure";
    const failure = new Error(privateMessage);
    const createMediaRequest = vi.fn<MediaRequestAdapter["createMediaRequest"]>(async () =>
      Promise.reject(failure),
    );
    const { database, resolveUser, service } = harness({ createMediaRequest });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          service.create(
            { is4k: false, kind: "series", seasons: "all", tmdbId: 1399 },
            "request-key-0003",
            context(),
          ),
        ).rejects.toMatchObject({
          reason: "temporarily_unavailable" satisfies MediaRequestFailureCode,
        });
      }
      expect(resolveUser).toHaveBeenCalledTimes(1);
      expect(createMediaRequest).toHaveBeenCalledTimes(1);
      const operation = database.sqlite
        .prepare(
          "select state, failure_code as failureCode, response_json as responseJson from media_request_operations",
        )
        .get();
      expect(operation).toEqual({
        failureCode: "temporarily_unavailable",
        responseJson: null,
        state: "failed",
      });
      const serializedAudit = JSON.stringify(
        database.sqlite
          .prepare(
            "select metadata_json from audit_events where event_type = 'media.request.failed'",
          )
          .get(),
      );
      expect(serializedAudit).toContain("temporarily_unavailable");
      expect(serializedAudit).not.toContain(privateMessage);
    } finally {
      database.close();
    }
  });

  it("authorizes request creation before reading connector or identity state", async () => {
    const { createMediaRequest, database, resolveUser, service } = harness();
    try {
      await expect(
        service.create({ is4k: false, kind: "movie", tmdbId: 550 }, "request-key-0004", {
          ...context(),
          principal: principal("viewer"),
        }),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
      expect(resolveUser).not.toHaveBeenCalled();
      expect(createMediaRequest).not.toHaveBeenCalled();
      expect(
        database.sqlite.prepare("select count(*) as count from media_request_operations").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("requires a healthy negotiated request capability before contacting Seerr", async () => {
    const { createMediaRequest, database, resolveUser, service } = harness();
    try {
      database.sqlite
        .prepare(
          "update connector_configs set capability_snapshot_json = ? where id = 'seerr-main'",
        )
        .run(
          JSON.stringify({
            health: {
              capabilities: ["connector.health", "connector.version", "media.discover"],
              checkedAt: now.toISOString(),
              connectorId: "seerr-main",
              displayName: "Seerr",
              failure: null,
              latencyMs: 12,
              service: "seerr",
              status: "healthy",
              version: "2.7.3",
            },
            schemaVersion: 1,
          }),
        );
      await expect(
        service.create({ is4k: false, kind: "movie", tmdbId: 550 }, "request-key-0005", context()),
      ).rejects.toMatchObject({ reason: "configuration_unavailable" });
      expect(resolveUser).not.toHaveBeenCalled();
      expect(createMediaRequest).not.toHaveBeenCalled();
      expect(
        database.sqlite
          .prepare("select state, failure_code as failureCode from media_request_operations")
          .get(),
      ).toEqual({ failureCode: "configuration_unavailable", state: "failed" });
    } finally {
      database.close();
    }
  });
});
