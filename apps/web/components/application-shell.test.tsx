import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeUsesApplicationShell } from "../lib/application-shell-route";
import { ApplicationShellBoundary, ApplicationShellContent } from "./application-shell";
import { ApplicationShellNavigation } from "./application-shell-navigation";
import { ApplicationShellStatus } from "./application-shell-status";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

function shell(children: ReactNode) {
  return (
    <ApplicationShellBoundary
      backdrop={<div className="cinematic-backdrop" data-testid="backdrop" />}
      environment={null}
      mobileNavigation={<ApplicationShellNavigation mobile />}
      navigation={<ApplicationShellNavigation />}
      topCommandBar={<div data-testid="command-bar">Command bar</div>}
    >
      {children}
    </ApplicationShellBoundary>
  );
}

describe("ApplicationShellBoundary", () => {
  beforeEach(() => {
    pathname = "/";
  });

  it("keeps primary navigation and command controls around operational routes", () => {
    pathname = "/operations/health";
    render(shell(<main>System health</main>));

    for (const operationsLink of screen.getAllByRole("link", { name: "Operations" })) {
      expect(operationsLink).toHaveAttribute("aria-current", "page");
    }
    expect(screen.getByTestId("command-bar")).toBeVisible();
    expect(screen.getByRole("main")).toHaveTextContent("System health");
  });

  it("preserves the desktop rail while authenticated route content changes", () => {
    const { rerender } = render(shell(<main>Discover</main>));
    const navigation = screen.getByRole("complementary", { name: "Primary navigation" });

    pathname = "/calendar";
    rerender(shell(<main>Calendar</main>));

    expect(screen.getByRole("complementary", { name: "Primary navigation" })).toBe(navigation);
    expect(screen.getByRole("main")).toHaveTextContent("Calendar");
  });

  it("marks Settings as the current destination on nested settings routes", () => {
    pathname = "/settings/connectors";
    render(shell(<main>Connectors</main>));

    for (const settingsLink of screen.getAllByRole("link", { name: "Settings" })) {
      expect(settingsLink).toHaveAttribute("aria-current", "page");
    }
  });

  it("updates shell chrome without restyling the page content ancestor", async () => {
    render(
      <ApplicationShellBoundary
        backdrop={<div className="cinematic-backdrop" data-testid="backdrop" />}
        environment={null}
        mobileNavigation={<ApplicationShellNavigation mobile />}
        navigation={<ApplicationShellNavigation />}
        topCommandBar={<ApplicationShellStatus />}
      >
        <ApplicationShellContent
          accent="#d8ff70"
          current="discover"
          displayProfile="ten-foot"
          status="healthy"
        >
          <main>Discover</main>
        </ApplicationShellContent>
      </ApplicationShellBoundary>,
    );

    const frame = screen.getByRole("main").closest(".application-frame");
    await waitFor(() => expect(frame).toHaveAttribute("data-connection-status", "healthy"));
    expect(frame).toHaveAttribute("data-display-profile", "ten-foot");
    expect(screen.getByTestId("backdrop")).toHaveStyle({ "--ambient-accent": "#d8ff70" });
    expect(screen.getByRole("link", { name: "All connected services are healthy" })).toBeVisible();
  });

  it("removes the persistent shell when navigation crosses into authentication", () => {
    pathname = "/login";
    render(shell(<main>Sign in</main>));

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
