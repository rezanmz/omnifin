import { apiErrorSchema } from "@omnifin/contracts/errors";
import { savedMembershipSummarySchema } from "@omnifin/contracts/saved";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import type { DatabaseHandle } from "../src/db/client.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-04T10:30:00.000Z");
const baseUrl = "https://omnifin.example";

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
  const readFavoriteState = vi.fn(async () => true);
  const appConfig = config();
  const app = await createApp({
    config: appConfig,
    savedTargetDependencies: {
      clock: () => now,
      createClient: () => ({
        readFavoriteState,
        updateFavoriteState: async ({ favorite }) => favorite,
      }),
      createTargetToken: () => "t".repeat(22),
      mediaReferences: { clock: () => now },
    },
    sessionDependencies: {
      clock: () => now,
      createId: () => `target-route-session-${++sessionId}`,
      createToken: () => Buffer.alloc(32, ++sessionToken).toString("base64url"),
    },
  });
  seed(app.database, appConfig);
  const references = new MediaReferenceService(app.database, appConfig, {
    clock: () => now,
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
    app,
    headers: {
      [SESSION_CSRF_HEADER]: session.csrfToken,
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
      origin: baseUrl,
    },
    readFavoriteState,
    referenceId: referenceId!,
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
        headers: { cookie: headers.cookie, origin: headers.origin },
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
});
