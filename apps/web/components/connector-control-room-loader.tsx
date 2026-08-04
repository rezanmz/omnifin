"use client";

import dynamic from "next/dynamic";

import { useIdleRender } from "../lib/use-idle-render";
import type { ConnectorControlRoomProperties } from "./connector-control-room";
import styles from "./connector-control-room.module.css";

function ConnectorControlRoomSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading service connections"
      className={styles.console}
      role="status"
    >
      <div className={`${styles.serviceRail} ${styles.skeleton}`} />
      <div className={`${styles.workspace} ${styles.skeleton}`} />
    </section>
  );
}

const LazyConnectorControlRoom = dynamic(
  () => import("./connector-control-room").then((module_) => module_.ConnectorControlRoom),
  { loading: ConnectorControlRoomSkeleton, ssr: false },
);

export function ConnectorControlRoomLoader(properties: ConnectorControlRoomProperties) {
  const ready = useIdleRender(properties.initialOutcome === undefined ? 800 : 0);
  return ready ? <LazyConnectorControlRoom {...properties} /> : <ConnectorControlRoomSkeleton />;
}
