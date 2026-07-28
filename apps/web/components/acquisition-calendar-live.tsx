"use client";

import type {
  AcquisitionCalendarEvent,
  AcquisitionCalendarResponse,
} from "@omnifin/contracts/calendar";
import { QueryClient, QueryClientProvider, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  acquisitionCalendarOutcomeFromError,
  type AcquisitionCalendarClient,
  type AcquisitionCalendarLoadOutcome,
  type AcquisitionCalendarRange,
} from "../lib/acquisition-calendar";
import {
  BoundaryState,
  currentWeek,
  LoadingState,
  ReadyCalendar,
  shiftedWeek,
  summarize,
  type CalendarFilter,
} from "./acquisition-calendar";

interface LiveCalendarContentProperties {
  client: AcquisitionCalendarClient;
  embedded?: boolean;
  hideHero?: boolean;
  initialOutcome?: AcquisitionCalendarLoadOutcome;
  live?: boolean;
}

function LiveCalendarContent({
  client,
  embedded = false,
  hideHero = false,
  initialOutcome,
  live,
}: LiveCalendarContentProperties) {
  const refreshAvailable = live ?? initialOutcome === undefined;
  const initialCalendar = initialOutcome?.status === "ready" ? initialOutcome.calendar : undefined;
  const [range, setRange] = useState<AcquisitionCalendarRange>(() =>
    initialCalendar
      ? { endAt: initialCalendar.endAt, limit: 100, startAt: initialCalendar.startAt }
      : currentWeek(),
  );
  const [filter, setFilter] = useState<CalendarFilter>("all");
  const [search, setSearch] = useState("");

  const initialData = initialCalendar
    ? { pageParams: [null as string | null], pages: [initialCalendar] }
    : undefined;
  const query = useInfiniteQuery({
    enabled: refreshAvailable,
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      client.load({ ...range, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    queryKey: ["acquisition-calendar", range.startAt, range.endAt],
    refetchInterval: refreshAvailable ? 30_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 20_000,
    ...(initialData === undefined ? {} : { initialData }),
  });

  if (!refreshAvailable && initialOutcome && initialOutcome.status !== "ready") {
    return <BoundaryState embedded={embedded} status={initialOutcome.status} />;
  }
  if (query.isPending) return <LoadingState embedded={embedded} />;
  if (!query.data)
    return (
      <BoundaryState
        embedded={embedded}
        status={acquisitionCalendarOutcomeFromError(query.error)}
      />
    );

  const firstPage = query.data.pages[0]!;
  const eventMap = new Map<string, AcquisitionCalendarEvent>();
  for (const page of query.data.pages) {
    for (const event of page.events) eventMap.set(event.id, event);
  }
  const events = [...eventMap.values()].toSorted((left, right) => {
    const byTime = Date.parse(left.eventAt) - Date.parse(right.eventAt);
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
  });
  const calendar: AcquisitionCalendarResponse = {
    ...firstPage,
    events,
    summary: summarize(events),
  };

  const navigate = (action: "next" | "previous" | "today") => {
    setRange(action === "today" ? currentWeek() : shiftedWeek(range, action === "next" ? 1 : -1));
    setFilter("all");
    setSearch("");
  };

  return (
    <ReadyCalendar
      calendar={calendar}
      canLoadMore={query.hasNextPage}
      embedded={embedded}
      filter={filter}
      hideHero={hideHero}
      isFetching={query.isFetching && !query.isFetchingNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onFilter={setFilter}
      onLoadMore={() => void query.fetchNextPage()}
      onNavigate={navigate}
      onRefresh={() => void query.refetch()}
      onSearch={setSearch}
      query={search}
      range={range}
      refreshAvailable={refreshAvailable}
      stale={query.isError}
    />
  );
}

export function LiveAcquisitionCalendar(properties: LiveCalendarContentProperties) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { gcTime: 5 * 60_000, retry: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <LiveCalendarContent {...properties} />
    </QueryClientProvider>
  );
}
