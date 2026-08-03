import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MediaIssuePage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("MediaIssuePage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders geometry-preserving loading while the operator boundary resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await MediaIssuePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByLabelText("Loading issue workbench")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("link", { name: "Requests" })).toHaveAttribute(
      "href",
      "/operations/requests",
    );
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
  });

  it("exposes deterministic normalized issue data only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await MediaIssuePage({ searchParams: Promise.resolve({ "test-view": "ready" }) }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Close the loop on every stream." }),
    ).toBeVisible();
    expect(screen.getByText("Northern Lights")).toBeVisible();
    expect(screen.getByText("Opaque boundary intact")).toBeVisible();
  });

  it("renders partial service health without hiding local reports", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await MediaIssuePage({ searchParams: Promise.resolve({ "test-view": "degraded" }) }));

    expect(screen.getByRole("status")).toHaveTextContent("Seerr is unavailable");
    expect(screen.getByText("The Long Meridian")).toBeVisible();
  });
});
