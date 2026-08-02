import { OnboardingDashboard } from "../../components/onboarding-dashboard";
import type { Metadata } from "next";
import { ThemeProvider } from "../../components/theme-provider";
import type { SetupReadinessDemoView } from "../../lib/setup-readiness-demo";
import type { StackVerificationDemoView } from "../../lib/stack-verification-demo";
import { readThemePreference } from "../../lib/theme-server";
import "./onboarding.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Welcome" };

interface OnboardingPageProperties {
  searchParams: Promise<{
    "test-profile"?: string | string[];
    "test-view"?: string | string[];
    "test-verification"?: string | string[];
  }>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProperties) {
  const parameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const testView =
    typeof parameters["test-view"] === "string" ? parameters["test-view"] : undefined;
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" || parameters["test-profile"] === "ten-foot"
      ? "ten-foot"
      : "standard";
  const verificationView =
    typeof parameters["test-verification"] === "string"
      ? parameters["test-verification"]
      : undefined;
  const demoViews = new Set([
    "deployment-attention",
    "deployment-unavailable",
    "forbidden",
    "needs-core",
    "partial",
    "provider-unavailable",
    "ready",
    "signed-out",
    "unavailable",
  ]);
  const initialOutcome =
    testView && demoViews.has(testView)
      ? (await import("../../lib/setup-readiness-demo")).setupReadinessDemo(
          testView as SetupReadinessDemoView,
        )
      : undefined;
  const verificationViews = new Set(["attention", "ready", "unconfigured"]);
  const initialVerificationOutcome =
    verificationView && verificationViews.has(verificationView)
      ? {
          report: (await import("../../lib/stack-verification-demo")).stackVerificationDemo(
            verificationView as StackVerificationDemoView,
          ),
          status: "ready" as const,
        }
      : undefined;
  const preference = await readThemePreference();

  return (
    <ThemeProvider initialPreference={preference}>
      <OnboardingDashboard
        displayProfile={displayProfile}
        {...(initialOutcome ? { initialOutcome } : {})}
        {...(initialVerificationOutcome ? { initialVerificationOutcome } : {})}
      />
    </ThemeProvider>
  );
}
