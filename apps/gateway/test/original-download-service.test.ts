import type {
  JellyfinOriginalDownloadMetadata,
  JellyfinOriginalDownloadStream,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { libraryDownloadPrepareResponseSchema } from "@omnifin/contracts/library";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import {
  OriginalDownloadError,
  OriginalDownloadService,
} from "../src/media/original-download-service.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-04T06:00:00.000Z");
const privateItemId = "private-upstream-movie";
const privateToken = "private-jellyfin-download-token";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 121),
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

function asRole(principal: SessionPrincipal, role: Role) {
  return sessionPrincipalSchema.parse({
    ...principal,
    permissions: ROLE_PERMISSIONS[role],
    role,
  });
}

async function harness() {
  const config = testConfig();
  let sessionId = 0;
  let sessionToken = 0;
  const app = await createApp({
    config,
    sessionDependencies: {
      clock: () => now,
      createId: () => `download-session-${++sessionId}`,
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
      displayName: "Download administrator",
      id: "download-admin",
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
      deviceId: "download-device",
      encryptedAccessToken: cipher.encrypt(
        privateToken,
        "service_identity_access_token:jellyfin:download-link",
      ),
      externalDisplayName: "Download administrator",
      externalServerId: "server-1",
      externalUserId: "download-external-user",
      externalUsername: "download-admin",
      healthState: "linked",
      id: "download-link",
      lastVerifiedAt: now,
      revision: 4,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "download-admin",
    })
    .run();
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "download-link",
      userId: "download-admin",
    },
  });
  const referenceId = new MediaReferenceService(app.database, config, {
    clock: () => now,
    createToken: () => "r".repeat(22),
  }).createOrRefresh({ linkId: "download-link", linkRevision: 4, userId: "download-admin" }, [
    {
      artwork: { backdropItemId: null, posterItemId: privateItemId },
      episodeNumber: null,
      itemId: privateItemId,
      kind: "movie",
      seasonNumber: null,
      title: "Northern Lights",
      year: 2026,
    },
  ])[0]!;
  const metadata: JellyfinOriginalDownloadMetadata = {
    canDownload: true,
    container: "mkv",
    etag: "private-source-etag",
    externalId: privateItemId,
    sizeBytes: 50 * 1_024 * 1_024 * 1_024,
    title: "Northern Lights",
    year: 2026,
  };
  const readOriginalDownloadMetadata = vi.fn(async () => metadata);
  const streamOriginalDownload = vi.fn(async (): Promise<JellyfinOriginalDownloadStream> => ({
    acceptRanges: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    }),
    contentLength: 4,
    contentRange: "bytes 0-3/53687091200",
    contentType: "video/x-matroska",
    status: 206,
  }));
  const createClient = vi.fn(() => ({
    readOriginalDownloadMetadata,
    streamOriginalDownload,
  }));
  let auditToken = 0;
  const service = new OriginalDownloadService(app.database, config, {
    clock: () => now,
    createAuditToken: () => String(++auditToken).padStart(22, "a"),
    createGrantToken: () => "g".repeat(22),
    createInternalToken: () => "i".repeat(22),
    createClient,
  });
  return {
    app,
    createClient,
    metadata,
    readOriginalDownloadMetadata,
    referenceId,
    service,
    session,
    streamOriginalDownload,
  };
}

describe("OriginalDownloadService", () => {
  it("prepares a short-lived opaque grant without persisting upstream identifiers", async () => {
    const { app, createClient, readOriginalDownloadMetadata, referenceId, service, session } =
      await harness();
    try {
      const prepared = await service.prepare(referenceId, {
        principal: session.principal,
        requestId: "download-prepare-request",
      });

      expect(libraryDownloadPrepareResponseSchema.parse(prepared)).toEqual(prepared);
      expect(prepared).toMatchObject({
        contentType: "video/x-matroska",
        filename: "Northern Lights (2026).mkv",
        grantId: `media_download_${"g".repeat(22)}`,
        path: `/v1/media/library/downloads/media_download_${"g".repeat(22)}`,
        referenceId,
        sizeBytes: 50 * 1_024 * 1_024 * 1_024,
      });
      expect(Date.parse(prepared.expiresAt) - Date.parse(prepared.generatedAt)).toBe(
        5 * 60 * 1_000,
      );
      expect(readOriginalDownloadMetadata).toHaveBeenCalledWith(
        { itemId: privateItemId, userId: "download-external-user" },
        undefined,
      );
      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: privateToken, deviceId: "download-device" }),
      );
      const persisted = JSON.stringify(
        app.database.sqlite.prepare("select * from media_download_grants").all(),
      );
      expect(persisted).not.toMatch(/private-upstream|private-source-etag|private-jellyfin/u);
      expect(persisted).not.toContain(prepared.grantId);
    } finally {
      await app.close();
    }
  });

  it("revalidates source metadata and forwards only a strict single byte range", async () => {
    const {
      app,
      readOriginalDownloadMetadata,
      referenceId,
      service,
      session,
      streamOriginalDownload,
    } = await harness();
    try {
      const prepared = await service.prepare(referenceId, { principal: session.principal });
      const transfer = await service.open(prepared.grantId, "bytes=0-3", {
        principal: session.principal,
      });

      expect(transfer).toMatchObject({
        acceptRanges: true,
        contentLength: 4,
        contentRange: "bytes 0-3/53687091200",
        contentType: "video/x-matroska",
        filename: "Northern Lights (2026).mkv",
        status: 206,
      });
      expect(readOriginalDownloadMetadata).toHaveBeenCalledTimes(2);
      expect(streamOriginalDownload).toHaveBeenCalledWith(
        {
          itemId: privateItemId,
          maxResponseBytes: 50 * 1_024 * 1_024 * 1_024,
          range: "bytes=0-3",
        },
        undefined,
      );
      await transfer.finish("success", 4);
      expect(
        app.database.sqlite
          .prepare("select state, bytes_transferred as bytesTransferred from media_download_grants")
          .get(),
      ).toEqual({ bytesTransferred: 4, state: "completed" });
    } finally {
      await app.close();
    }
  });

  it("denies other roles and rejects drift, replay from another session, and malformed ranges", async () => {
    const { app, metadata, readOriginalDownloadMetadata, referenceId, service, session } =
      await harness();
    try {
      await expect(
        service.prepare(referenceId, {
          principal: asRole(session.principal, "operator"),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(readOriginalDownloadMetadata).not.toHaveBeenCalled();

      const prepared = await service.prepare(referenceId, { principal: session.principal });
      await expect(
        service.open(prepared.grantId, "bytes=0-1,4-5", { principal: session.principal }),
      ).rejects.toBeInstanceOf(OriginalDownloadError);
      await expect(
        service.open(prepared.grantId, undefined, {
          principal: { ...session.principal, sessionId: "another-session" },
        }),
      ).rejects.toBeInstanceOf(OriginalDownloadError);

      readOriginalDownloadMetadata.mockResolvedValueOnce({ ...metadata, etag: "changed-etag" });
      await expect(
        service.open(prepared.grantId, undefined, { principal: session.principal }),
      ).rejects.toMatchObject({ reason: "source_changed" });
    } finally {
      await app.close();
    }
  });
});
