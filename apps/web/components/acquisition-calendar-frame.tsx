import type { AcquisitionCalendarResponse } from "@omnifin/contracts/calendar";
import { CalendarClock, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import type { ThemePreference } from "../lib/theme";
import { AcquisitionCalendarTopbar } from "./acquisition-calendar-topbar";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { ThemeProvider } from "./theme-provider";
import styles from "./acquisition-calendar.module.css";

function formatWeek(calendar: AcquisitionCalendarResponse) {
  const start = new Date(calendar.startAt);
  const end = new Date(Date.parse(calendar.endAt) - 1);
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

export function AcquisitionCalendarFrame({
  children,
  initialPreference,
}: {
  children: ReactNode;
  initialPreference: ThemePreference;
}) {
  return (
    <div className={styles.layout}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <ThemeProvider initialPreference={initialPreference}>
          <AcquisitionCalendarTopbar />
        </ThemeProvider>
        {children}
      </main>
    </div>
  );
}

export function AcquisitionCalendarHero({ calendar }: { calendar: AcquisitionCalendarResponse }) {
  const attention = calendar.summary.missing + calendar.summary.queued;
  return (
    <section className={styles.hero} aria-labelledby="acquisition-calendar-title">
      <div>
        <p className="eyebrow">Release observatory · UTC</p>
        <h1 id="acquisition-calendar-title">See what arrives next.</h1>
        <p>
          One verified horizon across movie releases and episode premieres—quiet when the stack is
          calm, precise when timing matters.
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
          <small>{formatWeek(calendar)}</small>
        </div>
      </div>
    </section>
  );
}
