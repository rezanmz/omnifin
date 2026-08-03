import type { Metadata } from "next";

import { RequestReview } from "../../../../components/request-review";
import { ThemeProvider } from "../../../../components/theme-provider";
import {
  emptyRequestReviewOutcome,
  readyRequestReviewOutcome,
} from "../../../../lib/request-review-demo";
import type { RequestReviewLoadOutcome } from "../../../../lib/request-review";
import { readThemePreference } from "../../../../lib/theme-server";
import "../../../globals.css";

export const metadata: Metadata = { title: "Request review" };
export const dynamic = "force-dynamic";

interface RequestReviewPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const boundaryStates = new Set<RequestReviewLoadOutcome["status"]>([
  "forbidden",
  "not_configured",
  "signed_out",
  "unavailable",
]);

export default async function RequestReviewPage({ searchParams }: RequestReviewPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedView = Array.isArray(testParameters["test-view"])
    ? testParameters["test-view"][0]
    : testParameters["test-view"];
  const initialOutcome =
    requestedView === "ready"
      ? readyRequestReviewOutcome
      : requestedView === "empty"
        ? emptyRequestReviewOutcome
        : requestedView && boundaryStates.has(requestedView as RequestReviewLoadOutcome["status"])
          ? ({ status: requestedView } as RequestReviewLoadOutcome)
          : undefined;
  const preference = await readThemePreference();

  return (
    <>
      <ThemeProvider initialPreference={preference}>
        <RequestReview {...(initialOutcome === undefined ? {} : { initialOutcome })} />
      </ThemeProvider>
    </>
  );
}
