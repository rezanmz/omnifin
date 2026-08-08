import {
  BazarrTargetError,
  type BazarrSubtitleCandidate,
  type BazarrSubtitleSearchResult,
} from "@omnifin/connectors/adapters/bazarr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";
import {
  SubtitleOperationError,
  SubtitleOperationService,
  type SubtitleAdapter,
} from "../src/subtitles/operation-service.js";

const startedAt = new Date("2026-07-28T12:00:00.000Z");
const privateApiKey = "private-bazarr-api-key";
const privateSubtitleToken = "private-bazarr-cache-token";

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 118),
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
    absoluteExpiresAt: "2026-08-27T12:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Subtitle operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-28T13:00:00.000Z",
    issuedAt: startedAt.toISOString(),
    linkedServices: [
      {
        displayName: "Subtitle operator",
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
  const checkedAt = startedAt.toISOString();
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values ('operator-user', 'Subtitle operator', 'operator', 'manual', 'active', ?, ?)`,
    )
    .run(startedAt.getTime(), startedAt.getTime());
  database.sqlite
    .prepare(
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials, tls_policy,
         insecure_http_approved, capability_snapshot_json, health_state, enabled,
         created_at, updated_at
       ) values (?, ?, ?, ?, ?, 'strict', 0, ?, 'healthy', 1, ?, ?)`,
    )
    .run(
      "jellyfin-main",
      "jellyfin",
      "Home Jellyfin",
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
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials, tls_policy,
         insecure_http_approved, capability_snapshot_json, health_state, enabled,
         created_at, updated_at
       ) values (?, ?, ?, ?, ?, 'strict', 0, ?, 'healthy', 1, ?, ?)`,
    )
    .run(
      "bazarr-main",
      "bazarr",
      "Bazarr",
      "https://bazarr.example.test/",
      cipher.encrypt(
        JSON.stringify({
          credentials: { apiKey: privateApiKey, kind: "api_key" },
          schemaVersion: 1,
        }),
        "connector_credentials:bazarr:bazarr-main",
      ),
      JSON.stringify({
        health: {
          capabilities: [
            "connector.health",
            "connector.version",
            "subtitle.search",
            "subtitle.download",
          ],
          checkedAt,
          connectorId: "bazarr-main",
          displayName: "Bazarr",
          failure: null,
          latencyMs: 4,
          service: "bazarr",
          status: "healthy",
          version: "1.5.6",
        },
        schemaVersion: 1,
      }),
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
      "Subtitle operator",
      cipher.encrypt(
        "private-jellyfin-token",
        "service_identity_access_token:jellyfin:operator-link",
      ),
      "operator-device",
      startedAt.getTime(),
      startedAt.getTime(),
      startedAt.getTime(),
    );
}

function subtitle(overrides: Partial<BazarrSubtitleCandidate> = {}): BazarrSubtitleCandidate {
  return {
    dontMatches: ["release_group"],
    forced: false,
    hearingImpaired: true,
    language: "English",
    matches: ["series", "season", "episode"],
    originalFormat: false,
    provider: "OpenSubtitles.com",
    releaseNames: ["Northern.Lights.S02E03.1080p.WEB-DL"],
    score: 97.5,
    subtitleToken: privateSubtitleToken,
    uploader: "caption-curator",
    ...overrides,
  };
}

function harness(options: { candidates?: BazarrSubtitleCandidate[] } = {}) {
  const appConfig = config();
  const database = openDatabase(":memory:");
  database.migrate();
  seed(database, appConfig);
  let now = startedAt.getTime();
  const mediaReference = new MediaReferenceService(database, appConfig, {
    clock: () => new Date(now),
    createToken: () => "m".repeat(22),
  }).createOrRefresh({ linkId: "operator-link", linkRevision: 3, userId: "operator-user" }, [
    {
      artwork: { backdropItemId: null, posterItemId: null },
      episodeNumber: 3,
      itemId: "episode-upstream-3",
      kind: "episode",
      seasonNumber: 2,
      title: "Northern Lights",
      year: 2026,
    },
  ])[0]!;
  const searchResult: BazarrSubtitleSearchResult = {
    candidates: options.candidates ?? [subtitle()],
    target: { episodeId: 73, kind: "episode", seriesId: 41 },
  };
  const searchSubtitles = vi.fn(async () => searchResult);
  const downloadSubtitle = vi.fn(async () => undefined);
  const adapter: SubtitleAdapter = { downloadSubtitle, searchSubtitles };
  const searchTokens = ["s".repeat(22), "t".repeat(22), "u".repeat(22)];
  const resultTokens = ["r".repeat(22), "q".repeat(22), "p".repeat(22)];
  const operationTokens = ["o".repeat(22), "n".repeat(22), "l".repeat(22)];
  let auditId = 0;
  const service = new SubtitleOperationService(database, appConfig, {
    clock: () => new Date(now),
    createAdapter: vi.fn(() => adapter),
    createAuditId: () => `subtitle-audit-${++auditId}`,
    createOperationToken: () => operationTokens.shift() ?? "k".repeat(22),
    createResultToken: () => resultTokens.shift() ?? "x".repeat(22),
    createSearchToken: () => searchTokens.shift() ?? "y".repeat(22),
    mediaReferences: { clock: () => new Date(now) },
  });
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    database,
    downloadSubtitle,
    mediaReference,
    searchSubtitles,
    service,
  };
}

const context = () => ({
  ipAddress: "203.0.113.25",
  principal: principal(),
  requestId: "subtitle-request-1",
});

describe("SubtitleOperationService", () => {
  it("persists an encrypted, opaque, user-bound subtitle search", async () => {
    const test = harness();
    try {
      const result = await test.service.search(test.mediaReference, context());

      expect(result).toMatchObject({
        media: {
          episodeNumber: 3,
          kind: "episode",
          seasonNumber: 2,
          title: "Northern Lights",
        },
        results: [
          {
            hearingImpaired: true,
            id: `subtitle_result_${"r".repeat(22)}`,
            score: 97.5,
          },
        ],
        searchId: `subtitle_search_${"s".repeat(22)}`,
      });
      expect(test.searchSubtitles).toHaveBeenCalledWith(
        {
          episodeNumber: 3,
          kind: "episode",
          seasonNumber: 2,
          title: "Northern Lights",
          year: 2026,
        },
        undefined,
      );
      expect(JSON.stringify(result)).not.toMatch(/private|episodeId|seriesId|subtitleToken/u);
      const stored = JSON.stringify(
        test.database.sqlite
          .prepare("select encrypted_payload as encryptedPayload from subtitle_searches")
          .all(),
      );
      expect(stored).not.toMatch(/private|episodeId|seriesId|OpenSubtitles/u);
      expect(
        test.database.sqlite
          .prepare("select event_type as eventType, outcome from audit_events")
          .all(),
      ).toContainEqual({ eventType: "subtitle.search.completed", outcome: "success" });
    } finally {
      test.database.close();
    }
  });

  it("downloads one encrypted candidate and safely replays the idempotent receipt", async () => {
    const test = harness();
    try {
      const search = await test.service.search(test.mediaReference, context());
      const resultId = search.results[0]!.id;
      const first = await test.service.download(
        search.searchId,
        resultId,
        "subtitle-download-idempotency-0001",
        context(),
      );
      const replay = await test.service.download(
        search.searchId,
        resultId,
        "subtitle-download-idempotency-0001",
        context(),
      );

      expect(first).toMatchObject({ download: { status: "accepted" }, replayed: false });
      expect(replay).toEqual({ download: first.download, replayed: true });
      expect(test.downloadSubtitle).toHaveBeenCalledTimes(1);
      expect(test.downloadSubtitle).toHaveBeenCalledWith(
        { episodeId: 73, kind: "episode", seriesId: 41 },
        expect.objectContaining({ subtitleToken: privateSubtitleToken }),
        undefined,
        expect.stringMatching(/^mutation_dispatch_[A-Za-z0-9_-]{22}$/u),
      );
      expect(
        test.database.sqlite
          .prepare("select state, response_json as responseJson from subtitle_download_operations")
          .get(),
      ).toMatchObject({ state: "succeeded", responseJson: expect.any(String) });
      expect(
        test.database.sqlite
          .prepare(
            "select state, dispatch_attempt_count as dispatchAttemptCount from external_mutation_dispatches",
          )
          .get(),
      ).toEqual({ dispatchAttemptCount: 1, state: "succeeded" });
      expect(
        test.database.sqlite
          .prepare("select event_type as eventType, outcome from audit_events order by created_at")
          .all(),
      ).toContainEqual({ eventType: "subtitle.download.accepted", outcome: "success" });
    } finally {
      test.database.close();
    }
  });

  it("persists a safe failure after expiry and never contacts Bazarr", async () => {
    const test = harness();
    try {
      const search = await test.service.search(test.mediaReference, context());
      test.advance(20 * 60 * 1_000);
      const attempt = () =>
        test.service.download(
          search.searchId,
          search.results[0]!.id,
          "subtitle-download-expired-0001",
          context(),
        );

      await expect(attempt()).rejects.toMatchObject({ reason: "search_expired" });
      await expect(attempt()).rejects.toMatchObject({ reason: "search_expired" });
      expect(test.downloadSubtitle).not.toHaveBeenCalled();
      expect(
        test.database.sqlite
          .prepare("select state, failure_code as failureCode from subtitle_download_operations")
          .get(),
      ).toEqual({ failureCode: "search_expired", state: "failed" });
    } finally {
      test.database.close();
    }
  });

  it("quarantines a lost Bazarr download response without redispatch under any key", async () => {
    const test = harness();
    try {
      const search = await test.service.search(test.mediaReference, context());
      const resultId = search.results[0]!.id;
      test.downloadSubtitle.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "private Bazarr timeout",
          operation: "subtitle.download",
          retryable: true,
          service: "bazarr",
        }),
      );
      const attempt = (key: string) =>
        test.service.download(search.searchId, resultId, key, context());

      await expect(attempt("subtitle-download-timeout-0001")).rejects.toMatchObject({
        reason: "outcome_uncertain",
      });
      await expect(attempt("subtitle-download-timeout-0001")).rejects.toMatchObject({
        reason: "outcome_uncertain",
      });
      await expect(attempt("subtitle-download-timeout-0002")).rejects.toMatchObject({
        reason: "outcome_uncertain",
      });
      expect(test.downloadSubtitle).toHaveBeenCalledOnce();
      expect(
        test.database.sqlite
          .prepare("select state, failure_code as failureCode from external_mutation_dispatches")
          .get(),
      ).toEqual({ failureCode: "outcome_uncertain", state: "uncertain" });
      expect(
        JSON.stringify(
          test.database.sqlite
            .prepare("select encrypted_normalized_request from external_mutation_dispatches")
            .get(),
        ),
      ).not.toContain(privateSubtitleToken);
      expect(
        test.database.sqlite
          .prepare("select count(*) as count from external_mutation_target_locks")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      test.database.close();
    }
  });

  it("rejects idempotency-key reuse for a different result before a second mutation", async () => {
    const test = harness({ candidates: [subtitle(), subtitle({ language: "French" })] });
    try {
      const search = await test.service.search(test.mediaReference, context());
      await test.service.download(
        search.searchId,
        search.results[0]!.id,
        "subtitle-download-conflict-0001",
        context(),
      );
      await expect(
        test.service.download(
          search.searchId,
          search.results[1]!.id,
          "subtitle-download-conflict-0001",
          context(),
        ),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      expect(test.downloadSubtitle).toHaveBeenCalledTimes(1);
    } finally {
      test.database.close();
    }
  });

  it("fails closed on role, ownership, target matching, and capability changes", async () => {
    const test = harness();
    try {
      await expect(
        test.service.search(test.mediaReference, { principal: principal("viewer") }),
      ).rejects.toMatchObject({ code: "permission_denied", statusCode: 403 });
      await expect(test.service.search(`media_${"z".repeat(22)}`, context())).rejects.toMatchObject(
        { reason: "media_not_found" },
      );

      test.database.sqlite
        .prepare(
          "update connector_configs set capability_snapshot_json = ? where id = 'bazarr-main'",
        )
        .run(JSON.stringify({ schemaVersion: 1 }));
      await expect(test.service.search(test.mediaReference, context())).rejects.toMatchObject({
        reason: "connector_integrity_failure",
      });
    } finally {
      test.database.close();
    }
  });

  it("maps an ambiguous Bazarr library match without exposing target details", async () => {
    const test = harness();
    test.searchSubtitles.mockRejectedValueOnce(new BazarrTargetError("ambiguous"));
    try {
      const failure = await test.service
        .search(test.mediaReference, context())
        .catch((error) => error);
      expect(failure).toBeInstanceOf(SubtitleOperationError);
      expect(failure).toMatchObject({
        message: "The subtitle operation could not be completed.",
        reason: "target_ambiguous",
      });
      expect(failure).not.toHaveProperty("title");
    } finally {
      test.database.close();
    }
  });

  it("treats an invalid adapter result as an upstream response failure", async () => {
    const test = harness();
    test.searchSubtitles.mockResolvedValueOnce({
      candidates: [subtitle({ score: Number.NaN })],
      target: { episodeId: 73, kind: "episode", seriesId: 41 },
    });
    try {
      await expect(test.service.search(test.mediaReference, context())).rejects.toMatchObject({
        reason: "response_invalid",
      });
      expect(
        test.database.sqlite.prepare("select count(*) as count from subtitle_searches").get(),
      ).toEqual({ count: 0 });
    } finally {
      test.database.close();
    }
  });
});
