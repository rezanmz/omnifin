import type { Metadata } from "next";

import { LibraryCare } from "../../components/library-care";
import { ThemeProvider } from "../../components/theme-provider";
import { emptyLibraryOutcome, readyLibraryOutcome } from "../../lib/library-care-demo";
import type { LibraryLoadOutcome } from "../../lib/library-operations";
import { readThemePreference } from "../../lib/theme-server";
import "../globals.css";

export const metadata: Metadata = { title: "Library care" };
export const dynamic = "force-dynamic";

interface LibraryPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const boundaryStates = new Set<LibraryLoadOutcome["status"]>([
  "forbidden",
  "not_configured",
  "signed_out",
  "unavailable",
]);

export default async function LibraryPage({ searchParams }: LibraryPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedView = Array.isArray(testParameters["test-view"])
    ? testParameters["test-view"][0]
    : testParameters["test-view"];
  const initialOutcome =
    requestedView === "ready"
      ? readyLibraryOutcome
      : requestedView === "empty"
        ? emptyLibraryOutcome
        : requestedView && boundaryStates.has(requestedView as LibraryLoadOutcome["status"])
          ? ({ status: requestedView } as LibraryLoadOutcome)
          : undefined;
  const preference = await readThemePreference();

  return (
    <ThemeProvider initialPreference={preference}>
      <LibraryCare {...(initialOutcome === undefined ? {} : { initialOutcome })} />
    </ThemeProvider>
  );
}
