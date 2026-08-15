import type { DiscoveryFeedItem, DiscoveryFeedResponse } from "@omnifin/contracts/discovery";
import { describe, expect, it } from "vitest";

import { discoveryItemIsRequestable, discoverySpotlightItems } from "./discovery-presentation";

const requestableItem = {
  artwork: { backdropPath: null, posterPath: null },
  availability: "unknown",
  id: "movie:603",
  kind: "movie",
  mediaRecordState: "absent",
  originalTitle: "The Matrix",
  overview: null,
  source: "seerr",
  title: "The Matrix",
  tmdbId: 603,
  voteAverage: 8.2,
  year: 1999,
} as const satisfies DiscoveryFeedItem;

function spotlightItem(id: string): DiscoveryFeedItem {
  return {
    ...requestableItem,
    id,
    title: id,
    tmdbId: Number(id.slice(-1)),
  };
}

describe("discovery presentation", () => {
  it("uses the shared requestability policy for a discovery item", () => {
    expect(discoveryItemIsRequestable(requestableItem)).toBe(true);
    expect(discoveryItemIsRequestable({ ...requestableItem, mediaRecordState: "unknown" })).toBe(
      false,
    );
  });

  it("returns the first five unique trending items before filling from other rails", () => {
    const first = spotlightItem("movie:1");
    const second = spotlightItem("movie:2");
    const third = spotlightItem("movie:3");
    const fourth = spotlightItem("movie:4");
    const fifth = spotlightItem("movie:5");
    const fallback = spotlightItem("movie:6");
    const feed = {
      failures: [],
      generatedAt: "2026-08-15T00:00:00.000Z",
      rails: [
        {
          failure: null,
          items: [first, second, third, fourth],
          kind: "trending",
          totalResults: 4,
          truncated: false,
        },
        {
          failure: null,
          items: [second, fifth, fallback],
          kind: "popular_movies",
          totalResults: 3,
          truncated: false,
        },
      ],
      state: "complete",
    } as const satisfies DiscoveryFeedResponse;

    expect(discoverySpotlightItems(feed)).toEqual([first, second, third, fourth, fifth]);
  });
});
