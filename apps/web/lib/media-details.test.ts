import type {
  DiscoveryMediaDetailResponse,
  DiscoveryPersonCreditsResponse,
  DiscoveryPersonDetailResponse,
} from "@omnifin/contracts/discovery";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoveryMediaDetailClient,
  discoveryPersonCreditsClient,
  discoveryPersonDetailClient,
} from "./media-details";

const response: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    artwork: { backdropPath: null, posterPath: null },
    availability: "available",
    mediaRecordState: "present",
    cast: [{ character: "Neo", name: "Keanu Reeves", personId: 6384, profilePath: null }],
    crew: [{ name: "Lana Wachowski", personId: 9340, role: "Director" }],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
    originalTitle: "The Matrix",
    overview: "A hacker discovers that the world he knows is a constructed reality.",
    productionStatus: "Released",
    runtimeMinutes: 136,
    source: "seerr",
    tagline: "Free your mind.",
    title: "The Matrix",
    tmdbId: 603,
    voteAverage: 8.2,
    voteCount: 27_000,
    year: 1999,
  },
};

const personResponse: DiscoveryPersonDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    biography: "A performer known for precise genre work.",
    birthday: "1964-09-02",
    birthplace: "Beirut, Lebanon",
    credits: [],
    creditsState: "empty",
    creditsTotal: 0,
    deathday: null,
    department: "Acting",
    id: "person:6384",
    name: "Keanu Reeves",
    profilePath: null,
    source: "seerr",
    tmdbId: 6384,
  },
};

const personCreditsResponse: DiscoveryPersonCreditsResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  items: Array.from({ length: 6 }, (_, index) => ({
    availability: "available",
    mediaRecordState: "present",
    kind: "movie",
    role: `Role ${index + 25}`,
    title: `Movie ${index + 25}`,
    tmdbId: 1_000 + index,
    voteAverage: 7,
    year: 2024,
  })),
  page: 2,
  pageSize: 24,
  totalPages: 2,
  totalResults: 30,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media detail client", () => {
  it("loads a bounded same-origin detail and parses the normalized response", async () => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoveryMediaDetailClient.load({ kind: "movie", tmdbId: 603 }, { language: "en-CA" }),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/discovery/details/movie/603?language=en-CA",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("rewrites only opaque title, cast, and person artwork references", async () => {
    const reference = `discovery_art_${"a".repeat(22)}`;
    const upstreamPath = `/v1/discovery/artwork/${reference}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...response,
          item: {
            ...response.item,
            artwork: { backdropPath: upstreamPath, posterPath: upstreamPath },
            cast: response.item.cast.map((credit) => ({ ...credit, profilePath: upstreamPath })),
          },
        }),
      ),
    );

    await expect(
      discoveryMediaDetailClient.load({ kind: "movie", tmdbId: 603 }, { language: "en" }),
    ).resolves.toMatchObject({
      item: {
        artwork: {
          backdropPath: `/api/discovery/artwork/${reference}`,
          posterPath: `/api/discovery/artwork/${reference}`,
        },
        cast: [{ profilePath: `/api/discovery/artwork/${reference}` }],
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...personResponse,
          item: { ...personResponse.item, profilePath: upstreamPath },
        }),
      ),
    );
    await expect(
      discoveryPersonDetailClient.load({ tmdbId: 6384 }, { language: "en" }),
    ).resolves.toMatchObject({
      item: { profilePath: `/api/discovery/artwork/${reference}` },
    });
  });

  it.each([
    { code: "authentication_required", expected: "signed_out", status: 401 },
    { code: "permission_denied", expected: "forbidden", status: 403 },
    { code: "discovery_not_configured", expected: "not_configured", status: 503 },
    { code: "discovery_rate_limited", expected: "rate_limited", status: 429 },
    { code: "discovery_response_invalid", expected: "invalid_response", status: 502 },
    { code: "discovery_timeout", expected: "timed_out", status: 504 },
    { code: "discovery_unauthorized", expected: "unauthorized", status: 502 },
    { code: "discovery_unsupported", expected: "unsupported", status: 502 },
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

    await expect(
      discoveryMediaDetailClient.load({ kind: "movie", tmdbId: 603 }, { language: "en" }),
    ).rejects.toMatchObject({ code, kind: expected });
  });

  it("rejects raw or malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...response, apiKey: "private" })),
    );

    await expect(
      discoveryMediaDetailClient.load({ kind: "movie", tmdbId: 603 }, { language: "en" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("preserves aborts without converting them into offline errors", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new DOMException("Aborted", "AbortError"))),
    );

    await expect(
      discoveryMediaDetailClient.load(
        { kind: "movie", tmdbId: 603 },
        { language: "en" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("loads normalized person context through a same-origin route", async () => {
    const fetchMock = vi.fn(async () => Response.json(personResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoveryPersonDetailClient.load({ tmdbId: 6384 }, { language: "en-CA" }),
    ).resolves.toEqual(personResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/discovery/people/6384?language=en-CA",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("loads a bounded person-credit page through a same-origin route", async () => {
    const fetchMock = vi.fn(async () => Response.json(personCreditsResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoveryPersonCreditsClient.load({ tmdbId: 6384 }, { language: "en-CA", page: 2 }),
    ).resolves.toEqual(personCreditsResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/discovery/people/6384/credits?language=en-CA&page=2",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("maps person-route failures and rejects malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "discovery_rate_limited",
              message: "Pause briefly.",
              requestId: "request-12345678",
            },
          },
          { status: 429 },
        ),
      ),
    );
    await expect(
      discoveryPersonDetailClient.load({ tmdbId: 6384 }, { language: "en" }),
    ).rejects.toMatchObject({ kind: "rate_limited" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...personResponse, apiKey: "raw" })),
    );
    await expect(
      discoveryPersonDetailClient.load({ tmdbId: 6384 }, { language: "en" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { headers: { "content-type": "text/plain" } })),
    );
    await expect(
      discoveryPersonDetailClient.load({ tmdbId: 6384 }, { language: "en" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("preserves person aborts and normalizes transport outages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new DOMException("Aborted", "AbortError"))),
    );
    await expect(
      discoveryPersonDetailClient.load({ tmdbId: 6384 }, { language: "en" }),
    ).rejects.toMatchObject({ name: "AbortError" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("private transport"))),
    );
    await expect(
      discoveryPersonDetailClient.load({ tmdbId: 6384 }, { language: "en" }),
    ).rejects.toMatchObject({ code: "service_unavailable", kind: "unavailable" });
  });
});
