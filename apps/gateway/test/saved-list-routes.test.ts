import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  savedListDeleteResponseSchema,
  savedListItemsResponseSchema,
  savedListMembershipDeleteResponseSchema,
  savedListMembershipResponseSchema,
  savedListMutationResponseSchema,
  savedListsResponseSchema,
  savedMembershipSummarySchema,
} from "@omnifin/contracts/saved";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-04T08:30:00.000Z");
const baseUrl = "https://omnifin.example";

function config(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 148),
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

async function harness() {
  let sessionId = 0;
  let sessionToken = 0;
  let listToken = 0;
  let operationToken = 0;
  let auditId = 0;
  const readImage = vi.fn(async () => ({
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    contentType: "image/png" as const,
  }));
  const appConfig = config();
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  const app = await createApp({
    config: appConfig,
    continueWatchingDependencies: {
      clock: () => now,
      createClient: () => ({
        readContinueWatching: async () => ({ items: [], truncated: false }),
        readImage,
      }),
      mediaReferences: { clock: () => now },
    },
    savedListDependencies: {
      clock: () => now,
      createAuditId: () => `saved-route-audit-${++auditId}`,
      createCatalogToken: () => "c".repeat(22),
      createItemToken: () => "i".repeat(22),
      createListToken: () => (++listToken).toString(36).padStart(22, "l"),
      createOperationToken: () => (++operationToken).toString(36).padStart(22, "o"),
      targetDependencies: { mediaReferences: { clock: () => now } },
    },
    savedTargetDependencies: {
      clock: () => now,
      createClient: () => ({
        readFavoriteState: async () => true,
        updateFavoriteState: async ({ favorite }) => favorite,
      }),
      createTargetToken: () => "t".repeat(22),
      mediaReferences: { clock: () => now },
    },
    sessionDependencies: {
      clock: () => now,
      createId: () => `saved-route-session-${++sessionId}`,
      createToken: () => Buffer.alloc(32, ++sessionToken).toString("base64url"),
    },
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: now,
      displayName: "Home Jellyfin",
      encryptedCredentials: cipher.encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:jellyfin-home",
      ),
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Saved Viewer",
      id: "saved-viewer",
      role: "viewer",
      roleSource: "default",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: now,
      deviceId: "saved-viewer-device",
      encryptedAccessToken: cipher.encrypt(
        "private-jellyfin-token",
        "service_identity_access_token:jellyfin:saved-viewer-link",
      ),
      externalDisplayName: "Saved Viewer",
      externalServerId: "private-server",
      externalUserId: "private-user",
      externalUsername: "saved-viewer",
      healthState: "linked",
      id: "saved-viewer-link",
      lastVerifiedAt: now,
      revision: 1,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "saved-viewer",
    })
    .run();
  const references = new MediaReferenceService(app.database, appConfig, {
    clock: () => now,
    createToken: () => "m".repeat(22),
  });
  const [referenceId] = references.createOrRefresh(
    { linkId: "saved-viewer-link", linkRevision: 1, userId: "saved-viewer" },
    [
      {
        artwork: { backdropItemId: "private-owned-movie", posterItemId: "private-owned-movie" },
        episodeNumber: null,
        itemId: "private-owned-movie",
        kind: "movie",
        seasonNumber: null,
        title: "Private owned movie",
        year: 2026,
      },
    ],
  );
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "saved-viewer-link",
      userId: "saved-viewer",
    },
  });
  return {
    app,
    headers: {
      [SESSION_CSRF_HEADER]: session.csrfToken,
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
      origin: baseUrl,
    },
    readImage,
    referenceId: referenceId!,
  };
}

describe("saved-list routes", () => {
  it("accepts bodyless list and membership DELETE requests over a real socket", async () => {
    const { app, headers, referenceId } = await harness();
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const created = await fetch(`${address}/v1/saved/lists`, {
        body: JSON.stringify({ description: null, name: "Delete over socket" }),
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "saved-route-socket-create-0001",
        },
        method: "POST",
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const customList = savedListMutationResponseSchema.parse(await created.json()).list;

      const listsResponse = await fetch(`${address}/v1/saved/lists`, {
        headers: { cookie: headers.cookie },
      });
      const watchLater = savedListsResponseSchema.parse(await listsResponse.json()).watchLater;
      const watchLaterResponse = await fetch(`${address}/v1/saved/lists/${watchLater.id}`, {
        headers: { cookie: headers.cookie },
      });
      const targetResponse = await fetch(`${address}/v1/saved/targets/library/${referenceId}`, {
        body: "{}",
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
      });
      const target = savedMembershipSummarySchema.parse(await targetResponse.json());
      const added = await fetch(`${address}/v1/saved/lists/${watchLater.id}/items`, {
        body: JSON.stringify({ targetReferenceId: target.targetReferenceId }),
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "saved-route-socket-add-0001",
          "if-match": String(watchLaterResponse.headers.get("etag")),
        },
        method: "POST",
      });
      expect(added.status, await added.clone().text()).toBe(201);
      const addedItem = savedListMembershipResponseSchema.parse(await added.json()).item;

      const deleteListHeaders = new Headers({
        ...headers,
        accept: "application/json",
        "if-match": String(created.headers.get("etag")),
      });
      expect(deleteListHeaders.has("content-type")).toBe(false);
      const deleted = await fetch(`${address}/v1/saved/lists/${customList.id}`, {
        headers: deleteListHeaders,
        method: "DELETE",
      });
      const deletedBody = await deleted.text();
      expect(deleted.status, deletedBody).toBe(200);
      expect(deletedBody).not.toContain("FST_ERR_CTP_EMPTY_JSON_BODY");
      expect(savedListDeleteResponseSchema.parse(JSON.parse(deletedBody))).toMatchObject({
        listId: customList.id,
      });

      const removeItemHeaders = new Headers({
        ...headers,
        accept: "application/json",
        "if-match": String(added.headers.get("etag")),
      });
      expect(removeItemHeaders.has("content-type")).toBe(false);
      const removed = await fetch(
        `${address}/v1/saved/lists/${watchLater.id}/items/${addedItem.catalog.id}`,
        { headers: removeItemHeaders, method: "DELETE" },
      );
      const removedBody = await removed.text();
      expect(removed.status, removedBody).toBe(200);
      expect(removedBody).not.toContain("FST_ERR_CTP_EMPTY_JSON_BODY");
      expect(savedListMembershipDeleteResponseSchema.parse(JSON.parse(removedBody))).toMatchObject({
        catalogReferenceId: addedItem.catalog.id,
        listId: watchLater.id,
        removed: true,
      });
    } finally {
      await app.close();
    }
  });

  it("returns one private no-store Watch Later list to an authenticated user", async () => {
    const { app, headers } = await harness();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/v1/saved/lists" });
      expect(anonymous.statusCode).toBe(401);

      const response = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: "/v1/saved/lists",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.vary).toBe("Cookie");
      expect(savedListsResponseSchema.parse(response.json())).toMatchObject({
        lists: [],
        watchLater: { itemCount: 0, kind: "watch_later", name: "Watch Later" },
      });
      expect(response.body).not.toMatch(/private-user|private-server|private-jellyfin/u);
    } finally {
      await app.close();
    }
  });

  it("requires CSRF and an idempotency key for custom-list creation", async () => {
    const { app, headers } = await harness();
    try {
      const missingCsrf = await app.inject({
        headers: {
          cookie: headers.cookie,
          "idempotency-key": "saved-route-create-0001",
          origin: headers.origin,
        },
        method: "POST",
        payload: { description: null, name: "Weekend" },
        url: "/v1/saved/lists",
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");

      const missingKey = await app.inject({
        headers,
        method: "POST",
        payload: { description: null, name: "Weekend" },
        url: "/v1/saved/lists",
      });
      expect(missingKey.statusCode).toBe(400);

      const request = {
        headers: { ...headers, "idempotency-key": "saved-route-create-0001" },
        method: "POST" as const,
        payload: { description: "Only this account can read it", name: "Weekend" },
        url: "/v1/saved/lists",
      };
      const created = await app.inject(request);
      const replayed = await app.inject(request);
      expect(created.statusCode, created.body).toBe(201);
      expect(replayed.statusCode, replayed.body).toBe(201);
      expect(created.headers["idempotency-replayed"]).toBe("false");
      expect(replayed.headers["idempotency-replayed"]).toBe("true");
      expect(replayed.body).toBe(created.body);
      expect(created.headers.etag).toMatch(/^"saved_[A-Za-z0-9_-]{22}"$/u);
      expect(created.headers.location).toBe(
        `/v1/saved/lists/${savedListMutationResponseSchema.parse(created.json()).list.id}`,
      );
    } finally {
      await app.close();
    }
  });

  it("enforces ETag concurrency across update, delete, and restore", async () => {
    const { app, headers } = await harness();
    try {
      const created = await app.inject({
        headers: { ...headers, "idempotency-key": "saved-route-create-0002" },
        method: "POST",
        payload: { description: null, name: "Temporary" },
        url: "/v1/saved/lists",
      });
      const listId = savedListMutationResponseSchema.parse(created.json()).list.id;
      const createdEtag = String(created.headers.etag);

      const missingPrecondition = await app.inject({
        headers,
        method: "PATCH",
        payload: { name: "Changed" },
        url: `/v1/saved/lists/${listId}`,
      });
      expect(missingPrecondition.statusCode).toBe(428);

      const stale = await app.inject({
        headers: { ...headers, "if-match": `"saved_${"x".repeat(22)}"` },
        method: "PATCH",
        payload: { name: "Changed" },
        url: `/v1/saved/lists/${listId}`,
      });
      expect(stale.statusCode).toBe(412);
      expect(stale.headers.etag).toBe(createdEtag);
      expect(apiErrorSchema.parse(stale.json()).error.code).toBe("saved_list_revision_stale");

      const updated = await app.inject({
        headers: { ...headers, "if-match": createdEtag },
        method: "PATCH",
        payload: { name: "Changed" },
        url: `/v1/saved/lists/${listId}`,
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(savedListMutationResponseSchema.parse(updated.json()).list).toMatchObject({
        name: "Changed",
        revision: 1,
      });

      const deleted = await app.inject({
        headers: { ...headers, "if-match": String(updated.headers.etag) },
        method: "DELETE",
        url: `/v1/saved/lists/${listId}`,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(savedListDeleteResponseSchema.parse(deleted.json())).toMatchObject({
        listId,
        revision: 2,
      });

      const restored = await app.inject({
        headers: {
          ...headers,
          "idempotency-key": "saved-route-restore-0001",
          "if-match": String(deleted.headers.etag),
        },
        method: "POST",
        payload: {},
        url: `/v1/saved/lists/${listId}/restore`,
      });
      expect(restored.statusCode, restored.body).toBe(200);
      expect(savedListMutationResponseSchema.parse(restored.json()).list).toMatchObject({
        name: "Changed",
        revision: 3,
      });
    } finally {
      await app.close();
    }
  });

  it("adds an issued owned title to Watch Later through the protected web contract", async () => {
    const { app, headers, referenceId } = await harness();
    try {
      const listsResponse = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: "/v1/saved/lists",
      });
      const watchLater = savedListsResponseSchema.parse(listsResponse.json()).watchLater;
      const listResponse = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/saved/lists/${watchLater.id}`,
      });
      const targetResponse = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/${referenceId}`,
      });
      expect(targetResponse.statusCode, targetResponse.body).toBe(201);
      const target = savedMembershipSummarySchema.parse(targetResponse.json());

      const missingPrecondition = await app.inject({
        headers: { ...headers, "idempotency-key": "saved-route-add-owned-0001" },
        method: "POST",
        payload: { targetReferenceId: target.targetReferenceId },
        url: `/v1/saved/lists/${watchLater.id}/items`,
      });
      expect(missingPrecondition.statusCode).toBe(428);

      const staleTarget = await app.inject({
        headers: {
          ...headers,
          "idempotency-key": "saved-route-add-stale-0001",
          "if-match": String(listResponse.headers.etag),
        },
        method: "POST",
        payload: { targetReferenceId: `save_target_${"z".repeat(22)}` },
        url: `/v1/saved/lists/${watchLater.id}/items`,
      });
      expect(staleTarget.statusCode).toBe(404);
      expect(apiErrorSchema.parse(staleTarget.json()).error.code).toBe("saved_target_not_found");

      const request = {
        headers: {
          ...headers,
          "idempotency-key": "saved-route-add-owned-0001",
          "if-match": String(listResponse.headers.etag),
        },
        method: "POST" as const,
        payload: { targetReferenceId: target.targetReferenceId },
        url: `/v1/saved/lists/${watchLater.id}/items`,
      };
      const added = await app.inject(request);
      const replayed = await app.inject(request);
      expect(added.statusCode, added.body).toBe(201);
      expect(replayed.statusCode, replayed.body).toBe(201);
      expect(replayed.body).toBe(added.body);
      expect(added.headers["idempotency-replayed"]).toBe("false");
      expect(replayed.headers["idempotency-replayed"]).toBe("true");
      expect(added.headers.etag).not.toBe(listResponse.headers.etag);
      const addedBody = savedListMembershipResponseSchema.parse(added.json());
      expect(addedBody).toMatchObject({
        created: true,
        item: { catalog: { availability: "owned", title: "Private owned movie" } },
        listId: watchLater.id,
        revision: 1,
      });
      expect(added.headers.location).toBe(
        `/v1/saved/lists/${watchLater.id}/items/${addedBody.item.catalog.id}`,
      );
      expect(added.body).not.toMatch(/private-owned-movie|private-jellyfin-token/u);

      const page = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/saved/lists/${watchLater.id}/items?availability=owned&sort=title`,
      });
      expect(page.statusCode, page.body).toBe(200);
      expect(page.headers["cache-control"]).toBe("private, no-store");
      expect(page.headers.etag).toBe(added.headers.etag);
      expect(savedListItemsResponseSchema.parse(page.json())).toMatchObject({
        items: [{ catalog: { availability: "owned", title: "Private owned movie" } }],
        list: { id: watchLater.id, itemCount: 1, revision: 1 },
        reconciliation: { state: "current" },
      });
      expect(page.body).not.toMatch(/private-owned-movie|private-jellyfin-token/u);

      const removed = await app.inject({
        headers: { ...headers, "if-match": String(page.headers.etag) },
        method: "DELETE",
        url: `/v1/saved/lists/${watchLater.id}/items/${addedBody.item.catalog.id}`,
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(savedListMembershipDeleteResponseSchema.parse(removed.json())).toMatchObject({
        catalogReferenceId: addedBody.item.catalog.id,
        listId: watchLater.id,
        removed: true,
        revision: 2,
      });
      const repeated = await app.inject({
        headers: { ...headers, "if-match": String(listResponse.headers.etag) },
        method: "DELETE",
        url: `/v1/saved/lists/${watchLater.id}/items/${addedBody.item.catalog.id}`,
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(savedListMembershipDeleteResponseSchema.parse(repeated.json())).toMatchObject({
        removed: false,
        revision: 2,
      });
      expect(repeated.headers.etag).toBe(removed.headers.etag);
    } finally {
      await app.close();
    }
  });

  it("proxies saved artwork only while the owned title remains in a private list", async () => {
    const { app, headers, readImage, referenceId } = await harness();
    try {
      const listsResponse = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: "/v1/saved/lists",
      });
      const watchLater = savedListsResponseSchema.parse(listsResponse.json()).watchLater;
      const listResponse = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/saved/lists/${watchLater.id}`,
      });
      const targetResponse = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/${referenceId}`,
      });
      const target = savedMembershipSummarySchema.parse(targetResponse.json());
      const added = await app.inject({
        headers: {
          ...headers,
          "idempotency-key": "saved-route-artwork-0001",
          "if-match": String(listResponse.headers.etag),
        },
        method: "POST",
        payload: { targetReferenceId: target.targetReferenceId },
        url: `/v1/saved/lists/${watchLater.id}/items`,
      });
      const item = savedListMembershipResponseSchema.parse(added.json()).item;
      const artworkUrl = `/v1/saved/catalog/${item.catalog.id}/images/poster`;

      const anonymous = await app.inject({ method: "GET", url: artworkUrl });
      expect(anonymous.statusCode).toBe(401);

      const artwork = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: artworkUrl,
      });
      expect(artwork.statusCode, artwork.body).toBe(200);
      expect(artwork.headers["content-type"]).toBe("image/png");
      expect(artwork.headers["content-disposition"]).toBe("inline");
      expect(artwork.headers["cache-control"]).toBe(
        "private, max-age=3600, stale-while-revalidate=86400",
      );
      expect(artwork.headers.vary).toBe("Cookie, Accept");
      expect(artwork.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(readImage).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: "private-owned-movie", type: "Primary" }),
      );

      const unchanged = await app.inject({
        headers: { cookie: headers.cookie, "if-none-match": String(artwork.headers.etag) },
        method: "GET",
        url: artworkUrl,
      });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.body).toBe("");

      const removed = await app.inject({
        headers: { ...headers, "if-match": String(added.headers.etag) },
        method: "DELETE",
        url: `/v1/saved/lists/${watchLater.id}/items/${item.catalog.id}`,
      });
      expect(removed.statusCode, removed.body).toBe(200);
      const staleArtwork = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: artworkUrl,
      });
      expect(staleArtwork.statusCode).toBe(404);
      expect(apiErrorSchema.parse(staleArtwork.json()).error.code).toBe("saved_artwork_not_found");
    } finally {
      await app.close();
    }
  });

  it("maps private-list conflicts and storage failures to bounded public errors", async () => {
    const { app, headers } = await harness();
    try {
      const initial = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: "/v1/saved/lists",
      });
      const watchLater = savedListsResponseSchema.parse(initial.json()).watchLater;
      const watchLaterRead = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/saved/lists/${watchLater.id}`,
      });

      const immutable = await app.inject({
        headers: { ...headers, "if-match": String(watchLaterRead.headers.etag) },
        method: "PATCH",
        payload: { name: "Renamed" },
        url: `/v1/saved/lists/${watchLater.id}`,
      });
      expect(immutable.statusCode).toBe(409);
      expect(apiErrorSchema.parse(immutable.json()).error.code).toBe("saved_list_immutable");

      const malformedPrecondition = await app.inject({
        headers: { ...headers, "if-match": `W/"saved_${"x".repeat(22)}"` },
        method: "PATCH",
        payload: { name: "Renamed" },
        url: `/v1/saved/lists/${watchLater.id}`,
      });
      expect(malformedPrecondition.statusCode).toBe(400);
      expect(apiErrorSchema.parse(malformedPrecondition.json()).error.code).toBe(
        "saved_list_precondition_invalid",
      );

      const invalidCursor = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/saved/lists?cursor=${"A".repeat(16)}`,
      });
      expect(invalidCursor.statusCode).toBe(400);
      expect(apiErrorSchema.parse(invalidCursor.json()).error.code).toBe(
        "saved_list_cursor_invalid",
      );

      const missing = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: `/v1/saved/lists/saved_list_${"z".repeat(22)}`,
      });
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error.code).toBe("saved_list_not_found");

      const request = {
        headers: { ...headers, "idempotency-key": "saved-route-conflict-0001" },
        method: "POST" as const,
        url: "/v1/saved/lists",
      };
      const created = await app.inject({
        ...request,
        payload: { description: null, name: "Original" },
      });
      const conflict = await app.inject({
        ...request,
        payload: { description: null, name: "Different" },
      });
      expect(created.statusCode).toBe(201);
      expect(conflict.statusCode).toBe(409);
      expect(apiErrorSchema.parse(conflict.json()).error.code).toBe("idempotency_key_conflict");

      const active = savedListMutationResponseSchema.parse(created.json());
      const restoreActive = await app.inject({
        headers: {
          ...headers,
          "idempotency-key": "saved-route-restore-active",
          "if-match": String(created.headers.etag),
        },
        method: "POST",
        payload: {},
        url: `/v1/saved/lists/${active.list.id}/restore`,
      });
      expect(restoreActive.statusCode).toBe(409);
      expect(apiErrorSchema.parse(restoreActive.json()).error.code).toBe("saved_list_not_deleted");

      app.database.sqlite.exec("drop table saved_lists");
      const unavailable = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: "/v1/saved/lists",
      });
      expect(unavailable.statusCode).toBe(503);
      expect(apiErrorSchema.parse(unavailable.json()).error.code).toBe(
        "saved_list_temporarily_unavailable",
      );
      expect(unavailable.body).not.toMatch(/SQLITE|saved_lists/u);
    } finally {
      await app.close();
    }
  });
});
