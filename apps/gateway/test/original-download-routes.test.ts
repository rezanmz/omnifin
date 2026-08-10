import type {
  JellyfinOriginalDownloadMetadata,
  JellyfinOriginalDownloadStream,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { libraryDownloadPrepareResponseSchema } from "@omnifin/contracts/library";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { createOriginalDownloadResponseBody } from "../src/media/original-download-routes.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-04T07:00:00.000Z");
const privateItemId = "route-private-original-movie";
const privateToken = "route-private-original-token";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
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

async function harness() {
  const config = testConfig();
  const metadata: JellyfinOriginalDownloadMetadata = {
    canDownload: true,
    container: "mp4",
    etag: "route-private-etag",
    externalId: privateItemId,
    sizeBytes: 9_000_000_000,
    title: "Ember Coast",
    year: 2026,
  };
  const readOriginalDownloadMetadata = vi.fn(async () => metadata);
  const streamOriginalDownload = vi.fn(
    async (_input?: unknown, _signal?: AbortSignal): Promise<JellyfinOriginalDownloadStream> => ({
      acceptRanges: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 2, 3]));
          controller.close();
        },
      }),
      contentLength: 4,
      contentRange: "bytes 0-3/9000000000",
      contentType: "video/mp4",
      status: 206,
    }),
  );
  let auditToken = 0;
  let grantToken = 0;
  let internalToken = 0;
  let sessionId = 0;
  let sessionToken = 0;
  const app = await createApp({
    config,
    originalDownloadDependencies: {
      clock: () => now,
      createAuditToken: () => String(++auditToken).padStart(22, "a"),
      createClient: () => ({ readOriginalDownloadMetadata, streamOriginalDownload }),
      createGrantToken: () => String(++grantToken).padStart(22, "g"),
      createInternalToken: () => String(++internalToken).padStart(22, "i"),
    },
    sessionDependencies: {
      clock: () => now,
      createId: () => `original-route-session-${++sessionId}`,
      createToken: () => Buffer.alloc(32, ++sessionToken).toString("base64url"),
    },
  });
  const cipher = new EnvelopeCipher(config.encryptionKey);
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: "Home Jellyfin",
      enabled: true,
      encryptedCredentials: cipher.encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:jellyfin-main",
      ),
      healthState: "healthy",
      id: "jellyfin-main",
      insecureHttpApproved: false,
      tlsPolicy: "strict",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Original download admin",
      id: "original-route-admin",
      role: "admin",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-main",
      createdAt: now,
      deviceId: "original-route-device",
      encryptedAccessToken: cipher.encrypt(
        privateToken,
        "service_identity_access_token:jellyfin:original-route-link",
      ),
      externalDisplayName: "Original download admin",
      externalServerId: "server-1",
      externalUserId: "original-route-external",
      externalUsername: "original-route-admin",
      healthState: "linked",
      id: "original-route-link",
      lastVerifiedAt: now,
      revision: 2,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "original-route-admin",
    })
    .run();
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "original-route-link",
      userId: "original-route-admin",
    },
  });
  const otherSession = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "original-route-link",
      userId: "original-route-admin",
    },
  });
  const referenceId = new MediaReferenceService(app.database, config, {
    clock: () => now,
    createToken: () => "r".repeat(22),
  }).createOrRefresh(
    { linkId: "original-route-link", linkRevision: 2, userId: "original-route-admin" },
    [
      {
        artwork: { backdropItemId: null, posterItemId: privateItemId },
        episodeNumber: null,
        itemId: privateItemId,
        kind: "movie",
        seasonNumber: null,
        title: "Ember Coast",
        year: 2026,
      },
    ],
  )[0]!;
  return {
    app,
    headers: {
      [SESSION_CSRF_HEADER]: session.csrfToken,
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
      origin: config.baseUrl.origin,
    },
    metadata,
    otherSession,
    readOriginalDownloadMetadata,
    referenceId,
    streamOriginalDownload,
  };
}

describe("original download routes", () => {
  it("prepares and streams an authenticated same-origin byte range with safe headers", async () => {
    const test = await harness();
    try {
      const preparedResponse = await test.app.inject({
        headers: test.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${test.referenceId}/downloads`,
      });
      expect(preparedResponse.statusCode, preparedResponse.body).toBe(201);
      const prepared = libraryDownloadPrepareResponseSchema.parse(preparedResponse.json());
      expect(preparedResponse.headers["cache-control"]).toBe("private, no-store");
      expect(preparedResponse.body).not.toMatch(/route-private|jellyfin\.example/u);

      const streamed = await test.app.inject({
        headers: {
          cookie: test.headers.cookie,
          range: "bytes=0-3",
        },
        method: "GET",
        url: prepared.path,
      });
      expect(streamed.statusCode, streamed.body).toBe(206);
      expect(streamed.rawPayload).toEqual(Buffer.from([0, 1, 2, 3]));
      expect(streamed.headers).toMatchObject({
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-length": "4",
        "content-range": "bytes 0-3/9000000000",
        "content-type": "video/mp4",
        pragma: "no-cache",
      });
      expect(streamed.headers["content-disposition"]).toContain(
        'attachment; filename="Ember Coast (2026).mp4"',
      );
      expect(test.streamOriginalDownload).toHaveBeenCalledWith(
        {
          itemId: privateItemId,
          maxResponseBytes: 9_000_000_000,
          range: "bytes=0-3",
        },
        expect.any(AbortSignal),
      );
      expect(
        test.app.database.sqlite
          .prepare("select state, bytes_transferred as bytesTransferred from media_download_grants")
          .get(),
      ).toEqual({ bytesTransferred: 4, state: "completed" });
    } finally {
      await test.app.close();
    }
  });

  it("requires CSRF to mint a grant and binds the grant to its originating session", async () => {
    const test = await harness();
    try {
      const rejected = await test.app.inject({
        headers: { cookie: test.headers.cookie, origin: test.headers.origin },
        method: "POST",
        payload: {},
        url: `/v1/media/library/${test.referenceId}/downloads`,
      });
      expect(rejected.statusCode).toBe(403);
      expect(test.readOriginalDownloadMetadata).not.toHaveBeenCalled();

      const preparedResponse = await test.app.inject({
        headers: test.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${test.referenceId}/downloads`,
      });
      const prepared = libraryDownloadPrepareResponseSchema.parse(preparedResponse.json());
      const replay = await test.app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${test.otherSession.sessionToken}`,
          range: "bytes=0-3",
        },
        method: "GET",
        url: prepared.path,
      });
      expect(replay.statusCode).toBe(404);
      expect(apiErrorSchema.parse(replay.json()).error.code).toBe("original_download_not_found");
      expect(test.streamOriginalDownload).not.toHaveBeenCalled();
    } finally {
      await test.app.close();
    }
  });

  it("rejects multi-range requests before contacting the Jellyfin file endpoint", async () => {
    const test = await harness();
    try {
      const preparedResponse = await test.app.inject({
        headers: test.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${test.referenceId}/downloads`,
      });
      const prepared = libraryDownloadPrepareResponseSchema.parse(preparedResponse.json());
      const response = await test.app.inject({
        headers: { cookie: test.headers.cookie, range: "bytes=0-1,4-5" },
        method: "GET",
        url: prepared.path,
      });
      expect(response.statusCode, response.body).toBe(416);
      expect(response.headers["content-range"]).toBe("bytes */9000000000");
      expect(test.streamOriginalDownload).not.toHaveBeenCalled();
    } finally {
      await test.app.close();
    }
  });

  it("streams a full response with conservative fallback headers", async () => {
    const test = await harness();
    try {
      const preparedResponse = await test.app.inject({
        headers: test.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${test.referenceId}/downloads`,
      });
      const prepared = libraryDownloadPrepareResponseSchema.parse(preparedResponse.json());
      test.streamOriginalDownload.mockResolvedValueOnce({
        acceptRanges: false,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([4, 3, 2, 1]));
            controller.close();
          },
        }),
        contentLength: null,
        contentRange: null,
        contentType: null,
        status: 200,
      });

      const streamed = await test.app.inject({
        headers: { cookie: test.headers.cookie },
        method: "GET",
        url: prepared.path,
      });
      expect(streamed.statusCode, streamed.body).toBe(200);
      expect(streamed.rawPayload).toEqual(Buffer.from([4, 3, 2, 1]));
      expect(streamed.headers["accept-ranges"]).toBe("none");
      expect(streamed.headers["content-type"]).toBe("application/octet-stream");
      expect(streamed.headers).not.toHaveProperty("content-range");
      expect(test.streamOriginalDownload).toHaveBeenCalledWith(
        { itemId: privateItemId, maxResponseBytes: 9_000_000_000 },
        expect.any(AbortSignal),
      );
    } finally {
      await test.app.close();
    }
  });

  it("maps denied, unavailable, changed, and expired sources to stable public errors", async () => {
    const denied = await harness();
    try {
      denied.readOriginalDownloadMetadata.mockResolvedValueOnce({
        ...denied.metadata,
        canDownload: false,
      });
      const response = await denied.app.inject({
        headers: denied.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${denied.referenceId}/downloads`,
      });
      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "original_download_permission_denied",
      );
    } finally {
      await denied.app.close();
    }

    const unavailable = await harness();
    try {
      unavailable.readOriginalDownloadMetadata.mockRejectedValueOnce(
        new Error("private upstream error"),
      );
      const response = await unavailable.app.inject({
        headers: unavailable.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${unavailable.referenceId}/downloads`,
      });
      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "original_download_unavailable",
      );
    } finally {
      await unavailable.app.close();
    }

    const changed = await harness();
    try {
      const preparedResponse = await changed.app.inject({
        headers: changed.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${changed.referenceId}/downloads`,
      });
      const prepared = libraryDownloadPrepareResponseSchema.parse(preparedResponse.json());
      changed.readOriginalDownloadMetadata.mockResolvedValueOnce({
        ...changed.metadata,
        etag: "changed-private-etag",
      });
      const response = await changed.app.inject({
        headers: { cookie: changed.headers.cookie },
        method: "GET",
        url: prepared.path,
      });
      expect(response.statusCode).toBe(409);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "original_download_source_changed",
      );
    } finally {
      await changed.app.close();
    }

    const expired = await harness();
    try {
      const preparedResponse = await expired.app.inject({
        headers: expired.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${expired.referenceId}/downloads`,
      });
      const prepared = libraryDownloadPrepareResponseSchema.parse(preparedResponse.json());
      expired.app.database.sqlite
        .prepare("update media_download_grants set created_at = ?, updated_at = ?, expires_at = ?")
        .run(now.getTime() - 2, now.getTime() - 2, now.getTime() - 1);
      const response = await expired.app.inject({
        headers: { cookie: expired.headers.cookie },
        method: "GET",
        url: prepared.path,
      });
      expect(response.statusCode).toBe(410);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("original_download_expired");
    } finally {
      await expired.app.close();
    }
  }, 15_000);

  it("cancels the bounded Jellyfin stream when the downstream response closes", async () => {
    const cancelled = vi.fn();
    const finish = vi.fn(async () => {});
    const response = createOriginalDownloadResponseBody(
      {
        acceptRanges: true,
        body: new ReadableStream<Uint8Array>({
          cancel: cancelled,
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          },
        }),
        contentLength: 4,
        contentRange: null,
        contentType: "video/mp4",
        filename: "Ember Coast (2026).mp4",
        finish,
        status: 200,
      },
      vi.fn(),
    );

    response.body.once("data", () => response.cancel());
    response.body.resume();

    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith("cancelled", 4));
    expect(String(cancelled.mock.calls[0]?.[0])).not.toMatch(/jellyfin|token|item/iu);
  });

  it("cancels an in-flight original stream with AbortError when runtime drain begins", async () => {
    const test = await harness();
    let streamSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    test.streamOriginalDownload.mockImplementationOnce(
      async (_input: unknown, signal?: AbortSignal): Promise<never> => {
        streamSignal = signal;
        started();
        return await new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );

    try {
      const preparedResponse = await test.app.inject({
        headers: test.headers,
        method: "POST",
        payload: {},
        url: `/v1/media/library/${test.referenceId}/downloads`,
      });
      const prepared = libraryDownloadPrepareResponseSchema.parse(preparedResponse.json());
      const pending = test.app.inject({
        headers: { cookie: test.headers.cookie },
        method: "GET",
        url: prepared.path,
      });

      await startedPromise;
      test.app.runtimeDrain.beginDrain("test drain");
      const response = await pending;

      expect(response.statusCode).toBe(503);
      expect(streamSignal?.reason).toBeInstanceOf(DOMException);
      expect((streamSignal?.reason as DOMException).name).toBe("AbortError");
    } finally {
      await test.app.close();
    }
  });
});
