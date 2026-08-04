"use client";

import { useEffect } from "react";

import type { ServiceStatus } from "../lib/dashboard-data";
import { APPLICATION_SHELL_STATUS_ATTRIBUTE } from "./application-shell-contract";

const AMBIENT_SURFACES =
  ".cinematic-backdrop, .navigation-rail, .mobile-navigation, .top-command-bar";

export function ApplicationShellContentEffect({
  accent,
  displayProfile,
  status,
}: {
  accent: string;
  displayProfile: "standard" | "ten-foot";
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
    for (const surface of frame.querySelectorAll<HTMLElement>(AMBIENT_SURFACES)) {
      surface.style.setProperty("--ambient-accent", accent);
    }
  }, [accent, displayProfile, status]);

  return null;
}
