"use client";

import type { DashboardModel } from "../lib/dashboard-data";
import { CalendarStrip } from "./calendar-strip";
import { LazyContinueWatchingRail } from "./lazy-continue-watching-rail";
import { MediaRail } from "./media-rail";
import { OperationsDock } from "./operations-dock";

export interface DashboardSectionsProperties {
  calendar: DashboardModel["calendar"];
  continueWatching: DashboardModel["continueWatching"];
  discovery: DashboardModel["discovery"];
  liveContinueWatching?: boolean;
  operations: DashboardModel["operations"];
  showMedia?: boolean;
}

export function DashboardSections({
  calendar,
  continueWatching,
  discovery,
  liveContinueWatching = false,
  operations,
  showMedia = true,
}: DashboardSectionsProperties) {
  return (
    <>
      {showMedia ? (
        <>
          {liveContinueWatching ? (
            <LazyContinueWatchingRail />
          ) : (
            <MediaRail items={continueWatching} title="Continue watching" />
          )}
          <MediaRail items={discovery} title="Made for tonight" />
        </>
      ) : null}
      <CalendarStrip items={calendar} />
      <OperationsDock operations={operations} />
    </>
  );
}
