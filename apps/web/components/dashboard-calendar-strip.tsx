"use client";

import type { AcquisitionCalendarEvent } from "@omnifin/contracts/calendar";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  acquisitionCalendarClient,
  acquisitionCalendarOutcomeFromError,
  type AcquisitionCalendarClient,
} from "../lib/acquisition-calendar";
import { currentWeek } from "../lib/calendar-period";
import type { CalendarItemModel } from "../lib/dashboard-data";
import { CalendarStrip } from "./calendar-strip";

const DASHBOARD_CALENDAR_LIMIT = 8;
const DASHBOARD_CALENDAR_VISIBLE_ITEMS = 4;
const EVENT_ACCENTS = {
  available: "#8de9d5",
  missing: "#f2a27e",
  monitored: "#9ecfff",
  queued: "#d8ff70",
  unknown: "#b8bfc7",
} as const;

export interface DashboardCalendarStripProperties {
  client?: AcquisitionCalendarClient;
  fallbackItems: CalendarItemModel[];
  live?: boolean;
}

function eventTitle(event: AcquisitionCalendarEvent) {
  if (event.kind === "movie") return event.title;
  return `${event.title} / ${event.seasonNumber}×${String(event.episodeNumber).padStart(2, "0")}`;
}

export function calendarStripItems(
  events: readonly AcquisitionCalendarEvent[],
): CalendarItemModel[] {
  const dayFormat = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    timeZone: "UTC",
    weekday: "short",
  });
  return events.slice(0, DASHBOARD_CALENDAR_VISIBLE_ITEMS).map((event) => ({
    accent: EVENT_ACCENTS[event.availability],
    day: dayFormat.format(new Date(event.eventAt)).toUpperCase(),
    id: event.id,
    service: event.kind === "movie" ? "Movie" : "Series",
    title: eventTitle(event),
  }));
}

function LiveDashboardCalendarStrip({
  client,
  fallbackItems,
  live,
}: Required<Pick<DashboardCalendarStripProperties, "client" | "fallbackItems">> &
  Required<Pick<DashboardCalendarStripProperties, "live">>) {
  const [range] = useState(() => ({ ...currentWeek(), limit: DASHBOARD_CALENDAR_LIMIT }));
  const query = useQuery({
    enabled: live,
    queryFn: ({ signal }) => client.load(range, signal),
    queryKey: ["dashboard-acquisition-calendar", range.startAt, range.endAt],
    refetchInterval: live ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 30_000,
  });

  if (!live) return <CalendarStrip items={fallbackItems} />;
  if (query.isPending) return <CalendarStrip items={[]} state="loading" />;
  if (!query.data) {
    return (
      <CalendarStrip
        items={[]}
        onRetry={() => void query.refetch()}
        state={acquisitionCalendarOutcomeFromError(query.error)}
      />
    );
  }
  if (query.data.state === "unconfigured") {
    return <CalendarStrip items={[]} state="unconfigured" />;
  }
  if (query.data.state === "degraded" && query.data.events.length === 0) {
    return <CalendarStrip items={[]} onRetry={() => void query.refetch()} state="unavailable" />;
  }
  return (
    <CalendarStrip
      degraded={query.data.state === "degraded"}
      items={calendarStripItems(query.data.events)}
    />
  );
}

export function DashboardCalendarStrip({
  client = acquisitionCalendarClient,
  fallbackItems,
  live = false,
}: DashboardCalendarStripProperties) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { gcTime: 5 * 60_000, retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <LiveDashboardCalendarStrip client={client} fallbackItems={fallbackItems} live={live} />
    </QueryClientProvider>
  );
}
