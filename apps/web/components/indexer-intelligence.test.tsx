import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { IndexerIntelligenceResponse } from "@omnifin/contracts/indexers";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  IndexerIntelligenceClient,
  IndexerIntelligenceLoadOutcome,
} from "../lib/indexer-intelligence";
import { IndexerIntelligence } from "./indexer-intelligence";
import { ThemeProvider } from "./theme-provider";

const generatedAt = "2026-07-27T19:00:00.000Z";
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-27T19:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Operator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-27T20:00:00.000Z",
  issuedAt: generatedAt,
  linkedServices: [
    {
      displayName: "Operator",
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

const indexers: IndexerIntelligenceResponse = {
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
        grabs: 14,
        queries: 98,
        successRate: 96 / 98,
      },
      supportsRss: true,
      supportsSearch: true,
    },
    {
      disabledUntil: "2026-07-27T20:00:00.000Z",
      enabled: true,
      id: 8,
      initialFailureAt: "2026-07-27T18:00:00.000Z",
      mostRecentFailureAt: "2026-07-27T18:30:00.000Z",
      name: "Northstar",
      privacy: "semi_private",
      protocol: "usenet",
      state: "cooldown",
      statistics: {
        averageGrabResponseTimeMs: 600,
        averageQueryResponseTimeMs: 840,
        failedGrabs: 1,
        failedQueries: 9,
        grabs: 7,
        queries: 38,
        successRate: 29 / 38,
      },
      supportsRss: true,
      supportsSearch: true,
    },
  ],
  nextCursor: null,
  periodEndedAt: generatedAt,
  periodStartedAt: "2026-07-26T19:00:00.000Z",
  state: "complete",
  summary: { attention: 1, disabled: 0, enabled: 2, failedQueries: 11, queries: 136, total: 2 },
};

const ready: Extract<IndexerIntelligenceLoadOutcome, { status: "ready" }> = {
  snapshot: {
    applications: {
      data: {
        generatedAt,
        items: [{ id: 2, implementation: "Radarr", name: "Movies", syncLevel: "full_sync" }],
        nextCursor: null,
      },
      status: "ready",
    },
    csrfToken: "test-csrf",
    failures: {
      data: {
        generatedAt,
        items: [
          {
            id: "prowlarr:history:22",
            indexerId: 8,
            kind: "query",
            latencyMs: 840,
            occurredAt: "2026-07-27T18:30:00.000Z",
            summary: "Search query failed",
          },
        ],
        nextCursor: null,
      },
      status: "ready",
    },
    indexers,
    principal,
  },
  status: "ready",
};

function client(overrides: Partial<IndexerIntelligenceClient> = {}): IndexerIntelligenceClient {
  return {
    load: vi.fn(async () => ready),
    loadApplications: vi.fn(async () =>
      ready.snapshot.applications.status === "ready" ? ready.snapshot.applications.data : never(),
    ),
    loadFailures: vi.fn(async () =>
      ready.snapshot.failures.status === "ready" ? ready.snapshot.failures.data : never(),
    ),
    loadIndexers: vi.fn(async () => ready.snapshot.indexers),
    test: vi.fn(async (indexerId) => ({
      indexerId,
      outcome: "passed" as const,
      testedAt: generatedAt,
    })),
    ...overrides,
  };
}

function never(): never {
  throw new Error("unreachable");
}

function renderScreen(
  outcome: IndexerIntelligenceLoadOutcome = ready,
  testClient: IndexerIntelligenceClient = client(),
) {
  return render(
    <ThemeProvider initialPreference="system">
      <IndexerIntelligence client={testClient} initialOutcome={outcome} />
    </ThemeProvider>,
  );
}

describe("IndexerIntelligence", () => {
  it("renders normalized telemetry, application sync, and sanitized failure history", () => {
    renderScreen();

    expect(screen.getByRole("heading", { level: 1, name: "Know every source." })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Indexers" })).toBeVisible();
    expect(screen.getByText("Nebula")).toBeVisible();
    expect(screen.getByText("Full sync")).toBeVisible();
    expect(screen.getByText("Search query failed")).toBeVisible();
    expect(
      screen.getByText(/Raw queries, hosts, sources, and credentials are excluded/u),
    ).toBeVisible();
  });

  it("filters attention states and indexer names without shifting entry controls", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Attention" }));
    expect(screen.queryByText("Nebula")).not.toBeInTheDocument();
    expect(screen.getByText("Northstar")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByRole("searchbox", { name: "Search indexers" }), "neb");
    expect(screen.getByText("Nebula")).toBeVisible();
    expect(screen.queryByText("Northstar")).not.toBeInTheDocument();
  });

  it("runs one no-body safe test and announces its verified outcome", async () => {
    const user = userEvent.setup();
    const test = vi.fn(async (indexerId: number) => ({
      indexerId,
      outcome: "passed" as const,
      testedAt: generatedAt,
    }));
    renderScreen(ready, client({ test }));

    await user.click(screen.getAllByRole("button", { name: "Test" })[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Passed" })).toBeVisible());
    expect(test).toHaveBeenCalledWith(4, "test-csrf");
    expect(screen.getByText(/Nebula passed at/u, { selector: ".sr-only" })).toBeInTheDocument();
  });

  it("provides accessible light, dark, and system appearance controls", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("radio", { name: "Light theme" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.keyboard("{ArrowRight}");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();
  });

  it.each([
    ["forbidden", "Operator access required."],
    ["not_configured", "Connect the indexer plane."],
    ["signed_out", "Sign in to continue."],
    ["unavailable", "Indexer intelligence is offline."],
  ] as const)("renders the %s entry state", (status, title) => {
    renderScreen({ status });
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });
});
