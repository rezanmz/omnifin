"use client";

import dynamic from "next/dynamic";

import { useIdleRender } from "../lib/use-idle-render";
import type { AcquisitionCalendarProperties } from "./acquisition-calendar";
import styles from "./acquisition-calendar.module.css";

function AcquisitionCalendarSkeleton() {
  return (
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
}

const LazyAcquisitionCalendar = dynamic(
  () => import("./acquisition-calendar").then((module_) => module_.AcquisitionCalendar),
  { loading: AcquisitionCalendarSkeleton, ssr: false },
);

export function AcquisitionCalendarLoader(properties: AcquisitionCalendarProperties) {
  const ready = useIdleRender();
  return ready ? <LazyAcquisitionCalendar {...properties} /> : <AcquisitionCalendarSkeleton />;
}
