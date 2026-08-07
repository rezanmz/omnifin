import type { Metadata } from "next";

import { SavedLibrary } from "../../../components/saved-library";
import { emptySavedPage, readySavedOutcome, readySavedPage } from "../../../lib/saved-lists-demo";
import "../../dashboard.css";
import "../../globals.css";

export const metadata: Metadata = { title: "Saved" };
export const dynamic = "force-dynamic";

interface SavedPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

export default async function SavedPage({ searchParams }: SavedPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedView = Array.isArray(testParameters["test-view"])
    ? testParameters["test-view"][0]
    : testParameters["test-view"];
  if (requestedView === "signed_out" || requestedView === "forbidden") {
    return <SavedLibrary initialOutcome={{ status: requestedView }} live={false} />;
  }
  if (requestedView === "unavailable") {
    return <SavedLibrary initialOutcome={{ status: "unavailable" }} live={false} />;
  }
  if (requestedView === "ready" || process.env.OMNIFIN_DEMO_MODE === "true") {
    return (
      <SavedLibrary
        demo
        initialOutcome={readySavedOutcome}
        initialPage={requestedView === "empty" ? emptySavedPage : readySavedPage}
        live={false}
      />
    );
  }
  if (requestedView === "empty") {
    return (
      <SavedLibrary
        demo
        initialOutcome={readySavedOutcome}
        initialPage={emptySavedPage}
        live={false}
      />
    );
  }
  return <SavedLibrary />;
}
