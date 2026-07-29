import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { JellyfinLibraryAttentionResult } from "@omnifin/connectors/media/jellyfin-library-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  LibraryOperationError,
  LibraryOperationService,
  type LibraryOperationClient,
} from "../src/library/operation-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const startedAt = new Date("2026-07-28T15:00:00.000Z");
const privateAccessToken = "private-jellyfin-library-token";
const privateImageUrl = "https://images.example.test/full/poster.jpg?token=private";
const privatePreviewUrl = "https://images.example.test/thumb/poster.jpg?token=private";

function config(): AppConfig {
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

function principal(role: "operator" | "viewer" = "operator"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-27T15:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Library operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-28T16:00:00.000Z",
    issuedAt: startedAt.toISOString(),
    linkedServices: [
      {
        displayName: "Library operator",
        externalUserId: "operator-external",
        health: "linked",
        id: "operator-link",
        lastVerifiedAt: startedAt.toISOString(),
        linkedAt: startedAt.toISOString(),
        service: "jellyfin",
        username: "operator",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: "operator-session",
    userId: "operator-user",
  });
}

function seed(database: DatabaseHandle, appConfig: AppConfig) {
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values ('operator-user', 'Library operator', 'operator', 'manual', 'active', ?, ?)`,
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
      "operator-link",
      "operator-user",
      "jellyfin-main",
      "server-1",
      "operator-external",
      "operator",
      "Library operator",
      cipher.encrypt(privateAccessToken, "service_identity_access_token:jellyfin:operator-link"),
      "operator-device",
      startedAt.getTime(),
      startedAt.getTime(),
      startedAt.getTime(),
    );
}

function attentionResult(): JellyfinLibraryAttentionResult {
  return {
    items: [
      {
        artwork: { poster: { itemId: "private-poster-item", type: "Primary" } },
        externalId: "private-movie-item",
        identityState: "unmatched",
        issues: ["missing_identity", "missing_overview"],
        kind: "movie",
        overview: null,
        title: "Ember Coast",
        year: 2026,
      },
    ],
    nextStartIndex: 40,
    scanned: 40,
    truncated: true,
  };
}

function harness() {
  const appConfig = config();
  const database = openDatabase(":memory:");
  database.migrate();
  seed(database, appConfig);
  let now = startedAt.getTime();
  const listAttentionItems = vi.fn(async () => attentionResult());
  const scanLibrary = vi.fn(async () => undefined);
  const refreshItem = vi.fn(async () => undefined);
  const updateMetadata = vi.fn(async () => undefined);
  const searchRemoteArtwork = vi.fn(async () => [
    {
      communityRating: 8.4,
      height: 3000,
      imageUrl: privateImageUrl,
      language: "English",
      previewUrl: privatePreviewUrl,
      providerName: "TMDB",
      voteCount: 42,
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
  const referenceTokens = ["m".repeat(22), "n".repeat(22), "p".repeat(22)];
  const operationTokens = ["o".repeat(22), "q".repeat(22), "w".repeat(22), "x".repeat(22)];
  let auditId = 0;
  const service = new LibraryOperationService(database, appConfig, {
    clock: () => new Date(now),
    createAuditId: () => `library-audit-${++auditId}`,
    createClient: vi.fn((input) => {
      expect(input.accessToken).toBe(privateAccessToken);
      return client;
    }),
    createOperationToken: () => operationTokens.shift() ?? "z".repeat(22),
    createResultToken: () => "r".repeat(22),
    createSearchToken: () => "s".repeat(22),
    mediaReferences: {
      clock: () => new Date(now),
      createToken: () => referenceTokens.shift() ?? "v".repeat(22),
    },
  });
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    applyRemoteArtwork,
    database,
    listAttentionItems,
    readRemoteArtwork,
    refreshItem,
    scanLibrary,
    searchRemoteArtwork,
    service,
    updateMetadata,
  };
}

const context = (role: "operator" | "viewer" = "operator") => ({
  ipAddress: "203.0.113.41",
  principal: principal(role),
  requestId: "library-request-1",
});

describe("LibraryOperationService", () => {
  it("returns opaque attention items and accepts only a signed link-bound cursor", async () => {
    const test = harness();
    try {
      const first = await test.service.attention({ limit: 30 }, context());
      expect(first).toMatchObject({
        items: [
          {
            identityState: "unmatched",
            posterPath: `/v1/media/media_${"m".repeat(22)}/images/poster`,
            referenceId: `media_${"m".repeat(22)}`,
            title: "Ember Coast",
          },
        ],
        scanned: 40,
        truncated: true,
      });
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/u);
      expect(JSON.stringify(first)).not.toMatch(/private-movie|private-poster|operator-link/u);

      test.listAttentionItems.mockResolvedValueOnce({
        items: [],
        nextStartIndex: null,
        scanned: 0,
        truncated: false,
      });
      await test.service.attention({ cursor: first.nextCursor!, limit: 12 }, context());
      expect(test.listAttentionItems).toHaveBeenLastCalledWith(
        { limit: 12, startIndex: 40 },
        undefined,
      );

      await expect(
        test.service.attention(
          { cursor: `${first.nextCursor!.slice(0, -1)}A`, limit: 12 },
          context(),
        ),
      ).rejects.toMatchObject({ reason: "cursor_invalid" });
    } finally {
      test.database.close();
    }
  });

  it("replays an accepted scan exactly once and records a redacted audit event", async () => {
    const test = harness();
    try {
      const first = await test.service.scan("library-scan-request-0001", context());
      const replay = await test.service.scan("library-scan-request-0001", context());

      expect(first.replayed).toBe(false);
      expect(replay).toEqual({ receipt: first.receipt, replayed: true });
      expect(first.receipt).toMatchObject({
        operationId: `library_operation_${"o".repeat(22)}`,
        referenceId: null,
        state: "accepted",
      });
      expect(test.scanLibrary).toHaveBeenCalledTimes(1);
      const stored = JSON.stringify(
        test.database.sqlite
          .prepare(
            "select idempotency_key_hash as keyHash, response_json as responseJson from library_mutation_operations",
          )
          .all(),
      );
      expect(stored).not.toContain("library-scan-request-0001");
      expect(
        test.database.sqlite
          .prepare("select event_type as eventType, metadata_json as metadata from audit_events")
          .get(),
      ).toEqual({ eventType: "library.scan.requested", metadata: '{"kind":"scan"}' });
    } finally {
      test.database.close();
    }
  });

  it("resolves opaque references for refresh and whitelisted metadata updates", async () => {
    const test = harness();
    try {
      const page = await test.service.attention({ limit: 30 }, context());
      const referenceId = page.items[0]!.referenceId;
      await test.service.refresh(
        referenceId,
        { imageMode: "replace", metadataMode: "missing" },
        "library-refresh-request-0001",
        context(),
      );
      await test.service.updateMetadata(
        referenceId,
        { overview: null, title: "Ember Coast: Restored", year: 2027 },
        "library-metadata-request-0001",
        context(),
      );

      expect(test.refreshItem).toHaveBeenCalledWith(
        {
          imageMode: "replace",
          itemId: "private-movie-item",
          metadataMode: "missing",
        },
        undefined,
      );
      expect(test.updateMetadata).toHaveBeenCalledWith(
        "private-movie-item",
        { overview: null, title: "Ember Coast: Restored", year: 2027 },
        undefined,
      );
      expect(
        JSON.stringify(
          test.database.sqlite
            .prepare("select metadata_json as metadata from audit_events order by created_at, id")
            .all(),
        ),
      ).not.toContain("Ember Coast: Restored");
    } finally {
      test.database.close();
    }
  });

  it("keeps remote artwork locations encrypted while proxying and applying one result", async () => {
    const test = harness();
    try {
      const referenceId = (await test.service.attention({ limit: 30 }, context())).items[0]!
        .referenceId;
      const search = await test.service.searchArtwork(
        referenceId,
        { includeAllLanguages: false, kind: "poster" },
        context(),
      );
      expect(search).toMatchObject({
        referenceId,
        results: [
          {
            id: `library_artwork_result_${"r".repeat(22)}`,
            previewPath: `/v1/library/artwork-searches/library_artwork_search_${"s".repeat(22)}/results/library_artwork_result_${"r".repeat(22)}/preview`,
          },
        ],
        searchId: `library_artwork_search_${"s".repeat(22)}`,
      });
      expect(JSON.stringify(search)).not.toMatch(/images\.example|token=private/u);
      const stored = test.database.sqlite
        .prepare("select encrypted_payload as encryptedPayload from library_artwork_searches")
        .get() as { encryptedPayload: string };
      expect(stored.encryptedPayload).not.toMatch(/images\.example|token=private/u);

      const resultId = search.results[0]!.id;
      const preview = await test.service.previewArtwork(search.searchId, resultId, context());
      expect(preview).toMatchObject({ contentType: "image/jpeg" });
      expect(preview.etag).toMatch(/^"library_artwork_[A-Za-z0-9_-]{22}"$/u);
      expect(test.readRemoteArtwork).toHaveBeenCalledWith(privatePreviewUrl, undefined);

      const applied = await test.service.applyArtwork(
        search.searchId,
        resultId,
        "library-artwork-apply-0001",
        context(),
      );
      const replay = await test.service.applyArtwork(
        search.searchId,
        resultId,
        "library-artwork-apply-0001",
        context(),
      );
      expect(replay).toEqual({ receipt: applied.receipt, replayed: true });
      expect(test.applyRemoteArtwork).toHaveBeenCalledTimes(1);
      expect(test.applyRemoteArtwork).toHaveBeenCalledWith(
        "private-movie-item",
        "poster",
        privateImageUrl,
        undefined,
      );
    } finally {
      test.database.close();
    }
  });

  it("denies viewers locally and persists a safe upstream permission outcome", async () => {
    const test = harness();
    try {
      await expect(
        test.service.scan("library-viewer-scan-0001", context("viewer")),
      ).rejects.toThrow();
      expect(test.scanLibrary).not.toHaveBeenCalled();

      test.scanLibrary.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "upstream_error",
          message: "private upstream denial",
          operation: "library.scan",
          retryable: false,
          service: "jellyfin",
          status: 403,
        }),
      );
      await expect(test.service.scan("library-denied-scan-0001", context())).rejects.toMatchObject({
        reason: "permission_denied",
      });
      await expect(test.service.scan("library-denied-scan-0001", context())).rejects.toMatchObject({
        reason: "permission_denied",
      });
      expect(test.scanLibrary).toHaveBeenCalledTimes(1);
      const operation = test.database.sqlite
        .prepare(
          "select failure_code as failureCode, response_json as responseJson from library_mutation_operations",
        )
        .get() as { failureCode: string; responseJson: string | null };
      expect(operation).toEqual({ failureCode: "permission_denied", responseJson: null });
    } finally {
      test.database.close();
    }
  });

  it("expires artwork selections before any remote request", async () => {
    const test = harness();
    try {
      const referenceId = (await test.service.attention({ limit: 30 }, context())).items[0]!
        .referenceId;
      const search = await test.service.searchArtwork(
        referenceId,
        { includeAllLanguages: false, kind: "poster" },
        context(),
      );
      test.advance(20 * 60 * 1_000 + 1);
      await expect(
        test.service.previewArtwork(search.searchId, search.results[0]!.id, context()),
      ).rejects.toBeInstanceOf(LibraryOperationError);
      expect(test.readRemoteArtwork).not.toHaveBeenCalled();
    } finally {
      test.database.close();
    }
  });
});
