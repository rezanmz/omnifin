import type { DiscoveryFeedItem } from "@omnifin/contracts/discovery";
import { describe, expect, it } from "vitest";

import { discoveryItemIsRequestable } from "./discovery-presentation";

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

describe("discovery presentation", () => {
  it("uses the shared requestability policy for a discovery item", () => {
    expect(discoveryItemIsRequestable(requestableItem)).toBe(true);
    expect(discoveryItemIsRequestable({ ...requestableItem, mediaRecordState: "unknown" })).toBe(
      false,
    );
  });
});
