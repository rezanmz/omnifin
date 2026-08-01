import { setupReadinessResponseSchema, setupReadinessStepIds } from "@omnifin/contracts/setup";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SetupReadinessOutcome } from "../lib/setup-readiness";
import { ThemeProvider } from "./theme-provider";
import { OnboardingDashboard } from "./onboarding-dashboard";

function readyOutcome(): SetupReadinessOutcome {
  return {
    readiness: setupReadinessResponseSchema.parse({
      coreReady: true,
      essentialCompleted: 2,
      essentialTotal: 2,
      generatedAt: "2026-08-01T12:00:00.000Z",
      optionalReady: 0,
      optionalTotal: 6,
      steps: setupReadinessStepIds.map((id, index) => ({
        configuredCount: index < 2 ? 1 : 0,
        id,
        readyCount: index < 2 ? 1 : 0,
        state: index < 2 ? "ready" : "not_configured",
      })),
    }),
    status: "ready",
  };
}

function renderDashboard(properties: React.ComponentProps<typeof OnboardingDashboard> = {}) {
  return render(
    <ThemeProvider initialPreference="system">
      <OnboardingDashboard {...properties} />
    </ThemeProvider>,
  );
}

describe("OnboardingDashboard", () => {
  it("separates an honest core-ready boundary from optional stack coverage", () => {
    renderDashboard({ initialOutcome: readyOutcome() });

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Core is ready. Shape the rest around your stack.",
      }),
    ).toBeVisible();
    expect(screen.getByText("2 of 2 essentials ready")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Jellyfin identity" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Jellyfin service" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "OpenID Connect" })).toBeVisible();
    expect(screen.getByText("Recommended", { selector: ".setup-step__requirement" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Configure OpenID Connect/i })).toHaveAttribute(
      "href",
      "/settings/identity-providers",
    );
    expect(screen.queryByText(/recovery secret|\/recovery/i)).not.toBeInTheDocument();
  });

  it("presents a truthful signed-out boundary", () => {
    renderDashboard({ initialOutcome: { status: "signed_out" } });

    expect(screen.getByRole("heading", { name: "Sign in to continue setup." })).toBeVisible();
    expect(screen.getByRole("link", { name: /Continue to sign in/i })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("does not imply that a non-administrator can inspect deployment readiness", () => {
    renderDashboard({ initialOutcome: { status: "forbidden" } });

    expect(screen.getByRole("heading", { name: "Administrator access required." })).toBeVisible();
    expect(screen.getByRole("link", { name: /Review account access/i })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("retries an unavailable readiness snapshot without changing settings", async () => {
    const user = userEvent.setup();
    const loadReadiness = vi.fn(async () => readyOutcome());
    renderDashboard({ initialOutcome: { status: "unavailable" }, loadReadiness });

    await user.click(screen.getByRole("button", { name: /Check again/i }));

    expect(loadReadiness).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText("2 of 2 essentials ready")).toBeVisible();
    });
  });

  it("uses geometry-matched loading regions before the first safe response", () => {
    renderDashboard({ loadReadiness: () => new Promise(() => undefined) });

    expect(screen.getByRole("status", { name: "Checking setup readiness" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getAllByTestId("setup-step-skeleton")).toHaveLength(8);
  });
});
