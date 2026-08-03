"use client";

import { createContext, type ReactNode, useContext, useEffect } from "react";

import type { ServiceStatus } from "../lib/dashboard-data";
import type { ApplicationDestination } from "../lib/application-shell-route";
import type { ThemePreference } from "../lib/theme";
import { ApplicationShellEnhancements } from "./application-shell-enhancements";

const DEFAULT_ACCENT = "#8de9d5";
const ApplicationShellEnhancementContext = createContext(true);
export const APPLICATION_SHELL_STATUS_ATTRIBUTE = "data-connection-status";

export function ApplicationShellEnhancementBoundary({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  return (
    <ApplicationShellEnhancementContext.Provider value={enabled}>
      {children}
    </ApplicationShellEnhancementContext.Provider>
  );
}

export function ApplicationShellContent({
  accent = DEFAULT_ACCENT,
  children,
  current,
  displayProfile = "standard",
  status,
  themePreference = "system",
}: {
  accent?: string;
  children: ReactNode;
  current: ApplicationDestination;
  displayProfile?: "standard" | "ten-foot";
  status: ServiceStatus;
  themePreference?: ThemePreference;
}) {
  const enhancementEnabled = useContext(ApplicationShellEnhancementContext);

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

  return (
    <>
      {enhancementEnabled ? (
        <ApplicationShellEnhancements
          initialCurrent={current}
          initialPreference={themePreference}
        />
      ) : null}
      {children}
    </>
  );
}
