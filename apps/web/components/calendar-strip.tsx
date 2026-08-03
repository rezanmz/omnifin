import {
  CalendarClock,
  CalendarOff,
  CalendarRange,
  CloudOff,
  LockKeyhole,
  RefreshCw,
  Settings2,
} from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";

import type { CalendarItemModel } from "../lib/dashboard-data";
import { DirectionalNavigationGroup } from "./directional-navigation-group";

type CalendarStyle = CSSProperties & { "--calendar-accent": string };
export type CalendarStripState =
  "forbidden" | "loading" | "ready" | "signed_out" | "unavailable" | "unconfigured";

const STATE_COPY = {
  forbidden: {
    detail: "Your account cannot inspect acquisition timing.",
    icon: LockKeyhole,
    title: "Calendar access is restricted",
  },
  signed_out: {
    detail: "Sign in again to restore your private release schedule.",
    icon: LockKeyhole,
    title: "Calendar access is restricted",
  },
  unavailable: {
    detail: "Discover remains available while Omnifin reconnects to Radarr and Sonarr.",
    icon: CloudOff,
    title: "Release timing is unavailable",
  },
  unconfigured: {
    detail: "Connect Radarr or Sonarr to bring upcoming releases into this dashboard.",
    icon: Settings2,
    title: "Calendar sources are not set up",
  },
} as const;

function CalendarLoadingState() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading this week’s releases"
      className="calendar-strip__grid calendar-strip__grid--loading"
      role="status"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <span aria-hidden="true" className="calendar-item calendar-item--loading" key={index}>
          <span className="calendar-item__loading-day" />
          <span className="calendar-item__loading-marker" />
          <span className="calendar-item__loading-copy">
            <span />
            <span />
          </span>
        </span>
      ))}
      <span className="sr-only">Loading this week’s releases…</span>
    </div>
  );
}

function CalendarBoundary({
  onRetry,
  state,
}: {
  onRetry?: () => void;
  state: Exclude<CalendarStripState, "loading" | "ready">;
}) {
  const copy = STATE_COPY[state];
  const Icon = copy.icon;
  return (
    <div className="quiet-state quiet-state--calendar" data-severity="warning" role="status">
      <span className="quiet-state__icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="quiet-state__copy">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </span>
      {state === "unavailable" && onRetry ? (
        <button
          className="button button--glass quiet-state__action"
          onClick={onRetry}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={16} /> Retry calendar
        </button>
      ) : state === "unconfigured" ? (
        <Link className="button button--glass quiet-state__action" href="/settings/connectors">
          Configure services
        </Link>
      ) : state === "signed_out" ? (
        <Link className="button button--glass quiet-state__action" href="/login">
          Sign in
        </Link>
      ) : null}
    </div>
  );
}

export function CalendarStrip({
  degraded = false,
  items,
  onRetry,
  state = "ready",
}: {
  degraded?: boolean;
  items: CalendarItemModel[];
  onRetry?: () => void;
  state?: CalendarStripState;
}) {
  return (
    <section className="calendar-strip" aria-labelledby="upcoming-heading">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Release cadence</p>
          <h2 id="upcoming-heading">This week</h2>
        </div>
        {state === "ready" && items.length > 0 ? (
          <Link className="icon-text-action" href="/calendar" prefetch={false}>
            <CalendarRange aria-hidden="true" size={17} /> Open calendar
          </Link>
        ) : null}
      </div>
      {state === "loading" ? (
        <CalendarLoadingState />
      ) : state !== "ready" ? (
        <CalendarBoundary {...(onRetry ? { onRetry } : {})} state={state} />
      ) : items.length > 0 ? (
        <>
          <DirectionalNavigationGroup axis="grid" className="calendar-strip__grid">
            {items.map((item) => (
              <Link
                aria-label={`Open ${item.title} in calendar`}
                className="calendar-item"
                data-directional-item
                href="/calendar"
                key={item.id}
                prefetch={false}
                style={{ "--calendar-accent": item.accent } as CalendarStyle}
              >
                <span className="calendar-item__day">{item.day}</span>
                <span className="calendar-item__marker" aria-hidden="true" />
                <span className="calendar-item__copy">
                  <strong>{item.title}</strong>
                  <span>{item.service}</span>
                </span>
              </Link>
            ))}
          </DirectionalNavigationGroup>
          {degraded ? (
            <p className="calendar-strip__notice" role="status">
              <CalendarClock aria-hidden="true" size={15} /> Showing available events; one or more
              calendar sources could not be reached.
            </p>
          ) : null}
        </>
      ) : (
        <div className="quiet-state quiet-state--calendar" role="status">
          <span className="quiet-state__icon" aria-hidden="true">
            <CalendarOff size={20} />
          </span>
          <span className="quiet-state__copy">
            <strong>No arrivals scheduled</strong>
            <span>Upcoming episodes and requested releases will appear here.</span>
          </span>
        </div>
      )}
    </section>
  );
}
