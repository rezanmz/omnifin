import { ApplicationShellContent } from "../../components/application-shell";
import { DashboardScreen, DashboardStateScreen } from "../../components/dashboard-screen";
import { DeferredDiscoveryDashboard } from "../../components/deferred-discovery-dashboard";
import { DiscoveryHeroActions } from "../../components/discovery-hero-actions";
import { HeroSpotlight } from "../../components/hero-spotlight";
import type { DashboardStateKind } from "../../components/dashboard-state";
import { connectedDashboard, demoDashboard, type DashboardModel } from "../../lib/dashboard-data";
import { demoDiscoveryFeed } from "../../lib/discovery-feed-demo";
import { discoverySpotlightHero, discoverySpotlightItem } from "../../lib/discovery-presentation";
import "../dashboard.css";

const DEMO_HERO_ARTWORK_PATH = "/demo-hero.svg";

export const dynamic = "force-dynamic";

interface DashboardPageProperties {
  searchParams: Promise<{ "test-profile"?: string; "test-view"?: string }>;
}

const dashboardStateKinds = new Set<DashboardStateKind>([
  "empty",
  "loading",
  "offline",
  "permission-denied",
  "recoverable-error",
  "stale",
  "terminal-error",
  "unsupported",
]);

function queueRecoveryTestDashboard(): DashboardModel {
  return {
    ...demoDashboard,
    operations: demoDashboard.operations.map((operation, operationIndex) => {
      const provenance = operation.provenance;
      const event = provenance?.events[0];
      if (operationIndex !== 0 || !provenance || !event) return operation;
      return {
        ...operation,
        provenance: {
          ...provenance,
          events: [
            {
              ...event,
              id: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
              kind: "stalled",
              recovery: {
                expiresAt: "2099-07-27T19:05:00.000Z",
                reference: `aqr_v2.${"A".repeat(100)}`,
              },
              state: "warning",
              summary: "Download needs operator attention before import can continue.",
            },
            ...provenance.events.slice(1),
          ],
        },
      };
    }),
  };
}

export default async function DashboardPage({ searchParams }: DashboardPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedTestView = testParameters["test-view"];
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    testParameters["test-profile"] === "ten-foot"
      ? "ten-foot"
      : "standard";
  const showLiveDashboard = requestedTestView === "continue-watching-live";
  const showQueueRecoveryDashboard = requestedTestView === "queue-recovery";
  const showDiscoveryPerformanceProfile = requestedTestView === "discovery-performance";
  const showDemoDashboard =
    requestedTestView === "onboarding" || showLiveDashboard || showDiscoveryPerformanceProfile
      ? false
      : process.env.OMNIFIN_DEMO_MODE === "true";

  if (requestedTestView === "route-error") {
    throw new Error("Deterministic browser-only route failure");
  }

  if (requestedTestView && dashboardStateKinds.has(requestedTestView as DashboardStateKind)) {
    return (
      <DashboardStateScreen
        displayProfile={displayProfile}
        kind={requestedTestView as DashboardStateKind}
      />
    );
  }

  if (requestedTestView === "quiet") {
    return (
      <DashboardScreen
        data={{
          ...demoDashboard,
          calendar: [],
          continueWatching: [],
          discovery: [],
          operations: [],
        }}
        displayProfile={displayProfile}
      />
    );
  }

  if (showDiscoveryPerformanceProfile) {
    const spotlight = discoverySpotlightItem(demoDiscoveryFeed);
    if (spotlight) {
      return (
        <ApplicationShellContent accent={discoverySpotlightHero(spotlight).accent} status="healthy">
          <main className="dashboard" id="main-content">
            <HeroSpotlight
              actionRegion={<DiscoveryHeroActions item={spotlight} />}
              artworkPath={spotlight.artwork.backdropPath ?? spotlight.artwork.posterPath}
              hero={discoverySpotlightHero(spotlight)}
            />
            <DeferredDiscoveryDashboard initialFeed={demoDiscoveryFeed} />
          </main>
        </ApplicationShellContent>
      );
    }
  }
  const dashboardData = showQueueRecoveryDashboard
    ? queueRecoveryTestDashboard()
    : showDemoDashboard
      ? demoDashboard
      : connectedDashboard;
  return (
    <DashboardScreen
      data={dashboardData}
      {...(showDiscoveryPerformanceProfile
        ? {
            discoveryInitialFeed: demoDiscoveryFeed,
            discoveryRefresh: false,
            discoveryShowContinueWatching: false,
          }
        : {})}
      displayProfile={displayProfile}
      demoSections={showDemoDashboard}
      {...(showDemoDashboard ? { heroArtworkPath: DEMO_HERO_ARTWORK_PATH } : {})}
      liveContinueWatching={
        showLiveDashboard || (!showDemoDashboard && !showQueueRecoveryDashboard)
      }
      liveCalendar={
        !showDemoDashboard && !showQueueRecoveryDashboard && !showDiscoveryPerformanceProfile
      }
      liveDiscovery={!showDemoDashboard && !showQueueRecoveryDashboard}
    />
  );
}
