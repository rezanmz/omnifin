import type {
  DiscoveryBrowseQuery,
  DiscoveryBrowseResponse,
  DiscoveryFeedItem,
} from "@omnifin/contracts/discovery";

export const demoBrowseCriteria: DiscoveryBrowseQuery = {
  availability: "any",
  kind: "movie",
  locale: "en",
  minimumRating: 7,
  page: 1,
  sort: "popularity",
};

const titles = [
  [603, "The Far Meridian", "unavailable", 8.8, 2026],
  [711, "Glass Horizon", "available", 8.3, 2025],
  [712, "The Quiet Index", "requested", 8.1, 2024],
  [713, "Aperture", "partial", 7.9, 2026],
  [714, "Low Orbit", "processing", 7.8, 2023],
  [715, "Field Notes", "available", 7.7, 2022],
  [716, "Ember Coast", "unavailable", 7.6, 2025],
  [717, "Violet Crossing", "unavailable", 7.5, 2027],
  [718, "Second Sun", "available", 7.4, 2021],
  [719, "The Long Meridian", "unavailable", 7.2, 2026],
] as const;

function artwork(index: number) {
  const seed = String.fromCharCode(97 + (index % 6));
  return `/api/discovery/artwork/discovery_art_${seed.repeat(22)}`;
}

const items: DiscoveryFeedItem[] = titles.map(
  ([tmdbId, title, availability, voteAverage, year], index) => ({
    artwork: { backdropPath: artwork(index + 1), posterPath: artwork(index) },
    availability,
    mediaRecordState: "present",
    id: `movie:${tmdbId}`,
    kind: "movie",
    originalTitle: null,
    overview: "A considered catalogue result surfaced through the connected Seerr signal.",
    source: "seerr",
    title,
    tmdbId,
    voteAverage,
    year,
  }),
);

export const demoBrowseResponse: DiscoveryBrowseResponse = {
  criteria: demoBrowseCriteria,
  generatedAt: "2026-08-02T12:00:00.000Z",
  items,
  page: 1,
  totalPages: 12,
  totalResults: 238,
};

export const emptyBrowseResponse: DiscoveryBrowseResponse = {
  ...demoBrowseResponse,
  items: [],
  totalPages: 0,
  totalResults: 0,
};
