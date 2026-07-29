import type {
  DiscoveryMediaDetailResponse,
  DiscoveryPersonDetailResponse,
} from "@omnifin/contracts/discovery";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoveryMediaDetailClient, discoveryPersonDetailClient } from "./media-details";

const response: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    availability: "available",
    cast: [{ character: "Neo", name: "Keanu Reeves", personId: 6384 }],
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
    deathday: null,
    department: "Acting",
    id: "person:6384",
    name: "Keanu Reeves",
    source: "seerr",
    tmdbId: 6384,
  },
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

  it.each([
    { code: "authentication_required", expected: "signed_out", status: 401 },
    { code: "permission_denied", expected: "forbidden", status: 403 },
    { code: "discovery_not_configured", expected: "not_configured", status: 503 },
    { code: "discovery_rate_limited", expected: "rate_limited", status: 429 },
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
