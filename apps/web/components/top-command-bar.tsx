"use client";

import { Command, Search } from "lucide-react";
import type { ServiceStatus } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { ConnectionPulse } from "./connection-pulse";

export function TopCommandBar({ connectionStatus }: { connectionStatus: ServiceStatus }) {
  return (
    <header
      className="top-command-bar"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "horizontal" })}
    >
      <div className="global-search">
        <Search aria-hidden="true" className="global-search__icon" size={18} strokeWidth={1.7} />
        <label className="sr-only" htmlFor="global-search">
          Search movies, series, people, and commands
        </label>
        <input
          autoComplete="off"
          data-directional-item
          id="global-search"
          name="search"
          placeholder="Search everything…"
          type="search"
        />
        <kbd className="global-search__shortcut">
          <Command aria-hidden="true" size={12} /> K
        </kbd>
      </div>
      <div className="top-command-bar__actions">
        <ConnectionPulse status={connectionStatus} />
        <button
          className="user-avatar"
          data-directional-item
          type="button"
          aria-label="Open profile menu"
        >
          <span aria-hidden="true">RN</span>
        </button>
      </div>
    </header>
  );
}
