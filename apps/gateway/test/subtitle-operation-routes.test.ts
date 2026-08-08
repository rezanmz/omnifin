import type { BazarrSubtitleSearchResult } from "@omnifin/connectors/adapters/bazarr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  subtitleDownloadResponseSchema,
  subtitleSearchResponseSchema,
} from "@omnifin/contracts/subtitles";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { MediaReferenceService } from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";
import {
  SubtitleOperationError,
  SubtitleOperationService,
  type SubtitleOperationErrorReason,
} from "../src/subtitles/operation-service.js";

const now = new Date("2026-07-28T14:00:00.000Z");
const baseUrl = "https://omnifin.example";
const privateSubtitleToken = "route-private-subtitle-cache-token";

function config(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 119),
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
    createId: () => `subtitle-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

async function harness() {
  const appConfig = config();
  const searchResult: BazarrSubtitleSearchResult = {
    candidates: [
      {
        dontMatches: [],
        forced: false,
        hearingImpaired: false,
        language: "English",
        matches: ["title", "season", "episode"],
        originalFormat: false,
        provider: "OpenSubtitles.com",
        releaseNames: ["Northern.Lights.S02E03.1080p.WEB-DL"],
        score: 98,
        subtitleToken: privateSubtitleToken,
        uploader: null,
      },
    ],
    target: { episodeId: 73, kind: "episode", seriesId: 41 },
  };
  const searchSubtitles = vi.fn(async () => searchResult);
  const downloadSubtitle = vi.fn(async () => undefined);
  let auditId = 0;
  const app = await createApp({
    config: appConfig,
    sessionDependencies: sessionDependencies(),
    subtitleOperationDependencies: {
      clock: () => now,
      createAdapter: () => ({ downloadSubtitle, searchSubtitles }),
      createAuditId: () => `subtitle-route-audit-${++auditId}`,
      createOperationToken: () => "o".repeat(22),
      createResultToken: () => "r".repeat(22),
      createSearchToken: () => "s".repeat(22),
      mediaReferences: { clock: () => now },
    },
  });
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  app.database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values ('operator-user', 'Subtitle operator', 'operator', 'manual', 'active', ?, ?)`,
    )
    .run(now.getTime(), now.getTime());
  app.database.sqlite
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
      now.getTime(),
      now.getTime(),
    );
  app.database.sqlite
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
          credentials: { apiKey: "route-private-bazarr-key", kind: "api_key" },
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
          checkedAt: now.toISOString(),
          connectorId: "bazarr-main",
          displayName: "Bazarr",
          failure: null,
          latencyMs: 3,
          service: "bazarr",
          status: "healthy",
          version: "1.5.6",
        },
        schemaVersion: 1,
      }),
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
      "Subtitle operator",
      cipher.encrypt(
        "route-private-jellyfin-token",
        "service_identity_access_token:jellyfin:operator-link",
      ),
      "operator-device",
      now.getTime(),
      now.getTime(),
      now.getTime(),
    );
  const mediaReference = new MediaReferenceService(app.database, appConfig, {
    clock: () => now,
    createToken: () => "m".repeat(22),
  }).createOrRefresh({ linkId: "operator-link", linkRevision: 3, userId: "operator-user" }, [
    {
      artwork: { backdropItemId: null, posterItemId: null },
      episodeNumber: 3,
      itemId: "route-private-episode",
      kind: "episode",
      seasonNumber: 2,
      title: "Northern Lights",
      year: 2026,
    },
  ])[0]!;
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
  return { app, downloadSubtitle, headers, mediaReference, searchSubtitles };
}

describe("subtitle operation routes", () => {
  it("requires CSRF before searching and returns only normalized private results", async () => {
    const { app, headers, mediaReference, searchSubtitles } = await harness();
    try {
      const missingCsrf = await app.inject({
        headers: { cookie: headers.cookie, origin: headers.origin },
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");
      expect(searchSubtitles).not.toHaveBeenCalled();

      const response = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(subtitleSearchResponseSchema.parse(response.json())).toMatchObject({
        results: [{ id: `subtitle_result_${"r".repeat(22)}`, language: "English" }],
        searchId: `subtitle_search_${"s".repeat(22)}`,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toBe("Cookie");
      expect(response.body).not.toMatch(/route-private|episodeId|seriesId|subtitleToken/u);
    } finally {
      await app.close();
    }
  });

  it("requires an idempotency key and replays one accepted Bazarr download", async () => {
    const { app, downloadSubtitle, headers, mediaReference } = await harness();
    try {
      const search = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      const found = subtitleSearchResponseSchema.parse(search.json());
      const downloadUrl = `/v1/subtitle-searches/${found.searchId}/results/${found.results[0]!.id}/download`;
      const missingKey = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: downloadUrl,
      });
      expect(missingKey.statusCode).toBe(400);
      expect(downloadSubtitle).not.toHaveBeenCalled();

      const downloadHeaders = {
        ...headers,
        "idempotency-key": "subtitle-route-download-0001",
      };
      const created = await app.inject({
        headers: downloadHeaders,
        method: "POST",
        payload: {},
        url: downloadUrl,
      });
      const replay = await app.inject({
        headers: downloadHeaders,
        method: "POST",
        payload: {},
        url: downloadUrl,
      });

      expect(created.statusCode, created.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(created.headers["idempotency-replayed"]).toBe("false");
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(subtitleDownloadResponseSchema.parse(created.json())).toEqual(replay.json());
      expect(downloadSubtitle).toHaveBeenCalledTimes(1);
      expect(`${created.body}${replay.body}`).not.toContain(privateSubtitleToken);
    } finally {
      await app.close();
    }
  });

  it("preserves bounded upstream retry guidance without exposing details", async () => {
    const { app, headers, mediaReference, searchSubtitles } = await harness();
    searchSubtitles.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "rate_limited",
        message: "route-private Bazarr response",
        operation: "subtitle.search",
        retryAfterSeconds: 17,
        retryable: true,
        service: "bazarr",
      }),
    );
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("17");
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("subtitle_rate_limited");
      expect(response.body).not.toContain("route-private");
    } finally {
      await app.close();
    }
  });

  it("returns a stable terminal uncertainty code after a lost Bazarr response", async () => {
    const { app, downloadSubtitle, headers, mediaReference } = await harness();
    try {
      const search = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      const found = subtitleSearchResponseSchema.parse(search.json());
      downloadSubtitle.mockRejectedValueOnce(
        new SafeConnectorError({
          code: "timeout",
          message: "route-private lost Bazarr response",
          operation: "subtitle.download",
          retryable: true,
          service: "bazarr",
        }),
      );
      const request = () =>
        app.inject({
          headers: { ...headers, "idempotency-key": "subtitle-route-timeout-0001" },
          method: "POST",
          payload: {},
          url: `/v1/subtitle-searches/${found.searchId}/results/${found.results[0]!.id}/download`,
        });
      const first = await request();
      const replay = await request();
      expect(first.statusCode).toBe(409);
      expect(replay.statusCode).toBe(409);
      expect(apiErrorSchema.parse(first.json()).error.code).toBe(
        "subtitle_download_outcome_uncertain",
      );
      expect(downloadSubtitle).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each<{
    code: string;
    reason: SubtitleOperationErrorReason;
    retryAfter?: string;
    status: number;
  }>([
    { code: "media_reference_not_found", reason: "media_not_found", status: 404 },
    { code: "subtitle_media_unsupported", reason: "media_unsupported", status: 409 },
    { code: "subtitle_media_not_indexed", reason: "target_not_found", status: 409 },
    { code: "subtitle_media_ambiguous", reason: "target_ambiguous", status: 409 },
    { code: "subtitle_identity_required", reason: "identity_required", status: 403 },
    {
      code: "subtitle_rate_limited",
      reason: "rate_limited",
      retryAfter: "30",
      status: 429,
    },
    { code: "subtitle_response_invalid", reason: "response_invalid", status: 502 },
    { code: "subtitle_configuration_unavailable", reason: "connector_ambiguous", status: 503 },
    {
      code: "subtitle_configuration_unavailable",
      reason: "connector_integrity_failure",
      status: 503,
    },
    { code: "subtitle_configuration_unavailable", reason: "connector_unconfigured", status: 503 },
    {
      code: "subtitle_configuration_unavailable",
      reason: "configuration_unavailable",
      status: 503,
    },
    { code: "subtitle_configuration_unavailable", reason: "storage_failure", status: 503 },
    { code: "subtitle_temporarily_unavailable", reason: "temporarily_unavailable", status: 503 },
  ])("maps subtitle search failure $reason", async ({ code, reason, retryAfter, status }) => {
    const { app, headers, mediaReference } = await harness();
    const search = vi
      .spyOn(SubtitleOperationService.prototype, "search")
      .mockRejectedValue(new SubtitleOperationError(reason));
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
      expect(response.headers["retry-after"]).toBe(retryAfter);
    } finally {
      search.mockRestore();
      await app.close();
    }
  });

  it.each<{
    code: string;
    reason: SubtitleOperationErrorReason;
    retryAfter?: string;
    status: number;
  }>([
    { code: "subtitle_search_expired", reason: "search_expired", status: 409 },
    { code: "idempotency_key_conflict", reason: "idempotency_conflict", status: 409 },
    {
      code: "subtitle_download_outcome_pending",
      reason: "idempotency_in_progress",
      retryAfter: "2",
      status: 409,
    },
    {
      code: "subtitle_operation_limit_reached",
      reason: "operation_limit_reached",
      retryAfter: "60",
      status: 429,
    },
    { code: "subtitle_download_outcome_uncertain", reason: "outcome_uncertain", status: 409 },
  ])("maps subtitle download failure $reason", async ({ code, reason, retryAfter, status }) => {
    const { app, headers } = await harness();
    const download = vi
      .spyOn(SubtitleOperationService.prototype, "download")
      .mockRejectedValue(new SubtitleOperationError(reason));
    try {
      const response = await app.inject({
        headers: { ...headers, "idempotency-key": "subtitle-route-error-mapping" },
        method: "POST",
        payload: {},
        url: `/v1/subtitle-searches/subtitle_search_${"s".repeat(22)}/results/subtitle_result_${"r".repeat(22)}/download`,
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
      expect(response.headers["retry-after"]).toBe(retryAfter);
    } finally {
      download.mockRestore();
      await app.close();
    }
  });

  it.each([
    ["response_invalid", "subtitle_response_invalid", 502],
    ["unsupported_version", "subtitle_response_invalid", 502],
    ["configuration_invalid", "subtitle_configuration_unavailable", 503],
    ["destination_blocked", "subtitle_configuration_unavailable", 503],
    ["invalid_credentials", "subtitle_configuration_unavailable", 503],
    ["timeout", "subtitle_temporarily_unavailable", 503],
  ] as const)("maps upstream subtitle %s failures", async (upstreamCode, code, status) => {
    const { app, headers, mediaReference, searchSubtitles } = await harness();
    searchSubtitles.mockRejectedValueOnce(
      new SafeConnectorError({
        code: upstreamCode,
        message: "private subtitle upstream detail",
        operation: "subtitle.search",
        retryable: upstreamCode === "timeout",
        service: "bazarr",
      }),
    );
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
      expect(response.body).not.toContain("private subtitle upstream detail");
    } finally {
      await app.close();
    }
  });

  it("omits retry-after when Bazarr supplies no bounded delay", async () => {
    const { app, headers, mediaReference, searchSubtitles } = await harness();
    searchSubtitles.mockRejectedValueOnce(
      new SafeConnectorError({
        code: "rate_limited",
        message: "private subtitle upstream detail",
        operation: "subtitle.search",
        retryable: true,
        service: "bazarr",
      }),
    );
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url: `/v1/media/${mediaReference}/subtitles/search`,
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
