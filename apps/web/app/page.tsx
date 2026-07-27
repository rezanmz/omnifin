import { DashboardScreen, DashboardStateScreen } from "../components/dashboard-screen";
import type { DashboardStateKind } from "../components/dashboard-state";
import { OnboardingDashboard } from "../components/onboarding-dashboard";
import { ThemeProvider } from "../components/theme-provider";
import { demoDashboard } from "../lib/dashboard-data";
import { readThemePreference } from "../lib/theme-server";

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
  const showDemoDashboard =
    requestedTestView === "onboarding" ? false : process.env.OMNIFIN_DEMO_MODE === "true";

  if (requestedTestView && dashboardStateKinds.has(requestedTestView as DashboardStateKind)) {
    const preference = await readThemePreference();
    return (
      <ThemeProvider initialPreference={preference}>
        <DashboardStateScreen
          displayProfile={displayProfile}
          kind={requestedTestView as DashboardStateKind}
        />
      </ThemeProvider>
    );
  }

  if (requestedTestView === "quiet") {
    const preference = await readThemePreference();
    return (
      <ThemeProvider initialPreference={preference}>
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
      </ThemeProvider>
    );
  }

  if (!showDemoDashboard) return <OnboardingDashboard displayProfile={displayProfile} />;

  const preference = await readThemePreference();
  return (
    <ThemeProvider initialPreference={preference}>
      <DashboardScreen data={demoDashboard} displayProfile={displayProfile} />
    </ThemeProvider>
  );
}
