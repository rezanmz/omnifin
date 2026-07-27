import { describe, expect, it } from "vitest";

import {
  indexerApplicationListResponseSchema,
  indexerFailureListResponseSchema,
  indexerIntelligenceResponseSchema,
  indexerPageQuerySchema,
  indexerTestResponseSchema,
} from "../src/indexers.js";

const timestamp = "2026-07-27T12:00:00.000Z";

describe("indexer intelligence contracts", () => {
  it("coerces bounded cursor pagination input", () => {
    expect(indexerPageQuerySchema.parse({ limit: "12" })).toEqual({ limit: 12 });
    expect(indexerPageQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(indexerPageQuerySchema.safeParse({ cursor: "not+a+cursor" }).success).toBe(false);
  });

  it("accepts a normalized, ordered indexer page", () => {
    const result = indexerIntelligenceResponseSchema.parse({
      failures: [],
      generatedAt: timestamp,
      items: [
        {
          disabledUntil: null,
          enabled: true,
          id: 4,
          initialFailureAt: null,
          mostRecentFailureAt: null,
          name: "Nebula",
          privacy: "private",
          protocol: "torrent",
          state: "healthy",
          statistics: {
            averageGrabResponseTimeMs: 210,
            averageQueryResponseTimeMs: 340,
            failedGrabs: 0,
            failedQueries: 2,
            grabs: 14,
            queries: 98,
            successRate: 0.98,
          },
          supportsRss: true,
          supportsSearch: true,
        },
      ],
      nextCursor: null,
      periodEndedAt: timestamp,
      periodStartedAt: "2026-07-26T12:00:00.000Z",
      state: "complete",
      summary: {
        attention: 0,
        disabled: 0,
        enabled: 1,
        failedQueries: 2,
        queries: 98,
        total: 1,
      },
    });

    expect(result.items[0]?.name).toBe("Nebula");
  });

  it("rejects contradictory operational and partial-failure states", () => {
    const base = {
      failures: [],
      generatedAt: timestamp,
      items: [],
      nextCursor: null,
      periodEndedAt: timestamp,
      periodStartedAt: "2026-07-26T12:00:00.000Z",
      state: "degraded",
      summary: {
        attention: 0,
        disabled: 0,
        enabled: 0,
        failedQueries: 0,
        queries: 0,
        total: 0,
      },
    };
    expect(indexerIntelligenceResponseSchema.safeParse(base).success).toBe(false);
  });

  it("keeps application, failure, and test payloads free of upstream configuration", () => {
    const applications = indexerApplicationListResponseSchema.parse({
      generatedAt: timestamp,
      items: [{ id: 2, implementation: "Radarr", name: "Movies", syncLevel: "full_sync" }],
      nextCursor: null,
    });
    const failures = indexerFailureListResponseSchema.parse({
      generatedAt: timestamp,
      items: [
        {
          id: "prowlarr:history:22",
          indexerId: 4,
          kind: "query",
          latencyMs: 840,
          occurredAt: timestamp,
          summary: "Search query failed",
        },
      ],
      nextCursor: null,
    });
    const test = indexerTestResponseSchema.parse({
      indexerId: 4,
      outcome: "passed",
      testedAt: timestamp,
    });

    expect(applications.items[0]).not.toHaveProperty("fields");
    expect(failures.items[0]).not.toHaveProperty("query");
    expect(test).toEqual({ indexerId: 4, outcome: "passed", testedAt: timestamp });
  });
});
