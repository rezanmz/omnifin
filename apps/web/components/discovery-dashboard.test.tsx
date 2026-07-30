import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  degradedDiscoveryFeed,
  demoDiscoveryFeed,
  emptyDiscoveryFeed,
} from "../lib/discovery-feed-demo";
import { DiscoveryFeedClientError } from "../lib/discovery-feed";
import type { DiscoveryMediaDetailClient } from "../lib/media-details";
import { DiscoveryDashboard } from "./discovery-dashboard";

const detailResponse = {
  generatedAt: "2026-07-29T20:00:00.000Z",
  item: {
    availability: "unavailable" as const,
    cast: [],
    crew: [],
    genres: ["Science Fiction"],
    id: "movie:603",
    intelligence: {
      ratings: [],
      ratingsState: "empty" as const,
      recommendations: [],
      recommendationsState: "empty" as const,
      trailers: [],
    },
    kind: "movie" as const,
    originalTitle: null,
    overview: "A normalized synopsis.",
    productionStatus: "Released",
    runtimeMinutes: 128,
    source: "seerr" as const,
    tagline: "Follow the signal.",
    title: "The Far Meridian",
    tmdbId: 603,
    voteAverage: 8.8,
    voteCount: 4200,
    year: 2026,
  },
};

describe("DiscoveryDashboard", () => {
  it("turns the live feed into a functional hero and four keyboard-ready rails", async () => {
    const user = userEvent.setup();
    const load = vi.fn<DiscoveryMediaDetailClient["load"]>(async () => detailResponse);
    render(
      <DiscoveryDashboard
        detailClient={{ load }}
        initialFeed={demoDiscoveryFeed}
        live={false}
        showContinueWatching={false}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "The Far Meridian" })).toBeVisible();
    expect(screen.getByRole("button", { name: "View details" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Request title" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Trending now" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Popular movies" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Series people are watching" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Coming soon" })).toBeVisible();
    expect(screen.queryByText("View all")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "The Far Meridian" })).toHaveAttribute(
      "data-artwork-source",
      "remote",
    );

    await user.click(
      screen.getAllByRole("button", { name: "View details for The Far Meridian" })[0]!,
    );
    expect(await screen.findByRole("dialog", { name: "The Far Meridian details" })).toBeVisible();
    expect(load).toHaveBeenCalledWith(
      { kind: "movie", tmdbId: 603 },
      { language: expect.stringMatching(/^[a-z]{2}(?:-[A-Z]{2})?$/u) },
      expect.any(AbortSignal),
    );
  });

  it("keeps healthy rails available beside an explicit degraded-state boundary", () => {
    render(
      <DiscoveryDashboard
        initialFeed={degradedDiscoveryFeed}
        live={false}
        showContinueWatching={false}
      />,
    );

    expect(screen.getByText("This rail missed the latest refresh")).toBeVisible();
    expect(screen.getByRole("button", { name: "View details for Glass Horizon" })).toBeVisible();
    expect(
      screen.getByText(/Available rails are current/u).closest('[role="status"]'),
    ).toBeVisible();
  });

  it("distinguishes a healthy empty feed from an unavailable request", async () => {
    const { unmount } = render(
      <DiscoveryDashboard
        initialFeed={emptyDiscoveryFeed}
        live={false}
        showContinueWatching={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "The signal is quiet right now" })).toBeVisible();

    unmount();
    render(
      <DiscoveryDashboard
        client={{
          load: async () =>
            Promise.reject(
              new DiscoveryFeedClientError(
                "signed_out",
                "authentication_required",
                "Sign in required.",
              ),
            ),
        }}
        showContinueWatching={false}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Your discovery signal is waiting" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("removes cached discovery immediately when the session loses authorization", async () => {
    render(
      <DiscoveryDashboard
        client={{
          load: async () =>
            Promise.reject(
              new DiscoveryFeedClientError("forbidden", "permission_denied", "Permission denied."),
            ),
        }}
        initialFeed={demoDiscoveryFeed}
        live
        showContinueWatching={false}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Discovery permission required" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "View details for The Far Meridian" }),
    ).not.toBeInTheDocument();
  });

  it("matches loading geometry before the discovery chunk resolves", () => {
    render(
      <DiscoveryDashboard
        client={{ load: vi.fn(async () => await new Promise<never>(() => undefined)) }}
        showContinueWatching={false}
      />,
    );

    expect(screen.getByRole("region", { name: "Loading discovery spotlight" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Loading connected discovery" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Loading Trending now" })).toBeVisible();
  });
});
