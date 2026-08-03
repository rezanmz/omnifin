import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import IndexerPage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("IndexerPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders geometry-preserving loading while the operator boundary resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await IndexerPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByLabelText("Loading indexer intelligence")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
  });

  it("exposes deterministic normalized telemetry only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await IndexerPage({ searchParams: Promise.resolve({ "test-view": "ready" }) }));

    expect(screen.getByRole("heading", { level: 1, name: "Know every source." })).toBeVisible();
    expect(screen.getByText("Nebula")).toBeVisible();
    expect(screen.getByText("Northstar")).toBeVisible();
    expect(screen.getByText("Full sync")).toBeVisible();
    expect(screen.getByText("Authentication check failed")).toBeVisible();
  });

  it("renders the unconfigured service path without contacting Prowlarr", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await IndexerPage({ searchParams: Promise.resolve({ "test-view": "not_configured" }) }));

    expect(screen.getByRole("heading", { name: "Connect the indexer plane." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure services" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
  });
});
