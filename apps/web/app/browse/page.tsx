import type { Metadata } from "next";

import { discoveryBrowseQuerySchema } from "@omnifin/contracts/discovery";

import { DiscoveryBrowser } from "../../components/discovery-browser";
import { demoBrowseResponse, emptyBrowseResponse } from "../../lib/discovery-browse-demo";
import { readThemePreference } from "../../lib/theme-server";
import "../dashboard.css";
import "../globals.css";

export const metadata: Metadata = { title: "Browse" };
export const dynamic = "force-dynamic";

interface BrowsePageProperties {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BrowsePage({ searchParams }: BrowsePageProperties) {
  const parameters = await searchParams;
  const testView =
    process.env.OMNIFIN_TEST_MODE === "true"
      ? Array.isArray(parameters["test-view"])
        ? parameters["test-view"][0]
        : parameters["test-view"]
      : undefined;
  const raw = Object.fromEntries(
    Object.entries(parameters).flatMap(([key, value]) => {
      if (key === "test-view") return [];
      const first = Array.isArray(value) ? value[0] : value;
      return first === undefined ? [] : [[key, first]];
    }),
  );
  const parsed = discoveryBrowseQuerySchema.safeParse({ locale: "en", ...raw });
  const initialCriteria = parsed.success
    ? parsed.data
    : discoveryBrowseQuerySchema.parse({ kind: raw.kind === "series" ? "series" : "movie" });
  const testResponse =
    testView === "ready"
      ? demoBrowseResponse
      : testView === "empty"
        ? emptyBrowseResponse
        : undefined;
  const demoResponse =
    testView === undefined && process.env.OMNIFIN_DEMO_MODE === "true"
      ? demoBrowseResponse
      : undefined;
  const initialResponse = testResponse ?? demoResponse;
  const freezeFixture = testView === "loading" || demoResponse !== undefined;
  const preference = await readThemePreference();
  return (
    <DiscoveryBrowser
      initialCriteria={initialResponse?.criteria ?? initialCriteria}
      {...(initialResponse === undefined ? {} : { initialResponse })}
      invalidCriteria={!parsed.success}
      {...(freezeFixture ? { live: false } : {})}
      themePreference={preference}
    />
  );
}
