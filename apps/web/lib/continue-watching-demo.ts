import type { ContinueWatchingResponse } from "@omnifin/contracts/dashboard";

export const demoContinueWatchingFeed: ContinueWatchingResponse = {
  failures: [],
  generatedAt: "2026-07-28T05:00:00.000Z",
  items: [
    {
      durationSeconds: 2_700,
      lastPlayedAt: "2026-07-28T04:45:00.000Z",
      media: {
        artwork: {
          accentColor: "#5d9690",
          backdropPath: `/v1/media/media_${"b".repeat(22)}/images/backdrop`,
          blurHash: null,
          posterPath: `/v1/media/media_${"b".repeat(22)}/images/poster`,
        },
        availability: "available",
        contentRating: "TV-14",
        id: `media_${"b".repeat(22)}`,
        kind: "episode",
        overview: "A receiver resolves a signal beyond the ice.",
        runtimeMinutes: 45,
        subtitle: "S02E03 · The Long Meridian",
        title: "Northern Lights",
        year: 2026,
      },
      positionSeconds: 900,
      progressPercent: 33.3,
    },
    {
      durationSeconds: 7_680,
      lastPlayedAt: "2026-07-27T23:20:00.000Z",
      media: {
        artwork: {
          accentColor: null,
          backdropPath: null,
          blurHash: null,
          posterPath: null,
        },
        availability: "available",
        contentRating: "PG-13",
        id: `media_${"c".repeat(22)}`,
        kind: "movie",
        overview: "A signal crosses the horizon.",
        runtimeMinutes: 128,
        subtitle: null,
        title: "The Far Meridian",
        year: 2026,
      },
      positionSeconds: 2_400,
      progressPercent: 31.25,
    },
  ],
  source: {
    connectorId: "jellyfin-main",
    displayName: "Home Jellyfin",
    failure: null,
    status: "healthy",
  },
  state: "complete",
  truncated: false,
};

export const emptyContinueWatchingFeed: ContinueWatchingResponse = {
  ...demoContinueWatchingFeed,
  items: [],
  state: "empty",
};

const unavailableFailure = {
  code: "timeout" as const,
  message: "Jellyfin did not respond before the deadline.",
  occurredAt: demoContinueWatchingFeed.generatedAt,
  operation: "media.continue_watching",
  retryable: true,
  service: "jellyfin" as const,
};

export const unavailableContinueWatchingFeed: ContinueWatchingResponse = {
  ...emptyContinueWatchingFeed,
  failures: [unavailableFailure],
  source: {
    ...emptyContinueWatchingFeed.source,
    failure: unavailableFailure,
    status: "unavailable",
  },
  state: "unavailable",
};
