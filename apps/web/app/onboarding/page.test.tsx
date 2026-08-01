import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import OnboardingPage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("OnboardingPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("exposes deterministic readiness only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await OnboardingPage({
        searchParams: Promise.resolve({ "test-view": "partial" }),
      }),
    );

    expect(screen.getByRole("heading", { name: /Core is ready/u })).toBeVisible();
    expect(screen.getByText("3 of 6 stack extensions ready")).toBeVisible();
  });

  it("ignores test fixtures in an ordinary deployment", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "false");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(
      await OnboardingPage({
        searchParams: Promise.resolve({ "test-view": "ready" }),
      }),
    );

    expect(screen.getByRole("status", { name: "Checking setup readiness" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /Core is ready/u })).not.toBeInTheDocument();
  });
});
