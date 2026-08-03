import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StandaloneApplicationShell from "../../../components/standalone-application-shell";
import ViewingHistoryPage from "./page";

function historyScreen(content: React.ReactNode) {
  return (
    <StandaloneApplicationShell
      accent="#6f8d84"
      current="library"
      displayProfile="standard"
      status="attention"
      themePreference="system"
    >
      {content}
    </StandaloneApplicationShell>
  );
}

describe("ViewingHistoryPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders deterministic private history only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");
    render(
      historyScreen(
        await ViewingHistoryPage({ searchParams: Promise.resolve({ "test-view": "ready" }) }),
      ),
    );

    expect(screen.getByRole("heading", { name: "Your story, in sequence." })).toBeVisible();
    expect(screen.getByText("Ember Coast")).toBeVisible();
    expect(screen.getByText("Only you")).toBeVisible();
  });

  it("renders a geometry-preserving loading state for the live route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(historyScreen(await ViewingHistoryPage({ searchParams: Promise.resolve({}) })));
    expect(screen.getByRole("heading", { name: "Replaying your recent signals…" })).toBeVisible();
  });
});
