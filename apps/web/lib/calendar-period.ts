import type { AcquisitionCalendarRange } from "./acquisition-calendar";

export type CalendarView = "month" | "week";

export const UTC_DAY = 24 * 60 * 60 * 1_000;
const MONTH_GRID_DAYS = 42;

type CalendarDate = Date | string;

function asDate(value: CalendarDate) {
  const date = typeof value === "string" ? new Date(value) : new Date(value.getTime());
  if (Number.isNaN(date.getTime())) throw new RangeError("Calendar date must be valid.");
  return date;
}

function startOfUtcDay(value: CalendarDate) {
  const date = asDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(value: CalendarDate) {
  const date = startOfUtcDay(value);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - mondayOffset * UTC_DAY);
}

export function currentWeek(reference: Date = new Date()): AcquisitionCalendarRange {
  const start = startOfUtcWeek(reference);
  return {
    endAt: new Date(start.getTime() + 7 * UTC_DAY).toISOString(),
    limit: 100,
    startAt: start.toISOString(),
  };
}

export function monthContaining(reference: CalendarDate): AcquisitionCalendarRange {
  const date = asDate(reference);
  const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const start = startOfUtcWeek(monthStart);
  return {
    endAt: new Date(start.getTime() + MONTH_GRID_DAYS * UTC_DAY).toISOString(),
    limit: 100,
    startAt: start.toISOString(),
  };
}

export function rangeForCalendarView(
  reference: CalendarDate,
  view: CalendarView,
): AcquisitionCalendarRange {
  return view === "month" ? monthContaining(reference) : currentWeek(asDate(reference));
}

export function calendarDays(range: AcquisitionCalendarRange) {
  const start = Date.parse(range.startAt);
  const end = Date.parse(range.endAt);
  const count = Math.round((end - start) / UTC_DAY);
  if (!Number.isInteger(count) || count < 1 || count > 62) {
    throw new RangeError("Calendar range must contain between 1 and 62 UTC days.");
  }
  return Array.from({ length: count }, (_, index) => new Date(start + index * UTC_DAY));
}

export function shiftCalendarAnchor(reference: CalendarDate, view: CalendarView, offset: number) {
  const date = asDate(reference);
  if (view === "week") return new Date(date.getTime() + offset * 7 * UTC_DAY);

  const targetMonthStart = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + offset,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  targetMonthStart.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return targetMonthStart;
}

function periodAnchor(range: AcquisitionCalendarRange, view: CalendarView) {
  const start = Date.parse(range.startAt);
  return new Date(start + (view === "month" ? 7 : 3) * UTC_DAY);
}

export function shiftedCalendarRange(
  range: AcquisitionCalendarRange,
  view: CalendarView,
  offset: number,
) {
  return rangeForCalendarView(shiftCalendarAnchor(periodAnchor(range, view), view, offset), view);
}

export function formatCalendarPeriod(range: AcquisitionCalendarRange, view: CalendarView) {
  if (view === "month") {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone: "UTC",
      year: "numeric",
    }).format(periodAnchor(range, view));
  }

  const start = new Date(range.startAt);
  const end = new Date(Date.parse(range.endAt) - 1);
  const startLabel = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(start);
  const endLabel = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: start.getUTCMonth() === end.getUTCMonth() ? undefined : "short",
    timeZone: "UTC",
    year: start.getUTCFullYear() === end.getUTCFullYear() ? undefined : "numeric",
  }).format(end);
  return `${startLabel} — ${endLabel}, ${end.getUTCFullYear()}`;
}
