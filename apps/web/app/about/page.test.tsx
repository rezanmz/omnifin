import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AboutPage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("AboutPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("exposes a deterministic verified identity only in test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await AboutPage({ searchParams: Promise.resolve({ "test-view": "verified" }) }));

    expect(screen.getByText("Release verified")).toBeVisible();
    expect(screen.getByText("1.0.0")).toBeVisible();
  });

  it("renders an honest unavailable state when the local gateway cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    render(await AboutPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("status")).toHaveTextContent("Build identity is unavailable");
  });

  it("enables the ten-foot profile only through the test boundary", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    const { container } = render(
      await AboutPage({
        searchParams: Promise.resolve({ "test-profile": "ten-foot", "test-view": "development" }),
      }),
    );

    expect(container.firstElementChild).toHaveAttribute("data-display-profile", "ten-foot");
  });
});
