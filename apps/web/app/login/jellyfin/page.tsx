import type { Metadata } from "next";

import { JellyfinCredentialScreen } from "../../../components/jellyfin-credential-screen";

export const metadata: Metadata = { title: "Sign in with Jellyfin" };

interface JellyfinLoginPageProperties {
  searchParams: Promise<{ "test-profile"?: string | string[]; "test-view"?: string | string[] }>;
}

function singleParameter(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

export default async function JellyfinLoginPage({ searchParams }: JellyfinLoginPageProperties) {
  const parameters = await searchParams;
  const testMode = process.env.OMNIFIN_TEST_MODE === "true";
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    (testMode && singleParameter(parameters["test-profile"]) === "ten-foot")
      ? "ten-foot"
      : "standard";
  const testView = testMode ? singleParameter(parameters["test-view"]) : undefined;
  const initialStatus =
    testView === "invalid-credentials"
      ? "invalid_credentials"
      : testView === "unavailable"
        ? "unavailable"
        : testView === "submitting"
          ? "submitting"
          : "idle";

  return <JellyfinCredentialScreen displayProfile={displayProfile} initialStatus={initialStatus} />;
}
