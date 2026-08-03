import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ConnectorsPage from "./page";

describe("ConnectorsPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders a geometry-preserving service-control loading state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await ConnectorsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "Every service. One signal." })).toBeVisible();
    expect(screen.getByLabelText("Loading service connections")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("link", { name: "Account & access" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("exposes deterministic connector telemetry only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await ConnectorsPage({
        searchParams: Promise.resolve({ "test-view": "ready" }),
      }),
    );

    expect(await screen.findByRole("heading", { name: "Living Room Jellyfin" })).toBeVisible();
    expect(screen.getByText("10.10.7")).toBeVisible();
    expect(screen.getByText("18 ms")).toBeVisible();
    expect(screen.getByText("media · playback")).toBeVisible();
  });
});
