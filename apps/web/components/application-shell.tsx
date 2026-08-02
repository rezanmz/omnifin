"use client";

import { usePathname } from "next/navigation";
import { type CSSProperties, type ReactNode, useEffect } from "react";

import type { ServiceStatus } from "../lib/dashboard-data";
import {
  routeUsesApplicationShell,
  type ApplicationDestination,
} from "../lib/application-shell-route";
import type { ThemePreference } from "../lib/theme";

const DEFAULT_ACCENT = "#8de9d5";
type ShellStyle = CSSProperties & { "--ambient-accent": string };
export const APPLICATION_SHELL_STATUS_ATTRIBUTE = "data-connection-status";

export function ApplicationShellBoundary({
  backdrop,
  children,
  environment,
  mobileNavigation,
  navigation,
  topCommandBar,
}: {
  backdrop: ReactNode;
  children: ReactNode;
  environment: ReactNode;
  mobileNavigation: ReactNode;
  navigation: ReactNode;
  topCommandBar: ReactNode;
}) {
  const pathname = usePathname();

  if (!routeUsesApplicationShell(pathname)) return children;

  return (
    <div
      className="application-frame"
      data-connection-status="attention"
      data-display-profile="standard"
      style={{ "--ambient-accent": DEFAULT_ACCENT } as ShellStyle}
    >
      {environment}
      {backdrop}
      {navigation}
      <div className="application-shell">
        {topCommandBar}
        {children}
      </div>
      {mobileNavigation}
    </div>
  );
}

export function ApplicationShellContent({
  accent = DEFAULT_ACCENT,
  children,
  displayProfile = "standard",
  status,
}: {
  accent?: string;
  children: ReactNode;
  current: ApplicationDestination;
  displayProfile?: "standard" | "ten-foot";
  status: ServiceStatus;
  themePreference?: ThemePreference;
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
