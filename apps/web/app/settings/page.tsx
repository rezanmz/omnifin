import type { Metadata } from "next";

import { AccountSecurityPanel } from "../../components/account-security-panel";

export const metadata: Metadata = { title: "Account & access" };
export const dynamic = "force-dynamic";

interface SettingsPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

export default async function SettingsPage({ searchParams }: SettingsPageProperties) {
  const parameters = await searchParams;
  const providerLogoutConfirmation =
    process.env.OMNIFIN_TEST_MODE === "true" && parameters["test-view"] === "provider-logout";
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  return (
    <AccountSecurityPanel
      displayProfile={displayProfile}
      initialConfirmation={providerLogoutConfirmation ? "provider" : null}
    />
  );
}
