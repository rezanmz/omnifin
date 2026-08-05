import type {
  LibraryBrowseItem,
  LibraryBrowseResponse,
  LibraryExtra,
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

const demoPlaybackStates = new Map(
  mediaLibraryDemoItems.flatMap((libraryItem) =>
    libraryItem.playback ? [[libraryItem.media.id, libraryItem.playback] as const] : [],
  ),
);

export const readyMediaLibraryOutcome = {
  feed: {
    generatedAt,
    items: mediaLibraryDemoItems,
    nextCursor: null,
    source: { displayName: "Living Room Jellyfin", failure: null, status: "healthy" },
    state: "complete",
    totalResults: mediaLibraryDemoItems.length,
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
    totalResults: 0,
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
    totalResults: null,
  } satisfies LibraryBrowseResponse,
  status: "ready",
} as const;

function titleDetail(item: LibraryBrowseItem): LibraryTitleDetailResponse {
  const movie =
    item.media.kind === "movie"
      ? {
          cast: [
            {
              imagePath: `/v1/media/${item.media.id}/images/people/${"p".repeat(64)}`,
              name: "Mara Voss",
              personReferenceId: `media_${"p".repeat(22)}`,
              role: "Iris Vale",
              type: "cast" as const,
            },
            {
              imagePath: `/v1/media/${item.media.id}/images/people/${"q".repeat(64)}`,
              name: "Inez Laurent",
              personReferenceId: null,
              role: "Captain Sol",
              type: "cast" as const,
            },
            {
              imagePath: null,
              name: "Theo Amari",
              personReferenceId: null,
              role: "Jonas",
              type: "cast" as const,
            },
          ],
          castTruncated: false,
          communityRating: 8.4,
          crew: [
            {
              imagePath: null,
              name: "Jon Bell",
              personReferenceId: null,
              role: null,
              type: "director" as const,
            },
            {
              imagePath: null,
              name: "Ari Chen",
              personReferenceId: null,
              role: null,
              type: "writer" as const,
            },
          ],
          crewTruncated: false,
          criticRating: 91,
          genres: ["Drama", "Science fiction"],
          mediaSources: [
            {
              audio: [
                {
                  bitrateKbps: 640,
                  channels: 6,
                  codec: "E-AC-3",
                  language: "English",
                  title: "English 5.1",
                },
              ],
              audioTruncated: false,
              bitrateKbps: 9_250,
              container: "MKV",
              label: "4K · HEVC · MKV",
              sizeBytes: 6_979_321_856,
              subtitles: [
                {
                  codec: "SUBRIP",
                  default: true,
                  forced: false,
                  language: "English",
                  title: null,
                },
              ],
              subtitlesTruncated: false,
              video: {
                bitrateKbps: 8_700,
                bitDepth: 10,
                codec: "HEVC",
                hdrFormat: "HDR10",
                height: 1_606,
                profile: "Main 10",
                width: 3_840,
              },
            },
          ],
          mediaSourcesTruncated: false,
          premiereDate: "2026-04-18",
          studios: ["Northlight Pictures"],
          tagline: "The horizon remembers.",
        }
      : null;
  return {
    generatedAt,
    media: item.media,
    movie,
    playback: item.playback,
    providerReferences:
      item.media.kind === "movie"
        ? [
            { identifier: "tt0133093", mediaKind: "movie", provider: "imdb" },
            { identifier: 603, mediaKind: "movie", provider: "tmdb" },
          ]
        : [{ identifier: 1396, mediaKind: "series", provider: "tmdb" }],
    seasons:
      item.media.kind === "series"
        ? [
            { episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 1, title: "Season 1" },
            { episodeCount: 6, playedEpisodeCount: 0, seasonNumber: 2, title: "Season 2" },
          ]
        : [],
    seasonsTruncated: false,
    seriesCredits:
      item.media.kind === "series"
        ? {
            cast: [
              {
                imagePath: null,
                name: "Mara Voss",
                personReferenceId: `media_${"s".repeat(22)}`,
                role: "Dr. Elian Vale",
                type: "cast",
              },
            ],
            castTruncated: false,
            crew: [],
            crewTruncated: false,
          }
        : null,
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
  const playback =
    demoPlaybackStates.get(referenceId) ??
    ({
      durationSeconds,
      played: episodeNumber <= 3 && seasonNumber === 1,
      positionSeconds: episodeNumber === 1 && seasonNumber === 2 ? 780 : 0,
    } as const);
  demoPlaybackStates.set(referenceId, playback);
  return {
    airDate: `2026-0${Math.min(9, seasonNumber + 2)}-${String(episodeNumber * 3).padStart(2, "0")}`,
    communityRating: 7.4 + episodeNumber / 10,
    credits: [
      {
        name: "Mara Voss",
        personReferenceId: `media_${"u".repeat(22)}`,
        role: "Dr. Elian Vale",
        type: "cast",
      },
      { name: "Inez Laurent", personReferenceId: null, role: "Captain Rhea Sol", type: "cast" },
      { name: "Jon Bell", personReferenceId: null, role: null, type: "director" },
      { name: "Ari Chen", personReferenceId: null, role: null, type: "writer" },
    ],
    creditsTruncated: false,
    criticRating: episodeNumber === 2 ? 84 : null,
    genres: ["Drama", "Science fiction"],
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
    playback,
    studios: ["Northlight Pictures"],
  };
}

const demoDetails = new Map(
  mediaLibraryDemoItems.map((libraryItem) => [libraryItem.media.id, titleDetail(libraryItem)]),
);

function demoExtras(referenceId: string): LibraryExtra[] {
  const parent = mediaLibraryDemoItems.find((item) => item.media.id === referenceId);
  if (!parent) return [];
  return [
    {
      extraType: "trailer",
      media: {
        ...parent.media,
        id: `media_${"x".repeat(22)}`,
        kind: "other",
        overview: "The local theatrical trailer stored beside this title in Jellyfin.",
        runtimeMinutes: 2,
        subtitle: "Local extra",
        title: `${parent.media.title} — Official trailer`,
      },
      playback: { durationSeconds: 128, played: false, positionSeconds: 0 },
      source: "local",
    },
    {
      extraType: "behind_the_scenes",
      media: {
        ...parent.media,
        id: `media_${"y".repeat(22)}`,
        kind: "other",
        overview: "A short production diary from the owned Jellyfin library.",
        runtimeMinutes: 9,
        subtitle: "Local extra",
        title: "Inside the signal room",
      },
      playback: { durationSeconds: 540, played: false, positionSeconds: 96 },
      source: "local",
    },
  ];
}

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
  async loadExtras(referenceId) {
    const items = demoExtras(referenceId);
    return {
      generatedAt,
      items,
      nextCursor: null,
      onlineItems: [
        {
          id: "youtube:QdBZY2fkU-0",
          provider: "youtube",
          resolution: 2160,
          title: "Official online trailer",
          type: "trailer",
        },
      ],
      onlineSource: { displayName: "Demo Seerr", failure: null, status: "healthy" },
      onlineState: "ready",
      parentReferenceId: referenceId,
      source: { displayName: "Demo Jellyfin", failure: null, status: "healthy" },
      state: items.length === 0 ? "empty" : "complete",
    };
  },
  async loadTitle(referenceId) {
    const detail = demoDetails.get(referenceId);
    if (!detail) throw new Error("Title unavailable");
    return detail;
  },
  async resolvePerson(referenceId) {
    if (
      ![`media_${"p".repeat(22)}`, `media_${"s".repeat(22)}`, `media_${"u".repeat(22)}`].includes(
        referenceId,
      )
    ) {
      throw new Error("Person unavailable");
    }
    return { generatedAt, name: "Mara Voss", tmdbId: 12_345 };
  },
  async updatePlaybackState(referenceId, request) {
    const previous = demoPlaybackStates.get(referenceId);
    if (!previous) throw new Error("Playback state unavailable");
    const playback =
      request.action === "mark_watched"
        ? { ...previous, played: true, positionSeconds: 0 }
        : request.action === "mark_unwatched"
          ? { ...previous, played: false, positionSeconds: 0 }
          : { ...previous, positionSeconds: 0 };
    demoPlaybackStates.set(referenceId, playback);
    return { action: request.action, playback, referenceId, updatedAt: generatedAt };
  },
};
