import type { Metadata } from "next";

import { AccountSecurityPanel } from "../../components/account-security-panel";

export const metadata: Metadata = { title: "Account & access" };
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  return <AccountSecurityPanel displayProfile={displayProfile} />;
}
