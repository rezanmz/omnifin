import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AuditTrailPage from "./page";

describe("AuditTrailPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders a geometry-preserving loading state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await AuditTrailPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", { name: "Every consequential move, accounted for." }),
    ).toBeVisible();
    expect(screen.getByLabelText("Loading operator audit trail")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("link", { name: "Account & access" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("exposes a deterministic privacy-safe ready state only in test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await AuditTrailPage({ searchParams: Promise.resolve({ "test-view": "ready" }) }));

    expect(
      await screen.findByRole("heading", { name: "Service configuration updated" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "User access updated" })).toBeVisible();
    expect(screen.getByText("5 recorded events")).toBeVisible();
    expect(screen.queryByText("connector_credentials")).not.toBeInTheDocument();
  });

  it("enables the ten-foot profile only through the test-mode preview boundary", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    const { container } = render(
      await AuditTrailPage({
        searchParams: Promise.resolve({ "test-profile": "ten-foot", "test-view": "empty" }),
      }),
    );

    expect(container.firstElementChild).toHaveAttribute("data-display-profile", "ten-foot");
  });
});
