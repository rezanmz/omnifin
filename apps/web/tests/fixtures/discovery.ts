import {
  discoveryBrowseQuerySchema,
  type DiscoveryFeedResponse,
} from "@omnifin/contracts/discovery";
import type { Page } from "@playwright/test";

import { demoBrowseResponse } from "../../lib/discovery-browse-demo";
import { demoDiscoveryFeed } from "../../lib/discovery-feed-demo";

function artworkReference(seed: string) {
  return `/v1/discovery/artwork/discovery_art_${seed.repeat(22)}`;
}

export const discoveryFeedFixture = {
  ...demoDiscoveryFeed,
  rails: demoDiscoveryFeed.rails.map((rail) => ({
    ...rail,
    items: rail.items.map((item) => ({
      ...item,
      artwork: {
        backdropPath:
          item.artwork.backdropPath?.replace("/api/discovery/artwork/", "/v1/discovery/artwork/") ??
          null,
        posterPath:
          item.artwork.posterPath?.replace("/api/discovery/artwork/", "/v1/discovery/artwork/") ??
          null,
      },
    })),
  })),
};

export const longTitleDiscoveryFeedFixture: DiscoveryFeedResponse = {
  ...discoveryFeedFixture,
  rails: discoveryFeedFixture.rails.map((rail) => ({
    ...rail,
    items: rail.items.map((item, index) =>
      rail.kind === "trending" && index === 0
        ? {
            ...item,
            overview:
              "A patient expedition maps distant worlds while a signal redraws every route home.",
            title: "The Extraordinary Cartography of Distant Forgotten Worlds",
          }
        : item,
    ),
  })),
};

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
    artwork: { backdropPath: artworkReference("a"), posterPath: artworkReference("b") },
    availability: "unavailable",
    cast: [
      {
        character: "Neo",
        name: "Keanu Reeves",
        personId: 6384,
        profilePath: artworkReference("c"),
      },
      {
        character: "Morpheus",
        name: "Laurence Fishburne",
        personId: 2975,
        profilePath: artworkReference("d"),
      },
      {
        character: "Trinity",
        name: "Carrie-Anne Moss",
        personId: 530,
        profilePath: artworkReference("e"),
      },
      {
        character: "Agent Smith",
        name: "Hugo Weaving",
        personId: 1331,
        profilePath: artworkReference("f"),
      },
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
    profilePath: artworkReference("c"),
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

const discoveryArtworkPalettes = {
  a: ["#07191f", "#16869a", "#b5f4df"],
  b: ["#17100d", "#b95835", "#ffd58a"],
  c: ["#0c170d", "#4b792f", "#d8ff70"],
  d: ["#100f22", "#5c4ead", "#c9bdff"],
  e: ["#1d0c12", "#a43a67", "#ffc2cf"],
  f: ["#061619", "#16786e", "#9df5df"],
} as const;

function discoveryArtwork(url: string) {
  const key = url.match(/discovery_art_([a-f])/u)?.[1] as
    keyof typeof discoveryArtworkPalettes | undefined;
  const [shadow, color, light] = discoveryArtworkPalettes[key ?? "a"];
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1200" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${color}" />
          <stop offset="0.52" stop-color="${shadow}" />
          <stop offset="1" stop-color="#020504" />
        </linearGradient>
        <radialGradient id="flare" cx="74%" cy="18%" r="48%">
          <stop offset="0" stop-color="${light}" stop-opacity="0.88" />
          <stop offset="0.18" stop-color="${color}" stop-opacity="0.44" />
          <stop offset="1" stop-color="${shadow}" stop-opacity="0" />
        </radialGradient>
        <filter id="soft"><feGaussianBlur stdDeviation="28" /></filter>
      </defs>
      <rect width="800" height="1200" fill="url(#field)" />
      <rect width="800" height="1200" fill="url(#flare)" />
      <circle cx="610" cy="248" r="176" fill="none" stroke="${light}" stroke-opacity="0.28" stroke-width="2" />
      <circle cx="610" cy="248" r="118" fill="${color}" fill-opacity="0.3" filter="url(#soft)" />
      <path d="M-120 870 C150 610 380 620 940 360" fill="none" stroke="${light}" stroke-opacity="0.22" stroke-width="3" />
      <path d="M-160 940 C210 720 480 760 980 520" fill="none" stroke="${light}" stroke-opacity="0.11" stroke-width="2" />
      <path d="M110 1200 L360 540 L610 1200 Z" fill="${shadow}" fill-opacity="0.68" />
      <path d="M260 1200 L520 690 L760 1200 Z" fill="#020504" fill-opacity="0.72" />
      <circle cx="132" cy="180" r="7" fill="${light}" fill-opacity="0.8" />
      <circle cx="176" cy="224" r="3" fill="${light}" fill-opacity="0.5" />
    </svg>`;
}

export async function mockDiscoveryFeed(
  page: Page,
  feed: DiscoveryFeedResponse = discoveryFeedFixture,
) {
  await page.route("**/api/discovery/feed?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify(feed),
      contentType: "application/json",
      status: 200,
    });
  });
  await mockDiscoveryArtwork(page);
}

export async function mockDiscoveryArtwork(page: Page) {
  await page.route("**/api/discovery/artwork/discovery_art_*", async (route) => {
    await route.fulfill({
      body: discoveryArtwork(route.request().url()),
      contentType: "image/svg+xml; charset=utf-8",
      headers: { "cache-control": "private, max-age=3600" },
      status: 200,
    });
  });
}

export async function mockDiscoveryBrowse(page: Page) {
  await page.route("**/api/discovery/browse?**", async (route) => {
    const criteria = discoveryBrowseQuerySchema.parse(
      Object.fromEntries(new URL(route.request().url()).searchParams),
    );
    const items = demoBrowseResponse.items.map((item, index) => ({
      ...item,
      artwork: {
        backdropPath:
          item.artwork.backdropPath?.replace("/api/discovery/artwork/", "/v1/discovery/artwork/") ??
          null,
        posterPath:
          item.artwork.posterPath?.replace("/api/discovery/artwork/", "/v1/discovery/artwork/") ??
          null,
      },
      id: criteria.kind === "series" ? `series:${item.tmdbId + 10_000}` : item.id,
      kind: criteria.kind,
      title: criteria.kind === "series" ? `${item.title} Files` : item.title,
      tmdbId: criteria.kind === "series" ? item.tmdbId + 10_000 : item.tmdbId,
      voteAverage: Math.max(0, (item.voteAverage ?? 0) - index * 0.01),
    }));
    await route.fulfill({
      body: JSON.stringify({
        criteria,
        generatedAt: "2026-08-02T12:00:00.000Z",
        items,
        page: criteria.page,
        totalPages: 12,
        totalResults: 238,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await mockDiscoveryArtwork(page);
}

export async function mockDiscoveryDetails(page: Page) {
  await mockDiscoveryArtwork(page);
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

export async function mockDiscoveryFeedDetails(page: Page) {
  await page.route("**/api/discovery/details/movie/603?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        ...discoveryMovieDetailFixture,
        item: {
          ...discoveryMovieDetailFixture.item,
          originalTitle: null,
          overview: "A deep-space survey hears a pattern no instrument was designed to find.",
          tagline: "Follow the signal.",
          title: "The Far Meridian",
          year: 2026,
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}
