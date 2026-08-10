import type {
  DiscoveryFeedItem,
  DiscoveryFeedRail,
  DiscoveryFeedRailKind,
  DiscoveryFeedResponse,
} from "@omnifin/contracts/discovery";

const artworkReferences = ["a", "b", "c", "d", "e", "f"] as const;

function artworkPath(index: number) {
  const token = artworkReferences[index % artworkReferences.length]!.repeat(22);
  return `/api/discovery/artwork/discovery_art_${token}`;
}

function movie(
  id: number,
  title: string,
  options: Partial<DiscoveryFeedItem> = {},
): DiscoveryFeedItem {
  return {
    artwork: {
      backdropPath: artworkPath(id + 1),
      posterPath: artworkPath(id),
    },
    availability: "available",
    mediaRecordState: "present",
    id: `movie:${id}`,
    kind: "movie",
    originalTitle: null,
    overview: "A precise, atmospheric story surfaced through the connected Seerr catalog.",
    source: "seerr",
    title,
    tmdbId: id,
    voteAverage: 8.2,
    year: 2026,
    ...options,
  } as DiscoveryFeedItem;
}

function series(
  id: number,
  title: string,
  options: Partial<DiscoveryFeedItem> = {},
): DiscoveryFeedItem {
  return {
    artwork: {
      backdropPath: artworkPath(id + 1),
      posterPath: artworkPath(id),
    },
    availability: "available",
    mediaRecordState: "present",
    id: `series:${id}`,
    kind: "series",
    originalTitle: null,
    overview: "An editorial series recommendation normalized from the connected Seerr catalog.",
    source: "seerr",
    title,
    tmdbId: id,
    voteAverage: 8.5,
    year: 2025,
    ...options,
  } as DiscoveryFeedItem;
}

const items: Record<DiscoveryFeedRailKind, DiscoveryFeedItem[]> = {
  popular_movies: [
    movie(711, "Glass Horizon"),
    movie(712, "The Quiet Index"),
    movie(713, "Aperture"),
    movie(714, "Low Orbit"),
    movie(715, "Field Notes"),
  ],
  popular_series: [
    series(821, "Northern Lights"),
    series(822, "The Last Frequency"),
    series(823, "Signal House"),
    series(824, "Afterimage"),
    series(825, "Static Bloom"),
  ],
  trending: [
    movie(603, "The Far Meridian", {
      availability: "unavailable",
      overview:
        "A deep-space survey hears a pattern no instrument was designed to find—and every answer changes the shape of home.",
      voteAverage: 8.8,
    }),
    series(604, "The Quiet Archive"),
    movie(605, "Ember Coast"),
    series(606, "Red Valley"),
    movie(607, "Monolith Season"),
  ],
  upcoming: [
    movie(931, "Violet Crossing", { availability: "unavailable", year: 2027 }),
    series(932, "Northstar", { availability: "unavailable", year: 2027 }),
    movie(933, "Second Sun", { availability: "unavailable", year: 2027 }),
    series(934, "Contour", { availability: "unavailable", year: 2027 }),
    movie(935, "The Long Meridian", { availability: "unavailable", year: 2027 }),
  ],
};

function rail(kind: DiscoveryFeedRailKind): DiscoveryFeedRail {
  return {
    failure: null,
    items: items[kind],
    kind,
    totalResults: items[kind].length,
    truncated: false,
  };
}

export const demoDiscoveryFeed: DiscoveryFeedResponse = {
  failures: [],
  generatedAt: "2026-07-29T20:00:00.000Z",
  rails: [rail("trending"), rail("popular_movies"), rail("popular_series"), rail("upcoming")],
  state: "complete",
};

const interruptedFailure = {
  code: "timeout" as const,
  message: "The discovery rail could not be loaded.",
  occurredAt: "2026-07-29T20:00:00.000Z",
  operation: "discovery.feed.popular_series",
  retryable: true,
  service: "seerr" as const,
};

export const degradedDiscoveryFeed: DiscoveryFeedResponse = {
  ...demoDiscoveryFeed,
  failures: [interruptedFailure],
  rails: demoDiscoveryFeed.rails.map((candidate) =>
    candidate.kind === "popular_series"
      ? {
          failure: interruptedFailure,
          items: [],
          kind: candidate.kind,
          totalResults: 0,
          truncated: false,
        }
      : candidate,
  ),
  state: "degraded",
};

export const emptyDiscoveryFeed: DiscoveryFeedResponse = {
  ...demoDiscoveryFeed,
  rails: demoDiscoveryFeed.rails.map((candidate) => ({
    ...candidate,
    items: [],
    totalResults: 0,
  })),
  state: "empty",
};

export const unavailableDiscoveryFeed: DiscoveryFeedResponse = {
  ...demoDiscoveryFeed,
  failures: demoDiscoveryFeed.rails.map((candidate) => ({
    ...interruptedFailure,
    operation: `discovery.feed.${candidate.kind}`,
  })),
  rails: demoDiscoveryFeed.rails.map((candidate) => ({
    failure: {
      ...interruptedFailure,
      operation: `discovery.feed.${candidate.kind}`,
    },
    items: [],
    kind: candidate.kind,
    totalResults: 0,
    truncated: false,
  })),
  state: "unavailable",
};
