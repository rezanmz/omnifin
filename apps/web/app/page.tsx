import { DashboardScreen, DashboardStateScreen } from "../components/dashboard-screen";
import type { DashboardStateKind } from "../components/dashboard-state";
import { connectedDashboard, demoDashboard } from "../lib/dashboard-data";
import { demoDiscoveryFeed } from "../lib/discovery-feed-demo";
import { readThemePreference } from "../lib/theme-server";
import "./dashboard.css";

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

export default async function DashboardPage({ searchParams }: DashboardPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedTestView = testParameters["test-view"];
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    testParameters["test-profile"] === "ten-foot"
      ? "ten-foot"
      : "standard";
  const showLiveDashboard = requestedTestView === "continue-watching-live";
  const showDiscoveryPerformanceProfile = requestedTestView === "discovery-performance";
  const showDemoDashboard =
    requestedTestView === "onboarding" || showLiveDashboard || showDiscoveryPerformanceProfile
      ? false
      : process.env.OMNIFIN_DEMO_MODE === "true";

  if (requestedTestView && dashboardStateKinds.has(requestedTestView as DashboardStateKind)) {
    const preference = await readThemePreference();
    return (
      <DashboardStateScreen
        displayProfile={displayProfile}
        kind={requestedTestView as DashboardStateKind}
        themePreference={preference}
      />
    );
  }

  if (requestedTestView === "quiet") {
    const preference = await readThemePreference();
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
        themePreference={preference}
      />
    );
  }

  const preference = await readThemePreference();
  return (
    <DashboardScreen
      data={showDemoDashboard ? demoDashboard : connectedDashboard}
      {...(showDiscoveryPerformanceProfile
        ? {
            discoveryInitialFeed: demoDiscoveryFeed,
            discoveryRefresh: false,
            discoveryShowContinueWatching: false,
          }
        : {})}
      displayProfile={displayProfile}
      liveContinueWatching={showLiveDashboard || !showDemoDashboard}
      liveDiscovery={!showDemoDashboard}
      themePreference={preference}
    />
  );
}
