import type { ReactNode } from "react";

import type { ThemePreference } from "../lib/theme";
import { ApplicationShellBoundary } from "./application-shell";
import { ApplicationShellNavigation } from "./application-shell-navigation";
import { ApplicationShellStatus } from "./application-shell-status";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { TopCommandBar } from "./top-command-bar";

export function ApplicationShellFrame({
  children,
  themePreference,
}: {
  children: ReactNode;
  themePreference: ThemePreference;
}) {
  return (
    <ApplicationShellBoundary
      backdrop={<CinematicBackdrop />}
      environment={<LiquidGlassEnvironment />}
      mobileNavigation={<ApplicationShellNavigation mobile />}
      navigation={<ApplicationShellNavigation />}
      topCommandBar={
        <TopCommandBar
          connectionIndicator={<ApplicationShellStatus />}
          connectionStatus="attention"
          themePreference={themePreference}
        />
      }
    >
      {children}
    </ApplicationShellBoundary>
  );
}
