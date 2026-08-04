import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { DiscoveryMediaDetail } from "@omnifin/contracts/discovery";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher, privacyHash } from "../src/security/crypto.js";
import { SavedTargetService, type SavedTargetClient } from "../src/saved/target-service.js";

const startedAt = new Date("2026-08-04T10:00:00.000Z");
const privateItemId = "movie-upstream-private";

function discoveryDetail(overrides: Partial<DiscoveryMediaDetail> = {}): DiscoveryMediaDetail {
  return {
    artwork: { backdropPath: null, posterPath: null },
    availability: "unavailable",
    cast: [],
    crew: [],
    genres: ["Science Fiction"],
    id: "movie:603",
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
    kind: "movie",
    originalTitle: null,
    overview: "A verified catalog title that has not been requested.",
    productionStatus: "Released",
    runtimeMinutes: 128,
    source: "seerr",
    tagline: null,
    title: "The Far Meridian",
    tmdbId: 603,
    voteAverage: 8.7,
    voteCount: 4200,
    year: 2026,
    ...overrides,
  } as DiscoveryMediaDetail;
}

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 149),
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

function principal(health: "linked" | "unavailable" = "linked"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-09-03T10:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Saved viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-08-04T11:00:00.000Z",
    issuedAt: startedAt.toISOString(),
    linkedServices: [
      {
        displayName: "Saved viewer",
        externalUserId: "jellyfin-user-private",
        health,
        id: "saved-viewer-link",
        lastVerifiedAt: startedAt.toISOString(),
        linkedAt: startedAt.toISOString(),
        service: "jellyfin",
        username: "saved-viewer",
      },
    ],
    permissions: ROLE_PERMISSIONS.viewer,
    role: "viewer",
    sessionId: "saved-viewer-session",
    userId: "saved-viewer",
  });
}

function seed(database: DatabaseHandle, appConfig: AppConfig) {
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values ('saved-viewer', 'Saved viewer', 'viewer', 'default', 'active', ?, ?)`,
    )
    .run(startedAt.getTime(), startedAt.getTime());
  database.sqlite
    .prepare(
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials, tls_policy,
         insecure_http_approved, capability_snapshot_json, health_state, enabled,
         created_at, updated_at
       ) values (?, 'jellyfin', 'Home Jellyfin', ?, ?, 'strict', 0, ?, 'healthy', 1, ?, ?)`,
    )
    .run(
      "jellyfin-main",
      "https://jellyfin.example.test/",
      cipher.encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:jellyfin-main",
      ),
      JSON.stringify({ schemaVersion: 1 }),
      startedAt.getTime(),
      startedAt.getTime(),
    );
  database.sqlite
    .prepare(
      `insert into service_identity_links (
         id, user_id, service, connector_id, external_server_id, external_user_id,
         external_username, external_display_name, encrypted_access_token, device_id,
         token_created_at, health_state, revision, created_at, updated_at
       ) values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?, 'linked', 3, ?, ?)`,
    )
    .run(
      "saved-viewer-link",
      "saved-viewer",
      "jellyfin-main",
      "server-private",
      "jellyfin-user-private",
      "saved-viewer",
      "Saved viewer",
      cipher.encrypt(
        "private-jellyfin-token",
        "service_identity_access_token:jellyfin:saved-viewer-link",
      ),
      "saved-viewer-device",
      startedAt.getTime(),
      startedAt.getTime(),
      startedAt.getTime(),
    );
}

const databases: DatabaseHandle[] = [];

function harness(favoriteResult: boolean | Error = true) {
  const appConfig = config();
  const database = openDatabase(":memory:");
  databases.push(database);
  database.migrate();
  seed(database, appConfig);
  let now = startedAt.getTime();
  let auditId = 0;
  const references = new MediaReferenceService(database, appConfig, {
    clock: () => new Date(now),
    createToken: () => "m".repeat(22),
  });
  const [referenceId] = references.createOrRefresh(
    { linkId: "saved-viewer-link", linkRevision: 3, userId: "saved-viewer" },
    [
      {
        artwork: { backdropItemId: privateItemId, posterItemId: privateItemId },
        episodeNumber: null,
        itemId: privateItemId,
        kind: "movie",
        seasonNumber: null,
        title: "Private title",
        year: 2026,
      },
    ],
  );
  let currentFavorite = favoriteResult instanceof Error ? true : favoriteResult;
  const readFavoriteState = vi.fn(async () => {
    if (favoriteResult instanceof Error) throw favoriteResult;
    return currentFavorite;
  });
  const updateFavoriteState = vi.fn(async ({ favorite }: { favorite: boolean }) => {
    currentFavorite = favorite;
    return favorite;
  });
  const client: SavedTargetClient = { readFavoriteState, updateFavoriteState };
  const resolveDiscovery = vi.fn(async () => discoveryDetail());
  const createClient = vi.fn((input) => {
    expect(input.accessToken).toBe("private-jellyfin-token");
    expect(input.baseUrl).toBe("https://jellyfin.example.test/");
    expect(input.deviceId).toBe("saved-viewer-device");
    return client;
  });
  const service = new SavedTargetService(database, appConfig, {
    clock: () => new Date(now),
    createAuditId: () => `saved-favorite-audit-${++auditId}`,
    createClient,
    createTargetToken: () => "t".repeat(22),
    mediaReferences: { clock: () => startedAt },
    resolveDiscovery,
  });
  return {
    advance(milliseconds: number) {
      now += milliseconds;
    },
    appConfig,
    createClient,
    database,
    readFavoriteState,
    referenceId: referenceId!,
    resolveDiscovery,
    service,
    setTime(milliseconds: number) {
      now = milliseconds;
    },
    updateFavoriteState,
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SavedTargetService", () => {
  it("issues and refreshes an encrypted user- and link-bound owned target", async () => {
    const { createClient, database, readFavoriteState, referenceId, service } = harness(true);

    const issued = await service.issueOwned(referenceId, { principal: principal() });
    const refreshed = await service.issueOwned(referenceId, { principal: principal() });

    expect(issued).toMatchObject({
      catalogReferenceId: null,
      customListCount: 0,
      customListIds: [],
      favorite: { state: "synced", value: true },
      targetReferenceId: `save_target_${"t".repeat(22)}`,
      watchLater: false,
    });
    expect(refreshed.targetReferenceId).toBe(issued.targetReferenceId);
    expect(readFavoriteState).toHaveBeenCalledTimes(2);
    expect(readFavoriteState).toHaveBeenCalledWith(
      { itemId: privateItemId, userId: "jellyfin-user-private" },
      undefined,
    );
    expect(createClient).toHaveBeenCalledTimes(2);
    const stored = database.sqlite
      .prepare(
        `select encrypted_payload as encryptedPayload, identity_digest as identityDigest
         from saved_targets`,
      )
      .get() as { encryptedPayload: string; identityDigest: string };
    expect(stored.encryptedPayload).not.toContain(privateItemId);
    expect(stored.encryptedPayload).not.toContain("Private title");
    expect(stored.identityDigest).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(database.sqlite.prepare("select count(*) as count from saved_targets").get()).toEqual({
      count: 1,
    });

    expect(
      service.resolveOwned(issued.targetReferenceId, { principal: principal() }),
    ).toMatchObject({
      linkId: "saved-viewer-link",
      linkRevision: 3,
      payload: {
        itemId: privateItemId,
        kind: "movie",
        libraryReferenceId: referenceId,
        title: "Private title",
      },
    });
  });

  it("keeps target issuance available with an explicit degraded favorite state", async () => {
    const { createClient, database, referenceId, service } = harness(
      new Error("Jellyfin unavailable"),
    );
    const failedRead = await service.issueOwned(referenceId, { principal: principal() });
    expect(failedRead.favorite).toEqual({ state: "unavailable", value: null });
    expect(createClient).toHaveBeenCalledOnce();

    database.sqlite
      .prepare(
        "update service_identity_links set health_state = 'unavailable' where id = 'saved-viewer-link'",
      )
      .run();
    createClient.mockClear();
    const unavailable = await service.issueOwned(referenceId, {
      principal: principal("unavailable"),
    });
    expect(unavailable.favorite).toEqual({ state: "unavailable", value: null });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("issues an encrypted requestable target only after catalog re-resolution", async () => {
    const { appConfig, database, resolveDiscovery, service } = harness();

    const issued = await service.issueDiscovery(
      { kind: "movie", language: "en-CA", tmdbId: 603 },
      { principal: principal() },
    );

    expect(issued).toMatchObject({
      catalogReferenceId: null,
      customListCount: 0,
      favorite: { state: "not_applicable", value: null },
      targetReferenceId: `save_target_${"t".repeat(22)}`,
      watchLater: false,
    });
    expect(resolveDiscovery).toHaveBeenCalledWith(
      { kind: "movie", language: "en-CA", tmdbId: 603 },
      principal(),
      undefined,
    );
    const resolved = service.resolve(issued.targetReferenceId, { principal: principal() });
    expect(resolved.payload).toMatchObject({
      availability: "requestable",
      kind: "movie",
      source: "seerr",
      title: "The Far Meridian",
      tmdbId: 603,
    });
    expect(() =>
      service.resolveOwned(issued.targetReferenceId, { principal: principal() }),
    ).toThrow(expect.objectContaining({ reason: "not_found" }));
    const row = database.sqlite
      .prepare("select encrypted_payload as encryptedPayload from saved_targets")
      .get() as { encryptedPayload: string };
    expect(row.encryptedPayload).not.toMatch(/The Far Meridian|603/u);
    expect(
      privacyHash("saved_catalog_identity", `tmdb\0movie\0${603}`, appConfig.encryptionKey),
    ).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it("rejects mismatched or unavailable catalog resolution", async () => {
    const first = harness();
    first.resolveDiscovery.mockResolvedValueOnce(discoveryDetail({ tmdbId: 604 }));
    await expect(
      first.service.issueDiscovery(
        { kind: "movie", language: "en", tmdbId: 603 },
        { principal: principal() },
      ),
    ).rejects.toMatchObject({ reason: "connector_unavailable" });

    const second = harness();
    second.resolveDiscovery.mockRejectedValueOnce(new Error("Seerr unavailable"));
    await expect(
      second.service.issueDiscovery(
        { kind: "movie", language: "en", tmdbId: 603 },
        { principal: principal() },
      ),
    ).rejects.toMatchObject({ reason: "connector_unavailable" });
  });

  it("round-trips favorite state through Jellyfin and refreshes encrypted list snapshots", async () => {
    const { appConfig, database, readFavoriteState, referenceId, service, updateFavoriteState } =
      harness(true);
    const issued = await service.issueOwned(referenceId, { principal: principal() });
    const cipher = new EnvelopeCipher(appConfig.encryptionKey);
    const identityDigest = privacyHash(
      "saved_catalog_identity",
      `jellyfin\0saved-viewer-link\0movie\0${privateItemId}`,
      appConfig.encryptionKey,
    );
    const catalogId = `catalog_${"f".repeat(22)}`;
    const listId = `saved_list_${"f".repeat(22)}`;
    const snapshotContext = `saved_catalog_snapshot:saved-viewer:${catalogId}`;
    database.sqlite
      .prepare(
        `insert into saved_catalog_items (
           id, user_id, identity_digest, encrypted_identity, encrypted_snapshot,
           library_reference_id, library_reference_user_id, last_resolved_at,
           created_at, updated_at
         ) values (?, 'saved-viewer', ?, 'encrypted', ?, ?, 'saved-viewer', ?, ?, ?)`,
      )
      .run(
        catalogId,
        identityDigest,
        cipher.encrypt(
          JSON.stringify({
            artwork: { backdrop: true, poster: true },
            favorite: { state: "synced", value: true },
            kind: "movie",
            overview: null,
            resolutionState: "current",
            schemaVersion: 1,
            title: "Private title",
            year: 2026,
          }),
          snapshotContext,
        ),
        referenceId,
        startedAt.getTime(),
        startedAt.getTime(),
        startedAt.getTime(),
      );
    database.sqlite
      .prepare(
        `insert into saved_lists (
           id, user_id, kind, encrypted_name, revision, created_at, updated_at
         ) values (?, 'saved-viewer', 'watch_later', 'encrypted', 0, ?, ?)`,
      )
      .run(listId, startedAt.getTime(), startedAt.getTime());
    database.sqlite
      .prepare(
        `insert into saved_list_items (
           id, user_id, list_id, catalog_item_id, position, created_at, updated_at
         ) values (?, 'saved-viewer', ?, ?, 0, ?, ?)`,
      )
      .run(
        `saved_item_${"f".repeat(22)}`,
        listId,
        catalogId,
        startedAt.getTime(),
        startedAt.getTime(),
      );

    const changed = await service.updateFavorite(
      issued.targetReferenceId,
      { favorite: false },
      {
        ipAddress: "203.0.113.91",
        principal: principal(),
        requestId: "favorite-request-1",
      },
    );
    expect(changed).toEqual({
      favorite: false,
      synchronizedAt: startedAt.toISOString(),
      targetReferenceId: issued.targetReferenceId,
    });
    expect(updateFavoriteState).toHaveBeenCalledWith(
      { favorite: false, itemId: privateItemId, userId: "jellyfin-user-private" },
      undefined,
    );
    expect(readFavoriteState).toHaveBeenCalledTimes(2);
    expect(
      service.resolveOwned(issued.targetReferenceId, { principal: principal() }).payload.favorite,
    ).toEqual({ state: "synced", value: false });
    const stored = database.sqlite
      .prepare(
        `select encrypted_snapshot as encryptedSnapshot
         from saved_catalog_items where id = ?`,
      )
      .get(catalogId) as { encryptedSnapshot: string };
    expect(JSON.parse(cipher.decrypt(stored.encryptedSnapshot, snapshotContext))).toMatchObject({
      favorite: { state: "synced", value: false },
      resolutionState: "current",
    });
    expect(
      database.sqlite.prepare("select revision from saved_lists where id = ?").get(listId),
    ).toEqual({ revision: 1 });
    const audit = database.sqlite
      .prepare(
        `select event_type as eventType, target_id as targetId, metadata_json as metadataJson
         from audit_events`,
      )
      .get() as { eventType: string; metadataJson: string; targetId: string };
    expect(audit).toMatchObject({ eventType: "saved.favorite.changed", targetId: catalogId });
    expect(JSON.parse(audit.metadataJson)).toEqual({ catalogLinked: true, favorite: false });
    expect(JSON.stringify(audit)).not.toContain(privateItemId);
    expect(JSON.stringify(audit)).not.toContain(issued.targetReferenceId);

    await service.updateFavorite(
      issued.targetReferenceId,
      { favorite: false },
      { principal: principal() },
    );
    expect(
      database.sqlite.prepare("select revision from saved_lists where id = ?").get(listId),
    ).toEqual({ revision: 1 });
  });

  it("fails closed when Jellyfin cannot confirm the requested favorite state", async () => {
    const { readFavoriteState, referenceId, service, updateFavoriteState } = harness(true);
    const issued = await service.issueOwned(referenceId, { principal: principal() });
    updateFavoriteState.mockRejectedValueOnce(new Error("offline"));
    await expect(
      service.updateFavorite(
        issued.targetReferenceId,
        { favorite: false },
        { principal: principal() },
      ),
    ).rejects.toMatchObject({ reason: "connector_unavailable" });

    readFavoriteState.mockResolvedValueOnce(true);
    await expect(
      service.updateFavorite(
        issued.targetReferenceId,
        { favorite: false },
        { principal: principal() },
      ),
    ).rejects.toMatchObject({ reason: "synchronization_failed" });
  });

  it("accepts legacy no-credential storage and normalizes an empty connector label", async () => {
    const { appConfig, createClient, database, referenceId, service } = harness();
    const cipher = new EnvelopeCipher(appConfig.encryptionKey);
    database.sqlite
      .prepare(
        `update connector_configs
         set display_name = ?, encrypted_credentials = ?, tls_policy = 'allow_self_signed'
         where id = 'jellyfin-main'`,
      )
      .run(
        "   ",
        cipher.encrypt(
          JSON.stringify({ kind: "none" }),
          "connector_credentials:jellyfin:jellyfin-main",
        ),
      );

    await service.issueOwned(referenceId, { principal: principal() });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Jellyfin", tlsPolicy: "allow_self_signed" }),
    );
  });

  it("reports existing private memberships without exposing provider identifiers", async () => {
    const { appConfig, database, referenceId, service } = harness(false);
    const catalogIdentityDigest = privacyHash(
      "saved_catalog_identity",
      `jellyfin\0saved-viewer-link\0movie\0${privateItemId}`,
      appConfig.encryptionKey,
    );
    const catalogId = `catalog_${"c".repeat(22)}`;
    database.sqlite
      .prepare(
        `insert into saved_catalog_items (
           id, user_id, identity_digest, encrypted_identity, encrypted_snapshot,
           library_reference_id, library_reference_user_id, last_resolved_at,
           created_at, updated_at
         ) values (?, 'saved-viewer', ?, 'x', 'x', ?, 'saved-viewer', ?, ?, ?)`,
      )
      .run(
        catalogId,
        catalogIdentityDigest,
        referenceId,
        startedAt.getTime(),
        startedAt.getTime(),
        startedAt.getTime(),
      );
    const lists = [
      { id: `saved_list_${"w".repeat(22)}`, kind: "watch_later" },
      { id: `saved_list_${"a".repeat(22)}`, kind: "custom" },
      { id: `saved_list_${"b".repeat(22)}`, kind: "custom" },
    ] as const;
    for (const [index, list] of lists.entries()) {
      database.sqlite
        .prepare(
          `insert into saved_lists (
             id, user_id, kind, encrypted_name, revision, created_at, updated_at
           ) values (?, 'saved-viewer', ?, 'x', 0, ?, ?)`,
        )
        .run(list.id, list.kind, startedAt.getTime(), startedAt.getTime());
      database.sqlite
        .prepare(
          `insert into saved_list_items (
             id, user_id, list_id, catalog_item_id, position, created_at, updated_at
           ) values (?, 'saved-viewer', ?, ?, 0, ?, ?)`,
        )
        .run(
          `saved_item_${String.fromCharCode(100 + index).repeat(22)}`,
          list.id,
          catalogId,
          startedAt.getTime(),
          startedAt.getTime(),
        );
    }

    const issued = await service.issueOwned(referenceId, { principal: principal() });
    expect(issued).toMatchObject({
      catalogReferenceId: catalogId,
      customListCount: 2,
      customListIds: [lists[1].id, lists[2].id],
      favorite: { state: "synced", value: false },
      watchLater: true,
    });
    expect(JSON.stringify(issued)).not.toContain(privateItemId);
  });

  it("rejects guessed, cross-user, and non-title media references", async () => {
    const { database, referenceId, service } = harness();
    await expect(
      service.issueOwned(`media_${"z".repeat(22)}`, { principal: principal() }),
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(
      service.issueOwned(referenceId, {
        principal: { ...principal(), userId: "different-user" },
      }),
    ).rejects.toMatchObject({ reason: "principal_unavailable" });

    database.sqlite
      .prepare("update connector_configs set enabled = 0 where id = 'jellyfin-main'")
      .run();
    await expect(service.issueOwned(referenceId, { principal: principal() })).rejects.toMatchObject(
      { reason: "principal_unavailable" },
    );
  });

  it.each([Number.NaN, -1, 8_640_000_000_000_000])(
    "fails closed when the issuance clock is outside the safe date range (%s)",
    async (milliseconds) => {
      const { referenceId, service, setTime } = harness();
      setTime(milliseconds);
      await expect(
        service.issueOwned(referenceId, { principal: principal() }),
      ).rejects.toMatchObject({ reason: "storage_failure" });
    },
  );

  it("rejects expired, stale-link, malformed, and guessed targets without disclosing them", async () => {
    const first = harness();
    const issued = await first.service.issueOwned(first.referenceId, { principal: principal() });
    first.advance(15 * 60 * 1_000);
    expect(() =>
      first.service.resolveOwned(issued.targetReferenceId, { principal: principal() }),
    ).toThrow(expect.objectContaining({ reason: "not_found" }));

    const second = harness();
    const stale = await second.service.issueOwned(second.referenceId, { principal: principal() });
    second.database.sqlite
      .prepare("update service_identity_links set revision = 4 where id = 'saved-viewer-link'")
      .run();
    expect(() =>
      second.service.resolveOwned(stale.targetReferenceId, { principal: principal() }),
    ).toThrow(expect.objectContaining({ reason: "not_found" }));

    const third = harness();
    const malformed = await third.service.issueOwned(third.referenceId, {
      principal: principal(),
    });
    third.database.sqlite
      .prepare("update saved_targets set encrypted_payload = 'malformed' where id = ?")
      .run(malformed.targetReferenceId);
    expect(() =>
      third.service.resolveOwned(malformed.targetReferenceId, { principal: principal() }),
    ).toThrow(expect.objectContaining({ reason: "storage_failure" }));

    expect(() =>
      third.service.resolveOwned(`save_target_${"z".repeat(22)}`, { principal: principal() }),
    ).toThrow(expect.objectContaining({ reason: "not_found" }));
  });
});
