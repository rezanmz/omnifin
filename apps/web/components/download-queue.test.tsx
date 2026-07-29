import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DownloadQueueClientError,
  type DownloadQueueClient,
  type DownloadQueueLoadOutcome,
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

  it("refreshes through the injected live client while keeping the last verified geometry", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => demoDownloadQueue);
    renderQueue(ready, { client: { load }, live: true });

    await user.click(screen.getByRole("button", { name: "Refresh download queue" }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Transfers" })).toBeVisible();
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
