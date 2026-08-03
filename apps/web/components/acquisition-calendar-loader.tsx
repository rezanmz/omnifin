"use client";

import dynamic from "next/dynamic";

import { useIdleRender } from "../lib/use-idle-render";
import type { AcquisitionCalendarProperties } from "./acquisition-calendar";
import styles from "./acquisition-calendar-loader.module.css";

function AcquisitionCalendarSkeleton({ hideHero = false }: { hideHero?: boolean }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading acquisition calendar"
      className={styles.loading}
      data-hide-hero={hideHero || undefined}
      role="status"
    >
      {hideHero ? null : (
        <div className={styles.loadingHero}>
          <i />
          <b />
          <span />
        </div>
      )}
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
}

const LazyAcquisitionCalendar = dynamic(
  () => import("./acquisition-calendar").then((module_) => module_.AcquisitionCalendar),
  { loading: () => <AcquisitionCalendarSkeleton /> },
);

export function AcquisitionCalendarLoader(properties: AcquisitionCalendarProperties) {
  const ready = useIdleRender(800);
  return ready ? (
    <LazyAcquisitionCalendar {...properties} />
  ) : (
    <AcquisitionCalendarSkeleton hideHero={properties.hideHero === true} />
  );
}
