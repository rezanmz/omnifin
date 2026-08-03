import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import RequestReviewPage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("RequestReviewPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders geometry-preserving loading while the operator boundary resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await RequestReviewPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByLabelText("Loading request review")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
  });

  it("exposes deterministic normalized request data only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await RequestReviewPage({ searchParams: Promise.resolve({ "test-view": "ready" }) }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Decide what enters the library." }),
    ).toBeVisible();
    expect(screen.getByText("A House of Dynamite")).toBeVisible();
    expect(screen.getByText("Secret boundary intact")).toBeVisible();
  });

  it("renders the unconfigured Seerr path without contacting a client", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await RequestReviewPage({
        searchParams: Promise.resolve({ "test-view": "not_configured" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "Connect the request plane." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure services" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
  });
});
