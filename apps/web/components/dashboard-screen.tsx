import type { CSSProperties } from "react";

import type { DashboardModel, DisplayProfile, ServiceStatus } from "../lib/dashboard-data";
import { CalendarStrip } from "./calendar-strip";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { DashboardState, type DashboardStateKind } from "./dashboard-state";
import { HeroSpotlight } from "./hero-spotlight";
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
  displayProfile = "standard",
}: {
  data: DashboardModel;
  displayProfile?: DisplayProfile;
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
          <HeroSpotlight hero={data.hero} />
          <MediaRail items={data.continueWatching} title="Continue watching" />
          <MediaRail items={data.discovery} title="Made for tonight" />
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
