import type { LibraryBrowseItem, LibraryBrowseResponse } from "@omnifin/contracts/library";

const generatedAt = "2026-07-30T12:00:00.000Z";

function item(
  referenceCharacter: string,
  input: {
    accent: string;
    contentRating?: string;
    kind?: "episode" | "movie";
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
    durationSeconds: input.runtimeMinutes * 60,
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
      runtimeMinutes: input.runtimeMinutes,
      subtitle: input.subtitle ?? null,
      title: input.title,
      year: input.year,
    },
    played: input.played ?? false,
    positionSeconds: input.positionSeconds ?? 0,
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
    kind: "episode",
    overview: "The observatory follows a pattern hidden inside the northern lights.",
    runtimeMinutes: 48,
    subtitle: "S02E03 · The Long Meridian",
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
    kind: "episode",
    overview: "Mara returns to the station as its oldest constellation disappears.",
    runtimeMinutes: 52,
    subtitle: "S01E06 · A Map of Quiet Stars",
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
    kind: "episode",
    overview: "The crew receives a message transmitted from tomorrow morning.",
    positionSeconds: 780,
    runtimeMinutes: 44,
    subtitle: "S03E01 · Before the Wake",
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
