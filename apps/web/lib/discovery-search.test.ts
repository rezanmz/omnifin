import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverySearchClient } from "./discovery-search";

const response = {
  generatedAt: "2026-07-27T07:00:00.000Z",
  items: [
    {
      availability: "available",
      id: "movie:603",
      kind: "movie",
      originalTitle: "The Matrix",
      overview: "A hacker discovers the nature of reality.",
      source: "seerr",
      title: "The Matrix",
      tmdbId: 603,
      voteAverage: 8.2,
      year: 1999,
    },
  ],
  page: 1,
  query: "matrix",
  totalPages: 1,
  totalResults: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery search client", () => {
  it("sends a bounded same-origin query and parses the normalized response", async () => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverySearchClient.search({ language: "en-CA", page: 1, query: "  matrix  " }),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/discovery/search?language=en-CA&page=1&query=matrix",
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
      discoverySearchClient.search({ language: "en", page: 1, query: "matrix" }),
    ).rejects.toMatchObject({ code, kind: expected });
  });

  it.each([
    { expected: "signed_out", status: 401 },
    { expected: "forbidden", status: 403 },
  ])(
    "preserves the $expected state when an auth error has no JSON body",
    async ({ expected, status }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );

      await expect(
        discoverySearchClient.search({ language: "en", page: 1, query: "matrix" }),
      ).rejects.toMatchObject({ code: "request_failed", kind: expected });
    },
  );

  it("rejects raw or malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...response, apiKey: "private" })),
    );

    await expect(
      discoverySearchClient.search({ language: "en", page: 1, query: "matrix" }),
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
      discoverySearchClient.search({ language: "en", page: 1, query: "matrix" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
