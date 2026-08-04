import type { Metadata } from "next";

import { ViewingHistory } from "../../../components/viewing-history";
import {
  demoViewingHistory,
  emptyViewingHistory,
  unavailableViewingHistory,
} from "../../../lib/viewing-history-demo";
import type { ViewingHistoryLoadOutcome } from "../../../lib/viewing-history";
import "../../dashboard.css";
import "../../globals.css";

export const metadata: Metadata = { title: "Viewing history" };
export const dynamic = "force-dynamic";

interface ViewingHistoryPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

export default async function ViewingHistoryPage({ searchParams }: ViewingHistoryPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedView = Array.isArray(testParameters["test-view"])
    ? testParameters["test-view"][0]
    : testParameters["test-view"];
  const initialOutcome: ViewingHistoryLoadOutcome | undefined =
    requestedView === "ready"
      ? { history: demoViewingHistory, status: "ready" }
      : requestedView === "empty"
        ? { history: emptyViewingHistory, status: "ready" }
        : requestedView === "unavailable"
          ? { history: unavailableViewingHistory, status: "ready" }
          : requestedView === "forbidden" ||
              requestedView === "signed_out" ||
              requestedView === "loading"
            ? { status: requestedView }
            : process.env.OMNIFIN_DEMO_MODE === "true"
              ? { history: demoViewingHistory, status: "ready" }
              : undefined;

  return (
    <ViewingHistory {...(initialOutcome === undefined ? {} : { initialOutcome, live: false })} />
  );
}
