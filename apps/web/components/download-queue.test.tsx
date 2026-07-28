import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DownloadQueueClient, DownloadQueueLoadOutcome } from "../lib/download-queue";
import { demoDownloadQueue, demoDownloadQueueGeneratedAt } from "../lib/download-queue-demo";
import { DownloadQueue } from "./download-queue";
import { ThemeProvider } from "./theme-provider";

const ready: DownloadQueueLoadOutcome = { queue: demoDownloadQueue, status: "ready" };

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
    expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
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
});
