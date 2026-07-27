import type { Page } from "@playwright/test";

export const discoverySearchFixture = {
  generatedAt: "2026-07-27T08:30:00.000Z",
  items: [
    {
      availability: "available",
      id: "movie:603",
      kind: "movie",
      originalTitle: "The Matrix",
      overview: "A hacker discovers that the world he knows is a constructed reality.",
      source: "seerr",
      title: "The Matrix",
      tmdbId: 603,
      voteAverage: 8.2,
      year: 1999,
    },
    {
      availability: "requested",
      id: "series:1396",
      kind: "series",
      originalTitle: "Breaking Bad",
      overview: "A chemistry teacher turns to manufacturing after a life-changing diagnosis.",
      source: "seerr",
      title: "Breaking Bad",
      tmdbId: 1396,
      voteAverage: 8.9,
      year: 2008,
    },
    {
      id: "person:287",
      kind: "person",
      knownFor: [
        { kind: "movie", title: "Fight Club", year: 1999 },
        { kind: "movie", title: "Se7en", year: 1995 },
      ],
      source: "seerr",
      title: "Brad Pitt",
      tmdbId: 287,
    },
  ],
  page: 1,
  query: "matrix",
  totalPages: 1,
  totalResults: 3,
} as const;

export async function mockDiscoverySearch(page: Page) {
  await page.route("**/api/discovery/search?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify(discoverySearchFixture),
      contentType: "application/json",
      status: 200,
    });
  });
}
