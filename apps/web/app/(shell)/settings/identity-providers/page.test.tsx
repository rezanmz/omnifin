import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import IdentityProvidersPage from "./page";

describe("IdentityProvidersPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders a geometry-preserving administration loading state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await IdentityProvidersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "Trust, made visible." })).toBeVisible();
    expect(screen.getByLabelText("Loading identity provider administration")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("link", { name: "Account & access" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("exposes deterministic ready states only when test mode is explicit", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");
    vi.stubEnv("OMNIFIN_BASE_URL", "https://omnifin.example.test");

    render(
      await IdentityProvidersPage({
        searchParams: Promise.resolve({ "test-view": "ready" }),
      }),
    );

    expect(await screen.findByRole("heading", { name: "Authentik" })).toBeVisible();
    expect(
      await screen.findByText("https://omnifin.example.test/api/auth/oidc/callback/oidc-authentik"),
    ).toBeVisible();
    expect(await screen.findByText(/media-operators/)).toBeVisible();
  });

  it("starts the administration bundle during initial hydration", async () => {
    const requestIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await IdentityProvidersPage({
        searchParams: Promise.resolve({ "test-view": "ready" }),
      }),
    );

    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Authentik" })).toBeVisible();
  });
});
