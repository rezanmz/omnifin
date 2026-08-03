import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  demoAcquisitionCalendar,
  emptyAcquisitionCalendar,
  unconfiguredAcquisitionCalendar,
} from "../lib/acquisition-calendar-demo";
import { AcquisitionCalendarClientError } from "../lib/acquisition-calendar";
import type { AcquisitionCalendarClient } from "../lib/acquisition-calendar";
import { DashboardCalendarStrip } from "./dashboard-calendar-strip";

describe("DashboardCalendarStrip", () => {
  it("replaces an empty static model with a bounded live current-week summary", async () => {
    const load = vi.fn<AcquisitionCalendarClient["load"]>(async () => demoAcquisitionCalendar);

    render(<DashboardCalendarStrip client={{ load }} fallbackItems={[]} live />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading this week’s releases");
    expect(await screen.findByRole("link", { name: /The Far Meridian/i })).toHaveAttribute(
      "href",
      "/calendar",
    );
    expect(screen.getByRole("link", { name: /Signal \/ 1×06/i })).toBeVisible();
    expect(screen.getAllByRole("link", { name: /Open .* in calendar/i })).toHaveLength(4);
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 8 }),
      expect.any(AbortSignal),
    );
    const range = load.mock.calls[0]![0];
    expect(Date.parse(range.endAt) - Date.parse(range.startAt)).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("distinguishes a genuinely empty week from an unconfigured calendar", async () => {
    const { rerender } = render(
      <DashboardCalendarStrip
        client={{ load: async () => emptyAcquisitionCalendar }}
        fallbackItems={[]}
        live
      />,
    );

    expect(await screen.findByText("No arrivals scheduled")).toBeVisible();

    rerender(
      <DashboardCalendarStrip
        client={{ load: async () => unconfiguredAcquisitionCalendar }}
        fallbackItems={[]}
        key="unconfigured"
        live
      />,
    );
    expect(await screen.findByText("Calendar sources are not set up")).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure services" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
  });

  it("keeps Discover usable and retries when the calendar is unavailable", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(demoAcquisitionCalendar);

    render(<DashboardCalendarStrip client={{ load }} fallbackItems={[]} live />);

    const retry = await screen.findByRole("button", { name: "Retry calendar" });
    expect(screen.getByRole("status")).toHaveTextContent("Release timing is unavailable");
    await user.click(retry);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("link", { name: /The Far Meridian/i })).toBeVisible();
  });

  it("does not retry a permission boundary", async () => {
    const load = vi.fn(async () => {
      throw new AcquisitionCalendarClientError(
        "forbidden",
        "permission_denied",
        "Calendar access is restricted.",
      );
    });

    render(<DashboardCalendarStrip client={{ load }} fallbackItems={[]} live />);

    expect(await screen.findByText("Calendar access is restricted")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry calendar" })).not.toBeInTheDocument();
  });
});
