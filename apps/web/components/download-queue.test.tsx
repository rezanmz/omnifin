import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DownloadQueueClientError,
  type DownloadQueueClient,
  type DownloadQueueLoadOutcome,
  type DownloadQueueWatchCallbacks,
} from "../lib/download-queue";
import { demoDownloadQueue, demoDownloadQueueGeneratedAt } from "../lib/download-queue-demo";
import { DownloadQueue } from "./download-queue";
import { ThemeProvider } from "./theme-provider";

const ready: DownloadQueueLoadOutcome = { queue: demoDownloadQueue, status: "ready" };
const operator: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-29T03:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Queue operator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-28T04:00:00.000Z",
  issuedAt: "2026-07-28T03:00:00.000Z",
  linkedServices: [
    {
      displayName: "Queue operator",
      externalUserId: "jellyfin-queue-operator",
      health: "linked",
      id: "jellyfin-link-queue-operator",
      lastVerifiedAt: "2026-07-28T03:00:00.000Z",
      linkedAt: "2026-07-27T03:00:00.000Z",
      service: "jellyfin",
      username: "queue-operator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "queue-session",
  userId: "queue-operator",
};

function renderQueue(
  outcome: DownloadQueueLoadOutcome = ready,
  options: { client?: DownloadQueueClient; live?: boolean } = {},
) {
  return render(
    <ThemeProvider initialPreference="system">
      <DownloadQueue
        initialOutcome={outcome}
        live={options.live ?? false}
        {...(options.client === undefined ? {} : { client: options.client })}
      />
    </ThemeProvider>,
  );
}

describe("DownloadQueue", () => {
  it("renders normalized queue telemetry without upstream identifiers", () => {
    renderQueue();

    expect(screen.getByRole("heading", { level: 1, name: "Every byte, in motion." })).toBeVisible();
    expect(screen.getByText("The.Far.Meridian.2026.2160p.WEB-DL")).toBeVisible();
    expect(screen.getByText("SABnzbd · Series")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: /Far\.Meridian.*progress/u })).toHaveAttribute(
      "aria-valuenow",
      "72",
    );
    expect(screen.getByText("Secret boundary intact")).toBeVisible();
    expect(document.body.textContent).not.toContain("download_ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("filters attention states and transfer names without hiding semantic progress", async () => {
    const user = userEvent.setup();
    renderQueue();

    await user.click(screen.getByRole("button", { name: "Attention" }));
    expect(screen.getByText("Glass.Horizon.2025.1080p.BluRay")).toBeVisible();
    expect(screen.queryByText("Signal.S01E07.1080p.WEB-DL")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByRole("searchbox", { name: "Search downloads" }), "signal");
    expect(screen.getByText("Signal.S01E07.1080p.WEB-DL")).toBeVisible();
    expect(screen.queryByText("Glass.Horizon.2025.1080p.BluRay")).not.toBeInTheDocument();
  });

  it("scopes bulk controls to the exact current view and restores cancel focus", async () => {
    const user = userEvent.setup();
    renderQueue();

    const pause = screen.getByRole("button", { name: "Pause 1 active transfer" });
    expect(screen.getByRole("button", { name: "Resume 1 paused transfer" })).toBeEnabled();
    expect(
      screen.getByText(/All visible transfers · 2 clients · exact targets only/u),
    ).toBeVisible();
    await user.click(pause);

    expect(screen.getByText("Pause 1 transfer?")).toBeVisible();
    expect(screen.getByText(/recheck every opaque target/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "Search downloads" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Attention" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(pause).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Attention" }));
    expect(screen.getByRole("button", { name: "Pause 0 active transfers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume 0 paused transfers" })).toBeDisabled();
    expect(screen.getByText(/Filtered scope · 1 client · exact targets only/u)).toBeVisible();
  });

  it("bulk-pauses the captured active view and applies only verified successes", async () => {
    const user = userEvent.setup();
    const item = demoDownloadQueue.items[0]!;
    const paused = {
      ...item,
      etaSeconds: null,
      rateBytesPerSecond: 0,
      state: "paused" as const,
    };
    const bulkAct = vi.fn(async () => ({
      action: "pause" as const,
      completedAt: "2026-07-28T03:00:08.000Z",
      operationId: "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
      replayed: false,
      results: [
        {
          response: {
            action: "pause" as const,
            item: paused,
            previousState: "downloading" as const,
            replayed: false,
            verifiedAt: "2026-07-28T03:00:08.000Z",
          },
          status: "succeeded" as const,
          target: {
            connectorId: item.connectorId,
            expectedState: "downloading" as const,
            itemId: item.id,
          },
        },
      ],
      state: "complete" as const,
      summary: { failed: 0, requested: 1, succeeded: 1 },
    }));
    renderQueue(ready, {
      client: {
        bulkAct,
        load: async () => demoDownloadQueue,
        loadEligibility: async () => ({
          snapshot: { csrfToken: "download-queue-csrf", principal: operator },
          status: "ready",
        }),
      },
    });

    await user.click(screen.getByRole("button", { name: "Pause 1 active transfer" }));
    await user.click(screen.getByRole("button", { name: "Confirm pause" }));

    await waitFor(() => expect(bulkAct).toHaveBeenCalledOnce());
    expect(bulkAct).toHaveBeenCalledWith(
      {
        action: "pause",
        targets: [
          {
            connectorId: item.connectorId,
            expectedState: "downloading",
            itemId: item.id,
          },
        ],
      },
      {
        csrfToken: "download-queue-csrf",
        idempotencyKey: expect.any(String),
      },
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "1 transfer paused and reverified.",
    );
    const card = screen.getByText(item.title).closest("article")!;
    expect(within(card).getByText("Paused")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause 0 active transfers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume 2 paused transfers" })).toBeEnabled();
  });

  it("refreshes through the injected live client while keeping the last verified geometry", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => demoDownloadQueue);
    renderQueue(ready, { client: { load }, live: true });

    await user.click(screen.getByRole("button", { name: "Refresh download queue" }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Transfers" })).toBeVisible();
  });

  it("replaces the queue in place when a strict live snapshot arrives", async () => {
    let callbacks: DownloadQueueWatchCallbacks | undefined;
    const unsubscribe = vi.fn();
    const changedTitle = "The.Far.Meridian.2026.REPACK.2160p";
    const client: DownloadQueueClient = {
      load: async () => demoDownloadQueue,
      watch: (nextCallbacks) => {
        callbacks = nextCallbacks;
        nextCallbacks.onStatus("connecting");
        return unsubscribe;
      },
    };
    const view = renderQueue(ready, { client, live: true });

    expect(screen.getByText("Connecting")).toBeVisible();
    act(() => {
      callbacks?.onSnapshot({
        cursor: "download_event_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "snapshot",
        queue: {
          ...demoDownloadQueue,
          items: demoDownloadQueue.items.map((item, index) =>
            index === 0 ? { ...item, title: changedTitle } : item,
          ),
        },
      });
    });

    expect(await screen.findByText(changedTitle)).toBeVisible();
    expect(screen.getByText("Live")).toBeVisible();
    expect(screen.queryByText(demoDownloadQueue.items[0]!.title)).not.toBeInTheDocument();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps verified data visible while live updates use polling fallback", () => {
    const client: DownloadQueueClient = {
      load: async () => demoDownloadQueue,
      watch: (callbacks) => {
        callbacks.onStatus("fallback");
        return vi.fn();
      },
    };
    renderQueue(ready, { client, live: true });

    expect(screen.getByText("12s fallback")).toBeVisible();
    expect(screen.getByText(demoDownloadQueue.items[0]!.title)).toBeVisible();
  });

  it("provides accessible light, dark, and system appearance controls", async () => {
    const user = userEvent.setup();
    renderQueue();

    await user.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
  });

  it("renders empty and unconfigured queue states honestly", () => {
    const { unmount } = renderQueue({
      queue: {
        ...demoDownloadQueue,
        clients: demoDownloadQueue.clients.map((client) => ({
          ...client,
          itemCount: 0,
          rateBytesPerSecond: 0,
        })),
        items: [],
        summary: {
          attention: 0,
          downloading: 0,
          paused: 0,
          queued: 0,
          remainingBytes: 0,
          total: 0,
          totalRateBytesPerSecond: 0,
        },
      },
      status: "ready",
    });
    expect(screen.getByRole("heading", { name: "The queue is calm" })).toBeVisible();

    unmount();
    renderQueue({
      queue: {
        clients: [],
        failures: [],
        generatedAt: demoDownloadQueueGeneratedAt,
        items: [],
        state: "unconfigured",
        summary: {
          attention: 0,
          downloading: 0,
          paused: 0,
          queued: 0,
          remainingBytes: 0,
          total: 0,
          totalRateBytesPerSecond: 0,
        },
        truncated: false,
      },
      status: "ready",
    });
    expect(screen.getByRole("heading", { name: "Connect the transfer plane." })).toBeVisible();
  });

  it("keeps healthy transfers visible when one client is degraded", () => {
    const failure = {
      code: "timeout" as const,
      message: "SABnzbd did not respond before the deadline.",
      occurredAt: demoDownloadQueueGeneratedAt,
      operation: "download.queue",
      retryable: true,
      service: "sabnzbd" as const,
    };
    renderQueue({
      queue: {
        ...demoDownloadQueue,
        clients: [
          demoDownloadQueue.clients[0]!,
          {
            ...demoDownloadQueue.clients[1]!,
            failure,
            itemCount: 0,
            rateBytesPerSecond: 0,
            status: "unavailable",
          },
        ],
        failures: [failure],
        items: demoDownloadQueue.items.filter((item) => item.client === "qbittorrent"),
        state: "degraded",
        summary: {
          attention: 1,
          downloading: 1,
          paused: 0,
          queued: 0,
          remainingBytes: 13_600_000_000,
          total: 2,
          totalRateBytesPerSecond: 48_600_000,
        },
      },
      status: "ready",
    });

    expect(screen.getByText("Partial queue")).toBeVisible();
    expect(screen.getByText("The.Far.Meridian.2026.2160p.WEB-DL")).toBeVisible();
    expect(screen.getByText("Offline")).toBeVisible();
  });

  it.each([
    ["forbidden", "Operator access required."],
    ["signed_out", "Sign in to continue."],
    ["unavailable", "The queue is offline."],
  ] as const)("renders the %s entry boundary", (status, title) => {
    renderQueue({ status });
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });

  it("opens an exact-item confirmation with safe cancel focused and restores trigger focus", async () => {
    const user = userEvent.setup();
    renderQueue();
    const trigger = screen.getByRole("button", {
      name: "Pause The.Far.Meridian.2026.2160p.WEB-DL",
    });

    await user.click(trigger);

    expect(screen.getByText("Pause this transfer?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pause The.Far.Meridian.2026.2160p.WEB-DL" }),
      ).toHaveFocus(),
    );
  });

  it("restores the queue action trigger after a synchronous animation frame", async () => {
    const animationFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const user = userEvent.setup();
    renderQueue();
    const triggerName = "Pause The.Far.Meridian.2026.2160p.WEB-DL";

    try {
      await user.click(screen.getByRole("button", { name: triggerName }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.getByRole("button", { name: triggerName })).toHaveFocus());
    } finally {
      animationFrame.mockRestore();
    }
  });

  it("requires typed confirmation before removing one item with downloaded files preserved", async () => {
    const user = userEvent.setup();
    const item = demoDownloadQueue.items[0]!;
    const remove = vi.fn(async () => ({
      contentDisposition: "preserved" as const,
      item,
      operationId: "download_removal_ABCDEFGHIJKLMNOPQRSTUV",
      removedAt: "2026-07-28T03:00:08.000Z",
      replayed: false,
    }));
    renderQueue(ready, {
      client: {
        load: async () => demoDownloadQueue,
        loadEligibility: async () => ({
          snapshot: { csrfToken: "download-queue-csrf", principal: operator },
          status: "ready",
        }),
        remove,
      },
    });

    const trigger = screen.getByRole("button", { name: `Remove ${item.title}` });
    await user.click(trigger);

    expect(screen.getByText("Remove this transfer?")).toBeVisible();
    expect(screen.getByText(/Downloaded content stays on disk/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel removal" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel removal" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Remove ${item.title}` })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: `Remove ${item.title}` }));

    const confirm = screen.getByRole("button", { name: "Remove transfer" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Type REMOVE to confirm" }), "REMOVE");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith(
      {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      },
      {
        csrfToken: "download-queue-csrf",
        idempotencyKey: expect.any(String),
      },
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      `${item.title} removed from ${item.clientName}. Downloaded files were preserved.`,
    );
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
  });

  it("resumes a paused transfer and updates the verified queue geometry in place", async () => {
    const user = userEvent.setup();
    const paused = demoDownloadQueue.items[1]!;
    const loadEligibility = vi.fn(async () => ({
      snapshot: { csrfToken: "download-queue-csrf", principal: operator },
      status: "ready" as const,
    }));
    const act = vi.fn(async () => ({
      action: "resume" as const,
      item: {
        ...paused,
        etaSeconds: 180,
        rateBytesPerSecond: 12_800_000,
        state: "downloading" as const,
      },
      previousState: "paused" as const,
      replayed: false,
      verifiedAt: "2026-07-28T03:00:08.000Z",
    }));
    renderQueue(ready, {
      client: { act, load: async () => demoDownloadQueue, loadEligibility },
    });

    await user.click(screen.getByRole("button", { name: `Resume ${paused.title}` }));
    await user.click(screen.getByRole("button", { name: "Confirm resume" }));

    await waitFor(() => expect(screen.getByText(`${paused.title} resumed.`)).toBeVisible());
    const card = screen.getByText(paused.title).closest("article");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("Downloading")).toBeVisible();
    expect(within(card!).getByText("12.2 MiB/s")).toBeVisible();
    expect(loadEligibility).toHaveBeenCalledOnce();
    expect(act).toHaveBeenCalledWith(
      {
        action: "resume",
        connectorId: paused.connectorId,
        expectedState: "paused",
        itemId: paused.id,
      },
      { csrfToken: "download-queue-csrf" },
    );
  });

  it("promotes one exact transfer to the front without a blocking confirmation", async () => {
    const user = userEvent.setup();
    const item = demoDownloadQueue.items[2]!;
    const promote = vi
      .fn()
      .mockResolvedValueOnce({
        item,
        position: 0 as const,
        previousPosition: 2,
        promotedAt: "2026-07-28T03:00:08.000Z",
        replayed: false,
      })
      .mockResolvedValueOnce({
        item,
        position: 0 as const,
        previousPosition: 0,
        promotedAt: "2026-07-28T03:00:09.000Z",
        replayed: true,
      });
    renderQueue(ready, {
      client: {
        load: async () => demoDownloadQueue,
        loadEligibility: async () => ({
          snapshot: { csrfToken: "download-queue-csrf", principal: operator },
          status: "ready",
        }),
        promote,
      },
    });

    await user.click(screen.getByRole("button", { name: `Move ${item.title} to front of queue` }));

    await waitFor(() => expect(promote).toHaveBeenCalledOnce());
    expect(promote).toHaveBeenCalledWith(
      {
        connectorId: item.connectorId,
        expectedState: item.state,
        itemId: item.id,
      },
      { csrfToken: "download-queue-csrf" },
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      `${item.title} moved to the front of ${item.clientName}.`,
    );
    const promotedCard = screen.getByText(item.title).closest("article")!;
    const formerFirstCard = screen.getByText(demoDownloadQueue.items[0]!.title).closest("article")!;
    expect(promotedCard.compareDocumentPosition(formerFirstCard)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.queryByText(/promote this transfer/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: `Move ${item.title} to front of queue` }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      `${item.title} was already first in ${item.clientName}.`,
    );
  });

  it("keeps queue order unchanged when promotion eligibility cannot be proven", async () => {
    const user = userEvent.setup();
    const item = demoDownloadQueue.items[0]!;
    const promote = vi.fn();
    renderQueue(ready, {
      client: {
        load: async () => demoDownloadQueue,
        loadEligibility: async () => ({ status: "signed_out" }),
        promote,
      },
    });

    await user.click(screen.getByRole("button", { name: `Move ${item.title} to front of queue` }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your session ended. Sign in again before prioritizing a transfer.",
    );
    expect(promote).not.toHaveBeenCalled();
  });

  it("locks every queue action while one exact mutation is in flight", async () => {
    const user = userEvent.setup();
    const item = demoDownloadQueue.items[0]!;
    let finishAction!: () => void;
    const actionPending = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    const act = vi.fn(async () => {
      await actionPending;
      return {
        action: "pause" as const,
        item: { ...item, etaSeconds: null, rateBytesPerSecond: 0, state: "paused" as const },
        previousState: "downloading" as const,
        replayed: false,
        verifiedAt: "2026-07-28T03:00:08.000Z",
      };
    });
    renderQueue(ready, {
      client: {
        act,
        load: async () => demoDownloadQueue,
        loadEligibility: async () => ({
          snapshot: { csrfToken: "download-queue-csrf", principal: operator },
          status: "ready",
        }),
      },
    });

    await user.click(screen.getByRole("button", { name: `Pause ${item.title}` }));
    await user.click(screen.getByRole("button", { name: "Confirm pause" }));

    await waitFor(() => expect(act).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: `Pause ${item.title}` })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Resume Signal.S01E07.1080p.WEB-DL" }),
    ).toBeDisabled();
    finishAction();
    await waitFor(() => expect(screen.getByText(`${item.title} paused.`)).toBeVisible());
  });

  it.each([
    ["signed_out", "Your session ended. Sign in again before changing a transfer."],
    ["forbidden", "Operator access is required to change this transfer."],
    ["unavailable", "The session could not be verified. No transfer state was changed."],
  ] as const)("keeps the transfer unchanged when eligibility is %s", async (status, message) => {
    const user = userEvent.setup();
    const item = demoDownloadQueue.items[0]!;
    const act = vi.fn();
    renderQueue(ready, {
      client: {
        act,
        load: async () => demoDownloadQueue,
        loadEligibility: async () => ({ status }),
      },
    });

    await user.click(screen.getByRole("button", { name: `Pause ${item.title}` }));
    await user.click(screen.getByRole("button", { name: "Confirm pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(act).not.toHaveBeenCalled();
  });

  it("announces a stale-state failure and refreshes the last verified queue", async () => {
    const user = userEvent.setup();
    const item = demoDownloadQueue.items[0]!;
    const load = vi.fn(async () => demoDownloadQueue);
    renderQueue(ready, {
      client: {
        act: async () => {
          throw new DownloadQueueClientError(
            "stale",
            "download_queue_state_changed",
            "The download changed before the action was confirmed. Refresh and try again.",
          );
        },
        load,
        loadEligibility: async () => ({
          snapshot: { csrfToken: "download-queue-csrf", principal: operator },
          status: "ready",
        }),
      },
    });

    await user.click(screen.getByRole("button", { name: `Pause ${item.title}` }));
    await user.click(screen.getByRole("button", { name: "Confirm pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("changed before the action");
    await waitFor(() => expect(load).toHaveBeenCalled());
  });
});
