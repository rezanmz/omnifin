import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationShellContent } from "./application-shell";
import { ApplicationShellFrame } from "./application-shell-frame";

let pathname = "/";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

function shell(children: ReactNode) {
  return <ApplicationShellFrame themePreference="system">{children}</ApplicationShellFrame>;
}

describe("ApplicationShellFrame", () => {
  beforeEach(() => {
    pathname = "/";
    push.mockClear();
  });

  it("keeps non-interactive command placeholders out of the accessibility tree", () => {
    const { container } = render(shell(<main>Loading</main>));

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open profile menu" })).not.toBeInTheDocument();
    for (const placeholder of container.querySelectorAll("[data-shell-placeholder]")) {
      expect(placeholder).toHaveAttribute("inert");
    }
  });

  it("keeps primary navigation and command controls around operational routes", async () => {
    pathname = "/operations/health";
    render(
      shell(
        <ApplicationShellContent current="operations" status="healthy">
          <main>System health</main>
        </ApplicationShellContent>,
      ),
    );

    for (const operationsLink of screen.getAllByRole("link", { name: "Operations" })) {
      await waitFor(() => expect(operationsLink).toHaveAttribute("aria-current", "page"));
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

  it("uses client navigation for shell links after hydration", async () => {
    const user = userEvent.setup();
    render(
      shell(
        <ApplicationShellContent current="discover" status="healthy">
          <main>Discover</main>
        </ApplicationShellContent>,
      ),
    );

    await user.click(screen.getAllByRole("link", { name: "Calendar" })[0]!);

    expect(push).toHaveBeenCalledWith("/calendar");
  });

  it("marks Settings as the current destination on nested settings routes", async () => {
    pathname = "/settings/connectors";
    render(
      shell(
        <ApplicationShellContent current="settings" status="healthy">
          <main>Connectors</main>
        </ApplicationShellContent>,
      ),
    );

    for (const settingsLink of screen.getAllByRole("link", { name: "Settings" })) {
      await waitFor(() => expect(settingsLink).toHaveAttribute("aria-current", "page"));
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
    expect(
      await screen.findByRole("link", { name: "All connected services are healthy" }),
    ).toBeVisible();
  });
});
