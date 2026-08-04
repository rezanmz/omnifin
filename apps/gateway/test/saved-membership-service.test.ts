import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";
import { SavedListService } from "../src/saved/list-service.js";
import { SavedTargetService } from "../src/saved/target-service.js";

const startedAt = new Date("2026-08-04T12:00:00.000Z");
const privateItemId = "owned-private-movie";

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
  const references = new MediaReferenceService(database, appConfig, {
    clock: () => new Date(now),
    createToken: () => "m".repeat(22),
  });
  const [referenceId] = references.createOrRefresh(
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
    ],
  );
  const targets = new SavedTargetService(database, appConfig, {
    clock: () => new Date(now),
    createClient: () => ({
      readFavoriteState: async () => true,
      updateFavoriteState: async ({ favorite }) => favorite,
    }),
    createTargetToken: () => "t".repeat(22),
    mediaReferences: { clock: () => new Date(now) },
  });
  const issued = await targets.issueOwned(referenceId!, { principal: principal() });
  let auditToken = 0;
  let listToken = 0;
  let operationToken = 0;
  const lists = new SavedListService(database, appConfig, {
    clock: () => new Date(now),
    createAuditId: () => `saved-membership-audit-${++auditToken}`,
    createCatalogToken: () => "c".repeat(22),
    createItemToken: () => "i".repeat(22),
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
    lists,
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
      added.etag,
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
    ).toThrow(expect.objectContaining({ reason: "target_not_found" }));

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
