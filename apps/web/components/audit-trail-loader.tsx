"use client";

import dynamic from "next/dynamic";

import { useIdleRender } from "../lib/use-idle-render";
import type { AuditTrailProperties } from "./audit-trail";
import styles from "./audit-trail.module.css";

function AuditTrailSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading operator audit trail"
      className={styles.ledger}
      data-liquid-glass
      role="status"
    >
      <div className={`${styles.filters} ${styles.skeleton}`} />
      <div className={styles.skeletonRows}>
        {Array.from({ length: 5 }, (_, index) => (
          <div className={styles.skeletonRow} key={index} />
        ))}
      </div>
    </section>
  );
}

const LazyAuditTrail = dynamic(
  () => import("./audit-trail").then((module_) => module_.AuditTrail),
  { loading: AuditTrailSkeleton, ssr: false },
);

export function AuditTrailLoader(properties: AuditTrailProperties) {
  const ready = useIdleRender(800);
  return ready ? <LazyAuditTrail {...properties} /> : <AuditTrailSkeleton />;
}
