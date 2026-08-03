import type { CSSProperties, ReactNode } from "react";

import type { ThemePreference } from "../lib/theme";
import { ApplicationShellEnhancements } from "./application-shell-enhancements";
import { ApplicationShellStatus } from "./application-shell-status";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { GlobalSearchLoader } from "./global-search-loader";
import { MobileNavigation, NavigationRail } from "./navigation-rail";
import { ProfileMenuLoader } from "./profile-menu-loader";

const DEFAULT_ACCENT = "#8de9d5";
type ShellStyle = CSSProperties & { "--ambient-accent": string };

function PersistentTopCommandBar({ themePreference }: { themePreference: ThemePreference }) {
  return (
    <header className="top-command-bar" data-shell-directional-axis="horizontal">
      <GlobalSearchLoader />
      <div className="top-command-bar__actions" data-liquid-glass>
        <ApplicationShellStatus />
        <ProfileMenuLoader initialPreference={themePreference} />
      </div>
    </header>
  );
}

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
      data-theme-preference={themePreference}
      style={{ "--ambient-accent": DEFAULT_ACCENT } as ShellStyle}
    >
      <ApplicationShellEnhancements />
      <CinematicBackdrop />
      <NavigationRail current={null} />
      <div className="application-shell">
        <PersistentTopCommandBar themePreference={themePreference} />
        {children}
      </div>
      <MobileNavigation current={null} />
    </div>
  );
}
