import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoDiscoveryFeed } from "../lib/discovery-feed-demo";
import { DeferredDiscoveryDashboard } from "./deferred-discovery-dashboard";

describe("DeferredDiscoveryDashboard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps below-fold discovery dormant until the user scrolls", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(<DeferredDiscoveryDashboard initialFeed={demoDiscoveryFeed} />);

    vi.advanceTimersByTime(10_000);

    expect(screen.getByRole("region", { name: "Preparing connected discovery" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Request The Far Meridian" }),
    ).not.toBeInTheDocument();
  });

  it("reserves spotlight geometry when connected discovery owns the hero", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(
      <DeferredDiscoveryDashboard
        initialFeed={demoDiscoveryFeed}
        live
        showContinueWatching
        suppressHero={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Loading connected discovery" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Preparing connected discovery" })).toBeVisible();
  });

  it("keeps passive discovery work beyond the largest-contentful-paint window", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    const requestIdleCallback = vi.fn(() => 23);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    render(<DeferredDiscoveryDashboard initialFeed={demoDiscoveryFeed} />);

    frames[0]?.(0);
    frames[1]?.(16);
    vi.advanceTimersByTime(2_999);
    expect(requestIdleCallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(requestIdleCallback).toHaveBeenCalledOnce();
  });

  it("reserves rail geometry and loads interactive discovery on user intent", async () => {
    render(<DeferredDiscoveryDashboard initialFeed={demoDiscoveryFeed} />);

    expect(screen.getByRole("region", { name: "Preparing connected discovery" })).toBeVisible();
    expect(screen.getAllByRole("article", { hidden: true })).toHaveLength(20);

    fireEvent.scroll(window);

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Preparing connected discovery" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Trending now" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Request The Far Meridian" })).not.toHaveLength(0);
  });
});
