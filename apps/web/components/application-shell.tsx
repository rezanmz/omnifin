"use client";

import { type ReactNode, useEffect } from "react";

import type { ServiceStatus } from "../lib/dashboard-data";

const DEFAULT_ACCENT = "#8de9d5";
export const APPLICATION_SHELL_STATUS_ATTRIBUTE = "data-connection-status";

export function ApplicationShellContent({
  accent = DEFAULT_ACCENT,
  children,
  displayProfile = "standard",
  status,
}: {
  accent?: string;
  children: ReactNode;
  displayProfile?: "standard" | "ten-foot";
  status: ServiceStatus;
}) {
  useEffect(() => {
    const frame = document.querySelector<HTMLElement>(".application-frame");
    if (!frame) return;

    if (frame.dataset.displayProfile !== displayProfile) {
      frame.dataset.displayProfile = displayProfile;
    }
    if (frame.getAttribute(APPLICATION_SHELL_STATUS_ATTRIBUTE) !== status) {
      frame.setAttribute(APPLICATION_SHELL_STATUS_ATTRIBUTE, status);
    }
    for (const surface of frame.querySelectorAll<HTMLElement>(
      ".cinematic-backdrop, .navigation-rail, .mobile-navigation, .top-command-bar",
    )) {
      surface.style.setProperty("--ambient-accent", accent);
    }
  }, [accent, displayProfile, status]);

  return children;
}
