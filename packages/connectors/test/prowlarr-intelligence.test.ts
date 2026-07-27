import { describe, expect, it } from "vitest";

import { ProwlarrAdapter } from "../src/adapters/prowlarr.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

const TEST_API_KEY = "fixture-prowlarr-key";

function adapter(responses: readonly Response[]) {
  const mock = createMockTransport(responses);
  return {
    adapter: new ProwlarrAdapter({
      apiKey: TEST_API_KEY,
      baseUrl: "https://prowlarr.example.test/",
      clock: fixedClock(),
      connectorId: "prowlarr-main",
      displayName: "Prowlarr",
      resolveHost: publicResolver,
      transport: mock.transport,
    }),
    requests: mock.requests,
  };
}

const indexers = [
  {
    enable: true,
    fields: [{ name: "apiKey", value: "must-not-leave-the-connector" }],
    id: 4,
    name: "Nebula",
    privacy: "private",
    protocol: "torrent",
    supportsRss: true,
    supportsSearch: true,
  },
  {
    enable: false,
    id: 7,
    name: "Archive",
    privacy: "public",
    protocol: "usenet",
    supportsRss: false,
    supportsSearch: true,
  },
];

const statistics = {
  hosts: [],
  indexers: [
    {
      averageGrabResponseTime: 210,
      averageResponseTime: 340,
      indexerId: 4,
      indexerName: "Nebula",
      numberOfAuthQueries: 2,
      numberOfFailedAuthQueries: 1,
      numberOfFailedGrabs: 0,
      numberOfFailedQueries: 1,
      numberOfFailedRssQueries: 0,
      numberOfGrabs: 14,
      numberOfQueries: 90,
      numberOfRssQueries: 6,
    },
  ],
  userAgents: [],
};

describe("Prowlarr indexer intelligence", () => {
  it("joins definitions, 24-hour statistics, and disabled state without exposing fields", async () => {
    const fixture = adapter([
      jsonResponse(indexers),
      jsonResponse(statistics),
      jsonResponse([
        {
          disabledTill: "2026-07-25T14:00:00.000Z",
          indexerId: 4,
          initialFailure: "2026-07-25T10:00:00.000Z",
          mostRecentFailure: "2026-07-25T11:58:00.000Z",
        },
      ]),
    ]);

    const page = await fixture.adapter.readIndexerIntelligencePage({ limit: 25 });

    expect(page.summary).toEqual({
      attention: 1,
      disabled: 1,
      enabled: 1,
      failedQueries: 2,
      queries: 98,
      total: 2,
    });
    expect(page.items).toMatchObject([
      {
        id: 4,
        name: "Nebula",
        state: "cooldown",
        statistics: { failedQueries: 2, queries: 98, successRate: 96 / 98 },
      },
      { id: 7, name: "Archive", state: "disabled" },
    ]);
    expect(JSON.stringify(page)).not.toContain("must-not-leave-the-connector");
    expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v1/indexer",
      "/api/v1/indexerstats",
      "/api/v1/indexerstatus",
    ]);
    expect(fixture.requests[1]?.url.searchParams.get("startDate")).toBe("2026-07-24T12:00:00.000Z");
    expect(
      fixture.requests.every(({ init }) => init.headers.get("x-api-key") === TEST_API_KEY),
    ).toBe(true);
  });

  it("returns verified indexers with a partial failure when optional telemetry is unavailable", async () => {
    const fixture = adapter([
      jsonResponse(indexers.slice(0, 1)),
      jsonResponse({}, { status: 503 }),
      jsonResponse([]),
    ]);

    const page = await fixture.adapter.readIndexerIntelligencePage({ limit: 25 });

    expect(page.items[0]?.statistics.queries).toBe(0);
    expect(page.failures).toMatchObject([
      {
        code: "upstream_error",
        operation: "indexer.intelligence.statistics",
        service: "prowlarr",
      },
    ]);
  });

  it("normalizes application sync state and paginates by stable identifier", async () => {
    const fixture = adapter([
      jsonResponse([
        { id: 1, implementationName: "Radarr", name: "Movies", syncLevel: "fullSync" },
        { id: 3, implementationName: "Sonarr", name: "Series", syncLevel: "addOnly" },
        { id: 5, implementationName: "Lidarr", name: "Music", syncLevel: "disabled" },
      ]),
    ]);

    const page = await fixture.adapter.readApplicationPage({ afterId: 1, limit: 1 });

    expect(page).toMatchObject({
      hasMore: true,
      items: [{ id: 3, implementation: "Sonarr", name: "Series", syncLevel: "add_only" }],
    });
  });

  it("normalizes failure history without returning query, host, or source data", async () => {
    const fixture = adapter([
      jsonResponse({
        page: 1,
        pageSize: 1,
        records: [
          {
            data: {
              elapsedTime: "840",
              host: "sensitive.example.test",
              query: "private search terms",
              source: "10.0.0.2",
            },
            date: "2026-07-25T11:59:00.000Z",
            eventType: "indexerQuery",
            id: 22,
            indexerId: 4,
            successful: false,
          },
        ],
        sortDirection: "descending",
        sortKey: "date",
        totalRecords: 3,
      }),
    ]);

    const page = await fixture.adapter.readFailurePage({ limit: 1, page: 1 });

    expect(page).toMatchObject({
      hasMore: true,
      items: [
        {
          id: "prowlarr:history:22",
          indexerId: 4,
          kind: "query",
          latencyMs: 840,
          summary: "Search query failed",
        },
      ],
    });
    expect(JSON.stringify(page)).not.toMatch(
      /private search terms|sensitive\.example|10\.0\.0\.2/u,
    );
    expect(fixture.requests[0]?.url.searchParams.get("successful")).toBe("false");
  });

  it("keeps the secret-bearing provider resource gateway-side during a safe test", async () => {
    const provider = {
      configContract: "CardigannSettings",
      fields: [{ name: "apiKey", value: "private-indexer-secret" }],
      id: 4,
      implementation: "Cardigann",
      name: "Nebula",
    };
    const fixture = adapter([jsonResponse(provider), jsonResponse({})]);

    const result = await fixture.adapter.testIndexer(4);

    expect(result).toEqual({
      indexerId: 4,
      outcome: "passed",
      testedAt: "2026-07-25T12:00:00.000Z",
    });
    expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v1/indexer/4",
      "/api/v1/indexer/test",
    ]);
    expect(fixture.requests[1]?.init.method).toBe("POST");
    expect(Buffer.from(fixture.requests[1]?.init.body ?? []).toString("utf8")).toContain(
      "private-indexer-secret",
    );
    expect(JSON.stringify(result)).not.toContain("private-indexer-secret");
  });

  it("rejects a mismatched provider resource instead of testing the wrong indexer", async () => {
    const fixture = adapter([jsonResponse({ id: 9, name: "Wrong target" })]);

    await expect(fixture.adapter.testIndexer(4)).rejects.toMatchObject({
      code: "response_invalid",
      operation: "indexer.test.prepare",
    });
    expect(fixture.requests).toHaveLength(1);
  });
});
