import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  libraryArtworkSearchResponseSchema,
  libraryAttentionResponseSchema,
  libraryMutationResponseSchema,
} from "@omnifin/contracts/library";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import type { LibraryOperationClient } from "../src/library/operation-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T16:00:00.000Z");
const baseUrl = "https://omnifin.example";
const privateImageUrl = "https://images.example.test/full/private-poster.jpg";
const privatePreviewUrl = "https://images.example.test/thumb/private-poster.jpg";

function config(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 122),
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
    createId: () => `library-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

async function harness() {
  const appConfig = config();
  const listAttentionItems = vi.fn(async () => ({
    items: [
      {
        artwork: { poster: { itemId: "route-private-poster", type: "Primary" as const } },
        externalId: "route-private-movie",
        identityState: "unmatched" as const,
        issues: ["missing_identity" as const, "missing_overview" as const],
        kind: "movie" as const,
        overview: null,
        title: "Ember Coast",
        year: 2026,
      },
    ],
    nextStartIndex: null,
    scanned: 1,
    truncated: false,
  }));
  const scanLibrary = vi.fn(async () => undefined);
  const refreshItem = vi.fn(async () => undefined);
  const updateMetadata = vi.fn(async () => undefined);
  const searchRemoteArtwork = vi.fn(async () => [
    {
      communityRating: 8.6,
      height: 3000,
      imageUrl: privateImageUrl,
      language: "English",
      previewUrl: privatePreviewUrl,
      providerName: "TMDB",
      voteCount: 88,
      width: 2000,
    },
  ]);
  const readRemoteArtwork = vi.fn(async () => ({
    body: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    contentType: "image/jpeg" as const,
  }));
  const applyRemoteArtwork = vi.fn(async () => undefined);
  const client: LibraryOperationClient = {
    applyRemoteArtwork,
    listAttentionItems,
    readRemoteArtwork,
    refreshItem,
    scanLibrary,
    searchRemoteArtwork,
    updateMetadata,
  };
  const operationTokens = ["o".repeat(22), "q".repeat(22), "w".repeat(22), "x".repeat(22)];
  let auditId = 0;
  const app = await createApp({
    config: appConfig,
    libraryOperationDependencies: {
      clock: () => now,
      createAuditId: () => `library-route-audit-${++auditId}`,
      createClient: () => client,
      createOperationToken: () => operationTokens.shift() ?? "z".repeat(22),
      createResultToken: () => "r".repeat(22),
      createSearchToken: () => "s".repeat(22),
      mediaReferences: {
        clock: () => now,
        createToken: () => "m".repeat(22),
      },
    },
    sessionDependencies: sessionDependencies(),
  });
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  app.database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values ('operator-user', 'Library operator', 'operator', 'manual', 'active', ?, ?)`,
    )
    .run(now.getTime(), now.getTime());
  app.database.sqlite
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
      now.getTime(),
      now.getTime(),
    );
  app.database.sqlite
    .prepare(
      `insert into service_identity_links (
         id, user_id, service, connector_id, external_server_id, external_user_id,
         external_username, external_display_name, encrypted_access_token, device_id,
         token_created_at, health_state, revision, created_at, updated_at
       ) values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?, 'linked', 3, ?, ?)`,
    )
    .run(
      "operator-link",
      "operator-user",
      "jellyfin-main",
      "server-1",
      "operator-external",
      "operator",
      "Library operator",
      cipher.encrypt(
        "route-private-jellyfin-token",
        "service_identity_access_token:jellyfin:operator-link",
      ),
      "operator-device",
      now.getTime(),
      now.getTime(),
      now.getTime(),
    );
  const operator = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "operator-link",
      userId: "operator-user",
    },
  });
  const headers = {
    [SESSION_CSRF_HEADER]: operator.csrfToken,
    cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
    origin: baseUrl,
  };
  return {
    app,
    applyRemoteArtwork,
    headers,
    listAttentionItems,
    readRemoteArtwork,
    refreshItem,
    scanLibrary,
    searchRemoteArtwork,
    updateMetadata,
  };
}

describe("library operation routes", () => {
  it("returns only normalized attention data from an authenticated operator", async () => {
    const { app, headers, listAttentionItems } = await harness();
    try {
      const unauthenticated = await app.inject({ method: "GET", url: "/v1/library/attention" });
      expect(unauthenticated.statusCode).toBe(401);
      expect(listAttentionItems).not.toHaveBeenCalled();

      const response = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: "/v1/library/attention?limit=12",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(libraryAttentionResponseSchema.parse(response.json())).toMatchObject({
        items: [{ referenceId: `media_${"m".repeat(22)}`, title: "Ember Coast" }],
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toMatch(/route-private|operator-link|jellyfin-token/u);
    } finally {
      await app.close();
    }
  });

  it("requires CSRF and an idempotency key before accepting one library scan", async () => {
    const { app, headers, scanLibrary } = await harness();
    try {
      const missingCsrf = await app.inject({
        headers: {
          cookie: headers.cookie,
          "idempotency-key": "library-route-scan-0001",
          origin: headers.origin,
        },
        method: "POST",
        payload: {},
        url: "/v1/library/scans",
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");

      const missingKey = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: "/v1/library/scans",
      });
      expect(missingKey.statusCode).toBe(400);
      expect(scanLibrary).not.toHaveBeenCalled();

      const mutationHeaders = { ...headers, "idempotency-key": "library-route-scan-0001" };
      const created = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: {},
        url: "/v1/library/scans",
      });
      const replay = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: {},
        url: "/v1/library/scans",
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(created.headers["idempotency-replayed"]).toBe("false");
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(libraryMutationResponseSchema.parse(created.json())).toEqual(replay.json());
      expect(scanLibrary).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("edits metadata, refreshes, and applies proxied artwork through opaque references", async () => {
    const test = await harness();
    try {
      const attention = await test.app.inject({
        headers: { cookie: test.headers.cookie },
        method: "GET",
        url: "/v1/library/attention",
      });
      const referenceId = libraryAttentionResponseSchema.parse(attention.json()).items[0]!
        .referenceId;
      const refresh = await test.app.inject({
        headers: { ...test.headers, "idempotency-key": "library-route-refresh-0001" },
        method: "POST",
        payload: { imageMode: "replace", metadataMode: "missing" },
        url: `/v1/library/items/${referenceId}/refresh`,
      });
      const metadata = await test.app.inject({
        headers: { ...test.headers, "idempotency-key": "library-route-metadata-0001" },
        method: "POST",
        payload: { title: "Ember Coast: Restored", year: 2027 },
        url: `/v1/library/items/${referenceId}/metadata`,
      });
      expect(refresh.statusCode, refresh.body).toBe(201);
      expect(metadata.statusCode, metadata.body).toBe(201);
      expect(test.refreshItem).toHaveBeenCalledWith(
        { imageMode: "replace", itemId: "route-private-movie", metadataMode: "missing" },
        expect.any(AbortSignal),
      );
      expect(test.updateMetadata).toHaveBeenCalledWith(
        "route-private-movie",
        { title: "Ember Coast: Restored", year: 2027 },
        expect.any(AbortSignal),
      );

      const searchResponse = await test.app.inject({
        headers: test.headers,
        method: "POST",
        payload: { kind: "poster" },
        url: `/v1/library/items/${referenceId}/artwork/search`,
      });
      expect(searchResponse.statusCode, searchResponse.body).toBe(201);
      const search = libraryArtworkSearchResponseSchema.parse(searchResponse.json());
      expect(searchResponse.body).not.toMatch(/images\.example|private-poster/u);

      const preview = await test.app.inject({
        headers: { cookie: test.headers.cookie },
        method: "GET",
        url: search.results[0]!.previewPath,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      expect(preview.headers["content-type"]).toBe("image/jpeg");
      expect(preview.headers["cache-control"]).toBe("private, max-age=300, must-revalidate");
      expect(preview.headers.etag).toMatch(/^"library_artwork_[A-Za-z0-9_-]{22}"$/u);
      expect(test.readRemoteArtwork).toHaveBeenCalledWith(
        privatePreviewUrl,
        expect.any(AbortSignal),
      );

      const notModified = await test.app.inject({
        headers: { cookie: test.headers.cookie, "if-none-match": preview.headers.etag! },
        method: "GET",
        url: search.results[0]!.previewPath,
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe("");

      const applyUrl = search.results[0]!.previewPath.replace(/\/preview$/u, "/apply");
      const applyHeaders = {
        ...test.headers,
        "idempotency-key": "library-route-artwork-0001",
      };
      const applied = await test.app.inject({
        headers: applyHeaders,
        method: "POST",
        payload: {},
        url: applyUrl,
      });
      const replay = await test.app.inject({
        headers: applyHeaders,
        method: "POST",
        payload: {},
        url: applyUrl,
      });
      expect(applied.statusCode, applied.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(test.applyRemoteArtwork).toHaveBeenCalledTimes(1);
      expect(test.applyRemoteArtwork).toHaveBeenCalledWith(
        "route-private-movie",
        "poster",
        privateImageUrl,
        expect.any(AbortSignal),
      );
    } finally {
      await test.app.close();
    }
  });

  it("preserves bounded retry guidance without leaking an upstream response", async () => {
    const { app, headers, listAttentionItems } = await harness();
    listAttentionItems.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "rate_limited",
        message: "route-private Jellyfin response",
        operation: "library.attention",
        retryAfterSeconds: 19,
        retryable: true,
        service: "jellyfin",
      }),
    );
    try {
      const response = await app.inject({
        headers: { cookie: headers.cookie },
        method: "GET",
        url: "/v1/library/attention",
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("19");
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("library_rate_limited");
      expect(response.body).not.toContain("route-private");
    } finally {
      await app.close();
    }
  });
});
