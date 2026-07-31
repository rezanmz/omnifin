import type { Metadata } from "next";

import { RecoveryBootstrapEntry } from "../../components/recovery-bootstrap-entry";
import "../globals.css";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Recovery access",
};

interface RecoveryPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

function singleParameter(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

export default async function RecoveryPage({ searchParams }: RecoveryPageProperties) {
  const parameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const testView = singleParameter(parameters["test-view"]);
  if (testView === "bootstrap") {
    return (
      <RecoveryBootstrapEntry
        initialProof={{ csrfToken: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG" }}
      />
    );
  }
  const initialState =
    testView === "denied"
      ? "denied"
      : testView === "rate-limited"
        ? "rate_limited"
        : testView === "unavailable"
          ? "unavailable"
          : testView === "entry"
            ? "idle"
            : undefined;
  return <RecoveryBootstrapEntry {...(initialState ? { initialState } : {})} />;
}
