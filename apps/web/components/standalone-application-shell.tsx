"use client";

import type { CSSProperties, ReactNode } from "react";

import type { ServiceStatus } from "../lib/dashboard-data";
import type { ApplicationDestination } from "../lib/application-shell-route";
import type { ThemePreference } from "../lib/theme";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { MobileNavigation, NavigationRail } from "./navigation-rail";
import { TopCommandBar } from "./top-command-bar";

type ShellStyle = CSSProperties & { "--ambient-accent": string };

export default function StandaloneApplicationShell({
  accent,
  children,
  current,
  displayProfile,
  status,
  themePreference,
}: {
  accent: string;
  children: ReactNode;
  current: ApplicationDestination;
  displayProfile: "standard" | "ten-foot";
  status: ServiceStatus;
  themePreference: ThemePreference;
}) {
  return (
    <div
      className="application-frame"
      data-display-profile={displayProfile}
      style={{ "--ambient-accent": accent } as ShellStyle}
    >
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <NavigationRail current={current} />
      <div className="application-shell">
        <TopCommandBar connectionStatus={status} themePreference={themePreference} />
        {children}
      </div>
      <MobileNavigation current={current} />
    </div>
  );
}
