import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DownloadQueuePage from "./page";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("DownloadQueuePage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders geometry-preserving loading while the operator boundary resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await DownloadQueuePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByLabelText("Loading download queue")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
  });

  it("exposes deterministic normalized telemetry only in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await DownloadQueuePage({ searchParams: Promise.resolve({ "test-view": "ready" }) }));

    expect(screen.getByRole("heading", { level: 1, name: "Every byte, in motion." })).toBeVisible();
    expect(screen.getByText("The.Far.Meridian.2026.2160p.WEB-DL")).toBeVisible();
    expect(screen.getByText("Secret boundary intact")).toBeVisible();
  });

  it("renders the unconfigured service path without contacting a client", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await DownloadQueuePage({ searchParams: Promise.resolve({ "test-view": "unconfigured" }) }),
    );

    expect(screen.getByRole("heading", { name: "Connect the transfer plane." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure services" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
  });
});
