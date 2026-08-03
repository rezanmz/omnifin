import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationShellContent } from "./application-shell";
import { ApplicationShellFrame } from "./application-shell-frame";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

function shell(children: ReactNode) {
  return <ApplicationShellFrame themePreference="system">{children}</ApplicationShellFrame>;
}

describe("ApplicationShellFrame", () => {
  beforeEach(() => {
    pathname = "/";
  });

  it("keeps primary navigation and command controls around operational routes", () => {
    pathname = "/operations/health";
    render(shell(<main>System health</main>));

    for (const operationsLink of screen.getAllByRole("link", { name: "Operations" })) {
      expect(operationsLink).toHaveAttribute("aria-current", "page");
    }
    expect(screen.getByRole("combobox", { name: "Search media and commands" })).toBeVisible();
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
      <ApplicationShellFrame themePreference="system">
        <ApplicationShellContent
          accent="#d8ff70"
          current="discover"
          displayProfile="ten-foot"
          status="healthy"
        >
          <main>Discover</main>
        </ApplicationShellContent>
      </ApplicationShellFrame>,
    );

    const frame = screen.getByRole("main").closest(".application-frame");
    await waitFor(() => expect(frame).toHaveAttribute("data-connection-status", "healthy"));
    expect(frame).toHaveAttribute("data-display-profile", "ten-foot");
    expect(document.querySelector(".cinematic-backdrop")).toHaveStyle({
      "--ambient-accent": "#d8ff70",
    });
    expect(screen.getByRole("link", { name: "All connected services are healthy" })).toBeVisible();
  });
});
