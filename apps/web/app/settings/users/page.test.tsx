import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import UserAccessPage from "./page";

describe("UserAccessPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders a geometry-preserving loading state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await UserAccessPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "Authority, without ambiguity." })).toBeVisible();
    expect(screen.getByLabelText("Loading user access administration")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("link", { name: "Account & access" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("exposes a deterministic provider-owned ready state only in test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(await UserAccessPage({ searchParams: Promise.resolve({ "test-view": "ready" }) }));

    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Rezan" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Sloane Park/i }));
    expect(screen.getByText(/role comes from an OIDC claim mapping/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /operator.*Manage requests/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Access enabled" })).toBeEnabled();
  });
});
