import type { Metadata } from "next";

import { ApplicationShellEnhancements } from "../../../../components/application-shell-enhancements";
import { MediaIssueWorkbench } from "../../../../components/media-issue-workbench";
import { ThemeProvider } from "../../../../components/theme-provider";
import {
  degradedMediaIssueOutcome,
  emptyMediaIssueOutcome,
  readyMediaIssueOutcome,
} from "../../../../lib/media-issues-demo";
import type { MediaIssueLoadOutcome } from "../../../../lib/media-issues";
import { readThemePreference } from "../../../../lib/theme-server";
import "../../../globals.css";

export const metadata: Metadata = { title: "Issue workbench" };
export const dynamic = "force-dynamic";

interface MediaIssuePageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const boundaryStates = new Set<MediaIssueLoadOutcome["status"]>([
  "forbidden",
  "signed_out",
  "unavailable",
]);

export default async function MediaIssuePage({ searchParams }: MediaIssuePageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedView = Array.isArray(testParameters["test-view"])
    ? testParameters["test-view"][0]
    : testParameters["test-view"];
  const initialOutcome =
    requestedView === "ready"
      ? readyMediaIssueOutcome
      : requestedView === "empty"
        ? emptyMediaIssueOutcome
        : requestedView === "degraded"
          ? degradedMediaIssueOutcome
          : requestedView && boundaryStates.has(requestedView as MediaIssueLoadOutcome["status"])
            ? ({ status: requestedView } as MediaIssueLoadOutcome)
            : undefined;
  const preference = await readThemePreference();

  return (
    <>
      <ApplicationShellEnhancements initialPreference={preference} />
      <ThemeProvider initialPreference={preference}>
        <MediaIssueWorkbench {...(initialOutcome === undefined ? {} : { initialOutcome })} />
      </ThemeProvider>
    </>
  );
}
