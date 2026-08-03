import type { RuntimeIdentity } from "@omnifin/contracts/runtime";
import type { Metadata } from "next";

import { AboutScreen } from "../../../components/about-screen";
import { ThemeProvider } from "../../../components/theme-provider";
import { loadRuntimeIdentity, type RuntimeIdentityLoadOutcome } from "../../../lib/runtime-identity";
import { readThemePreference } from "../../../lib/theme-server";
import "../../globals.css";

export const metadata: Metadata = { title: "About & build identity" };
export const dynamic = "force-dynamic";

const testRevision = "0123456789abcdef0123456789abcdef01234567";
const verifiedTestIdentity: RuntimeIdentity = {
  channel: "stable",
  license: "AGPL-3.0-only",
  revision: testRevision,
  schemaVersion: 1,
  sourceUrl: `https://github.com/rezanmz/omnifin/tree/${testRevision}`,
  verification: "verified",
  version: "1.0.0",
};
const developmentTestIdentity: RuntimeIdentity = {
  channel: "development",
  license: "AGPL-3.0-only",
  revision: null,
  schemaVersion: 1,
  sourceUrl: "https://github.com/rezanmz/omnifin",
  verification: "development",
  version: "0.0.0-dev",
};

interface AboutPageProperties {
  searchParams: Promise<{
    "test-profile"?: string | string[];
    "test-view"?: string | string[];
  }>;
}

function testOutcome(view: string | string[] | undefined): RuntimeIdentityLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (view === "verified") return { identity: verifiedTestIdentity, status: "ready" };
  if (view === "development") return { identity: developmentTestIdentity, status: "ready" };
  if (view === "unavailable") return { status: "unavailable" };
  return undefined;
}

export default async function AboutPage({ searchParams }: AboutPageProperties) {
  const parameters = await searchParams;
  const testMode = process.env.OMNIFIN_TEST_MODE === "true";
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    (testMode && parameters["test-profile"] === "ten-foot")
      ? "ten-foot"
      : "standard";
  const outcome =
    testOutcome(parameters["test-view"]) ??
    (await loadRuntimeIdentity({
      gatewayUrl: process.env.OMNIFIN_GATEWAY_URL ?? "http://127.0.0.1:4000",
    }));
  const preference = await readThemePreference();

  return (
    <>
      <ThemeProvider initialPreference={preference}>
        <AboutScreen displayProfile={displayProfile} embedded outcome={outcome} />
      </ThemeProvider>
    </>
  );
}
