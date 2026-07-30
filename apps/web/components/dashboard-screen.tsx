import type { CSSProperties } from "react";
import type { DiscoveryFeedResponse } from "@omnifin/contracts/discovery";

import type { DashboardModel, DisplayProfile, ServiceStatus } from "../lib/dashboard-data";
import { CalendarStrip } from "./calendar-strip";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { DashboardState, type DashboardStateKind } from "./dashboard-state";
import { DiscoveryDashboard } from "./discovery-dashboard";
import { HeroSpotlight } from "./hero-spotlight";
import { LazyContinueWatchingRail } from "./lazy-continue-watching-rail";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { MediaRail } from "./media-rail";
import { MobileNavigation, NavigationRail } from "./navigation-rail";
import { OperationsDock } from "./operations-dock";
import { TopCommandBar } from "./top-command-bar";

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
    <div
      className="application-frame"
      data-display-profile={displayProfile}
      style={{ "--ambient-accent": data.hero.accent } as AmbientStyle}
    >
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <NavigationRail />
      <div className="application-shell">
        <TopCommandBar connectionStatus={aggregateStatus(data.services)} />
        <main className="dashboard" id="main-content" tabIndex={-1}>
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
      </div>
      <MobileNavigation />
    </div>
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
    <div className="application-frame" data-display-profile={displayProfile}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <NavigationRail />
      <div className="application-shell">
        <TopCommandBar connectionStatus={connectionStatus} />
        <main className="dashboard" id="main-content" tabIndex={-1}>
          <DashboardState kind={kind} />
        </main>
      </div>
      <MobileNavigation />
    </div>
  );
}
