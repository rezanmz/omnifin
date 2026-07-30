import type { AcquisitionCalendarResponse } from "@omnifin/contracts/calendar";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AcquisitionCalendarClient,
  AcquisitionCalendarLoadOutcome,
} from "../lib/acquisition-calendar";
import {
  degradedAcquisitionCalendar,
  demoAcquisitionCalendar,
  emptyAcquisitionCalendar,
  unconfiguredAcquisitionCalendar,
} from "../lib/acquisition-calendar-demo";
import { AcquisitionCalendar } from "./acquisition-calendar";
import { ThemeProvider } from "./theme-provider";

const ready: AcquisitionCalendarLoadOutcome = {
  calendar: demoAcquisitionCalendar,
  status: "ready",
};

function renderCalendar(
  outcome: AcquisitionCalendarLoadOutcome = ready,
  options: { client?: AcquisitionCalendarClient; live?: boolean } = {},
) {
  return render(
    <ThemeProvider initialPreference="system">
      <AcquisitionCalendar
        initialOutcome={outcome}
        live={options.live ?? false}
        {...(options.client === undefined ? {} : { client: options.client })}
      />
    </ThemeProvider>,
  );
}

describe("AcquisitionCalendar", () => {
  it("keeps the server-rendered calendar search inert until hydration", () => {
    const markup = renderToString(
      <ThemeProvider initialPreference="system">
        <AcquisitionCalendar initialOutcome={ready} live={false} />
      </ThemeProvider>,
    );

    expect(markup).toMatch(/<input[^>]*disabled=""[^>]*placeholder="Find a title or source"/u);
  });

  it("renders deterministic UTC verification copy", () => {
    renderCalendar();

    expect(screen.getByText("Verified Jul 27, 6:00 PM UTC")).toBeVisible();
  });

  it("renders a seven-day normalized horizon without exposing opaque identifiers", () => {
    renderCalendar();

    expect(screen.getByRole("heading", { level: 1, name: "See what arrives next." })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Week at a glance" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Inspect The Far Meridian/i })).toBeVisible();
    expect(screen.getByText("Sonarr · Television")).toBeVisible();
    expect(screen.getAllByRole("region", { name: /Mon|Tue|Wed|Thu|Fri|Sat|Sun/u })).toHaveLength(7);
    expect(document.body.textContent).not.toContain("calendar_ABCDEFGHIJKLMNOPQRSTUV");
    expect(document.body.textContent).not.toContain("calendar_source_ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("filters attention signals and title search without changing source coverage", async () => {
    const user = userEvent.setup();
    renderCalendar();

    await user.click(screen.getByRole("button", { name: "Attention" }));
    expect(screen.getByRole("button", { name: /Inspect Glass Horizon/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /Inspect Signal, S01E07/i })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Inspect The Far Meridian/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByRole("searchbox", { name: "Search calendar" }), "orison");
    expect(screen.getByRole("button", { name: /Inspect Last Light at Orison/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Inspect Signal/i })).not.toBeInTheDocument();
    expect(screen.getByText("Radarr · Cinema")).toBeVisible();
  });

  it("opens a native, keyboard-dismissable event detail drawer", async () => {
    const user = userEvent.setup();
    renderCalendar();

    const eventCard = screen.getByRole("button", { name: /Inspect The Far Meridian/i });
    await user.click(eventCard);
    const drawer = await screen.findByRole("dialog");
    expect(drawer).toBeVisible();
    expect(within(drawer).getByRole("heading", { name: "The Far Meridian" })).toBeVisible();
    expect(within(drawer).getByText("Read-only calendar signal")).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "Close event details" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(eventCard).toHaveFocus());
  });

  it("provides accessible light, dark, and system appearance controls", async () => {
    const user = userEvent.setup();
    renderCalendar();

    await user.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
  });

  it("renders empty and unconfigured calendar states honestly", () => {
    const { unmount } = renderCalendar({ calendar: emptyAcquisitionCalendar, status: "ready" });
    expect(screen.getByRole("heading", { name: "The horizon is clear." })).toBeVisible();

    unmount();
    renderCalendar({ calendar: unconfiguredAcquisitionCalendar, status: "ready" });
    expect(screen.getByRole("heading", { name: "Connect your release horizon." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure services" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
  });

  it("keeps healthy movie arrivals visible when Sonarr is degraded", () => {
    renderCalendar({ calendar: degradedAcquisitionCalendar, status: "ready" });

    expect(screen.getByText("Partial horizon")).toBeVisible();
    expect(screen.getByRole("button", { name: /Inspect The Far Meridian/i })).toBeVisible();
    expect(screen.getByText("Offline")).toBeVisible();
  });

  it("loads a signed next page through the injected live client", async () => {
    const user = userEvent.setup();
    const firstPage: AcquisitionCalendarResponse = {
      ...demoAcquisitionCalendar,
      nextCursor: "calendar_cursor_fixture_payload.signature",
    };
    const nextEvent = {
      ...demoAcquisitionCalendar.events[0]!,
      eventAt: "2026-08-02T19:00:00.000Z",
      id: "calendar_IJKLMNOPQRSTUVWXYZabcd",
      title: "Second Horizon",
    };
    const nextPage: AcquisitionCalendarResponse = {
      ...demoAcquisitionCalendar,
      events: [nextEvent],
      nextCursor: null,
      sources: [
        { ...demoAcquisitionCalendar.sources[0]!, eventCount: 1 },
        { ...demoAcquisitionCalendar.sources[1]!, eventCount: 0 },
      ],
      summary: { available: 0, episodes: 0, missing: 0, movies: 1, queued: 0, total: 1 },
    };
    const load = vi.fn(async (range) => (range.cursor ? nextPage : firstPage));
    renderCalendar({ calendar: firstPage, status: "ready" }, { client: { load }, live: true });

    await user.click(await screen.findByRole("button", { name: "Load more arrivals" }));
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: firstPage.nextCursor }),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByRole("button", { name: /Inspect Second Horizon/i })).toBeVisible();
  });

  it.each([
    ["forbidden", "Calendar access is restricted."],
    ["signed_out", "Sign in to see what’s next."],
    ["unavailable", "The calendar is offline."],
  ] as const)("renders the %s entry boundary", (status, title) => {
    renderCalendar({ status });
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });
});
