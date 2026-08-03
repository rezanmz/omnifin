import type { CSSProperties } from "react";
import type { DiscoveryFeedResponse } from "@omnifin/contracts/discovery";

import type { DashboardModel, DisplayProfile, ServiceStatus } from "../lib/dashboard-data";
import { CalendarStrip } from "./calendar-strip";
import { ApplicationShellContent } from "./application-shell";
import { DashboardState, type DashboardStateKind } from "./dashboard-state";
import { DiscoveryDashboard } from "./discovery-dashboard";
import { HeroSpotlight } from "./hero-spotlight";
import { LazyContinueWatchingRail } from "./lazy-continue-watching-rail";
import { MediaRail } from "./media-rail";
import { OperationsDock } from "./operations-dock";

function aggregateStatus(services: DashboardModel["services"]): ServiceStatus {
  if (services.some(({ status }) => status === "offline")) return "offline";
  if (services.some(({ status }) => status === "attention")) return "attention";
  return "healthy";
}

type AmbientStyle = CSSProperties & { "--ambient-accent": string };

export function DashboardScreen({
  data,
  discoveryInitialFeed,
  discoveryRefresh = true,
  discoveryShowContinueWatching = true,
  displayProfile = "standard",
  liveContinueWatching = false,
  liveDiscovery = false,
}: {
  data: DashboardModel;
  discoveryInitialFeed?: DiscoveryFeedResponse;
  discoveryRefresh?: boolean;
  discoveryShowContinueWatching?: boolean;
  displayProfile?: DisplayProfile;
  liveContinueWatching?: boolean;
  liveDiscovery?: boolean;
}) {
  return (
    <ApplicationShellContent
      accent={data.hero.accent}
      displayProfile={displayProfile}
      status={aggregateStatus(data.services)}
    >
      <main
        className="dashboard"
        id="main-content"
        style={{ "--ambient-accent": data.hero.accent } as AmbientStyle}
        tabIndex={-1}
      >
        {liveDiscovery ? (
          <DiscoveryDashboard
            {...(discoveryInitialFeed === undefined ? {} : { initialFeed: discoveryInitialFeed })}
            live={discoveryRefresh}
            showContinueWatching={discoveryShowContinueWatching}
          />
        ) : (
          <>
            <HeroSpotlight hero={data.hero} />
            {liveContinueWatching ? (
              <LazyContinueWatchingRail />
            ) : (
              <MediaRail items={data.continueWatching} title="Continue watching" />
            )}
            <MediaRail items={data.discovery} title="Made for tonight" />
          </>
        )}
        <CalendarStrip items={data.calendar} />
        <OperationsDock operations={data.operations} />
      </main>
    </ApplicationShellContent>
  );
}

export function DashboardStateScreen({
  displayProfile = "standard",
  kind,
}: {
  displayProfile?: DisplayProfile;
  kind: DashboardStateKind;
}) {
  const connectionStatus: ServiceStatus = kind === "offline" ? "offline" : "attention";
  return (
    <ApplicationShellContent displayProfile={displayProfile} status={connectionStatus}>
      <main className="dashboard" id="main-content" tabIndex={-1}>
        <DashboardState kind={kind} />
      </main>
    </ApplicationShellContent>
  );
}
