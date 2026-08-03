import type { CSSProperties, ReactNode } from "react";

import type { ThemePreference } from "../lib/theme";
import { ApplicationShellNavigation } from "./application-shell-navigation";
import { ApplicationShellStatus } from "./application-shell-status";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { TopCommandBar } from "./top-command-bar";

const DEFAULT_ACCENT = "#8de9d5";
type ShellStyle = CSSProperties & { "--ambient-accent": string };

export function ApplicationShellFrame({
  children,
  themePreference,
}: {
  children: ReactNode;
  themePreference: ThemePreference;
}) {
  return (
    <div
      className="application-frame"
      data-connection-status="attention"
      data-display-profile="standard"
      style={{ "--ambient-accent": DEFAULT_ACCENT } as ShellStyle}
    >
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <ApplicationShellNavigation />
      <div className="application-shell">
        <TopCommandBar
          connectionIndicator={<ApplicationShellStatus />}
          connectionStatus="attention"
          themePreference={themePreference}
        />
        {children}
      </div>
      <ApplicationShellNavigation mobile />
    </div>
  );
}
