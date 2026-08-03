import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StandaloneApplicationShell from "../../../components/standalone-application-shell";
import LibraryPage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

function libraryScreen(content: ReactNode) {
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

describe("LibraryPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders geometry-preserving loading while the paired catalogue resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(libraryScreen(await LibraryPage({ searchParams: Promise.resolve({}) })));

    expect(screen.getByRole("region", { name: "Gathering your library…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getAllByRole("link", { name: "Library" })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "Library" })) {
      expect(link).toHaveAttribute("aria-current", "page");
    }
  });

  it("exposes the deterministic paired catalogue only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      libraryScreen(await LibraryPage({ searchParams: Promise.resolve({ "test-view": "ready" }) })),
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Every story, in its place." }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /View details for Ember Coast/u })).toBeVisible();
    expect(screen.getByRole("button", { name: /View details for Northern Lights/u })).toBeVisible();
    expect(screen.getByRole("heading", { name: "8 titles in view" })).toBeVisible();
  });

  it("renders a deliberate empty state", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      libraryScreen(await LibraryPage({ searchParams: Promise.resolve({ "test-view": "empty" }) })),
    );

    expect(screen.getByRole("heading", { name: "Your paired library is empty." })).toBeVisible();
    expect(screen.getByText(/Add a movie or series in Jellyfin/u)).toBeVisible();
  });
});
