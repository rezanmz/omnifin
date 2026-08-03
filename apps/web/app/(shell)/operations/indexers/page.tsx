import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { Metadata } from "next";

import { IndexerIntelligence } from "../../../../components/indexer-intelligence";
import { ThemeProvider } from "../../../../components/theme-provider";
import type { IndexerIntelligenceLoadOutcome } from "../../../../lib/indexer-intelligence";
import { readThemePreference } from "../../../../lib/theme-server";
import "../../../globals.css";

export const metadata: Metadata = { title: "Indexer intelligence" };
export const dynamic = "force-dynamic";

interface IndexerPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const generatedAt = "2026-07-27T19:00:00.000Z";

const testPrincipal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-27T19:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Stack operator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-27T20:00:00.000Z",
  issuedAt: generatedAt,
  linkedServices: [
    {
      displayName: "Stack operator",
      externalUserId: "operator-external",
      health: "linked",
      id: "operator-link",
      lastVerifiedAt: generatedAt,
      linkedAt: generatedAt,
      service: "jellyfin",
      username: "operator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "operator-session",
  userId: "operator-user",
};

const ready: Extract<IndexerIntelligenceLoadOutcome, { status: "ready" }> = {
  snapshot: {
    applications: {
      data: {
        generatedAt,
        items: [
          { id: 1, implementation: "Radarr", name: "Cinema", syncLevel: "full_sync" },
          { id: 2, implementation: "Sonarr", name: "Television", syncLevel: "add_only" },
          { id: 3, implementation: "Lidarr", name: "Music", syncLevel: "disabled" },
        ],
        nextCursor: null,
      },
      status: "ready",
    },
    csrfToken: "test_indexer_csrf_0123456789abcdefghijklmnop",
    failures: {
      data: {
        generatedAt,
        items: [
          {
            id: "prowlarr:history:91",
            indexerId: 8,
            kind: "authentication",
            latencyMs: 1840,
            occurredAt: "2026-07-27T18:42:00.000Z",
            summary: "Authentication check failed",
          },
          {
            id: "prowlarr:history:90",
            indexerId: 4,
            kind: "query",
            latencyMs: 932,
            occurredAt: "2026-07-27T17:18:00.000Z",
            summary: "Search query failed",
          },
          {
            id: "prowlarr:history:89",
            indexerId: 12,
            kind: "rss",
            latencyMs: null,
            occurredAt: "2026-07-27T14:08:00.000Z",
            summary: "RSS query failed",
          },
        ],
        nextCursor: "cGFnZToyOjI1",
      },
      status: "ready",
    },
    indexers: {
      failures: [],
      generatedAt,
      items: [
        {
          disabledUntil: null,
          enabled: true,
          id: 4,
          initialFailureAt: null,
          mostRecentFailureAt: "2026-07-27T17:18:00.000Z",
          name: "Nebula",
          privacy: "private",
          protocol: "torrent",
          state: "healthy",
          statistics: {
            averageGrabResponseTimeMs: 210,
            averageQueryResponseTimeMs: 340,
            failedGrabs: 0,
            failedQueries: 2,
            grabs: 146,
            queries: 1254,
            successRate: 0.9984,
          },
          supportsRss: true,
          supportsSearch: true,
        },
        {
          disabledUntil: "2026-07-27T20:30:00.000Z",
          enabled: true,
          id: 8,
          initialFailureAt: "2026-07-27T18:04:00.000Z",
          mostRecentFailureAt: "2026-07-27T18:42:00.000Z",
          name: "Northstar",
          privacy: "semi_private",
          protocol: "usenet",
          state: "cooldown",
          statistics: {
            averageGrabResponseTimeMs: 780,
            averageQueryResponseTimeMs: 1840,
            failedGrabs: 1,
            failedQueries: 18,
            grabs: 62,
            queries: 438,
            successRate: 0.9589,
          },
          supportsRss: true,
          supportsSearch: true,
        },
        {
          disabledUntil: null,
          enabled: false,
          id: 12,
          initialFailureAt: null,
          mostRecentFailureAt: null,
          name: "Archive Relay",
          privacy: "public",
          protocol: "torrent",
          state: "disabled",
          statistics: {
            averageGrabResponseTimeMs: 0,
            averageQueryResponseTimeMs: 0,
            failedGrabs: 0,
            failedQueries: 0,
            grabs: 0,
            queries: 0,
            successRate: 1,
          },
          supportsRss: false,
          supportsSearch: true,
        },
      ],
      nextCursor: null,
      periodEndedAt: generatedAt,
      periodStartedAt: "2026-07-26T19:00:00.000Z",
      state: "complete",
      summary: {
        attention: 1,
        disabled: 1,
        enabled: 2,
        failedQueries: 20,
        queries: 1692,
        total: 3,
      },
    },
    principal: testPrincipal,
  },
  status: "ready",
};

function testOutcome(
  view: string | string[] | undefined,
): IndexerIntelligenceLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (["forbidden", "not_configured", "signed_out", "unavailable"].includes(String(view))) {
    return { status: String(view) } as Exclude<IndexerIntelligenceLoadOutcome, { status: "ready" }>;
  }
  if (view === "empty") {
    return {
      snapshot: {
        ...ready.snapshot,
        applications: {
          data: { generatedAt, items: [], nextCursor: null },
          status: "ready",
        },
        failures: { data: { generatedAt, items: [], nextCursor: null }, status: "ready" },
        indexers: {
          ...ready.snapshot.indexers,
          items: [],
          summary: {
            attention: 0,
            disabled: 0,
            enabled: 0,
            failedQueries: 0,
            queries: 0,
            total: 0,
          },
        },
      },
      status: "ready",
    };
  }
  if (view === "degraded") {
    return {
      snapshot: {
        ...ready.snapshot,
        applications: { status: "unavailable" },
        indexers: {
          ...ready.snapshot.indexers,
          failures: [
            {
              code: "timeout",
              message: "Prowlarr statistics are temporarily unavailable.",
              occurredAt: generatedAt,
              operation: "indexer.intelligence.statistics",
              retryable: true,
              service: "prowlarr",
            },
          ],
          state: "degraded",
        },
      },
      status: "ready",
    };
  }
  return view === "ready" ? ready : undefined;
}

export default async function IndexerPage({ searchParams }: IndexerPageProperties) {
  const parameters = await searchParams;
  const preference = await readThemePreference();
  const outcome = testOutcome(parameters["test-view"]);

  return (
    <ThemeProvider initialPreference={preference}>
      <IndexerIntelligence {...(outcome === undefined ? {} : { initialOutcome: outcome })} />
    </ThemeProvider>
  );
}
