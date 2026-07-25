import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardState } from "./dashboard-state";

describe("DashboardState", () => {
  it("keeps a page heading and status announcement in the loading state", () => {
    render(<DashboardState kind="loading" />);

    expect(screen.getByRole("heading", { level: 1, name: "Loading your dashboard" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Loading your dashboard…");
  });

  it("pairs terminal error copy and iconography with a danger treatment", () => {
    render(<DashboardState kind="terminal-error" />);

    expect(
      screen.getByRole("heading", { name: "This connection needs repair." }).closest("section"),
    ).toHaveAttribute("data-severity", "danger");
    expect(screen.getByText("Configuration blocked")).toBeVisible();
  });

  it("keeps empty states visually neutral", () => {
    render(<DashboardState kind="empty" />);

    expect(
      screen.getByRole("heading", { name: "Your library is quiet." }).closest("section"),
    ).toHaveAttribute("data-severity", "neutral");
  });
});
