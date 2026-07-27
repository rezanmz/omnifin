import type { Metadata } from "next";

import {
  JellyfinCredentialScreen,
  type PairingSessionOutcome,
} from "../../../components/jellyfin-credential-screen";
import "../../globals.css";

export const metadata: Metadata = { title: "Link Jellyfin" };

interface JellyfinLinkPageProperties {
  searchParams: Promise<{ "test-profile"?: string | string[]; "test-view"?: string | string[] }>;
}

function singleParameter(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

export default async function JellyfinLinkPage({ searchParams }: JellyfinLinkPageProperties) {
  const parameters = await searchParams;
  const testMode = process.env.OMNIFIN_TEST_MODE === "true";
  const testView = testMode ? singleParameter(parameters["test-view"]) : undefined;
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    (testMode && singleParameter(parameters["test-profile"]) === "ten-foot")
      ? "ten-foot"
      : "standard";
  const initialPairingSession: PairingSessionOutcome | undefined =
    !testMode || testView === "live-session"
      ? undefined
      : testView === "session-expired"
        ? { status: "signed_out" }
        : testView === "ineligible"
          ? { status: "ineligible" }
          : testView === "unavailable"
            ? { status: "unavailable" }
            : {
                csrfToken: "visual_pairing_csrf_token_0123456789abcdefghij",
                status: "ready",
              };
  const quickConnectView = testView === "quick-connect";

  return (
    <JellyfinCredentialScreen
      autoPollQuickConnect={!quickConnectView}
      displayProfile={displayProfile}
      initialMethod={quickConnectView ? "quick-connect" : "password"}
      intent="pair"
      {...(initialPairingSession === undefined ? {} : { initialPairingSession })}
      {...(quickConnectView
        ? {
            initialNow: Date.parse("2026-07-26T12:00:00.000Z"),
            initialQuickConnectTransaction: {
              code: "CD-5678",
              expiresAt: "2026-07-26T12:05:00.000Z",
              pollAfterMs: 2_000,
              transactionId: "visual-pairing-quick-connect",
            },
          }
        : {})}
    />
  );
}
