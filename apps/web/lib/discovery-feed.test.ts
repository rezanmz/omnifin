import { afterEach, describe, expect, it, vi } from "vitest";

import { discoveryFeedClient } from "./discovery-feed";

const reference = `discovery_art_${"a".repeat(22)}`;
const feed = {
  failures: [],
  generatedAt: "2026-07-29T18:00:00.000Z",
  rails: ["trending", "popular_movies", "popular_series", "upcoming"].map((kind, index) => ({
    failure: null,
    items: [
      {
        artwork: {
          backdropPath: `/v1/discovery/artwork/${reference}`,
          posterPath: `/v1/discovery/artwork/${reference}`,
        },
        availability: "available",
        id: `movie:${index + 1}`,
        kind: "movie",
        originalTitle: null,
        overview: "A normalized synopsis.",
        source: "seerr",
        title: `Title ${index + 1}`,
        tmdbId: index + 1,
        voteAverage: 8.2,
        year: 2026,
      },
    ],
    kind,
    totalResults: 1,
    truncated: false,
  })),
  state: "complete",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery feed client", () => {
  it("loads a normalized same-origin feed and rewrites only opaque artwork paths", async () => {
    const fetchMock = vi.fn(async () => Response.json(feed));
    vi.stubGlobal("fetch", fetchMock);

    const response = await discoveryFeedClient.load({ language: "en-CA" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/discovery/feed?language=en-CA",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(response.rails[0]!.items[0]!.artwork).toEqual({
      backdropPath: `/api/discovery/artwork/${reference}`,
      posterPath: `/api/discovery/artwork/${reference}`,
    });
    expect(JSON.stringify(response)).not.toContain("/v1/discovery/artwork");
  });

  it.each([
    { code: "authentication_required", expected: "signed_out", status: 401 },
    { code: "permission_denied", expected: "forbidden", status: 403 },
    { code: "discovery_not_configured", expected: "not_configured", status: 503 },
    { code: "discovery_configuration_unavailable", expected: "unavailable", status: 503 },
  ])("maps $code to $expected", async ({ code, expected, status }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code, message: "A safe public message.", requestId: "request-12345678" } },
          { status },
        ),
      ),
    );

    await expect(discoveryFeedClient.load({ language: "en" })).rejects.toMatchObject({
      code,
      kind: expected,
    });
  });

  it("rejects malformed successful responses before any artwork is rendered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...feed, apiKey: "private" })),
    );

    await expect(discoveryFeedClient.load({ language: "en" })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("preserves request cancellation", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(abort)),
    );

    await expect(discoveryFeedClient.load({ language: "en" })).rejects.toBe(abort);
  });
});
