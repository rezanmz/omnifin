import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { DiscoveryMediaDetail } from "@omnifin/contracts/discovery";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";
import { SavedListService } from "../src/saved/list-service.js";
import { SavedTargetService } from "../src/saved/target-service.js";

const startedAt = new Date("2026-08-04T12:00:00.000Z");
const privateItemId = "owned-private-movie";

const discoveryDetail = {
  artwork: { backdropPath: null, posterPath: null },
  availability: "unavailable",
  cast: [],
  crew: [],
  genres: ["Drama"],
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
  overview: "A requestable title saved without creating a request.",
  productionStatus: "Released",
  runtimeMinutes: 128,
  source: "seerr",
  tagline: null,
  title: "The Far Meridian",
  tmdbId: 603,
  voteAverage: 8.7,
  voteCount: 4200,
  year: 2026,
} satisfies DiscoveryMediaDetail;

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 151),
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

function principal(userId = "saved-user"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-09-03T12:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: userId,
    externalIdentity: null,
    inactivityExpiresAt: "2026-08-04T13:00:00.000Z",
    issuedAt: startedAt.toISOString(),
    linkedServices: [
      {
        displayName: userId,
        externalUserId: `${userId}-external`,
        health: "linked",
        id: `${userId}-link`,
        lastVerifiedAt: startedAt.toISOString(),
        linkedAt: startedAt.toISOString(),
        service: "jellyfin",
        username: userId,
      },
    ],
    permissions: ROLE_PERMISSIONS.viewer,
    role: "viewer",
    sessionId: `${userId}-session`,
    userId,
  });
}

function seedUser(database: DatabaseHandle, appConfig: AppConfig, userId: string) {
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  const linkId = `${userId}-link`;
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values (?, ?, 'viewer', 'default', 'active', ?, ?)`,
    )
    .run(userId, userId, startedAt.getTime(), startedAt.getTime());
  database.sqlite
    .prepare(
      `insert into service_identity_links (
         id, user_id, service, connector_id, external_server_id, external_user_id,
         external_username, external_display_name, encrypted_access_token, device_id,
         token_created_at, health_state, revision, created_at, updated_at
       ) values (?, ?, 'jellyfin', 'jellyfin-main', 'server-private', ?, ?, ?, ?, ?, ?,
                 'linked', 1, ?, ?)`,
    )
    .run(
      linkId,
      userId,
      `${userId}-external`,
      userId,
      userId,
      cipher.encrypt("private-token", `service_identity_access_token:jellyfin:${linkId}`),
      `${userId}-device`,
      startedAt.getTime(),
      startedAt.getTime(),
      startedAt.getTime(),
    );
}

const databases: DatabaseHandle[] = [];

async function harness(artwork = true) {
  const appConfig = config();
  const database = openDatabase(":memory:");
  databases.push(database);
  database.migrate();
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  database.sqlite
    .prepare(
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials, tls_policy,
         insecure_http_approved, capability_snapshot_json, health_state, enabled,
         created_at, updated_at
       ) values ('jellyfin-main', 'jellyfin', 'Home Jellyfin', ?, ?, 'strict', 0, ?,
                 'healthy', 1, ?, ?)`,
    )
    .run(
      "https://jellyfin.example.test/",
      cipher.encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:jellyfin-main",
      ),
      JSON.stringify({ schemaVersion: 1 }),
      startedAt.getTime(),
      startedAt.getTime(),
    );
  seedUser(database, appConfig, "saved-user");
  seedUser(database, appConfig, "other-user");
  let now = startedAt.getTime();
  let referenceToken = 0;
  const references = new MediaReferenceService(database, appConfig, {
    clock: () => new Date(now),
    createToken: () => (++referenceToken).toString(36).padStart(22, "m"),
  });
  const [referenceId, secondReferenceId] = references.createOrRefresh(
    { linkId: "saved-user-link", linkRevision: 1, userId: "saved-user" },
    [
      {
        artwork: {
          backdropItemId: artwork ? privateItemId : null,
          posterItemId: artwork ? privateItemId : null,
        },
        episodeNumber: null,
        itemId: privateItemId,
        kind: "movie",
        seasonNumber: null,
        title: "Private saved title",
        year: 2026,
      },
      {
        artwork: { backdropItemId: null, posterItemId: "second-owned-movie" },
        episodeNumber: null,
        itemId: "second-owned-movie",
        kind: "movie",
        seasonNumber: null,
        title: "Another saved title",
        year: 2025,
      },
    ],
  );
  let targetToken = 0;
  let favorite = true;
  const targets = new SavedTargetService(database, appConfig, {
    clock: () => new Date(now),
    createClient: () => ({
      readFavoriteState: async () => favorite,
      updateFavoriteState: async ({ favorite }) => favorite,
    }),
    createTargetToken: () => (++targetToken).toString(36).padStart(22, "t"),
    mediaReferences: { clock: () => new Date(now) },
    resolveDiscovery: async () => discoveryDetail,
  });
  const issued = await targets.issueOwned(referenceId!, { principal: principal() });
  const secondIssued = await targets.issueOwned(secondReferenceId!, { principal: principal() });
  const discoveryIssued = await targets.issueDiscovery(
    { kind: "movie", language: "en", tmdbId: 603 },
    { principal: principal() },
  );
  let auditToken = 0;
  let catalogToken = 0;
  let itemToken = 0;
  let listToken = 0;
  let operationToken = 0;
  const lists = new SavedListService(database, appConfig, {
    clock: () => new Date(now),
    createAuditId: () => `saved-membership-audit-${++auditToken}`,
    createCatalogToken: () => (++catalogToken).toString(36).padStart(22, "c"),
    createItemToken: () => (++itemToken).toString(36).padStart(22, "i"),
    createListToken: () => (++listToken).toString(36).padStart(22, "l"),
    createOperationToken: () => (++operationToken).toString(36).padStart(22, "o"),
    targetDependencies: { mediaReferences: { clock: () => new Date(now) } },
  });
  return {
    advance(milliseconds: number) {
      now += milliseconds;
    },
    appConfig,
    context(userId = "saved-user") {
      return {
        ipAddress: "203.0.113.84",
        principal: principal(userId),
        requestId: `membership-${userId}`,
      };
    },
    database,
    discoveryTargetReferenceId: discoveryIssued.targetReferenceId,
    issueTarget: () => targets.issueOwned(referenceId!, { principal: principal() }),
    lists,
    secondTargetReferenceId: secondIssued.targetReferenceId,
    setFavorite(value: boolean) {
      favorite = value;
    },
    targetReferenceId: issued.targetReferenceId,
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SavedListService membership", () => {
  it("adds one encrypted owned title with revision and idempotency protection", async () => {
    const { context, database, lists, targetReferenceId } = await harness();
    const watchLater = lists.list({}, context()).watchLater;
    const initialEtag = lists.read(watchLater.id, context()).etag;

    const added = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-owned-title-0001",
      initialEtag,
      context(),
    );
    const replayed = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-owned-title-0001",
      initialEtag,
      context(),
    );

    expect(added).toMatchObject({
      body: {
        created: true,
        item: {
          catalog: {
            availability: "owned",
            favorite: { state: "synced", value: true },
            kind: "movie",
            resolutionState: "current",
            title: "Private saved title",
          },
          position: 0,
        },
        listId: watchLater.id,
        revision: 1,
      },
      replayed: false,
    });
    expect(replayed).toEqual({ ...added, replayed: true });
    expect(added.etag).not.toBe(initialEtag);
    expect(added.body.item.catalog.artwork).toMatchObject({
      backdropPath: `/v1/saved/catalog/${added.body.item.catalog.id}/images/backdrop`,
      posterPath: `/v1/saved/catalog/${added.body.item.catalog.id}/images/poster`,
    });

    const duplicate = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-owned-title-0002",
      initialEtag,
      context(),
    );
    expect(duplicate).toMatchObject({
      body: { created: false, revision: 1 },
      etag: added.etag,
      replayed: false,
    });
    expect(
      database.sqlite.prepare("select count(*) as count from saved_catalog_items").get(),
    ).toEqual({ count: 1 });
    expect(database.sqlite.prepare("select count(*) as count from saved_list_items").get()).toEqual(
      {
        count: 1,
      },
    );
    const stored = database.sqlite
      .prepare(
        `select encrypted_identity as encryptedIdentity, encrypted_snapshot as encryptedSnapshot
         from saved_catalog_items`,
      )
      .get() as { encryptedIdentity: string; encryptedSnapshot: string };
    expect(`${stored.encryptedIdentity}${stored.encryptedSnapshot}`).not.toMatch(
      /owned-private-movie|Private saved title/u,
    );
    expect(
      database.sqlite.prepare("select event_type as eventType from audit_events").all(),
    ).toEqual([{ eventType: "saved.list.item.added" }]);

    expect(lists.items(watchLater.id, {}, context())).toMatchObject({
      items: [
        {
          catalog: { availability: "owned", title: "Private saved title" },
          id: added.body.item.id,
          position: 0,
        },
      ],
      list: { id: watchLater.id, itemCount: 1, revision: 1 },
      nextCursor: null,
      reconciliation: { failures: [], state: "current" },
    });
    expect(lists.items(watchLater.id, { availability: "unavailable" }, context()).items).toEqual(
      [],
    );
    expect(
      lists.items(watchLater.id, { query: "saved TITLE", sort: "title" }, context()).items,
    ).toHaveLength(1);
    expect(lists.items(watchLater.id, { query: "not present" }, context()).items).toEqual([]);

    database.sqlite.prepare("delete from media_references where user_id = 'saved-user'").run();
    expect(lists.items(watchLater.id, {}, context()).items[0]?.catalog).toMatchObject({
      artwork: { backdropPath: null, posterPath: null },
      availability: "unavailable",
      favorite: { state: "not_applicable", value: null },
      libraryReferenceId: null,
      resolutionState: "missing",
    });
  });

  it("adds a verified requestable title without creating a request", async () => {
    const { context, database, discoveryTargetReferenceId, lists } = await harness();
    const watchLater = lists.list({}, context()).watchLater;

    const added = lists.addItem(
      watchLater.id,
      { targetReferenceId: discoveryTargetReferenceId },
      "add-requestable-title-0001",
      lists.read(watchLater.id, context()).etag,
      context(),
    );

    expect(added.body.item.catalog).toMatchObject({
      artwork: { backdropPath: null, posterPath: null },
      availability: "requestable",
      favorite: { state: "not_applicable", value: null },
      kind: "movie",
      libraryReferenceId: null,
      resolutionState: "current",
      title: "The Far Meridian",
      year: 2026,
    });
    expect(lists.items(watchLater.id, {}, context()).items[0]?.catalog).toMatchObject({
      availability: "requestable",
      title: "The Far Meridian",
    });
    expect(
      database.sqlite.prepare("select count(*) as count from media_request_operations").get(),
    ).toEqual({ count: 0 });
  });

  it("fails closed for stale revisions, expired targets, and cross-user guesses", async () => {
    const { advance, context, lists, targetReferenceId } = await harness();
    const own = lists.list({}, context()).watchLater;
    const ownEtag = lists.read(own.id, context()).etag;

    expect(() =>
      lists.addItem(
        own.id,
        { targetReferenceId },
        "stale-membership-0001",
        `"saved_${"z".repeat(22)}"`,
        context(),
      ),
    ).toThrow(expect.objectContaining({ currentEtag: ownEtag, reason: "revision_stale" }));

    advance(15 * 60 * 1_000);
    expect(() =>
      lists.addItem(own.id, { targetReferenceId }, "expired-membership-0001", ownEtag, context()),
    ).toThrow(expect.objectContaining({ reason: "target_expired" }));

    const other = lists.list({}, context("other-user")).watchLater;
    const otherEtag = lists.read(other.id, context("other-user")).etag;
    expect(() =>
      lists.addItem(
        other.id,
        { targetReferenceId },
        "cross-user-membership-0001",
        otherEtag,
        context("other-user"),
      ),
    ).toThrow(expect.objectContaining({ reason: "target_not_found" }));
    expect(() => lists.items(own.id, {}, context("other-user"))).toThrow(
      expect.objectContaining({ reason: "list_not_found" }),
    );
  });

  it("represents absent artwork without inventing image routes", async () => {
    const { context, lists, targetReferenceId } = await harness(false);
    const watchLater = lists.list({}, context()).watchLater;
    const added = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-no-artwork-0001",
      lists.read(watchLater.id, context()).etag,
      context(),
    );
    expect(added.body.item.catalog.artwork).toMatchObject({
      backdropPath: null,
      posterPath: null,
    });
  });

  it("expires stale owned references in one read and advances the list version", async () => {
    const { advance, context, lists, targetReferenceId } = await harness();
    const watchLater = lists.list({}, context()).watchLater;
    const added = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-before-reference-expiry",
      lists.read(watchLater.id, context()).etag,
      context(),
    );

    advance(7 * 24 * 60 * 60 * 1_000);
    const stale = lists.readItems(watchLater.id, {}, context());

    expect(stale.body).toMatchObject({
      items: [
        {
          catalog: {
            availability: "unavailable",
            favorite: { state: "not_applicable", value: null },
            libraryReferenceId: null,
            resolutionState: "missing",
          },
        },
      ],
      list: { revision: added.body.revision + 1 },
      reconciliation: { state: "degraded" },
    });
    expect(stale.etag).not.toBe(added.etag);
  });

  it("paginates, filters, sorts, and reports degraded saved-title snapshots", async () => {
    const {
      advance,
      appConfig,
      context,
      database,
      lists,
      secondTargetReferenceId,
      targetReferenceId,
    } = await harness();
    const watchLater = lists.list({}, context()).watchLater;
    const first = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-paged-title-0001",
      lists.read(watchLater.id, context()).etag,
      context(),
    );
    advance(1);
    const second = lists.addItem(
      watchLater.id,
      { targetReferenceId: secondTargetReferenceId },
      "add-paged-title-0002",
      first.etag,
      context(),
    );

    const pageOne = lists.items(watchLater.id, { limit: 1 }, context());
    const pageTwo = lists.items(watchLater.id, { cursor: pageOne.nextCursor, limit: 1 }, context());
    expect(pageOne.items.map(({ id }) => id)).toEqual([first.body.item.id]);
    expect(pageTwo.items.map(({ id }) => id)).toEqual([second.body.item.id]);
    expect(pageTwo.nextCursor).toBeNull();
    expect(lists.items(watchLater.id, { sort: "added_desc" }, context()).items[0]?.id).toBe(
      second.body.item.id,
    );
    expect(lists.items(watchLater.id, { sort: "title" }, context()).items[0]?.catalog.title).toBe(
      "Another saved title",
    );
    expect(() =>
      lists.items(
        watchLater.id,
        { cursor: pageOne.nextCursor, limit: 1, sort: "title" },
        context(),
      ),
    ).toThrow(expect.objectContaining({ reason: "cursor_invalid" }));

    const cipher = new EnvelopeCipher(appConfig.encryptionKey);
    const catalogId = first.body.item.catalog.id;
    const row = database.sqlite
      .prepare(
        "select encrypted_snapshot as encryptedSnapshot from saved_catalog_items where id = ?",
      )
      .get(catalogId) as { encryptedSnapshot: string };
    const snapshot = JSON.parse(
      cipher.decrypt(row.encryptedSnapshot, `saved_catalog_snapshot:saved-user:${catalogId}`),
    ) as Record<string, unknown>;
    database.sqlite
      .prepare("update saved_catalog_items set encrypted_snapshot = ? where id = ?")
      .run(
        cipher.encrypt(
          JSON.stringify({
            ...snapshot,
            favorite: { state: "unavailable", value: null },
            resolutionState: "connector_unavailable",
          }),
          `saved_catalog_snapshot:saved-user:${catalogId}`,
        ),
        catalogId,
      );
    expect(lists.items(watchLater.id, {}, context()).reconciliation).toMatchObject({
      failures: [{ code: "unreachable", service: "jellyfin" }],
      state: "degraded",
    });
  });

  it("refreshes a duplicate catalog snapshot while ignoring its stale list ETag", async () => {
    const { context, issueTarget, lists, setFavorite, targetReferenceId } = await harness();
    const watchLater = lists.list({}, context()).watchLater;
    const initialEtag = lists.read(watchLater.id, context()).etag;
    const added = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-refresh-title-0001",
      initialEtag,
      context(),
    );

    setFavorite(false);
    await issueTarget();
    const refreshed = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-refresh-title-0002",
      initialEtag,
      context(),
    );

    expect(refreshed).toMatchObject({
      body: {
        created: false,
        item: { catalog: { favorite: { state: "synced", value: false } } },
        revision: 2,
      },
      replayed: false,
    });
    expect(refreshed.etag).not.toBe(added.etag);
    expect(lists.items(watchLater.id, {}, context()).items[0]?.catalog.favorite).toEqual({
      state: "synced",
      value: false,
    });
  });

  it("removes only private membership, closes the position gap, and makes repeats safe", async () => {
    const { context, database, lists, secondTargetReferenceId, targetReferenceId } =
      await harness();
    const watchLater = lists.list({}, context()).watchLater;
    const first = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-before-remove-0001",
      lists.read(watchLater.id, context()).etag,
      context(),
    );
    const second = lists.addItem(
      watchLater.id,
      { targetReferenceId: secondTargetReferenceId },
      "add-before-remove-0002",
      first.etag,
      context(),
    );

    const removed = lists.removeItem(
      watchLater.id,
      first.body.item.catalog.id,
      second.etag,
      context(),
    );
    expect(removed).toMatchObject({
      body: {
        catalogReferenceId: first.body.item.catalog.id,
        listId: watchLater.id,
        removed: true,
        revision: 3,
      },
    });
    expect(removed.etag).not.toBe(second.etag);
    expect(lists.items(watchLater.id, {}, context())).toMatchObject({
      items: [{ id: second.body.item.id, position: 0 }],
      list: { itemCount: 1, revision: 3 },
    });
    expect(
      database.sqlite
        .prepare("select count(*) as count from saved_catalog_items where id = ?")
        .get(first.body.item.catalog.id),
    ).toEqual({ count: 0 });

    const repeated = lists.removeItem(
      watchLater.id,
      first.body.item.catalog.id,
      first.etag,
      context(),
    );
    expect(repeated).toEqual({
      body: {
        catalogReferenceId: first.body.item.catalog.id,
        listId: watchLater.id,
        removed: false,
        revision: 3,
      },
      etag: removed.etag,
    });
    expect(
      database.sqlite
        .prepare("select event_type as eventType from audit_events order by rowid")
        .all(),
    ).toEqual([
      { eventType: "saved.list.item.added" },
      { eventType: "saved.list.item.added" },
      { eventType: "saved.list.item.removed" },
    ]);
  });

  it("reorders an exact bounded window with revision and replay protection", async () => {
    const { context, lists, secondTargetReferenceId, targetReferenceId } = await harness();
    const watchLater = lists.list({}, context()).watchLater;
    const first = lists.addItem(
      watchLater.id,
      { targetReferenceId },
      "add-before-reorder-0001",
      lists.read(watchLater.id, context()).etag,
      context(),
    );
    const second = lists.addItem(
      watchLater.id,
      { targetReferenceId: secondTargetReferenceId },
      "add-before-reorder-0002",
      first.etag,
      context(),
    );
    const input = {
      orderedItemIds: [second.body.item.id, first.body.item.id],
      startPosition: 0,
    };

    const reordered = lists.reorderItems(
      watchLater.id,
      input,
      "reorder-saved-items-0001",
      second.etag,
      context(),
    );
    const replayed = lists.reorderItems(
      watchLater.id,
      input,
      "reorder-saved-items-0001",
      second.etag,
      context(),
    );
    expect(reordered).toMatchObject({
      body: { ...input, revision: 3 },
      replayed: false,
    });
    expect(replayed).toEqual({ ...reordered, replayed: true });
    expect(lists.items(watchLater.id, {}, context()).items).toMatchObject([
      { id: second.body.item.id, position: 0 },
      { id: first.body.item.id, position: 1 },
    ]);

    const unchanged = lists.reorderItems(
      watchLater.id,
      input,
      "reorder-saved-items-0002",
      reordered.etag,
      context(),
    );
    expect(unchanged).toMatchObject({ body: { revision: 3 }, etag: reordered.etag });
    expect(() =>
      lists.reorderItems(
        watchLater.id,
        { ...input, startPosition: 1 },
        "reorder-saved-items-0003",
        reordered.etag,
        context(),
      ),
    ).toThrow(expect.objectContaining({ reason: "reorder_window_changed" }));
    expect(() =>
      lists.reorderItems(watchLater.id, input, "reorder-saved-items-0004", second.etag, context()),
    ).toThrow(expect.objectContaining({ reason: "revision_stale" }));
  });

  it("normalizes corrupt targets and invalid generated identifiers to safe failures", async () => {
    const first = await harness();
    const watchLater = first.lists.list({}, first.context()).watchLater;
    const etag = first.lists.read(watchLater.id, first.context()).etag;
    first.database.sqlite
      .prepare("update saved_targets set encrypted_payload = 'malformed' where id = ?")
      .run(first.targetReferenceId);
    expect(() =>
      first.lists.addItem(
        watchLater.id,
        { targetReferenceId: first.targetReferenceId },
        "add-corrupt-target-0001",
        etag,
        first.context(),
      ),
    ).toThrow(expect.objectContaining({ reason: "storage_failure" }));

    const second = await harness();
    const secondList = second.lists.list({}, second.context()).watchLater;
    const invalidCatalog = new SavedListService(second.database, second.appConfig, {
      clock: () => startedAt,
      createCatalogToken: () => "invalid",
    });
    expect(() =>
      invalidCatalog.addItem(
        secondList.id,
        { targetReferenceId: second.targetReferenceId },
        "add-invalid-catalog-0001",
        invalidCatalog.read(secondList.id, second.context()).etag,
        second.context(),
      ),
    ).toThrow(expect.objectContaining({ reason: "integrity_failure" }));

    const invalidMembership = new SavedListService(second.database, second.appConfig, {
      clock: () => startedAt,
      createCatalogToken: () => "x".repeat(22),
      createItemToken: () => "invalid",
    });
    expect(() =>
      invalidMembership.addItem(
        secondList.id,
        { targetReferenceId: second.targetReferenceId },
        "add-invalid-membership-0001",
        invalidMembership.read(secondList.id, second.context()).etag,
        second.context(),
      ),
    ).toThrow(expect.objectContaining({ reason: "integrity_failure" }));
  });

  it("fails closed when corrupted ordering has exhausted the bounded position range", async () => {
    const { context, database, lists, targetReferenceId } = await harness();
    const watchLater = lists.list({}, context()).watchLater;
    database.sqlite
      .prepare(
        `insert into saved_catalog_items (
           id, user_id, identity_digest, encrypted_identity, encrypted_snapshot,
           created_at, updated_at
         ) values (?, 'saved-user', ?, 'encrypted', 'encrypted', ?, ?)`,
      )
      .run(`catalog_${"q".repeat(22)}`, "d".repeat(22), startedAt.getTime(), startedAt.getTime());
    database.sqlite
      .prepare(
        `insert into saved_list_items (
           id, user_id, list_id, catalog_item_id, position, created_at, updated_at
         ) values (?, 'saved-user', ?, ?, 499, ?, ?)`,
      )
      .run(
        `saved_item_${"q".repeat(22)}`,
        watchLater.id,
        `catalog_${"q".repeat(22)}`,
        startedAt.getTime(),
        startedAt.getTime(),
      );
    expect(() =>
      lists.addItem(
        watchLater.id,
        { targetReferenceId },
        "add-invalid-position-0001",
        lists.read(watchLater.id, context()).etag,
        context(),
      ),
    ).toThrow(expect.objectContaining({ reason: "list_item_quota_reached" }));
  });
});
