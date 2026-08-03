import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { demoDiscoveryFeed } from "../lib/discovery-feed-demo";
import { discoverySpotlightItem } from "../lib/discovery-presentation";
import { DiscoveryHeroActions } from "./discovery-hero-actions";

describe("DiscoveryHeroActions", () => {
  it("keeps details and quick request controls interactive as a focused client island", async () => {
    const item = discoverySpotlightItem(demoDiscoveryFeed);
    expect(item).not.toBeNull();
    if (!item) return;
    const user = userEvent.setup();
    render(<DiscoveryHeroActions item={item} />);

    await user.click(screen.getByRole("button", { name: "View details" }));
    expect(await screen.findByRole("dialog", { name: `${item.title} details` })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Request title" }));
    expect(await screen.findByRole("dialog", { name: "Compose request" })).toBeVisible();
  });
});
