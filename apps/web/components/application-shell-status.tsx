"use client";

import { useLayoutEffect, useState } from "react";

import type { ServiceStatus } from "../lib/dashboard-data";
import { APPLICATION_SHELL_STATUS_ATTRIBUTE } from "./application-shell-contract";
import { ConnectionPulse } from "./connection-pulse";

export function ApplicationShellStatus() {
  const [status, setStatus] = useState<ServiceStatus>("attention");

  useLayoutEffect(() => {
    const frame = document.querySelector<HTMLElement>(".application-frame");
    if (!frame) return;

    const update = () => {
      const nextStatus = frame.getAttribute(APPLICATION_SHELL_STATUS_ATTRIBUTE);
      if (nextStatus === "attention" || nextStatus === "healthy" || nextStatus === "offline") {
        setStatus(nextStatus);
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(frame, {
      attributeFilter: [APPLICATION_SHELL_STATUS_ATTRIBUTE],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);

  return <ConnectionPulse status={status} />;
}
