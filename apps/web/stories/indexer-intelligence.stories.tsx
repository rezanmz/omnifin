import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { IndexerIntelligence } from "../components/indexer-intelligence";
import type {
  IndexerIntelligenceClient,
  IndexerIntelligenceLoadOutcome,
} from "../lib/indexer-intelligence";

const generatedAt = "2026-07-27T19:00:00.000Z";
const principal: SessionPrincipal = {
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
        ],
        nextCursor: null,
      },
      status: "ready",
    },
    csrfToken: "story-indexer-csrf",
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
        ],
        nextCursor: null,
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
      ],
      nextCursor: null,
      periodEndedAt: generatedAt,
      periodStartedAt: "2026-07-26T19:00:00.000Z",
      state: "complete",
      summary: {
        attention: 1,
        disabled: 0,
        enabled: 2,
        failedQueries: 20,
        queries: 1692,
        total: 2,
      },
    },
    principal,
  },
  status: "ready",
};

function storyClient(
  load: IndexerIntelligenceClient["load"] = async () => ready,
): IndexerIntelligenceClient {
  return {
    load,
    loadApplications: async () =>
      ready.snapshot.applications.status === "ready"
        ? ready.snapshot.applications.data
        : Promise.reject(new Error("unavailable")),
    loadFailures: async () =>
      ready.snapshot.failures.status === "ready"
        ? ready.snapshot.failures.data
        : Promise.reject(new Error("unavailable")),
    loadIndexers: async () => ready.snapshot.indexers,
    test: async (indexerId) => ({ indexerId, outcome: "passed", testedAt: generatedAt }),
  };
}

const meta = {
  args: { client: storyClient(), initialOutcome: ready },
  argTypes: { client: { control: false }, initialOutcome: { control: false } },
  component: IndexerIntelligence,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Indexer intelligence",
} satisfies Meta<typeof IndexerIntelligence>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const ReadyLight: Story = { globals: { theme: "light" } };
export const AttentionFilter: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Attention" }));
    await expect(canvas.getByText("Northstar")).toBeVisible();
    await expect(canvas.queryByText("Nebula")).not.toBeInTheDocument();
  },
};
export const SafeTestSuccess: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole("button", { name: "Test" })[0]!);
    await waitFor(() => expect(canvas.getByRole("button", { name: "Passed" })).toBeVisible());
  },
};
export const Empty: Story = {
  args: {
    initialOutcome: {
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
    },
  },
};
export const Degraded: Story = {
  args: {
    initialOutcome: {
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
    },
  },
};
export const Loading: Story = {
  render: () => (
    <IndexerIntelligence client={storyClient(async () => new Promise(() => undefined))} />
  ),
};
export const Restricted: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const NotConfigured: Story = {
  args: { initialOutcome: { status: "not_configured" } },
};
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const GatewayUnavailable: Story = {
  args: { initialOutcome: { status: "unavailable" } },
};
