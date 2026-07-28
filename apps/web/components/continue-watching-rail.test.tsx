import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  demoContinueWatchingFeed,
  emptyContinueWatchingFeed,
  unavailableContinueWatchingFeed,
} from "../lib/continue-watching-demo";
import { ContinueWatchingRail } from "./continue-watching-rail";

describe("ContinueWatchingRail", () => {
  it("renders normalized progress and a private same-origin artwork path", () => {
    const { container } = render(
      <ContinueWatchingRail
        initialOutcome={{ feed: demoContinueWatchingFeed, status: "ready" }}
        live={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Open Northern Lights" }),
    ).toHaveAccessibleDescription("33% watched");
    expect(container.querySelector('[data-artwork-source="remote"]')).toHaveStyle({
      "--card-artwork": `url("/api/media/media_${"b".repeat(22)}/images/poster")`,
    });
    expect(container.innerHTML).not.toContain("jellyfin-main");
  });

  it("uses final card geometry while the feed is loading", () => {
    render(<ContinueWatchingRail client={{ load: () => new Promise<never>(() => undefined) }} />);

    expect(screen.getByRole("region", { name: "Continue watching" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(document.querySelectorAll(".media-card--loading")).toHaveLength(4);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Continue Watching");
  });

  it("guides signed-out viewers without contacting the client", () => {
    const load = vi.fn();
    render(
      <ContinueWatchingRail
        client={{ load }}
        initialOutcome={{ status: "signed_out" }}
        live={false}
      />,
    );

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("status")).toHaveTextContent("Your progress is waiting");
    expect(load).not.toHaveBeenCalled();
  });

  it("renders deliberate empty and unavailable states", () => {
    const { rerender } = render(
      <ContinueWatchingRail
        initialOutcome={{ feed: emptyContinueWatchingFeed, status: "ready" }}
        live={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Start watching something in Jellyfin");

    rerender(
      <ContinueWatchingRail
        key="unavailable"
        initialOutcome={{ feed: unavailableContinueWatchingFeed, status: "ready" }}
        live={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Jellyfin is out of reach");
  });

  it("retries an interrupted live feed on explicit request", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<ContinueWatchingRail client={{ load }} />);

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(load).toHaveBeenCalledOnce();
    await user.click(retry);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
