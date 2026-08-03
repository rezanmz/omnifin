import type { Metadata } from "next";

import { MediaLibrary } from "../../../components/media-library";
import {
  emptyMediaLibraryOutcome,
  readyMediaLibraryOutcome,
  unavailableMediaLibraryOutcome,
} from "../../../lib/media-library-demo";
import type { MediaLibraryLoadOutcome } from "../../../lib/media-library";
import { readThemePreference } from "../../../lib/theme-server";
import "../../dashboard.css";
import "../../globals.css";

export const metadata: Metadata = { title: "Library" };
export const dynamic = "force-dynamic";

interface LibraryPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

export default async function LibraryPage({ searchParams }: LibraryPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedView = Array.isArray(testParameters["test-view"])
    ? testParameters["test-view"][0]
    : testParameters["test-view"];
  const initialOutcome: MediaLibraryLoadOutcome | undefined =
    requestedView === "ready"
      ? readyMediaLibraryOutcome
      : requestedView === "empty"
        ? emptyMediaLibraryOutcome
        : requestedView === "unavailable"
          ? unavailableMediaLibraryOutcome
          : requestedView === "forbidden" ||
              requestedView === "signed_out" ||
              requestedView === "loading"
            ? { status: requestedView }
            : process.env.OMNIFIN_DEMO_MODE === "true"
              ? readyMediaLibraryOutcome
              : undefined;
  const preference = await readThemePreference();

  return (
    <MediaLibrary
      {...(initialOutcome === undefined ? {} : { initialOutcome, live: false })}
      themePreference={preference}
    />
  );
}
