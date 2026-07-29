import type { Page } from "@playwright/test";

export const discoverySearchFixture = {
  generatedAt: "2026-07-27T08:30:00.000Z",
  items: [
    {
      availability: "unavailable",
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

export const discoveryMovieDetailFixture = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    availability: "unavailable",
    cast: [
      { character: "Neo", name: "Keanu Reeves", personId: 6384 },
      { character: "Morpheus", name: "Laurence Fishburne", personId: 2975 },
      { character: "Trinity", name: "Carrie-Anne Moss", personId: 530 },
      { character: "Agent Smith", name: "Hugo Weaving", personId: 1331 },
    ],
    crew: [
      { name: "Lana Wachowski", personId: 9340, role: "Director" },
      { name: "Lilly Wachowski", personId: 9341, role: "Writer" },
      { name: "Bill Pope", personId: 13302, role: "Director of Photography" },
      { name: "Don Davis", personId: 1262, role: "Original Music Composer" },
    ],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    intelligence: {
      ratings: [
        {
          audience: "community",
          label: "TMDB",
          scale: 10,
          sentiment: null,
          source: "tmdb",
          value: 8.2,
          voteCount: 27_000,
        },
        {
          audience: "community",
          label: "IMDb",
          scale: 10,
          sentiment: null,
          source: "imdb",
          value: 8.7,
          voteCount: 2_100_000,
        },
        {
          audience: "critics",
          label: "Tomatometer",
          scale: 100,
          sentiment: "Certified Fresh",
          source: "rotten_tomatoes",
          value: 83,
          voteCount: null,
        },
        {
          audience: "audience",
          label: "RT audience",
          scale: 100,
          sentiment: "Upright",
          source: "rotten_tomatoes",
          value: 85,
          voteCount: null,
        },
      ],
      ratingsState: "ready",
      recommendations: [
        {
          availability: "requested",
          id: "movie:604",
          kind: "movie",
          originalTitle: "The Matrix Reloaded",
          overview: "The signal continues.",
          source: "seerr",
          title: "The Matrix Reloaded",
          tmdbId: 604,
          voteAverage: 7.1,
          year: 2003,
        },
      ],
      recommendationsState: "ready",
      trailers: [
        {
          id: "youtube:m8e-FF8MsqU",
          provider: "youtube",
          resolution: 1080,
          title: "The Matrix — official trailer",
          type: "trailer",
        },
      ],
    },
    kind: "movie",
    originalTitle: "The Matrix",
    overview:
      "A hacker discovers that the world he knows is a constructed reality and joins a rebellion fighting to free humanity from its hidden machinery.",
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
} as const;

export const discoveryPersonDetailFixture = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    biography:
      "An actor and producer whose work spans independent drama, action cinema, and landmark science fiction.",
    birthday: "1964-09-02",
    birthplace: "Beirut, Lebanon",
    credits: [
      {
        availability: "available",
        kind: "movie",
        role: "Neo",
        title: "The Matrix",
        tmdbId: 603,
        voteAverage: 8.2,
        year: 1999,
      },
    ],
    creditsState: "ready",
    deathday: null,
    department: "Acting",
    id: "person:6384",
    name: "Keanu Reeves",
    source: "seerr",
    tmdbId: 6384,
  },
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

export async function mockDiscoveryDetails(page: Page) {
  await page.route("**/api/discovery/details/movie/603?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify(discoveryMovieDetailFixture),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/discovery/people/6384?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify(discoveryPersonDetailFixture),
      contentType: "application/json",
      status: 200,
    });
  });
}
