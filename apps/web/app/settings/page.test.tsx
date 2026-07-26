import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("states the partial identity checkpoint in user language", () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Account setup is still being secured.",
      }),
    ).toBeVisible();
    expect(screen.getByText(/has no supported provider or account administration/i)).toBeVisible();
    expect(screen.getByText(/Jellyfin sign-in and pairing/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /Return home/i })).toHaveAttribute("href", "/");
    expect(screen.queryByText(/Phase 0|preview|validation/i)).not.toBeInTheDocument();
  });
});
