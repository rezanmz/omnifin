import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { demoDashboard } from "../lib/dashboard-data";
import { MediaRail } from "./media-rail";

describe("MediaRail", () => {
  it("describes watch progress on each poster control", () => {
    render(<MediaRail items={demoDashboard.continueWatching} title="Continue watching" />);

    expect(screen.getByRole("button", { name: "Open Ember Coast" })).toHaveAccessibleDescription(
      "64% watched",
    );
    expect(screen.getByRole("progressbar", { name: "Ember Coast watch progress" })).toHaveAttribute(
      "aria-valuenow",
      "64",
    );
  });

  it("uses deterministic artwork variants and retains an explicit fallback", () => {
    const { container, rerender } = render(
      <MediaRail items={demoDashboard.continueWatching} title="Continue watching" />,
    );

    expect(container.querySelector('[data-artwork="contour"]')).toBeInTheDocument();
    expect(container.querySelector('[data-artwork="archive"]')).toBeInTheDocument();

    rerender(
      <MediaRail
        items={[{ accent: "#51675b", eyebrow: "New", id: "fallback", title: "Fallback" }]}
        title="Discovery"
      />,
    );
    expect(container.querySelector('[data-artwork="fallback"]')).toBeInTheDocument();
  });

  it("fails closed instead of loading an unrecognized artwork URL", () => {
    const { container } = render(
      <MediaRail
        items={[
          {
            accent: "#51675b",
            artworkPath: "https://unexpected.example/private-artwork",
            eyebrow: "New",
            id: "fallback",
            title: "Fallback",
          },
        ]}
        title="Continue watching"
      />,
    );

    expect(container.querySelector('[data-artwork-source="generated"]')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("unexpected.example");
  });

  it("moves focus between posters with directional keys", async () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    const user = userEvent.setup();
    render(<MediaRail items={demoDashboard.continueWatching} title="Continue watching" />);

    const first = screen.getByRole("button", { name: "Open Ember Coast" });
    const second = screen.getByRole("button", { name: "Open The Quiet Archive" });
    first.focus();
    await user.keyboard("{ArrowRight}");

    expect(second).toHaveFocus();
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("renders useful guidance for an empty rail", () => {
    render(<MediaRail items={[]} title="Continue watching" />);

    expect(screen.getByRole("status")).toHaveTextContent("Start watching something in Jellyfin");
    expect(screen.queryByRole("button", { name: "View all" })).not.toBeInTheDocument();
  });
});
