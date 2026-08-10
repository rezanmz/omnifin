import type { DiscoveryBrowseResponse } from "@omnifin/contracts/discovery";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoveryBrowseClient, type DiscoveryBrowseClientError } from "./discovery-browse";

const response: DiscoveryBrowseResponse = {
  criteria: {
    availability: "requestable",
    genre: "science-fiction",
    kind: "movie",
    locale: "en-CA",
    minimumRating: 7.5,
    page: 2,
    sort: "rating",
  },
  generatedAt: "2026-08-03T10:00:00.000Z",
  items: [
    {
      artwork: {
        backdropPath: null,
        posterPath: "/v1/discovery/artwork/discovery_art_abcdefghijklmnopqrstuv",
      },
      availability: "unavailable",
      mediaRecordState: "absent",
      id: "movie:603",
      kind: "movie",
      originalTitle: null,
      overview: "A bounded browse result.",
      source: "seerr",
      title: "The Matrix",
      tmdbId: 603,
      voteAverage: 8.2,
      year: 1999,
    },
  ],
  page: 2,
  totalPages: 5,
  totalResults: 84,
};

afterEach(() => vi.unstubAllGlobals());

describe("discovery browse client", () => {
  it("serializes only normalized criteria and maps opaque artwork to the web proxy", async () => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoveryBrowseClient.load(response.criteria);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/discovery/browse?availability=requestable&kind=movie&locale=en-CA&page=2&sort=rating&genre=science-fiction&minimumRating=7.5",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(result.items[0]?.artwork.posterPath).toBe(
      "/api/discovery/artwork/discovery_art_abcdefghijklmnopqrstuv",
    );
  });

  it("rejects unsafe artwork and maps session failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ...response,
            items: [
              {
                ...response.items[0],
                artwork: { backdropPath: null, posterPath: "https://private.invalid/poster.jpg" },
              },
            ],
          },
          { status: 200 },
        ),
      ),
    );
    await expect(discoveryBrowseClient.load(response.criteria)).rejects.toMatchObject({
      kind: "invalid_response",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "not_authenticated" } }, { status: 401 })),
    );
    await expect(discoveryBrowseClient.load(response.criteria)).rejects.toEqual(
      expect.objectContaining<Partial<DiscoveryBrowseClientError>>({ kind: "signed_out" }),
    );
  });
});
