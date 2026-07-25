import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("states the foundation-release configuration boundary in user language", () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Account setup arrives in Phase 1.",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/does not yet accept credentials or connect to media services/i),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Return home/i })).toHaveAttribute("href", "/");
    expect(screen.queryByText(/Phase 0|preview|validation/i)).not.toBeInTheDocument();
  });
});
