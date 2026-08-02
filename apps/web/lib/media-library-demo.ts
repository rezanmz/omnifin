import type {
  LibraryBrowseItem,
  LibraryBrowseResponse,
  LibrarySeasonEpisode,
  LibraryTitleDetailResponse,
} from "@omnifin/contracts/library";

import type { MediaLibraryClient } from "./media-library";

const generatedAt = "2026-07-30T12:00:00.000Z";

function item(
  referenceCharacter: string,
  input: {
    accent: string;
    contentRating?: string;
    kind?: "movie" | "series";
    overview: string;
    played?: boolean;
    positionSeconds?: number;
    runtimeMinutes: number;
    subtitle?: string;
    title: string;
    year: number;
  },
): LibraryBrowseItem {
  const kind = input.kind ?? "movie";
  return {
    media: {
      artwork: {
        accentColor: input.accent,
        backdropPath: null,
        blurHash: null,
        posterPath: null,
      },
      availability: "available",
      contentRating: input.contentRating ?? null,
      id: `media_${referenceCharacter.repeat(22)}`,
      kind,
      overview: input.overview,
      runtimeMinutes: kind === "movie" ? input.runtimeMinutes : null,
      subtitle: input.subtitle ?? null,
      title: input.title,
      year: input.year,
    },
    playback:
      kind === "movie"
        ? {
            durationSeconds: input.runtimeMinutes * 60,
            played: input.played ?? false,
            positionSeconds: input.positionSeconds ?? 0,
          }
        : null,
  };
}

export const mediaLibraryDemoItems: LibraryBrowseItem[] = [
  item("a", {
    accent: "#c46f52",
    contentRating: "PG-13",
    overview: "A coastal signal draws two estranged cartographers toward a horizon that moves.",
    positionSeconds: 2_940,
    runtimeMinutes: 118,
    title: "Ember Coast",
    year: 2026,
  }),
  item("b", {
    accent: "#758cc7",
    contentRating: "TV-14",
    kind: "series",
    overview: "The observatory follows a pattern hidden inside the northern lights.",
    runtimeMinutes: 48,
    subtitle: "2 seasons",
    title: "Northern Lights",
    year: 2025,
  }),
  item("c", {
    accent: "#a9825d",
    contentRating: "PG",
    overview: "A quiet courier crosses a desert where every footprint becomes a memory.",
    played: true,
    runtimeMinutes: 104,
    title: "The Far Meridian",
    year: 2024,
  }),
  item("d", {
    accent: "#667f73",
    overview: "An archivist discovers a garden that blooms only during radio silence.",
    runtimeMinutes: 96,
    title: "Stillwater Signal",
    year: 2026,
  }),
  item("e", {
    accent: "#9a6f91",
    contentRating: "TV-PG",
    kind: "series",
    overview: "Mara returns to the station as its oldest constellation disappears.",
    runtimeMinutes: 52,
    subtitle: "1 season",
    title: "Atlas Station",
    year: 2026,
  }),
  item("f", {
    accent: "#5f8d98",
    overview: "A family restores an impossible lighthouse one winter at a time.",
    runtimeMinutes: 111,
    title: "Blue Hour",
    year: 2023,
  }),
  item("g", {
    accent: "#b38a54",
    contentRating: "PG-13",
    overview: "Three musicians follow a vanished melody through the night markets of Orison.",
    runtimeMinutes: 126,
    title: "Golden Static",
    year: 2025,
  }),
  item("h", {
    accent: "#61758d",
    kind: "series",
    overview: "The crew receives a message transmitted from tomorrow morning.",
    positionSeconds: 780,
    runtimeMinutes: 44,
    subtitle: "3 seasons",
    title: "Liminal Sea",
    year: 2026,
  }),
];

export const readyMediaLibraryOutcome = {
  feed: {
    generatedAt,
    items: mediaLibraryDemoItems,
    nextCursor: null,
    source: { displayName: "Living Room Jellyfin", failure: null, status: "healthy" },
    state: "complete",
  } satisfies LibraryBrowseResponse,
  status: "ready",
} as const;

export const emptyMediaLibraryOutcome = {
  feed: {
    generatedAt,
    items: [],
    nextCursor: null,
    source: { displayName: "Living Room Jellyfin", failure: null, status: "healthy" },
    state: "empty",
  } satisfies LibraryBrowseResponse,
  status: "ready",
} as const;

export const unavailableMediaLibraryOutcome = {
  feed: {
    generatedAt,
    items: [],
    nextCursor: null,
    source: {
      displayName: "Living Room Jellyfin",
      failure: {
        code: "unreachable",
        message: "Jellyfin is temporarily unavailable.",
        occurredAt: generatedAt,
        operation: "media.library",
        retryable: true,
        service: "jellyfin",
      },
      status: "unavailable",
    },
    state: "unavailable",
  } satisfies LibraryBrowseResponse,
  status: "ready",
} as const;

function titleDetail(item: LibraryBrowseItem): LibraryTitleDetailResponse {
  return {
    generatedAt,
    media: item.media,
    playback: item.playback,
    seasons:
      item.media.kind === "series"
        ? [
            { episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 1, title: "Season 1" },
            { episodeCount: 6, playedEpisodeCount: 0, seasonNumber: 2, title: "Season 2" },
          ]
        : [],
    seasonsTruncated: false,
  };
}

function demoEpisode(
  referenceCharacter: string,
  series: LibraryBrowseItem,
  seasonNumber: number,
  episodeNumber: number,
): LibrarySeasonEpisode {
  const referenceId = `media_${referenceCharacter.repeat(22)}`;
  const durationSeconds = (42 + episodeNumber) * 60;
  return {
    media: {
      ...series.media,
      artwork: {
        ...series.media.artwork,
        backdropPath: null,
        posterPath: null,
      },
      id: referenceId,
      kind: "episode",
      overview: [
        "A hidden signal changes the shape of the investigation.",
        "The crew follows a clue that only appears after midnight.",
        "An old promise returns with a new set of coordinates.",
      ][(episodeNumber - 1) % 3]!,
      runtimeMinutes: Math.ceil(durationSeconds / 60),
      subtitle: `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`,
      title: ["The Long Meridian", "A Map of Quiet Stars", "Before the Wake"][
        (episodeNumber - 1) % 3
      ]!,
    },
    playback: {
      durationSeconds,
      played: episodeNumber <= 3 && seasonNumber === 1,
      positionSeconds: episodeNumber === 1 && seasonNumber === 2 ? 780 : 0,
    },
  };
}

const demoDetails = new Map(
  mediaLibraryDemoItems.map((libraryItem) => [libraryItem.media.id, titleDetail(libraryItem)]),
);

export const mediaLibraryDemoClient: MediaLibraryClient = {
  async load() {
    return readyMediaLibraryOutcome.feed;
  },
  async loadSeasonEpisodes(referenceId, seasonNumber) {
    const series = mediaLibraryDemoItems.find((item) => item.media.id === referenceId);
    if (!series || series.media.kind !== "series") throw new Error("Series unavailable");
    const characters = seasonNumber === 1 ? ["i", "j", "k"] : ["l", "n", "o"];
    return {
      generatedAt,
      items: characters.map((character, index) =>
        demoEpisode(character, series, seasonNumber, index + 1),
      ),
      nextCursor: null,
      seasonNumber,
      titleReferenceId: referenceId,
    };
  },
  async loadTitle(referenceId) {
    const detail = demoDetails.get(referenceId);
    if (!detail) throw new Error("Title unavailable");
    return detail;
  },
};
