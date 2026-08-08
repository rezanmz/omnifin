import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  indexerApplicationListResponseSchema,
  indexerFailureListResponseSchema,
  indexerIntelligenceResponseSchema,
  indexerTestResponseSchema,
} from "@omnifin/contracts/indexers";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import {
  IndexerIntelligenceError,
  IndexerIntelligenceService,
} from "../src/indexers/intelligence-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-27T19:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 97),
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
    createId: () => `indexer-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

function capabilitySnapshot() {
  return JSON.stringify({
    health: {
      capabilities: ["connector.health", "connector.version", "indexer.statistics", "indexer.test"],
      checkedAt: now.toISOString(),
      connectorId: "prowlarr-main",
      displayName: "Prowlarr",
      failure: null,
      latencyMs: 10,
      service: "prowlarr",
      status: "healthy",
      version: "2.5.2.5491",
    },
    schemaVersion: 1,
  });
}

async function harness(
  options: { testFailure?: SafeConnectorError; withConnector?: boolean } = {},
) {
  const config = testConfig();
  const readIndexerIntelligencePage = vi.fn(async () => ({
    failures: [],
    generatedAt: now.toISOString(),
    hasMore: false,
    items: [
      {
        disabledUntil: null,
        enabled: true,
        id: 4,
        initialFailureAt: null,
        mostRecentFailureAt: null,
        name: "Nebula",
        privacy: "private" as const,
        protocol: "torrent" as const,
        state: "healthy" as const,
        statistics: {
          averageGrabResponseTimeMs: 210,
          averageQueryResponseTimeMs: 340,
          failedGrabs: 0,
          failedQueries: 2,
          grabs: 14,
          queries: 98,
          successRate: 96 / 98,
        },
        supportsRss: true,
        supportsSearch: true,
      },
    ],
    periodEndedAt: now.toISOString(),
    periodStartedAt: "2026-07-26T19:00:00.000Z",
    summary: { attention: 0, disabled: 0, enabled: 1, failedQueries: 2, queries: 98, total: 1 },
  }));
  const readApplicationPage = vi.fn(async () => ({
    generatedAt: now.toISOString(),
    hasMore: false,
    items: [{ id: 2, implementation: "Radarr", name: "Movies", syncLevel: "full_sync" as const }],
  }));
  const readFailurePage = vi.fn(async () => ({
    generatedAt: now.toISOString(),
    hasMore: false,
    items: [
      {
        id: "prowlarr:history:22" as const,
        indexerId: 4,
        kind: "query" as const,
        latencyMs: 840,
        occurredAt: "2026-07-27T18:55:00.000Z",
        summary: "Search query failed",
      },
    ],
  }));
  const testIndexer = options.testFailure
    ? vi.fn(async () => Promise.reject(options.testFailure))
    : vi.fn(async (indexerId: number) => ({
        indexerId,
        outcome: "passed" as const,
        testedAt: now.toISOString(),
      }));
  let auditIdentifier = 0;
  const app = await createApp({
    config,
    indexerIntelligenceDependencies: {
      clock: () => now,
      createAdapter: () => ({
        readApplicationPage,
        readFailurePage,
        readIndexerIntelligencePage,
        testIndexer,
      }),
      createId: () => `indexer-route-audit-${++auditIdentifier}`,
    },
    sessionDependencies: sessionDependencies(),
  });
  app.database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test/",
      capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: now,
      displayName: "Jellyfin",
      enabled: true,
      encryptedCredentials: "v2.fixture-jellyfin-credentials",
      healthState: "healthy",
      id: "jellyfin-main",
      type: "jellyfin",
      updatedAt: now,
    })
    .run();
  if (options.withConnector !== false) {
    app.database.db
      .insert(connectorConfigs)
      .values({
        baseUrl: "https://prowlarr.example.test/",
        capabilitySnapshotJson: capabilitySnapshot(),
        createdAt: now,
        displayName: "Prowlarr",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: "route-private-api-key", kind: "api_key" },
            schemaVersion: 1,
          }),
          "connector_credentials:prowlarr:prowlarr-main",
        ),
        healthState: "healthy",
        id: "prowlarr-main",
        type: "prowlarr",
        updatedAt: now,
      })
      .run();
  }
  app.database.db
    .insert(users)
    .values([
      {
        createdAt: now,
        displayName: "Operator",
        id: "operator-user",
        role: "operator",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
      {
        createdAt: now,
        displayName: "Viewer",
        id: "viewer-user",
        role: "viewer",
        roleSource: "manual",
        status: "active",
        updatedAt: now,
      },
    ])
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values(
      ["operator", "viewer"].map((role) => ({
        connectorId: "jellyfin-main",
        createdAt: now,
        deviceId: `${role}-device`,
        encryptedAccessToken: `v2.fixture-${role}-token`,
        externalDisplayName: role === "operator" ? "Operator" : "Viewer",
        externalServerId: "jellyfin-server",
        externalUserId: `${role}-external`,
        externalUsername: role,
        healthState: "linked" as const,
        id: `${role}-link`,
        lastVerifiedAt: now,
        service: "jellyfin" as const,
        tokenCreatedAt: now,
        updatedAt: now,
        userId: `${role}-user`,
      })),
    )
    .run();
  const operator = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "operator-link",
      userId: "operator-user",
    },
  });
  const viewer = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "viewer-link",
      userId: "viewer-user",
    },
  });
  return { app, operator, testIndexer, viewer };
}

describe("indexer intelligence routes", () => {
  it("serves all normalized read models to an operator with no-store policy", async () => {
    const { app, operator } = await harness();
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` };
    try {
      const [indexers, applications, failures] = await Promise.all([
        app.inject({ headers, method: "GET", url: "/v1/indexers/intelligence?limit=25" }),
        app.inject({ headers, method: "GET", url: "/v1/indexer-applications?limit=25" }),
        app.inject({ headers, method: "GET", url: "/v1/indexer-failures?limit=25" }),
      ]);

      expect(indexers.statusCode, indexers.body).toBe(200);
      expect(applications.statusCode, applications.body).toBe(200);
      expect(failures.statusCode, failures.body).toBe(200);
      expect(indexerIntelligenceResponseSchema.parse(indexers.json()).items[0]?.name).toBe(
        "Nebula",
      );
      expect(indexerApplicationListResponseSchema.parse(applications.json()).items).toHaveLength(1);
      expect(indexerFailureListResponseSchema.parse(failures.json()).items).toHaveLength(1);
      expect(indexers.headers["cache-control"]).toBe("no-store");
      expect(indexers.body).not.toContain("route-private-api-key");
    } finally {
      await app.close();
    }
  });

  it("denies anonymous and viewer reads before creating an adapter", async () => {
    const { app, viewer } = await harness();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/v1/indexers/intelligence" });
      const denied = await app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${viewer.sessionToken}` },
        method: "GET",
        url: "/v1/indexers/intelligence",
      });
      expect(anonymous.statusCode).toBe(401);
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("requires origin and CSRF proof for the no-body safe test action", async () => {
    const { app, operator, testIndexer } = await harness();
    const cookie = `${SESSION_COOKIE_NAME}=${operator.sessionToken}`;
    try {
      const missingProof = await app.inject({
        headers: { cookie, origin: baseUrl },
        method: "POST",
        url: "/v1/indexers/4/tests",
      });
      expect(missingProof.statusCode).toBe(403);

      const response = await app.inject({
        headers: {
          cookie,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        url: "/v1/indexers/4/tests",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(indexerTestResponseSchema.parse(response.json())).toEqual({
        indexerId: 4,
        outcome: "passed",
        testedAt: now.toISOString(),
      });
      expect(testIndexer).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("returns canonical safe errors for invalid cursors and upstream rate limits", async () => {
    const upstream = new SafeConnectorError({
      code: "rate_limited",
      message: "Private upstream rate-limit details",
      operation: "indexer.test",
      retryAfterSeconds: 17,
      retryable: true,
      service: "prowlarr",
      status: 429,
    });
    const { app, operator } = await harness({ testFailure: upstream });
    const cookie = `${SESSION_COOKIE_NAME}=${operator.sessionToken}`;
    try {
      const invalid = await app.inject({
        headers: { cookie },
        method: "GET",
        url: `/v1/indexer-failures?limit=25&cursor=${Buffer.from("page:2:10").toString("base64url")}`,
      });
      expect(invalid.statusCode).toBe(400);
      expect(apiErrorSchema.parse(invalid.json()).error.code).toBe("indexer_cursor_invalid");

      const limited = await app.inject({
        headers: {
          cookie,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        url: "/v1/indexers/4/tests",
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("17");
      expect(apiErrorSchema.parse(limited.json()).error.code).toBe(
        "indexer_intelligence_rate_limited",
      );
      expect(limited.body).not.toContain("Private upstream rate-limit details");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["identity_required", 403, "indexer_test_identity_required"],
    ["connector_unconfigured", 503, "indexer_intelligence_not_configured"],
    ["connector_ambiguous", 503, "indexer_intelligence_configuration_unavailable"],
    ["connector_integrity_failure", 503, "indexer_intelligence_configuration_unavailable"],
    ["storage_failure", 503, "indexer_intelligence_configuration_unavailable"],
  ] as const)("maps indexer test service failure %s", async (reason, status, code) => {
    const { app, operator } = await harness();
    const testIndexer = vi
      .spyOn(IndexerIntelligenceService.prototype, "testIndexer")
      .mockRejectedValue(new IndexerIntelligenceError(reason));
    try {
      const response = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        url: "/v1/indexers/4/tests",
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
    } finally {
      testIndexer.mockRestore();
      await app.close();
    }
  });

  it.each([
    ["rate_limited", 429, "indexer_intelligence_rate_limited"],
    ["response_invalid", 502, "indexer_intelligence_response_invalid"],
    ["unsupported_version", 502, "indexer_intelligence_response_invalid"],
    ["configuration_invalid", 503, "indexer_intelligence_configuration_unavailable"],
    ["destination_blocked", 503, "indexer_intelligence_configuration_unavailable"],
    ["invalid_credentials", 503, "indexer_intelligence_configuration_unavailable"],
    ["timeout", 503, "indexer_intelligence_temporarily_unavailable"],
  ] as const)("maps indexer test connector failure %s", async (reason, status, code) => {
    const { app, operator } = await harness();
    const testIndexer = vi
      .spyOn(IndexerIntelligenceService.prototype, "testIndexer")
      .mockRejectedValue(
        new SafeConnectorError({
          code: reason,
          message: "Private indexer diagnostic",
          operation: "indexer.test",
          retryable: reason === "rate_limited" || reason === "timeout",
          service: "prowlarr",
        }),
      );
    try {
      const response = await app.inject({
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}`,
          origin: baseUrl,
          "x-omnifin-csrf": operator.csrfToken,
        },
        method: "POST",
        url: "/v1/indexers/4/tests",
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
      expect(response.body).not.toContain("Private indexer diagnostic");
    } finally {
      testIndexer.mockRestore();
      await app.close();
    }
  });

  it.each([
    ["readIndexers", "/v1/indexers/intelligence"],
    ["readApplications", "/v1/indexer-applications"],
    ["readFailures", "/v1/indexer-failures"],
  ] as const)("maps every %s route failure without leaking details", async (method, url) => {
    const errorCases = [
      { error: new IndexerIntelligenceError("storage_failure"), status: 503 },
      {
        error: new SafeConnectorError({
          code: "timeout",
          message: "Private route connector failure",
          operation: "indexer.read",
          retryable: true,
          service: "prowlarr",
        }),
        status: 503,
      },
      { error: new Error("Private unexpected route failure"), status: 500 },
    ];
    for (const errorCase of errorCases) {
      const { app, operator } = await harness();
      const operation = vi
        .spyOn(IndexerIntelligenceService.prototype, method)
        .mockRejectedValue(errorCase.error);
      try {
        const response = await app.inject({
          headers: { cookie: `${SESSION_COOKIE_NAME}=${operator.sessionToken}` },
          method: "GET",
          url,
        });
        expect(response.statusCode, response.body).toBe(errorCase.status);
        expect(response.body).not.toContain("Private");
      } finally {
        operation.mockRestore();
        await app.close();
      }
    }
  });
});
