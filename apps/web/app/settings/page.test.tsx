import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "./page";

describe("SettingsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the account-and-access center with geometry-preserving loading states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Your identity, under your control." }),
    ).toBeVisible();
    expect(screen.getByLabelText("Loading account security")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
    expect(screen.queryByText(/preview|checkpoint|phase/i)).not.toBeInTheDocument();
  });
});
