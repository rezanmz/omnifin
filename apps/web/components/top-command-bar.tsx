"use client";

import type { ServiceStatus } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { ConnectionPulse } from "./connection-pulse";
import { GlobalSearch } from "./global-search";

export function TopCommandBar({ connectionStatus }: { connectionStatus: ServiceStatus }) {
  return (
    <header
      className="top-command-bar"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "horizontal" })}
    >
      <GlobalSearch />
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
