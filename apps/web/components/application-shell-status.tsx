"use client";

import { useApplicationShellSignal } from "./application-shell";
import { ConnectionPulse } from "./connection-pulse";

export function ApplicationShellStatus() {
  return <ConnectionPulse status={useApplicationShellSignal().status} />;
}
