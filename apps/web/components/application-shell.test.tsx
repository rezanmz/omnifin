import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeUsesApplicationShell } from "../lib/application-shell-route";
import { ApplicationShellBoundary } from "./application-shell";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("./liquid-glass-environment", () => ({ LiquidGlassEnvironment: () => null }));
vi.mock("./top-command-bar", () => ({
  TopCommandBar: () => <div data-testid="command-bar">Command bar</div>,
}));

describe("ApplicationShellBoundary", () => {
  beforeEach(() => {
    pathname = "/";
  });

  it("keeps primary navigation and command controls around operational routes", () => {
    pathname = "/operations/health";
    render(
      <ApplicationShellBoundary themePreference="system">
        <main>System health</main>
      </ApplicationShellBoundary>,
    );

    for (const operationsLink of screen.getAllByRole("link", { name: "Operations" })) {
      expect(operationsLink).toHaveAttribute("aria-current", "page");
    }
    expect(screen.getByTestId("command-bar")).toBeVisible();
    expect(screen.getByRole("main")).toHaveTextContent("System health");
  });

  it("preserves the desktop rail while authenticated route content changes", () => {
    const { rerender } = render(
      <ApplicationShellBoundary themePreference="system">
        <main>Discover</main>
      </ApplicationShellBoundary>,
    );
    const navigation = screen.getByRole("complementary", { name: "Primary navigation" });

    pathname = "/calendar";
    rerender(
      <ApplicationShellBoundary themePreference="system">
        <main>Calendar</main>
      </ApplicationShellBoundary>,
    );

    expect(screen.getByRole("complementary", { name: "Primary navigation" })).toBe(navigation);
    expect(screen.getByRole("main")).toHaveTextContent("Calendar");
  });

  it("marks Settings as the current destination on nested settings routes", () => {
    pathname = "/settings/connectors";
    render(
      <ApplicationShellBoundary themePreference="dark">
        <main>Connectors</main>
      </ApplicationShellBoundary>,
    );

    for (const settingsLink of screen.getAllByRole("link", { name: "Settings" })) {
      expect(settingsLink).toHaveAttribute("aria-current", "page");
    }
  });

  it("removes the persistent shell when navigation crosses into authentication", () => {
    pathname = "/login";
    render(
      <ApplicationShellBoundary themePreference="system">
        <main>Sign in</main>
      </ApplicationShellBoundary>,
    );

    expect(screen.queryByRole("complementary", { name: "Primary navigation" })).toBeNull();
    expect(screen.queryByTestId("command-bar")).toBeNull();
    expect(screen.getByRole("main")).toHaveTextContent("Sign in");
  });

  it("leaves authentication, pairing, recovery, and onboarding routes unshelled", () => {
    for (const publicPath of [
      "/login",
      "/login/jellyfin",
      "/link/jellyfin",
      "/recovery",
      "/onboarding",
    ]) {
      expect(routeUsesApplicationShell(publicPath)).toBe(false);
    }
    expect(routeUsesApplicationShell("/library")).toBe(true);
  });
});
