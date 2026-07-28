import type { MediaIssueWorkbenchItem } from "@omnifin/contracts/issues";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { MediaIssueClient, MediaIssueLoadOutcome } from "../lib/media-issues";
import {
  degradedMediaIssueOutcome,
  demoMediaIssues,
  emptyMediaIssueOutcome,
  readyMediaIssueOutcome,
} from "../lib/media-issues-demo";
import { MediaIssueWorkbench } from "./media-issue-workbench";
import { ThemeProvider } from "./theme-provider";

const ready = readyMediaIssueOutcome as Extract<MediaIssueLoadOutcome, { status: "ready" }>;

function testClient(overrides: Partial<MediaIssueClient> = {}): MediaIssueClient {
  return {
    list: async (query) => ({ ...ready.snapshot.page, source: query.source, status: query.status }),
    load: async () => ready,
    updateStatus: async (issueId, input) => {
      const issue = demoMediaIssues.find((candidate) => candidate.id === issueId)!;
      return {
        issue: {
          ...issue,
          status: input.status,
          updatedAt: "2026-07-28T20:13:00.000Z",
        },
        replayed: false,
      };
    },
    ...overrides,
  };
}

function renderWorkbench(
  outcome: MediaIssueLoadOutcome = ready,
  client: MediaIssueClient = testClient(),
) {
  return render(
    <ThemeProvider initialPreference="system">
      <MediaIssueWorkbench client={client} initialOutcome={outcome} />
    </ThemeProvider>,
  );
}

function renderLiveWorkbench(client: MediaIssueClient = testClient()) {
  return render(
    <ThemeProvider initialPreference="system">
      <MediaIssueWorkbench client={client} />
    </ThemeProvider>,
  );
}

describe("MediaIssueWorkbench", () => {
  it("renders normalized issues without upstream identifiers", () => {
    renderWorkbench();

    expect(
      screen.getByRole("heading", { level: 1, name: "Close the loop on every stream." }),
    ).toBeVisible();
    expect(screen.getByText("Northern Lights")).toBeVisible();
    expect(screen.getByText("Captions drift after the opening scene.")).toBeVisible();
    expect(screen.getByText("Opaque boundary intact")).toBeVisible();
    expect(document.body.textContent).not.toContain("operator-external");
    expect(document.body.textContent).not.toContain("upstreamId");
  });

  it("filters by status and source without losing the normalized snapshot", async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(screen.getByRole("button", { name: "Omnifin" }));
    expect(screen.getByText("The Long Meridian")).toBeVisible();
    expect(screen.queryByText("Northern Lights")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resolved" }));
    expect(screen.getByText("Signal / Noise")).toBeVisible();
  });

  it("loads live data and refreshes server-side filters", async () => {
    const user = userEvent.setup();
    const list = vi.fn(testClient().list);
    const load = vi.fn(async () => ready);
    renderLiveWorkbench(testClient({ list, load }));

    expect(screen.getByLabelText("Loading issue workbench")).toBeVisible();
    expect(await screen.findByText("Northern Lights")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Seerr" }));
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(
        { limit: 50, source: "seerr", status: "open" },
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Refresh issues" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("keeps the last good queue when a live refresh fails", async () => {
    const user = userEvent.setup();
    const list = vi.fn(async () => {
      throw new Error("The issue queue is taking longer than expected.");
    });
    renderLiveWorkbench(testClient({ list }));

    expect(await screen.findByText("Northern Lights")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh issues" }));
    expect(await screen.findByRole("status")).toHaveTextContent("taking longer than expected");
    expect(screen.getByText("Northern Lights")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByText("taking longer than expected")).not.toBeInTheDocument();
  });

  it("confirms and writes one idempotent resolution", async () => {
    const user = userEvent.setup();
    const updateStatus = vi.fn(testClient().updateStatus);
    renderWorkbench(ready, testClient({ updateStatus }));
    const card = screen.getByText("Northern Lights").closest("article");
    expect(card).not.toBeNull();

    await user.click(within(card!).getByRole("button", { name: "Resolve" }));
    expect(screen.getByRole("dialog", { name: "Mark issue resolved?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Resolve issue" }));

    await waitFor(() => expect(updateStatus).toHaveBeenCalledOnce());
    expect(updateStatus.mock.calls[0]?.[0]).toBe(`issue_${"a".repeat(22)}`);
    expect(updateStatus.mock.calls[0]?.[1]).toEqual({ status: "resolved" });
    expect(updateStatus.mock.calls[0]?.[2].csrfToken).toBe(ready.snapshot.csrfToken);
    expect(updateStatus.mock.calls[0]?.[2].idempotencyKey).toMatch(/^issue-status-[0-9a-f-]{36}$/u);
    expect(screen.getByRole("status")).toHaveTextContent("Northern Lights was resolved.");
    expect(screen.queryByText("Northern Lights")).not.toBeInTheDocument();
  });

  it("reopens a resolved issue and reports an idempotent replay", async () => {
    const user = userEvent.setup();
    const updateStatus = vi.fn(async (issueId, input) => {
      const issue = demoMediaIssues.find((candidate) => candidate.id === issueId)!;
      return { issue: { ...issue, status: input.status }, replayed: true };
    });
    renderWorkbench(ready, testClient({ updateStatus }));

    await user.click(screen.getByRole("button", { name: "Resolved" }));
    const card = screen.getByText("Signal / Noise").closest("article");
    await user.click(within(card!).getByRole("button", { name: "Reopen" }));
    expect(screen.getByRole("dialog", { name: "Reopen this issue?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reopen issue" }));

    await waitFor(() => expect(updateStatus).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Signal / Noise was reopened. The existing decision was confirmed.",
    );
  });

  it("cancels a decision with Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    const card = screen.getByText("Northern Lights").closest("article");
    const trigger = within(card!).getByRole("button", { name: "Resolve" });

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Resolve issue" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps a failed decision open with safe retry context", async () => {
    const user = userEvent.setup();
    const updateStatus = vi.fn(
      async (): Promise<{ issue: MediaIssueWorkbenchItem; replayed: boolean }> => {
        throw new Error("Seerr is taking longer than expected. No outcome was assumed.");
      },
    );
    renderWorkbench(ready, testClient({ updateStatus }));
    const card = screen.getByText("Ember Coast").closest("article");

    await user.click(within(card!).getByRole("button", { name: "Resolve" }));
    await user.click(screen.getByRole("button", { name: "Resolve issue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No outcome was assumed");
    expect(screen.getByRole("dialog", { name: "Mark issue resolved?" })).toBeVisible();
  });

  it("announces partial source health while preserving available issues", () => {
    renderWorkbench(degradedMediaIssueOutcome);

    expect(screen.getByRole("status")).toHaveTextContent("Partial view");
    expect(screen.getByRole("status")).toHaveTextContent("Seerr is unavailable");
    expect(screen.getByText("The Long Meridian")).toBeVisible();
  });

  it("explains unconfigured sources, truncation, and missing optional context", () => {
    const issue = {
      ...demoMediaIssues[0]!,
      episodeNumber: null,
      kind: "series" as const,
      positionSeconds: null,
      seasonNumber: null,
      source: "omnifin" as const,
      summary: null,
      title: "Quiet Signal",
      year: null,
    };
    renderWorkbench({
      snapshot: {
        ...ready.snapshot,
        page: {
          ...ready.snapshot.page,
          items: [issue],
          limit: 1,
          sourceStates: { omnifin: "available", seerr: "unconfigured" },
          truncated: true,
        },
      },
      status: "ready",
    });

    expect(screen.getByText("Series")).toBeVisible();
    expect(screen.getByText("No additional context was provided.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect Seerr" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
    expect(screen.getByText("Showing the newest 1 issues.")).toBeVisible();
  });

  it("supports light, dark, and system appearance choices", async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    await user.keyboard("{End}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "System theme" })).toHaveFocus();
      expect(document.documentElement).toHaveAttribute("data-theme-preference", "system");
    });
  });

  it("renders empty and protected boundaries honestly", () => {
    const { unmount } = renderWorkbench(emptyMediaIssueOutcome);
    expect(screen.getByRole("heading", { name: "No issues in this view." })).toBeVisible();

    unmount();
    renderWorkbench({ status: "forbidden" });
    expect(screen.getByRole("heading", { name: "Operator access required." })).toBeVisible();
  });

  it("offers honest signed-out and retryable offline boundaries", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWorkbench({ status: "signed_out" });
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");

    unmount();
    const load = vi.fn(async () => ready);
    renderWorkbench({ status: "unavailable" }, testClient({ load }));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Northern Lights")).toBeVisible();
    expect(load).toHaveBeenCalledOnce();
  });
});
