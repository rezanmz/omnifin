"use client";

import dynamic from "next/dynamic";

import { useIdleRender } from "../lib/use-idle-render";
import type { UserAccessControlProperties } from "./user-access-control";
import styles from "./user-access-control.module.css";

function UserAccessControlSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading user access administration"
      className={styles.console}
      role="status"
    >
      <div className={`${styles.userRail} ${styles.skeleton}`} />
      <div className={`${styles.workspace} ${styles.skeleton}`} />
    </section>
  );
}

const LazyUserAccessControl = dynamic(
  () => import("./user-access-control").then((module_) => module_.UserAccessControl),
  { loading: UserAccessControlSkeleton, ssr: false },
);

export function UserAccessControlLoader(properties: UserAccessControlProperties) {
  const ready = useIdleRender(800);
  return ready ? <LazyUserAccessControl {...properties} /> : <UserAccessControlSkeleton />;
}
