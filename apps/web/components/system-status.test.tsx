import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  SystemStatusClient,
  SystemStatusLoadOutcome,
  SystemStatusWatchCallbacks,
} from "../lib/system-status";
import {
  demoSystemStatus,
  demoSystemStatusGeneratedAt,
  demoSystemStatusPrincipal,
} from "../lib/system-status-demo";
import { SystemStatus } from "./system-status";
import { ThemeProvider } from "./theme-provider";

const ready: SystemStatusLoadOutcome = {
  snapshot: { principal: demoSystemStatusPrincipal, status: demoSystemStatus },
  status: "ready",
};

function renderStatus(
  outcome: SystemStatusLoadOutcome = ready,
  options: { client?: SystemStatusClient; live?: boolean } = {},
) {
  return render(
    <ThemeProvider initialPreference="system">
      <SystemStatus
        initialOutcome={outcome}
        live={options.live ?? false}
        {...(options.client === undefined ? {} : { client: options.client })}
      />
    </ThemeProvider>,
  );
}

describe("SystemStatus", () => {
  it("renders normalized service signals and semantic capacity", () => {
    renderStatus();

    expect(
      screen.getByRole("heading", { level: 1, name: "2 clear things to check." }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Signal by signal" })).toBeVisible();
    expect(screen.getByText("One configured root folder is waiting to reconnect.")).toBeVisible();
    expect(
      screen.getByRole("meter", { name: "Cinema storage 1: 11 percent free" }),
    ).toHaveAttribute("aria-valuenow", "11");
    expect(document.body.textContent).not.toContain("/srv/");
    expect(document.body.textContent).not.toContain("source_1234567890123456789012");
  });

  it("refreshes through the injected client and preserves the protected view", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => ready);
    renderStatus(ready, { client: { load } });

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "Room to keep moving" })).toBeVisible();
  });

  it("replaces the verified reading from a strict live snapshot and closes on unmount", async () => {
    let callbacks: SystemStatusWatchCallbacks | undefined;
    const unsubscribe = vi.fn();
    const client: SystemStatusClient = {
      load: async () => ready,
      watch: (nextCallbacks) => {
        callbacks = nextCallbacks;
        nextCallbacks.onStatus("connecting");
        return unsubscribe;
      },
    };
    const view = renderStatus(ready, { client, live: true });

    expect(screen.getByText("Connecting")).toBeVisible();
    act(() => {
      callbacks?.onSnapshot({
        cursor: "system_event_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "snapshot",
        status: { ...demoSystemStatus, generatedAt: "2026-07-28T23:55:00.000Z" },
      });
      callbacks?.onStatus("live");
    });

    expect(await screen.findByText("Live")).toBeVisible();
    expect(screen.getByText("Updated 11:55 PM UTC")).toBeVisible();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("shows the polling fallback and refreshes only after its visible 30-second interval", async () => {
    vi.useFakeTimers();
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const load = vi.fn(async () => ready);
    const client: SystemStatusClient = {
      load,
      watch: (callbacks) => {
        callbacks.onStatus("fallback");
        return vi.fn();
      },
    };
    try {
      renderStatus(ready, { client, live: true });
      expect(screen.getByText("30s polling")).toBeVisible();
      expect(load).not.toHaveBeenCalled();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(load).not.toHaveBeenCalled();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(load).toHaveBeenCalledOnce();
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
    }
  });

  it("labels fixture-backed views as a stable snapshot", () => {
    renderStatus();
    expect(screen.getByText("Snapshot")).toBeVisible();
  });

  it("retains the last verified reading when a later refresh is unavailable", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => ({ status: "unavailable" }) as const);
    renderStatus(ready, { client: { load } });

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.getByText("Showing the last verified reading.")).toBeVisible(),
    );
    expect(screen.getByRole("heading", { name: "Signal by signal" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "System telemetry is offline." })).toBeNull();
  });

  it("recovers from the offline boundary on retry", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => ready);
    renderStatus({ status: "unavailable" }, { client: { load } });

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "2 clear things to check." })).toBeVisible(),
    );
  });

  it("provides accessible light, dark, and system appearance controls", async () => {
    const user = userEvent.setup();
    renderStatus();

    await user.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
  });

  it("renders unconfigured and identity boundaries honestly", () => {
    const unconfigured: SystemStatusLoadOutcome = {
      snapshot: {
        principal: demoSystemStatusPrincipal,
        status: {
          generatedAt: demoSystemStatusGeneratedAt,
          sources: [],
          state: "unconfigured",
          summary: {
            attentionSources: 0,
            criticalStorage: 0,
            errorSignals: 0,
            healthySources: 0,
            noticeSignals: 0,
            sources: 0,
            unavailableSources: 0,
            warningSignals: 0,
            warningStorage: 0,
          },
        },
      },
      status: "ready",
    };
    const { unmount } = renderStatus(unconfigured);
    expect(screen.getByRole("heading", { name: "Connect the stack." })).toBeVisible();

    unmount();
    renderStatus({ status: "forbidden" });
    expect(screen.getByRole("heading", { name: "Operator access required." })).toBeVisible();
  });
});
