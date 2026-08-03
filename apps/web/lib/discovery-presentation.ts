import type { DiscoveryFeedItem, DiscoveryFeedResponse } from "@omnifin/contracts/discovery";

import type { DashboardModel } from "./dashboard-data";

const ACCENTS = ["#8ce8d3", "#a9d7ff", "#d8ff70", "#f0a77b", "#c9adff", "#f29ab5"];

export function discoveryAccent(item: DiscoveryFeedItem) {
  return ACCENTS[item.tmdbId % ACCENTS.length]!;
}

export function discoveryAvailabilityLabel(item: DiscoveryFeedItem) {
  return {
    available: "Ready to watch",
    partial: "Partially available",
    processing: "Acquiring",
    requested: "Requested",
    unavailable: "Available to request",
    unknown: "Availability unknown",
  }[item.availability];
}

export function discoveryItemFacts(item: DiscoveryFeedItem) {
  return [
    item.kind === "movie" ? "Movie" : "Series",
    item.year,
    item.voteAverage === null ? null : `${item.voteAverage.toFixed(1)} ★`,
    discoveryAvailabilityLabel(item),
  ]
    .filter((fact): fact is string | number => fact !== null)
    .map(String);
}

export function discoveryItemMedia(item: DiscoveryFeedItem) {
  return {
    availability: item.availability,
    id: item.id,
    kind: item.kind,
    originalTitle: item.originalTitle,
    overview: item.overview,
    source: item.source,
    title: item.title,
    tmdbId: item.tmdbId,
    voteAverage: item.voteAverage,
    year: item.year,
  };
}

export function discoveryItemIsRequestable(item: DiscoveryFeedItem) {
  return item.availability === "unavailable" || item.availability === "partial";
}

export function discoverySpotlightItem(feed: DiscoveryFeedResponse) {
  return (
    feed.rails.find(({ kind }) => kind === "trending")?.items[0] ??
    feed.rails.flatMap((rail) => rail.items)[0] ??
    null
  );
}

export function discoverySpotlightHero(item: DiscoveryFeedItem): DashboardModel["hero"] {
  return {
    accent: discoveryAccent(item),
    actions: "none",
    description:
      item.overview ?? "Open the full detail view for normalized metadata and availability.",
    eyebrow: "Trending through Seerr",
    facts: discoveryItemFacts(item),
    title: item.title,
  };
}
