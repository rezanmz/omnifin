import { apiErrorSchema } from "@omnifin/contracts/errors";
import type { DiscoveryMediaDetail } from "@omnifin/contracts/discovery";
import {
  savedFavoriteMutationResponseSchema,
  savedMembershipSummarySchema,
} from "@omnifin/contracts/saved";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import type { DatabaseHandle } from "../src/db/client.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-04T10:30:00.000Z");
const baseUrl = "https://omnifin.example";

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
  overview: "A verified discovery title.",
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
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 150),
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

function seed(database: DatabaseHandle, appConfig: AppConfig) {
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values ('target-viewer', 'Target viewer', 'viewer', 'default', 'active', ?, ?)`,
    )
    .run(now.getTime(), now.getTime());
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
      now.getTime(),
      now.getTime(),
    );
  database.sqlite
    .prepare(
      `insert into service_identity_links (
         id, user_id, service, connector_id, external_server_id, external_user_id,
         external_username, external_display_name, encrypted_access_token, device_id,
         token_created_at, health_state, revision, created_at, updated_at
       ) values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?, 'linked', 2, ?, ?)`,
    )
    .run(
      "target-viewer-link",
      "target-viewer",
      "jellyfin-main",
      "server-private",
      "target-user-private",
      "target-viewer",
      "Target viewer",
      cipher.encrypt(
        "target-private-token",
        "service_identity_access_token:jellyfin:target-viewer-link",
      ),
      "target-viewer-device",
      now.getTime(),
      now.getTime(),
      now.getTime(),
    );
}

async function harness() {
  let sessionId = 0;
  let sessionToken = 0;
  let favorite = true;
  let currentTime = now;
  const readFavoriteState = vi.fn(async () => favorite);
  const resolveDiscovery = vi.fn(async () => discoveryDetail);
  const updateFavoriteState = vi.fn(async (input: { favorite: boolean }) => {
    favorite = input.favorite;
    return favorite;
  });
  const appConfig = config();
  const app = await createApp({
    config: appConfig,
    savedTargetDependencies: {
      clock: () => currentTime,
      createAuditId: () => "saved-route-favorite-audit",
      createClient: () => ({
        readFavoriteState,
        updateFavoriteState,
      }),
      createTargetToken: () => "t".repeat(22),
      mediaReferences: { clock: () => currentTime },
      resolveDiscovery,
    },
    sessionDependencies: {
      clock: () => currentTime,
      createId: () => `target-route-session-${++sessionId}`,
      createToken: () => Buffer.alloc(32, ++sessionToken).toString("base64url"),
    },
  });
  seed(app.database, appConfig);
  const references = new MediaReferenceService(app.database, appConfig, {
    clock: () => currentTime,
    createToken: () => "m".repeat(22),
  });
  const [referenceId] = references.createOrRefresh(
    { linkId: "target-viewer-link", linkRevision: 2, userId: "target-viewer" },
    [
      {
        artwork: { backdropItemId: "private-movie", posterItemId: "private-movie" },
        episodeNumber: null,
        itemId: "private-movie",
        kind: "movie",
        seasonNumber: null,
        title: "Private movie",
        year: 2026,
      },
    ],
  );
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "target-viewer-link",
      userId: "target-viewer",
    },
  });
  return {
    advance(milliseconds: number) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
    app,
    headers: {
      [SESSION_CSRF_HEADER]: session.csrfToken,
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
      origin: baseUrl,
    },
    readFavoriteState,
    referenceId: referenceId!,
    resolveDiscovery,
    updateFavoriteState,
  };
}

describe("saved target routes", () => {
  it("issues a no-store library save target only with session, origin, and CSRF proof", async () => {
    const { app, headers, readFavoriteState, referenceId } = await harness();
    try {
      const anonymous = await app.inject({
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/${referenceId}`,
      });
      expect(anonymous.statusCode).toBe(403);

      const missingCsrf = await app.inject({
        headers: {
          cookie: headers.cookie,
          origin: headers.origin,
        },
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/${referenceId}`,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");

      const response = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/${referenceId}`,
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.vary).toBe("Cookie");
      expect(savedMembershipSummarySchema.parse(response.json())).toMatchObject({
        catalogReferenceId: null,
        favorite: { state: "synced", value: true },
        targetReferenceId: `save_target_${"t".repeat(22)}`,
      });
      expect(readFavoriteState).toHaveBeenCalledWith(
        { itemId: "private-movie", userId: "target-user-private" },
        expect.any(AbortSignal),
      );
      expect(response.body).not.toMatch(/private-movie|target-user-private|target-private-token/u);
    } finally {
      await app.close();
    }
  });

  it("returns bounded not-found and storage-unavailable errors", async () => {
    const { app, headers } = await harness();
    try {
      const missing = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/media_${"z".repeat(22)}`,
      });
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error.code).toBe("saved_target_not_found");

      app.database.sqlite.exec("drop table saved_targets");
      const unavailable = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/media_${"m".repeat(22)}`,
      });
      expect(unavailable.statusCode).toBe(503);
      expect(apiErrorSchema.parse(unavailable.json()).error.code).toBe(
        "saved_target_temporarily_unavailable",
      );
      expect(unavailable.body).not.toMatch(/SQLITE|saved_targets/u);
    } finally {
      await app.close();
    }
  });

  it("returns 410 only for an expired target owned by the active user", async () => {
    const { advance, app, headers, referenceId } = await harness();
    try {
      const issuedResponse = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/${referenceId}`,
      });
      const issued = savedMembershipSummarySchema.parse(issuedResponse.json());
      advance(15 * 60 * 1_000);

      const expired = await app.inject({
        headers: { ...headers, "idempotency-key": "favorite-route-expired" },
        method: "PUT",
        payload: { favorite: false },
        url: `/v1/saved/favorites/${issued.targetReferenceId}`,
      });
      expect(expired.statusCode).toBe(410);
      expect(apiErrorSchema.parse(expired.json()).error.code).toBe("saved_target_expired");

      const unknown = await app.inject({
        headers: { ...headers, "idempotency-key": "favorite-route-unknown" },
        method: "PUT",
        payload: { favorite: false },
        url: `/v1/saved/favorites/save_target_${"z".repeat(22)}`,
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("issues a no-store discovery target without creating a media request", async () => {
    const { app, headers, resolveDiscovery } = await harness();
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: { kind: "movie", language: "en-CA", tmdbId: 603 },
        url: "/v1/saved/targets/discovery",
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(savedMembershipSummarySchema.parse(response.json())).toMatchObject({
        favorite: { state: "not_applicable", value: null },
        targetReferenceId: `save_target_${"t".repeat(22)}`,
        watchLater: false,
      });
      expect(resolveDiscovery).toHaveBeenCalledWith(
        { kind: "movie", language: "en-CA", tmdbId: 603 },
        expect.objectContaining({ userId: "target-viewer" }),
        expect.any(AbortSignal),
      );
      expect(response.body).not.toMatch(/603|The Far Meridian|target-user-private/u);
      expect(
        app.database.sqlite.prepare("select count(*) as count from media_request_operations").get(),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it("changes favorite state only through a confirmed no-store Jellyfin round trip", async () => {
    const { app, headers, referenceId, updateFavoriteState } = await harness();
    try {
      const issuedResponse = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/saved/targets/library/${referenceId}`,
      });
      const issued = savedMembershipSummarySchema.parse(issuedResponse.json());
      const missingCsrf = await app.inject({
        headers: { cookie: headers.cookie, origin: headers.origin },
        method: "PUT",
        payload: { favorite: false },
        url: `/v1/saved/favorites/${issued.targetReferenceId}`,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");

      const changed = await app.inject({
        headers: { ...headers, "idempotency-key": "favorite-route-0001" },
        method: "PUT",
        payload: { favorite: false },
        url: `/v1/saved/favorites/${issued.targetReferenceId}`,
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.headers["cache-control"]).toBe("private, no-store");
      expect(savedFavoriteMutationResponseSchema.parse(changed.json())).toEqual({
        favorite: false,
        synchronizedAt: now.toISOString(),
        targetReferenceId: issued.targetReferenceId,
      });
      expect(updateFavoriteState).toHaveBeenCalledWith(
        { favorite: false, itemId: "private-movie", userId: "target-user-private" },
        expect.any(AbortSignal),
      );
      expect(changed.body).not.toMatch(/private-movie|target-user-private|target-private-token/u);

      const missing = await app.inject({
        headers: { ...headers, "idempotency-key": "favorite-route-missing" },
        method: "PUT",
        payload: { favorite: true },
        url: `/v1/saved/favorites/save_target_${"z".repeat(22)}`,
      });
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error.code).toBe("saved_target_not_found");
    } finally {
      await app.close();
    }
  });
});
