import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AcquisitionCalendarPage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("AcquisitionCalendarPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders geometry-preserving loading while the media boundary resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await AcquisitionCalendarPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByLabelText("Loading acquisition calendar")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
  });

  it("exposes deterministic normalized arrivals only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await AcquisitionCalendarPage({ searchParams: Promise.resolve({ "test-view": "ready" }) }),
    );

    expect(screen.getByRole("heading", { level: 1, name: "See what arrives next." })).toBeVisible();
    expect(await screen.findByRole("button", { name: /Inspect The Far Meridian/i })).toBeVisible();
    expect(screen.getByText("Opaque by design")).toBeVisible();
  });

  it("renders the unconfigured service path without contacting a source", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await AcquisitionCalendarPage({
        searchParams: Promise.resolve({ "test-view": "unconfigured" }),
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Connect your release horizon." }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure services" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
  });
});
