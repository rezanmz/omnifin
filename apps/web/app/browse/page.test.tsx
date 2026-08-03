import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import BrowsePage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe("BrowsePage", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders deterministic browse results only in the browser test profile", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await BrowsePage({
        searchParams: Promise.resolve({ "test-view": "ready" }),
      }),
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Browse without the guesswork." }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "View details for The Far Meridian" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Request The Far Meridian" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Browse" })).toHaveLength(2);
    for (const destination of screen.getAllByRole("link", { name: "Browse" })) {
      expect(destination).toHaveAttribute("aria-current", "page");
    }
  });

  it("retains a safe media kind while reporting invalid shared criteria", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await BrowsePage({
        searchParams: Promise.resolve({
          kind: "series",
          minimumRating: "not-a-number",
          "test-view": "loading",
        }),
      }),
    );

    expect(screen.getByRole("button", { name: "Series" })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("Some shared filters were invalid and have been safely reset."),
    ).toBeVisible();
    expect(screen.getByLabelText("Loading browse results")).toBeVisible();
  });
});
