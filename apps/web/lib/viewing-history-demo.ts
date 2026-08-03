import type { ViewingHistoryResponse } from "@omnifin/contracts/library";

import { mediaLibraryDemoItems } from "./media-library-demo";
import type { ViewingHistoryClient } from "./viewing-history";

const generatedAt = "2026-07-30T12:00:00.000Z";
const ember = mediaLibraryDemoItems[0]!;
const meridian = mediaLibraryDemoItems[2]!;

export const demoViewingHistory: ViewingHistoryResponse = {
  generatedAt,
  items: [
    {
      activity: "in_progress",
      lastPlayedAt: "2026-07-30T10:42:00.000Z",
      media: ember.media,
      playback: ember.playback!,
    },
    {
      activity: "completed",
      lastPlayedAt: "2026-07-29T22:18:00.000Z",
      media: meridian.media,
      playback: { durationSeconds: 6_240, played: true, positionSeconds: 0 },
    },
    {
      activity: "in_progress",
      lastPlayedAt: "2026-07-27T02:14:00.000Z",
      media: {
        artwork: {
          accentColor: "#748cc7",
          backdropPath: null,
          blurHash: null,
          posterPath: null,
        },
        availability: "available",
        contentRating: "TV-14",
        id: `media_${"i".repeat(22)}`,
        kind: "episode",
        overview: "A hidden signal changes the shape of the investigation.",
        runtimeMinutes: 45,
        subtitle: "Northern Lights · S02E01",
        title: "The Long Meridian",
        year: 2026,
      },
      playback: { durationSeconds: 2_700, played: false, positionSeconds: 780 },
    },
  ],
  nextCursor: null,
  source: { displayName: "Living Room Jellyfin", failure: null, status: "healthy" },
  state: "complete",
};

export const emptyViewingHistory: ViewingHistoryResponse = {
  ...demoViewingHistory,
  items: [],
  state: "empty",
};

export const unavailableViewingHistory: ViewingHistoryResponse = {
  ...emptyViewingHistory,
  source: {
    displayName: "Living Room Jellyfin",
    failure: {
      code: "unreachable",
      message: "Jellyfin is temporarily unavailable.",
      occurredAt: generatedAt,
      operation: "media.viewing_history",
      retryable: true,
      service: "jellyfin",
    },
    status: "unavailable",
  },
  state: "unavailable",
};

export const viewingHistoryDemoClient: ViewingHistoryClient = {
  async load() {
    return demoViewingHistory;
  },
};
