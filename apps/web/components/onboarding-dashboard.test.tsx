import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OnboardingDashboard } from "./onboarding-dashboard";

describe("OnboardingDashboard", () => {
  it("offers a truthful first-run surface without fabricated identity or dead controls", () => {
    render(<OnboardingDashboard />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Your media control room is being prepared." }),
    ).toBeVisible();
    expect(
      screen.getByText(/does not accept account credentials or connect to media services/i),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /View release readiness/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("RN")).not.toBeInTheDocument();
    expect(screen.queryByText(/Phase 0|preview|under test/i)).not.toBeInTheDocument();
  });
});
