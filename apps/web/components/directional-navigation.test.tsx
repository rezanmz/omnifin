import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { demoDashboard } from "../lib/dashboard-data";
import { ApplicationShellEnhancements } from "./application-shell-enhancements";
import { CalendarStrip } from "./calendar-strip";
import { HeroSpotlight } from "./hero-spotlight";
import { NavigationRail } from "./navigation-rail";
import { OperationsDock } from "./operations-dock";
import { TopCommandBar } from "./top-command-bar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

describe("directional navigation", () => {
  it("moves through primary navigation vertically", async () => {
    const user = userEvent.setup();
    render(
      <>
        <NavigationRail />
        <ApplicationShellEnhancements initialCurrent="discover" />
      </>,
    );

    const discover = screen.getByRole("link", { name: "Discover" });
    discover.focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("link", { name: "Browse" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Browse" })).toHaveAttribute("href", "/browse");
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("link", { name: "Library" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("href", "/library");
    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("href", "/calendar");
    expect(screen.getByRole("link", { name: "Operations" })).toHaveAttribute(
      "href",
      "/operations/health",
    );
    expect(screen.getByRole("link", { name: "Requests" })).toHaveAttribute(
      "href",
      "/operations/requests",
    );
  });

  it("marks the viewer library as the current destination", () => {
    render(<NavigationRail current="library" />);

    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Discover" })).not.toHaveAttribute("aria-current");
  });

  it("moves between hero actions horizontally", async () => {
    const user = userEvent.setup();
    render(<HeroSpotlight hero={demoDashboard.hero} />);

    const library = screen.getByRole("link", { name: "Browse library" });
    library.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("link", { name: "Open calendar" })).toHaveFocus();
  });

  it("moves from search to service status without stealing text-editing arrows", async () => {
    const user = userEvent.setup();
    render(<TopCommandBar connectionStatus="healthy" />);

    await user.click(await screen.findByRole("combobox"));
    await waitFor(() => expect(screen.getByRole("combobox")).not.toHaveAttribute("aria-busy"));
    const search = screen.getByRole("combobox");
    await user.keyboard("signal{ArrowLeft}");
    expect(search).toHaveFocus();

    await user.clear(search);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("link", { name: "All connected services are healthy" })).toHaveFocus();
  });

  it("moves between calendar cells with arrow keys", async () => {
    const user = userEvent.setup();
    render(<CalendarStrip items={demoDashboard.calendar} />);

    const first = screen.getByRole("link", { name: /Signal \/ 1×07/i });
    first.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("link", { name: /The Long Meridian/i })).toHaveFocus();
  });

  it("moves from the expanded operations summary into its first row", async () => {
    const user = userEvent.setup();
    render(<OperationsDock operations={demoDashboard.operations} />);

    const summary = screen.getByRole("button", { name: /2 acquisitions moving/i });
    await waitFor(() => expect(summary).toBeEnabled());
    await user.click(summary);
    summary.focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("button", { name: /The Far Meridian/i })).toHaveFocus();
  });
});
