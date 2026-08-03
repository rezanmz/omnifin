import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { demoDiscoveryFeed } from "../lib/discovery-feed-demo";
import { DeferredDiscoveryDashboard } from "./deferred-discovery-dashboard";

describe("DeferredDiscoveryDashboard", () => {
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
