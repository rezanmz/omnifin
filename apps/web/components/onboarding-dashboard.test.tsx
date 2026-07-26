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
      screen.getByText(/can validate OIDC sign-in and recovery in an isolated environment/i),
    ).toBeVisible();
    expect(
      screen.getByText(/Jellyfin sign-in and proof-based pairing remain gated/i),
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
