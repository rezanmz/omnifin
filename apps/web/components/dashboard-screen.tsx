import type { CSSProperties } from "react";
import type { DiscoveryFeedResponse } from "@omnifin/contracts/discovery";

import type { AcquisitionCalendarClient } from "../lib/acquisition-calendar";
import type { DashboardModel, DisplayProfile, ServiceStatus } from "../lib/dashboard-data";
import { ApplicationShellContent } from "./application-shell";
import { DashboardState, type DashboardStateKind } from "./dashboard-state";
import { DeferredDashboardSections } from "./deferred-dashboard-sections";
import { DeferredDemoDashboardSections } from "./deferred-demo-dashboard-sections";
import { DeferredDiscoveryDashboard } from "./deferred-discovery-dashboard";
import { HeroSpotlight } from "./hero-spotlight";

function aggregateStatus(services: DashboardModel["services"]): ServiceStatus {
  if (services.some(({ status }) => status === "offline")) return "offline";
  if (services.some(({ status }) => status === "attention")) return "attention";
  return "healthy";
}

type AmbientStyle = CSSProperties & { "--ambient-accent": string };

export function DashboardScreen({
  calendarClient,
  data,
  discoveryInitialFeed,
  discoveryRefresh = true,
  discoveryShowContinueWatching = true,
  demoSections = false,
  displayProfile = "standard",
  heroArtworkPath,
  liveContinueWatching = false,
  liveCalendar = false,
  liveDiscovery = false,
}: {
  calendarClient?: AcquisitionCalendarClient;
  data: DashboardModel;
  discoveryInitialFeed?: DiscoveryFeedResponse;
  discoveryRefresh?: boolean;
  discoveryShowContinueWatching?: boolean;
  demoSections?: boolean;
  displayProfile?: DisplayProfile;
  heroArtworkPath?: string;
  liveContinueWatching?: boolean;
  liveCalendar?: boolean;
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
          <DeferredDiscoveryDashboard
            {...(discoveryInitialFeed === undefined ? {} : { initialFeed: discoveryInitialFeed })}
            live={discoveryRefresh}
            showContinueWatching={discoveryShowContinueWatching}
            suppressHero={false}
          />
        ) : (
          <HeroSpotlight
            {...(heroArtworkPath === undefined ? {} : { artworkPath: heroArtworkPath })}
            hero={data.hero}
          />
        )}
        {demoSections ? (
          <DeferredDemoDashboardSections />
        ) : (
          <DeferredDashboardSections
            calendar={data.calendar}
            {...(calendarClient === undefined ? {} : { calendarClient })}
            continueWatching={data.continueWatching}
            discovery={data.discovery}
            liveCalendar={liveCalendar}
            liveContinueWatching={liveContinueWatching}
            operations={data.operations}
            showMedia={!liveDiscovery}
          />
        )}
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
