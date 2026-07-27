import { OnboardingDashboard } from "../../components/onboarding-dashboard";
import type { Metadata } from "next";
import "./onboarding.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Welcome" };

interface OnboardingPageProperties {
  searchParams: Promise<{ "test-profile"?: string | string[] }>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProperties) {
  const parameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" || parameters["test-profile"] === "ten-foot"
      ? "ten-foot"
      : "standard";

  return <OnboardingDashboard displayProfile={displayProfile} />;
}
