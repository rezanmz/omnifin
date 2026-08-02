import { describe, expect, it } from "vitest";

import {
  calendarDays,
  currentWeek,
  formatCalendarPeriod,
  monthContaining,
  rangeForCalendarView,
  shiftCalendarAnchor,
  shiftedCalendarRange,
} from "./calendar-period";

describe("calendar periods", () => {
  it("aligns weeks to Monday in UTC", () => {
    expect(currentWeek(new Date("2026-08-01T23:59:00.000Z"))).toEqual({
      endAt: "2026-08-03T00:00:00.000Z",
      limit: 100,
      startAt: "2026-07-27T00:00:00.000Z",
    });
  });

  it("builds a Monday-aligned six-week month grid", () => {
    const range = monthContaining(new Date("2026-08-15T12:00:00.000Z"));

    expect(range).toEqual({
      endAt: "2026-09-07T00:00:00.000Z",
      limit: 100,
      startAt: "2026-07-27T00:00:00.000Z",
    });
    expect(calendarDays(range)).toHaveLength(42);
    expect(formatCalendarPeriod(range, "month")).toBe("August 2026");
  });

  it("keeps leap February inside one bounded month request", () => {
    const range = monthContaining(new Date("2028-02-29T18:00:00.000Z"));

    expect(range.startAt).toBe("2028-01-31T00:00:00.000Z");
    expect(range.endAt).toBe("2028-03-13T00:00:00.000Z");
    expect(formatCalendarPeriod(range, "month")).toBe("February 2028");
  });

  it("moves month navigation cleanly across a year boundary", () => {
    const december = monthContaining(new Date("2026-12-18T00:00:00.000Z"));
    const january = shiftedCalendarRange(december, "month", 1);

    expect(formatCalendarPeriod(december, "month")).toBe("December 2026");
    expect(formatCalendarPeriod(january, "month")).toBe("January 2027");
    expect(january.startAt).toBe("2026-12-28T00:00:00.000Z");
    expect(january.endAt).toBe("2027-02-08T00:00:00.000Z");
  });

  it("preserves the selected day when switching and shifting periods", () => {
    const anchor = new Date("2026-01-31T18:45:00.000Z");
    const nextMonthAnchor = shiftCalendarAnchor(anchor, "month", 1);

    expect(nextMonthAnchor.toISOString()).toBe("2026-02-28T18:45:00.000Z");
    expect(rangeForCalendarView(nextMonthAnchor, "week")).toEqual({
      endAt: "2026-03-02T00:00:00.000Z",
      limit: 100,
      startAt: "2026-02-23T00:00:00.000Z",
    });
  });
});
