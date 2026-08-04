import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StandaloneApplicationShell from "../../../components/standalone-application-shell";
import SavedPage from "./page";

function savedScreen(content: ReactNode) {
  return (
    <StandaloneApplicationShell
      accent="#84a8a0"
      current="saved"
      displayProfile="standard"
      status="healthy"
      themePreference="system"
    >
      {content}
    </StandaloneApplicationShell>
  );
}

describe("SavedPage", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders deterministic private shelves only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      savedScreen(await SavedPage({ searchParams: Promise.resolve({ "test-view": "ready" }) })),
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Keep the next story close." }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ember Coast" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Northern Lights" })).toBeVisible();
    for (const link of screen.getAllByRole("link", { name: "Saved" })) {
      expect(link).toHaveAttribute("aria-current", "page");
    }
  });

  it("renders the deliberate empty Watch Later state", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      savedScreen(await SavedPage({ searchParams: Promise.resolve({ "test-view": "empty" }) })),
    );

    expect(screen.getByRole("heading", { name: "Watch Later is empty." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Browse your library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });
});
