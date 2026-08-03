import { render, screen, waitFor } from "@testing-library/react";
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
    artwork: { backdropPath: null, posterPath: null },
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
    const { container } = render(
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
    expect(screen.getAllByRole("link", { name: "View all" })).toHaveLength(4);
    expect(screen.getAllByRole("link", { name: "View all" })[0]).toHaveAttribute(
      "href",
      "/browse?kind=movie",
    );
    expect(screen.getAllByRole("button", { name: "Request The Far Meridian" })).not.toHaveLength(0);
    expect(screen.getByRole("region", { name: "The Far Meridian" })).toHaveAttribute(
      "data-artwork-source",
      "remote",
    );
    const spotlightArtwork = container.querySelector(".hero-spotlight__art-image");
    expect(spotlightArtwork).toHaveAttribute("decoding", "async");
    expect(spotlightArtwork).toHaveAttribute("fetchpriority", "high");

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

  it("opens the guarded request composer directly from a discovery card", async () => {
    const user = userEvent.setup();
    render(
      <DiscoveryDashboard
        initialFeed={demoDiscoveryFeed}
        live={false}
        showContinueWatching={false}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "Request The Far Meridian" })[0]!);

    expect(await screen.findByRole("dialog", { name: "Compose request" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Selected title" })).toHaveTextContent(
      "The Far Meridian",
    );
    expect(
      screen.queryByRole("dialog", { name: "The Far Meridian details" }),
    ).not.toBeInTheDocument();
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
    expect(screen.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
    expect(screen.getByText("OIDC or Jellyfin")).toBeVisible();
    expect(screen.queryByText("Jellyfin linked")).not.toBeInTheDocument();
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
    expect(screen.getByRole("heading", { level: 1, name: "Ready when you are" })).toBeVisible();
    expect(screen.getByText("Protected upstreams")).toBeVisible();
    expect(screen.queryByText("Jellyfin linked")).not.toBeInTheDocument();
  });

  it("keeps the last safe feed visible when a background refresh is interrupted", async () => {
    render(
      <DiscoveryDashboard
        client={{
          load: async () =>
            Promise.reject(
              new DiscoveryFeedClientError(
                "unavailable",
                "service_unavailable",
                "Service unavailable.",
              ),
            ),
        }}
        initialFeed={demoDiscoveryFeed}
        live
        showContinueWatching={false}
      />,
    );

    expect(await screen.findAllByText("Saved results · refresh interrupted")).not.toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1, name: "The Far Meridian" })).toBeVisible();
    expect(screen.getByRole("button", { name: "View details for The Far Meridian" })).toBeVisible();
  });

  it("aborts an in-flight feed request when the dashboard unmounts", async () => {
    let signal: AbortSignal | undefined;
    const load = vi.fn((_input, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      return new Promise<never>(() => undefined);
    });
    const { unmount } = render(
      <DiscoveryDashboard client={{ load }} showContinueWatching={false} />,
    );

    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
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
