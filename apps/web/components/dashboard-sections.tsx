"use client";

import type { AcquisitionCalendarClient } from "../lib/acquisition-calendar";
import type { DashboardModel } from "../lib/dashboard-data";
import { DashboardCalendarStrip } from "./dashboard-calendar-strip";
import { LazyContinueWatchingRail } from "./lazy-continue-watching-rail";
import { MediaRail } from "./media-rail";
import { OperationsDock } from "./operations-dock";

export interface DashboardSectionsProperties {
  calendar: DashboardModel["calendar"];
  calendarClient?: AcquisitionCalendarClient;
  continueWatching: DashboardModel["continueWatching"];
  discovery: DashboardModel["discovery"];
  liveCalendar?: boolean;
  liveContinueWatching?: boolean;
  operations: DashboardModel["operations"];
  showMedia?: boolean;
}

export function DashboardSections({
  calendar,
  calendarClient,
  continueWatching,
  discovery,
  liveCalendar = false,
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
      <DashboardCalendarStrip
        {...(calendarClient === undefined ? {} : { client: calendarClient })}
        fallbackItems={calendar}
        live={liveCalendar}
      />
      <OperationsDock operations={operations} />
    </>
  );
}
