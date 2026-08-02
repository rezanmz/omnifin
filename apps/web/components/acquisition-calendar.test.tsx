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
  demoMonthAcquisitionCalendar,
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
  options: {
    client?: AcquisitionCalendarClient;
    initialView?: "month" | "week";
    live?: boolean;
  } = {},
) {
  return render(
    <ThemeProvider initialPreference="system">
      <AcquisitionCalendar
        initialOutcome={outcome}
        live={options.live ?? false}
        {...(options.client === undefined ? {} : { client: options.client })}
        {...(options.initialView === undefined ? {} : { initialView: options.initialView })}
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

  it("switches to an accessible six-week month view", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => demoMonthAcquisitionCalendar);
    renderCalendar(ready, { client: { load }, live: true });

    const month = await screen.findByRole("button", { name: "Month view" });
    expect(screen.getByRole("button", { name: "Week view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(month);

    expect(await screen.findByRole("heading", { name: "Month at a glance" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Month view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("grid", { name: /Month acquisition calendar/u })).toBeVisible();
    const cells = screen.getAllByRole("gridcell");
    expect(cells).toHaveLength(42);
    expect(cells.every((cell) => cell.tagName === "DIV")).toBe(true);
    expect(screen.getByRole("button", { name: "Previous month" })).toBeEnabled();
    expect(screen.getByText("premieres this month")).toBeVisible();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        endAt: "2026-08-10T00:00:00.000Z",
        startAt: "2026-06-29T00:00:00.000Z",
      }),
      expect.any(AbortSignal),
    );
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

  it("reveals a crowded month day without making arrivals unreachable", async () => {
    const user = userEvent.setup();
    const events = demoAcquisitionCalendar.events.slice(0, 3).map((event) => ({
      ...event,
      eventAt: "2026-07-27T18:30:00.000Z",
    }));
    renderCalendar(
      {
        calendar: {
          ...demoMonthAcquisitionCalendar,
          events,
          summary: {
            available: 1,
            episodes: 1,
            missing: 1,
            movies: 2,
            queued: 0,
            total: 3,
          },
        },
        status: "ready",
      },
      { initialView: "month" },
    );

    expect(
      screen.queryByRole("button", { name: /Inspect Glass Horizon/i }),
    ).not.toBeInTheDocument();
    const reveal = screen.getByRole("button", {
      name: "Show 1 more arrivals on Monday, July 27, 2026",
    });
    await user.click(reveal);

    expect(screen.getByRole("button", { name: /Inspect Glass Horizon/i })).toBeVisible();
    expect(reveal).toHaveAttribute("aria-expanded", "true");
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
