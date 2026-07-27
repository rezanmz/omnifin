"use client";

import type { ServiceStatus } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { ConnectionPulse } from "./connection-pulse";
import { GlobalSearch } from "./global-search";
import { ProfileMenu } from "./profile-menu";

export function TopCommandBar({ connectionStatus }: { connectionStatus: ServiceStatus }) {
  return (
    <header
      className="top-command-bar"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "horizontal" })}
    >
      <GlobalSearch />
      <div className="top-command-bar__actions">
        <ConnectionPulse status={connectionStatus} />
        <ProfileMenu />
      </div>
    </header>
  );
}
