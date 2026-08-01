import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import LibraryCarePage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("LibraryCarePage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders geometry-preserving loading while the operator boundary resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await LibraryCarePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByLabelText("Loading library care")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
  });

  it("exposes the deterministic attention workspace only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await LibraryCarePage({ searchParams: Promise.resolve({ "test-view": "ready" }) }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Make every title feel finished." }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspect Ember Coast" })).toBeVisible();
    expect(screen.getByText("4 titles need a finishing touch")).toBeVisible();
  });

  it("renders a deliberate empty state", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await LibraryCarePage({ searchParams: Promise.resolve({ "test-view": "empty" }) }));

    expect(screen.getByText("Library looks polished")).toBeVisible();
    expect(screen.getByText("Nothing needs attention.")).toBeVisible();
  });
});
