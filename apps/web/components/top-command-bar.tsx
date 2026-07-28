"use client";

import type { ServiceStatus } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { ConnectionPulse } from "./connection-pulse";
import { GlobalSearchLoader } from "./global-search-loader";
import { ProfileMenu } from "./profile-menu";

export function TopCommandBar({ connectionStatus }: { connectionStatus: ServiceStatus }) {
  return (
    <header
      className="top-command-bar"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "horizontal" })}
    >
      <GlobalSearchLoader />
      <div className="top-command-bar__actions" data-liquid-glass>
        <ConnectionPulse status={connectionStatus} />
        <ProfileMenu />
      </div>
    </header>
  );
}
