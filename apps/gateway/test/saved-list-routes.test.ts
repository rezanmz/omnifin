import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  savedListDeleteResponseSchema,
  savedListMutationResponseSchema,
  savedListsResponseSchema,
} from "@omnifin/contracts/saved";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";

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
  const app = await createApp({
    config: config(),
    savedListDependencies: {
      clock: () => now,
      createAuditId: () => `saved-route-audit-${++auditId}`,
      createListToken: () => (++listToken).toString(36).padStart(22, "l"),
      createOperationToken: () => (++operationToken).toString(36).padStart(22, "o"),
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
      encryptedCredentials: "v2.private-connector-credentials",
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
      encryptedAccessToken: "v2.private-jellyfin-token",
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
  };
}

describe("saved-list routes", () => {
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
