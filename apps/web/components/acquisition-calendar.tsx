"use client";

import type {
  AcquisitionCalendarEvent,
  AcquisitionCalendarResponse,
} from "@omnifin/contracts/calendar";
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  CloudOff,
  Eye,
  Film,
  Layers3,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ServerCog,
  Sparkles,
  Timer,
  Tv,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  acquisitionCalendarClient,
  type AcquisitionCalendarClient,
  type AcquisitionCalendarLoadOutcome,
  type AcquisitionCalendarRange,
} from "../lib/acquisition-calendar";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { AcquisitionCalendarTopbar } from "./acquisition-calendar-topbar";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import styles from "./acquisition-calendar.module.css";

export type CalendarFilter = "all" | "attention" | "episodes" | "movies";

const FILTERS: { icon: LucideIcon; label: string; value: CalendarFilter }[] = [
  { icon: Sparkles, label: "All", value: "all" },
  { icon: Film, label: "Movies", value: "movies" },
  { icon: Tv, label: "Episodes", value: "episodes" },
  { icon: CircleAlert, label: "Attention", value: "attention" },
];

const EventDetail = dynamic(() =>
  import("./acquisition-calendar-event-detail").then(
    (module) => module.AcquisitionCalendarEventDetail,
  ),
);

const LiveCalendar = dynamic(
  () => import("./acquisition-calendar-live").then((module) => module.LiveAcquisitionCalendar),
  { loading: () => <LoadingState /> },
);

const EmbeddedLiveCalendar = dynamic(
  () => import("./acquisition-calendar-live").then((module) => module.LiveAcquisitionCalendar),
  { loading: () => <LoadingState embedded /> },
);

const UTC_DAY = 24 * 60 * 60 * 1_000;
const subscribeToHydration = () => () => undefined;
const clientHydrated = () => true;
const serverHydrated = () => false;

export interface AcquisitionCalendarProperties {
  client?: AcquisitionCalendarClient;
  embedded?: boolean;
  hideHero?: boolean;
  initialOutcome?: AcquisitionCalendarLoadOutcome;
  live?: boolean;
}

export function currentWeek(): AcquisitionCalendarRange {
  const current = new Date();
  const mondayOffset = (current.getUTCDay() + 6) % 7;
  const start = new Date(
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() - mondayOffset),
  );
  return {
    endAt: new Date(start.getTime() + 7 * UTC_DAY).toISOString(),
    limit: 100,
    startAt: start.toISOString(),
  };
}

export function shiftedWeek(
  range: AcquisitionCalendarRange,
  offset: number,
): AcquisitionCalendarRange {
  const start = new Date(Date.parse(range.startAt) + offset * 7 * UTC_DAY);
  return {
    endAt: new Date(start.getTime() + 7 * UTC_DAY).toISOString(),
    limit: 100,
    startAt: start.toISOString(),
  };
}

function dayDates(range: AcquisitionCalendarRange) {
  const start = Date.parse(range.startAt);
  return Array.from({ length: 7 }, (_, index) => new Date(start + index * UTC_DAY));
}

function dayKey(value: Date | string) {
  return (typeof value === "string" ? value : value.toISOString()).slice(0, 10);
}

function formatWeek(range: AcquisitionCalendarRange) {
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

function formatEventTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatVerifiedAt(value: string) {
  const date = new Date(value);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ] as const;
  const hour = date.getUTCHours();
  const displayHour = hour % 12 || 12;
  const period = hour >= 12 ? "PM" : "AM";
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${displayHour}:${String(date.getUTCMinutes()).padStart(2, "0")} ${period} UTC`;
}

export function summarize(events: readonly AcquisitionCalendarEvent[]) {
  return {
    available: events.filter((event) => event.availability === "available").length,
    episodes: events.filter((event) => event.kind === "episode").length,
    missing: events.filter((event) => event.availability === "missing").length,
    movies: events.filter((event) => event.kind === "movie").length,
    queued: events.filter((event) => event.availability === "queued").length,
    total: events.length,
  };
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.layout}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <AcquisitionCalendarTopbar />
        {children}
      </main>
    </div>
  );
}

const BOUNDARY_COPY = {
  forbidden: {
    action: "Return to discovery",
    detail: "Your current account cannot inspect acquisition timing for this media stack.",
    href: "/",
    icon: LockKeyhole,
    kicker: "Media boundary",
    title: "Calendar access is restricted.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before Omnifin could retrieve the private acquisition calendar.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Session required",
    title: "Sign in to see what’s next.",
  },
  unavailable: {
    action: "Return to discovery",
    detail:
      "The gateway cannot verify release timing right now. Existing monitoring and requests were not changed.",
    href: "/",
    icon: CloudOff,
    kicker: "Signal interrupted",
    title: "The calendar is offline.",
  },
} as const;

export function BoundaryState({
  embedded = false,
  status,
}: {
  embedded?: boolean;
  status: keyof typeof BOUNDARY_COPY;
}) {
  const copy = BOUNDARY_COPY[status];
  const Icon = copy.icon;
  const content = (
    <section className={styles.statePanel}>
      <span className={styles.stateIcon} aria-hidden="true">
        <Icon />
      </span>
      <p className="eyebrow">{copy.kicker}</p>
      <h1>{copy.title}</h1>
      <p>{copy.detail}</p>
      <Link className={styles.primaryAction} href={copy.href}>
        {copy.action}
      </Link>
    </section>
  );
  return embedded ? content : <PageFrame>{content}</PageFrame>;
}

export function LoadingState({ embedded = false }: { embedded?: boolean }) {
  const content = (
    <div
      aria-busy="true"
      aria-label="Loading acquisition calendar"
      className={styles.loading}
      role="status"
    >
      <div className={styles.loadingHero}>
        <i />
        <b />
        <span />
      </div>
      <div className={styles.loadingCommand} />
      <div className={styles.loadingMetrics}>
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <div className={styles.loadingWeek}>
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <span className="sr-only">Loading monitored movies and episodes.</span>
    </div>
  );
  return embedded ? content : <PageFrame>{content}</PageFrame>;
}

function Metric({
  detail,
  icon: Icon,
  label,
  state,
  value,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  state?: "attention" | "good";
  value: string;
}) {
  return (
    <article className={styles.metric} data-state={state}>
      <Icon aria-hidden="true" size={19} strokeWidth={1.65} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function EventCard({
  event,
  interactive,
  onSelect,
}: {
  event: AcquisitionCalendarEvent;
  interactive: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <button
      aria-label={`Inspect ${event.title}, ${event.subtitle ?? (event.kind === "movie" ? "movie" : "episode")}`}
      className={styles.eventCard}
      data-availability={event.availability}
      data-directional-item
      disabled={!interactive}
      onFocus={() => void import("./acquisition-calendar-event-detail")}
      onClick={(interaction) => onSelect(interaction.currentTarget)}
      onPointerEnter={() => void import("./acquisition-calendar-event-detail")}
      type="button"
    >
      <span className={styles.eventStatus} aria-hidden="true">
        <i />
      </span>
      <span className={styles.eventCopy}>
        <time dateTime={event.eventAt}>{formatEventTime(event.eventAt).replace(" UTC", "")}</time>
        <strong>{event.title}</strong>
        <small>{event.subtitle ?? (event.kind === "movie" ? "Movie" : "Episode")}</small>
      </span>
      <span className={styles.eventKind} aria-hidden="true">
        {event.kind === "movie" ? <Film size={15} /> : <Tv size={15} />}
      </span>
    </button>
  );
}

function WeekGrid({
  events,
  interactive,
  onSelect,
  range,
}: {
  events: AcquisitionCalendarEvent[];
  interactive: boolean;
  onSelect: (event: AcquisitionCalendarEvent, trigger: HTMLButtonElement) => void;
  range: AcquisitionCalendarRange;
}) {
  const today = dayKey(new Date());
  const days = dayDates(range);
  const grouped = new Map<string, AcquisitionCalendarEvent[]>();
  for (const event of events) {
    const list = grouped.get(dayKey(event.eventAt)) ?? [];
    list.push(event);
    grouped.set(dayKey(event.eventAt), list);
  }

  return (
    <section className={styles.weekPanel} aria-labelledby="week-grid-title">
      <header className={styles.sectionHeading}>
        <div>
          <p className="section-kicker">Normalized arrivals</p>
          <h2 id="week-grid-title">Week at a glance</h2>
        </div>
        <span aria-label={`${events.length} visible events`}>
          {String(events.length).padStart(2, "0")}
        </span>
      </header>
      <div
        className={styles.weekGrid}
        onKeyDown={(event) => handleDirectionalFocus(event, { axis: "grid" })}
      >
        {days.map((day) => {
          const key = dayKey(day);
          const items = grouped.get(key) ?? [];
          const headingId = `calendar-day-${key}`;
          const weekday = new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC",
            weekday: "short",
          }).format(day);
          const month = new Intl.DateTimeFormat("en-US", {
            month: "short",
            timeZone: "UTC",
          }).format(day);
          return (
            <section
              aria-label={`${weekday} ${month} ${day.getUTCDate()}`}
              className={styles.dayColumn}
              data-today={key === today || undefined}
              key={key}
            >
              <header>
                <span>{weekday}</span>
                <strong id={headingId}>{day.getUTCDate()}</strong>
                <small>{month}</small>
              </header>
              <div className={styles.dayEvents}>
                {items.length > 0 ? (
                  items.map((event) => (
                    <EventCard
                      event={event}
                      interactive={interactive}
                      key={event.id}
                      onSelect={(trigger) => onSelect(event, trigger)}
                    />
                  ))
                ) : (
                  <span className={styles.quietDay}>
                    <i aria-hidden="true" /> Quiet
                  </span>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function SourcePanel({ calendar }: { calendar: AcquisitionCalendarResponse }) {
  return (
    <aside className={styles.sourcePanel} aria-labelledby="calendar-sources-title">
      <header className={styles.sectionHeading}>
        <div>
          <p className="section-kicker">Source plane</p>
          <h2 id="calendar-sources-title">Coverage</h2>
        </div>
        <ServerCog aria-hidden="true" size={20} />
      </header>
      <div className={styles.sourceList}>
        {calendar.sources.map((source) => (
          <article data-status={source.status} key={source.id}>
            <span aria-hidden="true">
              {source.service === "radarr" ? <Film size={17} /> : <Tv size={17} />}
            </span>
            <div>
              <h3>{source.displayName}</h3>
              <p>{source.service === "radarr" ? "Movie releases" : "Episode premieres"}</p>
            </div>
            <strong>{source.status === "healthy" ? "Connected" : "Offline"}</strong>
            <small>
              {source.status === "healthy"
                ? `${source.eventCount} on this page`
                : source.failure?.retryable
                  ? "Retrying safely"
                  : "Check configuration"}
            </small>
          </article>
        ))}
      </div>
      <div className={styles.sourceBoundary}>
        <Eye aria-hidden="true" size={18} />
        <p>
          <strong>Opaque by design</strong>
          <span>Only normalized timing and display metadata cross the browser boundary.</span>
        </p>
      </div>
    </aside>
  );
}

function UnconfiguredCalendar() {
  return (
    <section className={styles.unconfigured}>
      <span aria-hidden="true">
        <Unplug />
      </span>
      <p className="section-kicker">No validated sources</p>
      <h2>Connect your release horizon.</h2>
      <p>
        Validate and enable Radarr or Sonarr to map monitored movie releases and episode premieres
        into one private week view.
      </p>
      <Link className={styles.primaryAction} href="/settings/connectors">
        Configure services
      </Link>
    </section>
  );
}

export function ReadyCalendar({
  calendar,
  canLoadMore,
  embedded = false,
  filter,
  hideHero = false,
  interactive = true,
  isFetching,
  isFetchingNextPage,
  onFilter,
  onLoadMore,
  onNavigate,
  onRefresh,
  onSearch,
  query,
  range,
  refreshAvailable,
  stale,
}: {
  calendar: AcquisitionCalendarResponse;
  canLoadMore: boolean;
  embedded?: boolean;
  filter: CalendarFilter;
  hideHero?: boolean;
  interactive?: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  onFilter: (filter: CalendarFilter) => void;
  onLoadMore: () => void;
  onNavigate: (action: "next" | "previous" | "today") => void;
  onRefresh: () => void;
  onSearch: (value: string) => void;
  query: string;
  range: AcquisitionCalendarRange;
  refreshAvailable: boolean;
  stale: boolean;
}) {
  const [selected, setSelected] = useState<AcquisitionCalendarEvent | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocusPending = useRef(false);
  const selectEvent = useCallback((event: AcquisitionCalendarEvent, trigger: HTMLButtonElement) => {
    returnFocus.current = trigger;
    setSelected(event);
  }, []);
  const closeEvent = useCallback(() => {
    restoreFocusPending.current = true;
    setSelected(null);
  }, []);
  useEffect(() => {
    if (selected !== null || !restoreFocusPending.current) return;
    restoreFocusPending.current = false;
    const focusTask = globalThis.setTimeout(() =>
      returnFocus.current?.focus({ preventScroll: true }),
    );
    return () => globalThis.clearTimeout(focusTask);
  }, [selected]);
  const visibleEvents = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return calendar.events.filter((event) => {
      const matchesText =
        !term ||
        [event.title, event.subtitle, event.sourceName].some((value) =>
          value?.toLocaleLowerCase().includes(term),
        );
      const matchesFilter =
        filter === "all" ||
        (filter === "movies" && event.kind === "movie") ||
        (filter === "episodes" && event.kind === "episode") ||
        (filter === "attention" && ["missing", "queued"].includes(event.availability));
      return matchesText && matchesFilter;
    });
  }, [calendar.events, filter, query]);
  const filtered = filter !== "all" || query.trim().length > 0;
  const attention = calendar.summary.missing + calendar.summary.queued;

  const content = (
    <>
      {hideHero ? null : (
        <section className={styles.hero} aria-labelledby="acquisition-calendar-title">
          <div>
            <p className="eyebrow">Release observatory · UTC</p>
            <h1 id="acquisition-calendar-title">See what arrives next.</h1>
            <p>
              One verified horizon across movie releases and episode premieres—quiet when the stack
              is calm, precise when timing matters.
            </p>
          </div>
          <div
            className={styles.heroLens}
            data-attention={attention > 0 || undefined}
            data-liquid-glass
          >
            <span aria-hidden="true">
              {attention > 0 ? <CircleAlert size={20} /> : <CalendarClock size={20} />}
            </span>
            <div>
              <strong>
                {attention > 0
                  ? `${attention} ${attention === 1 ? "arrival needs" : "arrivals need"} attention`
                  : `${calendar.summary.total} arrivals mapped`}
              </strong>
              <small>{formatWeek(range)}</small>
            </div>
          </div>
        </section>
      )}

      {calendar.state === "unconfigured" ? (
        <UnconfiguredCalendar />
      ) : (
        <>
          <div className={styles.commandGlass} data-liquid-glass>
            <div className={styles.weekNavigation}>
              <button
                aria-label="Previous week"
                disabled={!refreshAvailable}
                onClick={() => onNavigate("previous")}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={18} />
              </button>
              <button
                disabled={!refreshAvailable}
                onClick={() => onNavigate("today")}
                type="button"
              >
                Today
              </button>
              <button
                aria-label="Next week"
                disabled={!refreshAvailable}
                onClick={() => onNavigate("next")}
                type="button"
              >
                <ChevronRight aria-hidden="true" size={18} />
              </button>
            </div>
            <label className={styles.searchControl}>
              <span className="sr-only">Search calendar</span>
              <Search aria-hidden="true" size={17} />
              <input
                autoComplete="off"
                disabled={!interactive}
                onChange={(event) => onSearch(event.target.value)}
                placeholder="Find a title or source"
                type="search"
                value={query}
              />
            </label>
            <div aria-label="Filter calendar" className={styles.filters} role="group">
              {FILTERS.map(({ icon: Icon, label, value }) => (
                <button
                  aria-label={label}
                  aria-pressed={filter === value}
                  data-selected={filter === value || undefined}
                  disabled={!interactive}
                  key={value}
                  onClick={() => onFilter(value)}
                  type="button"
                >
                  <Icon aria-hidden="true" size={14} /> <span>{label}</span>
                </button>
              ))}
            </div>
            <button
              aria-label="Refresh acquisition calendar"
              className={styles.refresh}
              disabled={!refreshAvailable || isFetching}
              onClick={onRefresh}
              type="button"
            >
              {isFetching ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={17} />
              ) : (
                <RefreshCw aria-hidden="true" size={17} />
              )}
            </button>
          </div>

          {calendar.state === "degraded" ? (
            <div className={styles.degradedNotice} role="status">
              <CircleAlert aria-hidden="true" size={19} />
              <span>
                <strong>Partial horizon</strong>One source is unavailable. Verified arrivals from
                healthy services remain visible.
              </span>
            </div>
          ) : null}
          {stale ? (
            <div className={styles.staleNotice} role="status">
              <CloudOff aria-hidden="true" size={18} />
              <span>
                <strong>Live refresh interrupted</strong>Showing the last verified calendar.
                Monitoring was not changed.
              </span>
            </div>
          ) : null}
          {calendar.sourceTruncated ? (
            <div className={styles.truncatedNotice} role="status">
              <Layers3 aria-hidden="true" size={18} />A source returned more events than this
              bounded view can safely display.
            </div>
          ) : null}

          <section className={styles.metrics} aria-label="Acquisition calendar summary">
            <Metric
              detail={`${calendar.summary.available} already available`}
              icon={Film}
              label="Movies"
              value={String(calendar.summary.movies).padStart(2, "0")}
            />
            <Metric
              detail="premieres this week"
              icon={Tv}
              label="Episodes"
              value={String(calendar.summary.episodes).padStart(2, "0")}
            />
            <Metric
              detail={`${calendar.summary.queued} queued`}
              icon={Timer}
              label="Monitored"
              state="good"
              value={String(
                calendar.summary.total - calendar.summary.available - calendar.summary.missing,
              ).padStart(2, "0")}
            />
            <Metric
              detail={attention > 0 ? "missing or queued" : "no exceptions"}
              icon={attention > 0 ? CircleAlert : Check}
              label="Attention"
              state={attention > 0 ? "attention" : "good"}
              value={String(attention).padStart(2, "0")}
            />
          </section>

          {calendar.events.length === 0 && !filtered ? (
            <section className={styles.emptyCalendar} role="status">
              <span aria-hidden="true">
                <CalendarClock />
              </span>
              <h2>The horizon is clear.</h2>
              <p>No monitored movies or episodes are scheduled in this week.</p>
            </section>
          ) : (
            <div className={styles.workspace}>
              <div>
                <WeekGrid
                  events={visibleEvents}
                  interactive={interactive}
                  onSelect={selectEvent}
                  range={range}
                />
                {visibleEvents.length === 0 && filtered ? (
                  <div className={styles.filteredEmpty} role="status">
                    <ListFilter aria-hidden="true" size={19} />
                    <span>
                      <strong>No arrivals match this view</strong>Adjust the filter or search to
                      restore the week.
                    </span>
                  </div>
                ) : null}
                {canLoadMore ? (
                  <button
                    className={styles.loadMore}
                    disabled={isFetchingNextPage}
                    onClick={onLoadMore}
                    type="button"
                  >
                    {isFetchingNextPage ? (
                      <LoaderCircle aria-hidden="true" className={styles.spinner} size={17} />
                    ) : (
                      <Layers3 aria-hidden="true" size={17} />
                    )}
                    {isFetchingNextPage ? "Mapping more arrivals" : "Load more arrivals"}
                  </button>
                ) : null}
              </div>
              <SourcePanel calendar={calendar} />
            </div>
          )}
          <footer className={styles.pageFooter}>
            <span>
              <Clock3 aria-hidden="true" size={14} /> Verified{" "}
              {formatVerifiedAt(calendar.generatedAt)}
            </span>
            <span>Read-only timing · UTC</span>
          </footer>
        </>
      )}
      {selected ? <EventDetail event={selected} onClose={closeEvent} /> : null}
    </>
  );
  return embedded ? content : <PageFrame>{content}</PageFrame>;
}

function StaticCalendarContent({
  embedded = false,
  hideHero = false,
  outcome,
}: {
  embedded?: boolean;
  hideHero?: boolean;
  outcome: AcquisitionCalendarLoadOutcome;
}) {
  const [range] = useState<AcquisitionCalendarRange>(() =>
    outcome.status === "ready"
      ? { endAt: outcome.calendar.endAt, limit: 100, startAt: outcome.calendar.startAt }
      : currentWeek(),
  );
  const [filter, setFilter] = useState<CalendarFilter>("all");
  const [search, setSearch] = useState("");
  const hydrated = useSyncExternalStore(subscribeToHydration, clientHydrated, serverHydrated);
  if (outcome.status !== "ready")
    return <BoundaryState embedded={embedded} status={outcome.status} />;

  return (
    <ReadyCalendar
      calendar={outcome.calendar}
      canLoadMore={false}
      embedded={embedded}
      filter={filter}
      hideHero={hideHero}
      interactive={hydrated}
      isFetching={false}
      isFetchingNextPage={false}
      onFilter={setFilter}
      onLoadMore={() => undefined}
      onNavigate={() => undefined}
      onRefresh={() => undefined}
      onSearch={setSearch}
      query={search}
      range={range}
      refreshAvailable={false}
      stale={false}
    />
  );
}

export function AcquisitionCalendar({
  client = acquisitionCalendarClient,
  embedded = false,
  hideHero = false,
  initialOutcome,
  live,
}: AcquisitionCalendarProperties) {
  if (live ?? initialOutcome === undefined) {
    const Calendar = embedded ? EmbeddedLiveCalendar : LiveCalendar;
    return (
      <Calendar
        client={client}
        embedded={embedded}
        hideHero={hideHero}
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
        {...(live === undefined ? {} : { live })}
      />
    );
  }
  return initialOutcome ? (
    <StaticCalendarContent embedded={embedded} hideHero={hideHero} outcome={initialOutcome} />
  ) : (
    <LoadingState embedded={embedded} />
  );
}
