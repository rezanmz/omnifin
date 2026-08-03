import type { CSSProperties, ReactNode } from "react";

import type { ThemePreference } from "../lib/theme";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { ConnectionPulse } from "./connection-pulse";
import { MobileNavigation, NavigationRail } from "./navigation-rail";
import { ShellIcon } from "./shell-icon";

const DEFAULT_ACCENT = "#8de9d5";
type ShellStyle = CSSProperties & { "--ambient-accent": string };

function PersistentTopCommandBar() {
  return (
    <header className="top-command-bar" data-shell-directional-axis="horizontal">
      <div className="shell-search-slot">
        <div
          aria-hidden="true"
          className="global-search"
          data-liquid-glass
          data-shell-placeholder="search"
        >
          <ShellIcon
            aria-hidden="true"
            className="global-search__icon"
            name="search"
            size={18}
            strokeWidth={1.7}
          />
          <label className="sr-only" htmlFor="global-search-shell-placeholder">
            Search media and commands
          </label>
          <input
            aria-autocomplete="list"
            aria-controls="global-search-results"
            aria-expanded="false"
            aria-haspopup="listbox"
            aria-keyshortcuts="Meta+K Control+K"
            autoComplete="off"
            data-directional-item
            disabled
            id="global-search-shell-placeholder"
            placeholder="Search everything…"
            role="combobox"
            type="text"
          />
          <kbd className="global-search__shortcut">
            <span aria-hidden="true">⌘</span> K
          </kbd>
        </div>
        <div className="shell-search-slot__mount" data-shell-mount="search" />
      </div>
      <div className="top-command-bar__actions" data-liquid-glass>
        <div aria-hidden="true" data-shell-placeholder="status">
          <ConnectionPulse status="attention" />
        </div>
        <div data-shell-mount="status" />
        <div aria-hidden="true" className="profile-menu" data-shell-placeholder="profile">
          <button
            aria-expanded="false"
            aria-haspopup="dialog"
            aria-label="Open profile menu"
            className="user-avatar"
            data-directional-item
            disabled
            type="button"
          >
            <span aria-hidden="true">RN</span>
          </button>
        </div>
        <div data-shell-mount="profile" />
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
      <CinematicBackdrop />
      <NavigationRail current={null} />
      <div className="application-shell">
        <PersistentTopCommandBar />
        {children}
      </div>
      <MobileNavigation current={null} />
    </div>
  );
}
