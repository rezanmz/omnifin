import { z } from "zod";
import type { TitleProviderReference } from "@omnifin/contracts/discovery";
import {
  LIBRARY_EPISODE_MAX_CREDITS,
  LIBRARY_EPISODE_MAX_GENRES,
  LIBRARY_EPISODE_MAX_STUDIOS,
  LIBRARY_BROWSE_MAX_TOTAL_RESULTS,
  LIBRARY_EXTRAS_MAX_ITEMS,
  LIBRARY_MOVIE_MAX_AUDIO_TRACKS,
  LIBRARY_MOVIE_MAX_CAST,
  LIBRARY_MOVIE_MAX_CREW,
  LIBRARY_MOVIE_MAX_GENRES,
  LIBRARY_MOVIE_MAX_MEDIA_SOURCES,
  LIBRARY_MOVIE_MAX_STUDIOS,
  LIBRARY_MOVIE_MAX_SUBTITLE_TRACKS,
  type LibraryPlaybackState,
  type LibraryPlaybackStateAction,
  type ViewingHistoryKind,
  type ViewingHistoryState,
  type LibraryEpisodeCredit,
  type LibraryExtraType,
  type LibraryMovieAudioTrack,
  type LibraryMovieCredit,
  type LibraryMovieMediaSource,
  type LibraryMovieSubtitleTrack,
  type LibraryMovieVideo,
} from "@omnifin/contracts/library";

import {
  jellyfinAuthorization,
  jellyfinClientMetadata,
  type JellyfinClientMetadata,
} from "../auth/jellyfin-authorization.js";
import { SafeConnectorError, SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

export const JELLYFIN_CONTINUE_WATCHING_LIMIT = 50;
export const JELLYFIN_LIBRARY_BROWSE_LIMIT = 50;
export const JELLYFIN_LIBRARY_EPISODE_LIMIT = 50;
export const JELLYFIN_LIBRARY_EXTRAS_LIMIT = LIBRARY_EXTRAS_MAX_ITEMS;
export const JELLYFIN_LIBRARY_SEASON_LIMIT = 100;
export const JELLYFIN_VIEWING_HISTORY_LIMIT = 50;
const JELLYFIN_VIEWING_HISTORY_SCAN_PAGE_SIZE = 100;
const JELLYFIN_VIEWING_HISTORY_MAX_SCAN_PAGES = 20;
const JELLYFIN_SEASON_COUNT_CONCURRENCY = 4;
const JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT = 50;
const JELLYFIN_LIBRARY_EXTRAS_UPSTREAM_LIMIT = 256;
const JELLYFIN_PERSON_LOOKUP_BATCH_SIZE = 40;
const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
const MAX_RUNTIME_TICKS = 60_000_000_000_000;
const BLUR_HASH_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

const imageTagsSchema = z.record(
  z.string().trim().min(1).max(80),
  z.string().min(1).max(256).nullable(),
);

const jellyfinResumeItemSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.nullish(),
  IndexNumber: z.int().nonnegative().max(100_000).nullish(),
  Name: z.string().trim().min(1).max(300),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ParentBackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  ParentBackdropItemId: z.string().trim().min(1).max(256).nullish(),
  ParentIndexNumber: z.int().nonnegative().max(100_000).nullish(),
  ProductionYear: z.int().min(1870).max(2200).nullish(),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  SeriesId: z.string().trim().min(1).max(256).nullish(),
  SeriesName: z.string().trim().min(1).max(300).nullish(),
  SeriesPrimaryImageTag: z.string().min(1).max(256).nullish(),
  Type: z.string().trim().min(1).max(80),
  UserData: z.object({
    LastPlayedDate: z.iso.datetime({ offset: true }),
    PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS),
  }),
});

const jellyfinResumeResponseSchema = z.object({
  Items: z.array(jellyfinResumeItemSchema).max(JELLYFIN_CONTINUE_WATCHING_LIMIT + 1),
  StartIndex: z.int().nonnegative().optional(),
  TotalRecordCount: z.int().nonnegative().optional(),
});

const jellyfinViewingHistoryItemSchema = jellyfinResumeItemSchema.omit({ UserData: true }).extend({
  UserData: z.object({
    LastPlayedDate: z.iso.datetime({ offset: true }).nullish(),
    Played: z.boolean().nullish(),
    PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
  }),
});

const jellyfinViewingHistoryResponseSchema = z.object({
  Items: z.array(jellyfinViewingHistoryItemSchema).max(JELLYFIN_VIEWING_HISTORY_SCAN_PAGE_SIZE),
});

const jellyfinLibraryItemSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  CanDownload: z.boolean().nullish(),
  CanDelete: z.boolean().nullish().catch(null),
  CommunityRating: z.number().finite().nullish().catch(null),
  Container: z.string().trim().min(1).max(64).nullish(),
  CriticRating: z.number().finite().nullish().catch(null),
  Etag: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .nullish(),
  Genres: z.array(z.string().max(100)).max(128).nullish().catch(null),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.nullish(),
  IndexNumber: z.int().nonnegative().max(100_000).nullish(),
  Name: z.string().trim().min(1).max(300).nullish(),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ParentBackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  ParentBackdropItemId: z.string().trim().min(1).max(256).nullish(),
  ParentIndexNumber: z.int().nonnegative().max(100_000).nullish(),
  People: z
    .array(
      z.object({
        Id: z.string().trim().min(1).max(256).nullish(),
        Name: z.string().max(160).nullish(),
        PrimaryImageTag: z.string().min(1).max(256).nullish(),
        Role: z.string().max(200).nullish(),
        Type: z.string().max(64).nullish(),
      }),
    )
    .max(512)
    .nullish()
    .catch(null),
  PremiereDate: z.string().trim().min(1).max(64).nullish().catch(null),
  ProviderIds: z
    .record(z.string().min(1).max(64), z.string().min(1).max(256))
    .refine((ids) => Object.keys(ids).length <= 32)
    .nullish()
    .catch(null),
  ProductionYear: z.int().min(0).max(9_999).nullish(),
  RunTimeTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
  SeriesId: z.string().trim().min(1).max(256).nullish(),
  SeriesName: z.string().trim().min(1).max(300).nullish(),
  SeriesPrimaryImageTag: z.string().min(1).max(256).nullish(),
  Studios: z
    .array(z.object({ Name: z.string().max(160).nullish() }))
    .max(128)
    .nullish()
    .catch(null),
  Taglines: z.array(z.string().max(500)).max(32).nullish().catch(null),
  Type: z.enum(["Movie", "Series"]),
  UserData: z
    .object({
      Played: z.boolean().nullish(),
      PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
    })
    .nullish(),
  MediaSources: z
    .array(
      z.object({
        Bitrate: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
        Container: z.string().max(64).nullish(),
        MediaStreams: z
          .array(
            z.object({
              BitDepth: z.int().positive().max(64).nullish(),
              BitRate: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
              Channels: z.int().positive().max(64).nullish(),
              Codec: z.string().max(64).nullish(),
              Height: z.int().positive().max(100_000).nullish(),
              IsDefault: z.boolean().nullish(),
              IsForced: z.boolean().nullish(),
              Language: z.string().max(80).nullish(),
              Profile: z.string().max(80).nullish(),
              Title: z.string().max(160).nullish(),
              Type: z.string().max(64),
              VideoRange: z.string().max(80).nullish(),
              VideoRangeType: z.string().max(80).nullish(),
              Width: z.int().positive().max(100_000).nullish(),
            }),
          )
          .max(256)
          .nullish(),
        Size: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
      }),
    )
    .max(64)
    .nullish()
    .catch(null),
});

const jellyfinOriginalDownloadItemSchema = jellyfinLibraryItemSchema
  .pick({
    CanDownload: true,
    Container: true,
    Etag: true,
    Id: true,
    IndexNumber: true,
    Name: true,
    ParentIndexNumber: true,
    ProductionYear: true,
    SeriesName: true,
  })
  .extend({
    MediaSources: z
      .array(
        z.object({
          Container: z.string().trim().min(1).max(64).nullish(),
          Id: z.string().trim().min(1).max(256),
          Size: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
        }),
      )
      .max(64)
      .nullish(),
    Type: z.enum(["Episode", "Movie"]),
  });

const jellyfinLibraryResponseSchema = z.object({
  Items: z.array(jellyfinLibraryItemSchema).max(JELLYFIN_LIBRARY_BROWSE_LIMIT + 1),
  TotalRecordCount: z.int().nonnegative().max(LIBRARY_BROWSE_MAX_TOTAL_RESULTS).nullish(),
});

const jellyfinLibraryExtraItemSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  ExtraType: z.string().trim().max(64).nullish(),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.nullish(),
  Name: z.string().trim().min(1).max(300),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ProductionYear: z.int().min(0).max(9_999).nullish(),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  Type: z.string().trim().min(1).max(80),
  UserData: z
    .object({
      Played: z.boolean().nullish(),
      PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
    })
    .nullish(),
});

const jellyfinLibraryExtrasResponseSchema = z
  .array(jellyfinLibraryExtraItemSchema)
  .max(JELLYFIN_LIBRARY_EXTRAS_UPSTREAM_LIMIT);

const jellyfinLibraryProviderIdsSchema = z.object({
  ProviderIds: z.record(z.string(), z.string().max(128)).nullish(),
});

const jellyfinLibrarySeasonSchema = z.object({
  ChildCount: z.int().nonnegative().max(100_000).nullish(),
  Id: z.string().trim().min(1).max(256),
  IndexNumber: z.int().nonnegative().max(100_000),
  Name: z.string().trim().min(1).max(300),
  RecursiveItemCount: z.int().nonnegative().max(100_000).nullish(),
  Type: z.literal("Season"),
  UserData: z
    .object({
      Played: z.boolean().nullish(),
      UnplayedItemCount: z.int().nonnegative().max(100_000).nullish(),
    })
    .nullish(),
});

const jellyfinLibrarySeasonsResponseSchema = z.object({
  Items: z.array(jellyfinLibrarySeasonSchema).max(JELLYFIN_LIBRARY_SEASON_LIMIT + 1),
});

const jellyfinLibraryEpisodeSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  CommunityRating: z.number().finite().nullish(),
  CriticRating: z.number().finite().nullish(),
  Genres: z.array(z.string().max(100)).max(128).nullish(),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.nullish(),
  IndexNumber: z.int().nonnegative().max(100_000).nullish(),
  Name: z.string().trim().min(1).max(300),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ParentBackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  ParentBackdropItemId: z.string().trim().min(1).max(256).nullish(),
  ParentIndexNumber: z.int().nonnegative().max(100_000).nullish(),
  People: z
    .array(
      z.object({
        Id: z.string().trim().min(1).max(256).nullish(),
        Name: z.string().max(160).nullish(),
        Role: z.string().max(200).nullish(),
        Type: z.string().max(64).nullish(),
      }),
    )
    .max(256)
    .nullish(),
  PremiereDate: z.string().trim().min(1).max(64).nullish(),
  ProductionYear: z.int().min(0).max(9_999).nullish(),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  SeriesId: z.string().trim().min(1).max(256),
  SeriesName: z.string().trim().min(1).max(300).nullish(),
  SeriesPrimaryImageTag: z.string().min(1).max(256).nullish(),
  Studios: z
    .array(z.object({ Name: z.string().max(160).nullish() }))
    .max(128)
    .nullish(),
  Type: z.literal("Episode"),
  UserData: z
    .object({
      Played: z.boolean().nullish(),
      PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
    })
    .nullish(),
});

const jellyfinPersonItemSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  Name: z.string().trim().min(1).max(160),
  ProviderIds: z
    .record(z.string().min(1).max(64), z.string().min(1).max(256))
    .refine((ids) => Object.keys(ids).length <= 32)
    .nullish()
    .catch(null),
  Type: z.literal("Person"),
});

const jellyfinPersonItemsResponseSchema = z.object({
  Items: z.array(jellyfinPersonItemSchema).max(JELLYFIN_PERSON_LOOKUP_BATCH_SIZE),
});

const jellyfinLibraryEpisodesResponseSchema = z.object({
  Items: z.array(jellyfinLibraryEpisodeSchema).max(JELLYFIN_LIBRARY_EPISODE_LIMIT + 1),
});

const jellyfinLibraryEpisodeCountResponseSchema = z.object({
  Items: z
    .array(
      z.object({
        Id: z.string().trim().min(1).max(256),
        Type: z.literal("Episode"),
        UserData: z
          .object({
            Played: z.boolean().nullish(),
          })
          .nullish(),
      }),
    )
    .max(JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT + 1),
  TotalRecordCount: z.int().nonnegative().max(100_000).optional(),
});

const jellyfinPlaybackStateItemSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  Type: z.enum(["Episode", "Movie"]),
  UserData: z.object({
    Played: z.boolean().nullish(),
    PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
  }),
});

const jellyfinLibraryQuerySchema = z.strictObject({
  kind: z.enum(["all", "movies", "series"]),
  limit: z.int().positive().max(JELLYFIN_LIBRARY_BROWSE_LIMIT),
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .optional(),
  sort: z.enum(["recent", "title", "year"]),
  startIndex: z.int().nonnegative().max(1_000_000),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});

const jellyfinLibraryTitleQuerySchema = z.strictObject({
  itemId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});

export const JELLYFIN_ORIGINAL_DOWNLOAD_MAX_BYTES = 128 * 1_024 * 1_024 * 1_024 * 1_024;

const jellyfinOriginalDownloadInputSchema = z
  .strictObject({
    itemId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
    maxResponseBytes: z.int().positive().max(JELLYFIN_ORIGINAL_DOWNLOAD_MAX_BYTES),
    range: z
      .string()
      .regex(/^bytes=\d*-\d*$/u)
      .optional(),
  })
  .superRefine((input, context) => {
    if (!input.range) return;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(input.range);
    const startText = match?.[1] ?? "";
    const endText = match?.[2] ?? "";
    const start = startText ? Number(startText) : null;
    const end = endText ? Number(endText) : null;
    if (
      (start === null && end === null) ||
      (start !== null && !Number.isSafeInteger(start)) ||
      (end !== null && !Number.isSafeInteger(end)) ||
      (start !== null && end !== null && start > end)
    ) {
      context.addIssue({ code: "custom", message: "The byte range is invalid.", path: ["range"] });
    }
  });

const jellyfinLibraryExtrasQuerySchema = jellyfinLibraryTitleQuerySchema.extend({
  limit: z.int().positive().max(JELLYFIN_LIBRARY_EXTRAS_LIMIT),
  startIndex: z.int().nonnegative().max(1_000_000),
});

const jellyfinLibrarySeasonEpisodesQuerySchema = z.strictObject({
  limit: z.int().positive().max(JELLYFIN_LIBRARY_EPISODE_LIMIT),
  seasonNumber: z.int().nonnegative().max(100_000),
  seriesId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  startIndex: z.int().nonnegative().max(1_000_000),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});

const jellyfinPlaybackStateMutationInputSchema = z.strictObject({
  action: z.enum(["mark_watched", "mark_unwatched", "reset_progress"]),
  itemId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});

const jellyfinViewingHistoryInputSchema = z.strictObject({
  afterItemId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
    .optional(),
  kind: z.enum(["all", "movies", "episodes"]),
  limit: z.int().positive().max(JELLYFIN_VIEWING_HISTORY_LIMIT),
  since: z.iso.datetime({ offset: true }).optional(),
  state: z.enum(["all", "completed", "in_progress"]),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});

export interface JellyfinArtworkSource {
  itemId: string;
  type: "Backdrop" | "Primary";
}

export interface JellyfinContinueWatchingItem {
  artwork: {
    accentColor: string | null;
    backdrop: JellyfinArtworkSource | null;
    blurHash: string | null;
    poster: JellyfinArtworkSource | null;
  };
  contentRating: string | null;
  episodeNumber: number | null;
  externalId: string;
  kind: "episode" | "movie" | "other";
  lastPlayedAt: string;
  overview: string | null;
  positionSeconds: number;
  runtimeSeconds: number;
  seasonNumber: number | null;
  subtitle: string | null;
  title: string;
  year: number | null;
}

export interface JellyfinContinueWatchingResult {
  items: JellyfinContinueWatchingItem[];
  truncated: boolean;
}

export interface JellyfinViewingHistoryInput {
  afterItemId?: string;
  kind: ViewingHistoryKind;
  limit: number;
  since?: string;
  state: ViewingHistoryState;
  userId: string;
}

export interface JellyfinViewingHistoryItem extends JellyfinContinueWatchingItem {
  kind: "episode" | "movie";
  played: boolean;
}

export interface JellyfinViewingHistoryResult {
  boundaryFound: boolean;
  items: JellyfinViewingHistoryItem[];
  nextAfterItemId: string | null;
}

export interface JellyfinLibraryBrowseInput {
  kind: "all" | "movies" | "series";
  limit: number;
  query?: string;
  sort: "recent" | "title" | "year";
  startIndex: number;
  userId: string;
}

export interface JellyfinLibraryItem {
  artwork: JellyfinContinueWatchingItem["artwork"];
  contentRating: string | null;
  externalId: string;
  kind: "movie" | "series";
  overview: string | null;
  played: boolean;
  positionSeconds: number;
  runtimeSeconds: number | null;
  title: string;
  year: number | null;
}

export interface JellyfinLibraryResult {
  items: JellyfinLibraryItem[];
  nextStartIndex: number | null;
  totalResults: number | null;
  truncated: boolean;
}

export interface JellyfinLibrarySeason {
  episodeCount: number;
  playedEpisodeCount: number;
  seasonNumber: number;
  title: string;
}

export interface JellyfinLibraryTitleResult {
  item: JellyfinLibraryItem;
  movie: JellyfinLibraryMovieDetail | null;
  providerReferences: TitleProviderReference[];
  removal?: JellyfinLibraryRemovalFacts | null;
  seasons: JellyfinLibrarySeason[];
  seasonsTruncated: boolean;
  seriesCredits: JellyfinLibraryTitleCredits | null;
}

export interface JellyfinOriginalDownloadMetadata {
  canDownload: boolean;
  container: string | null;
  etag: string | null;
  externalId: string;
  sizeBytes: number | null;
  title: string;
  year: number | null;
}

export interface JellyfinLibraryExtra {
  artwork: JellyfinContinueWatchingItem["artwork"];
  contentRating: string | null;
  externalId: string;
  extraType: LibraryExtraType;
  overview: string | null;
  played: boolean;
  positionSeconds: number;
  runtimeSeconds: number;
  title: string;
  year: number | null;
}

export interface JellyfinOriginalDownloadStream {
  acceptRanges: boolean;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
  status: 200 | 206 | 416;
}

export interface JellyfinLibraryExtrasResult {
  catalogTmdbId: number | null;
  items: JellyfinLibraryExtra[];
  nextStartIndex: number | null;
}

export interface JellyfinLibraryRemovalFacts {
  canDelete: boolean;
  providerIds: {
    imdb: string | null;
    tmdb: number | null;
  };
  sizeBytes: number | null;
}

export interface JellyfinLibraryMovieCredit extends LibraryMovieCredit {
  image: JellyfinArtworkSource | null;
  imagePath: null;
  person: JellyfinLibraryPersonIdentity | null;
  personItemId: string | null;
  personReferenceId: null;
}

export interface JellyfinLibraryPersonIdentity {
  itemId: string;
  tmdbId: number;
}

export interface JellyfinLibraryTitleCredits {
  cast: JellyfinLibraryMovieCredit[];
  castTruncated: boolean;
  crew: JellyfinLibraryMovieCredit[];
  crewTruncated: boolean;
}

export interface JellyfinLibraryMovieDetail {
  cast: JellyfinLibraryMovieCredit[];
  castTruncated: boolean;
  communityRating: number | null;
  crew: JellyfinLibraryMovieCredit[];
  crewTruncated: boolean;
  criticRating: number | null;
  genres: string[];
  mediaSources: LibraryMovieMediaSource[];
  mediaSourcesTruncated: boolean;
  premiereDate: string | null;
  studios: string[];
  tagline: string | null;
}

export interface JellyfinLibrarySeasonEpisodesInput {
  limit: number;
  seasonNumber: number;
  seriesId: string;
  startIndex: number;
  userId: string;
}

export interface JellyfinLibrarySeasonEpisodesResult {
  items: JellyfinLibraryEpisode[];
  nextStartIndex: number | null;
  truncated: boolean;
}

export interface JellyfinPlaybackStateMutationInput {
  action: LibraryPlaybackStateAction;
  itemId: string;
  userId: string;
}

export interface JellyfinLibraryEpisode extends Omit<
  JellyfinContinueWatchingItem,
  "lastPlayedAt" | "kind"
> {
  airDate: string | null;
  communityRating: number | null;
  credits: JellyfinLibraryEpisodeCredit[];
  creditsTruncated: boolean;
  criticRating: number | null;
  genres: string[];
  kind: "episode";
  played: boolean;
  studios: string[];
}

export interface JellyfinLibraryEpisodeCredit extends LibraryEpisodeCredit {
  person: JellyfinLibraryPersonIdentity | null;
  personItemId: string | null;
  personReferenceId: null;
}

export interface JellyfinLibraryPerson {
  itemId: string;
  name: string;
  tmdbId: number;
}

export interface JellyfinImageResult {
  body: Uint8Array;
  contentType: "image/avif" | "image/jpeg" | "image/png" | "image/webp";
}

export interface JellyfinUserMediaClientOptions {
  accessToken: string;
  deviceId: string;
  metadata?: JellyfinClientMetadata;
  target: ConnectorTargetConfig;
}

function compactText(value: string | null | undefined, maxLength: number) {
  if (!value) return null;
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (!compacted) return null;
  return compacted.length <= maxLength ? compacted : compacted.slice(0, maxLength).trimEnd();
}

function dateOnly(value: string | null | undefined) {
  const candidate = value?.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (!candidate) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate;
}

function boundedRating(value: number | null | undefined, maximum: number) {
  return value !== null && value !== undefined && value >= 0 && value <= maximum ? value : null;
}

function uniqueText(
  values: readonly string[] | null | undefined,
  limit: number,
  maxLength: number,
) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const text = compactText(value, maxLength);
    const key = text?.toLocaleLowerCase("en-US");
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
    if (normalized.length === limit) break;
  }
  return normalized;
}

function episodeCredits(
  people: z.infer<typeof jellyfinLibraryEpisodeSchema>["People"],
): Pick<JellyfinLibraryEpisode, "credits" | "creditsTruncated"> {
  const normalized: JellyfinLibraryEpisodeCredit[] = [];
  const seen = new Set<string>();
  for (const person of people ?? []) {
    const upstreamType = person.Type?.toLocaleLowerCase("en-US").replace(/[\s_-]+/gu, "");
    const type =
      upstreamType === "actor" || upstreamType === "gueststar"
        ? ("cast" as const)
        : upstreamType === "director"
          ? ("director" as const)
          : upstreamType === "writer"
            ? ("writer" as const)
            : null;
    if (!type) continue;
    const name = compactText(person.Name, 160);
    if (!name) continue;
    const role = compactText(person.Role, 200);
    const key = person.Id
      ? `${type}:id:${person.Id}`
      : `${type}:name:${name.toLocaleLowerCase("en-US")}:${role?.toLocaleLowerCase("en-US") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      name,
      person: null,
      personItemId: person.Id ?? null,
      personReferenceId: null,
      role,
      type,
    });
  }
  return {
    credits: normalized.slice(0, LIBRARY_EPISODE_MAX_CREDITS),
    creditsTruncated: normalized.length > LIBRARY_EPISODE_MAX_CREDITS,
  };
}

function bitrateKbps(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  return Math.min(10_000_000, Math.round(value / 1_000));
}

function codecLabel(value: string | null | undefined) {
  const codec = compactText(value, 64)?.toLocaleLowerCase("en-US");
  if (!codec) return null;
  return (
    {
      ac3: "AC-3",
      av1: "AV1",
      eac3: "E-AC-3",
      h264: "H.264",
      hevc: "HEVC",
      mjpeg: "MJPEG",
      truehd: "TrueHD",
      vp9: "VP9",
    }[codec] ?? codec.toLocaleUpperCase("en-US")
  );
}

function movieCredits(
  people: z.infer<typeof jellyfinLibraryItemSchema>["People"],
): Pick<JellyfinLibraryMovieDetail, "cast" | "castTruncated" | "crew" | "crewTruncated"> {
  const cast: JellyfinLibraryMovieCredit[] = [];
  const crew: JellyfinLibraryMovieCredit[] = [];
  const seen = new Set<string>();
  for (const person of people ?? []) {
    const upstreamType = person.Type?.toLocaleLowerCase("en-US").replace(/[\s_-]+/gu, "");
    const type =
      upstreamType === "actor" || upstreamType === "gueststar"
        ? ("cast" as const)
        : upstreamType === "director"
          ? ("director" as const)
          : upstreamType === "writer"
            ? ("writer" as const)
            : upstreamType === "producer"
              ? ("producer" as const)
              : null;
    if (!type) continue;
    const name = compactText(person.Name, 160);
    if (!name) continue;
    const role = compactText(person.Role, 200);
    const key = person.Id
      ? `${type}:id:${person.Id}`
      : `${type}:name:${name.toLocaleLowerCase("en-US")}:${role?.toLocaleLowerCase("en-US") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const image =
      person.Id && person.PrimaryImageTag ? { itemId: person.Id, type: "Primary" as const } : null;
    const credit = {
      image,
      imagePath: null,
      name,
      person: null,
      personItemId: person.Id ?? null,
      personReferenceId: null,
      role,
      type,
    } satisfies JellyfinLibraryMovieCredit;
    if (type === "cast") cast.push(credit);
    else crew.push(credit);
  }
  return {
    cast: cast.slice(0, LIBRARY_MOVIE_MAX_CAST),
    castTruncated: cast.length > LIBRARY_MOVIE_MAX_CAST,
    crew: crew.slice(0, LIBRARY_MOVIE_MAX_CREW),
    crewTruncated: crew.length > LIBRARY_MOVIE_MAX_CREW,
  };
}

type JellyfinLibraryMediaSource = NonNullable<
  z.infer<typeof jellyfinLibraryItemSchema>["MediaSources"]
>[number];
type JellyfinLibraryMediaStream = NonNullable<JellyfinLibraryMediaSource["MediaStreams"]>[number];

function normalizeAudioTrack(stream: JellyfinLibraryMediaStream): LibraryMovieAudioTrack {
  return {
    bitrateKbps: bitrateKbps(stream.BitRate),
    channels: stream.Channels ?? null,
    codec: codecLabel(stream.Codec),
    language: compactText(stream.Language, 80),
    title: compactText(stream.Title, 160),
  };
}

function normalizeSubtitleTrack(stream: JellyfinLibraryMediaStream): LibraryMovieSubtitleTrack {
  return {
    codec: codecLabel(stream.Codec),
    default: stream.IsDefault ?? false,
    forced: stream.IsForced ?? false,
    language: compactText(stream.Language, 80),
    title: compactText(stream.Title, 160),
  };
}

function hdrFormat(stream: JellyfinLibraryMediaStream) {
  for (const candidate of [stream.VideoRangeType, stream.VideoRange]) {
    const value = compactText(candidate, 80);
    if (value && value.toLocaleLowerCase("en-US") !== "sdr") return value;
  }
  return null;
}

function normalizeVideo(stream: JellyfinLibraryMediaStream | undefined): LibraryMovieVideo | null {
  if (!stream) return null;
  return {
    bitrateKbps: bitrateKbps(stream.BitRate),
    bitDepth: stream.BitDepth ?? null,
    codec: codecLabel(stream.Codec),
    hdrFormat: hdrFormat(stream),
    height: stream.Height ?? null,
    profile: compactText(stream.Profile, 80),
    width: stream.Width ?? null,
  };
}

function resolutionLabel(video: LibraryMovieVideo | null) {
  const width = video?.width;
  const height = video?.height;
  if (width !== null && width !== undefined) {
    if (width >= 3_400) return "4K";
    if (width >= 2_400) return "QHD";
    if (width >= 1_700) return "1080p";
    if (width >= 1_100) return "720p";
  }
  return height ? `${height}p` : null;
}

function normalizeMovieMediaSource(
  source: JellyfinLibraryMediaSource,
  index: number,
  sourceCount: number,
): LibraryMovieMediaSource {
  const streams = source.MediaStreams ?? [];
  const video = normalizeVideo(
    streams.find((stream) => stream.Type.toLocaleLowerCase("en-US") === "video"),
  );
  const audio = streams
    .filter((stream) => stream.Type.toLocaleLowerCase("en-US") === "audio")
    .map(normalizeAudioTrack);
  const subtitles = streams
    .filter((stream) => stream.Type.toLocaleLowerCase("en-US") === "subtitle")
    .map(normalizeSubtitleTrack);
  const container = codecLabel(source.Container);
  const baseLabel =
    [resolutionLabel(video), video?.codec, container].filter(Boolean).join(" · ") ||
    "Media version";
  return {
    audio: audio.slice(0, LIBRARY_MOVIE_MAX_AUDIO_TRACKS),
    audioTruncated: audio.length > LIBRARY_MOVIE_MAX_AUDIO_TRACKS,
    bitrateKbps: bitrateKbps(source.Bitrate),
    container,
    label: sourceCount > 1 ? `${baseLabel} · Version ${index + 1}` : baseLabel,
    sizeBytes: source.Size ?? null,
    subtitles: subtitles.slice(0, LIBRARY_MOVIE_MAX_SUBTITLE_TRACKS),
    subtitlesTruncated: subtitles.length > LIBRARY_MOVIE_MAX_SUBTITLE_TRACKS,
    video,
  };
}

function normalizeMovieDetail(
  item: z.infer<typeof jellyfinLibraryItemSchema>,
): JellyfinLibraryMovieDetail {
  const mediaSources = item.MediaSources ?? [];
  return {
    ...movieCredits(item.People),
    communityRating: boundedRating(item.CommunityRating, 10),
    criticRating: boundedRating(item.CriticRating, 100),
    genres: uniqueText(item.Genres, LIBRARY_MOVIE_MAX_GENRES, 100),
    mediaSources: mediaSources
      .slice(0, LIBRARY_MOVIE_MAX_MEDIA_SOURCES)
      .map((source, index) => normalizeMovieMediaSource(source, index, mediaSources.length)),
    mediaSourcesTruncated: mediaSources.length > LIBRARY_MOVIE_MAX_MEDIA_SOURCES,
    premiereDate: dateOnly(item.PremiereDate),
    studios: uniqueText(
      item.Studios?.flatMap(({ Name }) => (Name === null || Name === undefined ? [] : [Name])),
      LIBRARY_MOVIE_MAX_STUDIOS,
      160,
    ),
    tagline: uniqueText(item.Taglines, 1, 500)[0] ?? null,
  };
}

function normalizedProviderId(
  providerIds: Record<string, string> | null | undefined,
  provider: "imdb" | "tmdb",
) {
  const value = Object.entries(providerIds ?? {}).find(
    ([key]) => key.toLocaleLowerCase("en-US") === provider,
  )?.[1];
  return value?.trim() ?? null;
}

function normalizedTmdbPersonId(providerIds: Record<string, string> | null | undefined) {
  const value = normalizedProviderId(providerIds, "tmdb");
  if (value === null || !/^[1-9][0-9]{0,9}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
}

function resolvedCredit<T extends { personItemId: string | null }>(
  credit: T,
  people: ReadonlyMap<string, JellyfinLibraryPersonIdentity>,
): T & { person: JellyfinLibraryPersonIdentity | null } {
  return {
    ...credit,
    person: credit.personItemId === null ? null : (people.get(credit.personItemId) ?? null),
  };
}

function resolvedTitleCredits(
  credits: JellyfinLibraryTitleCredits,
  people: ReadonlyMap<string, JellyfinLibraryPersonIdentity>,
): JellyfinLibraryTitleCredits {
  return {
    ...credits,
    cast: credits.cast.map((credit) => resolvedCredit(credit, people)),
    crew: credits.crew.map((credit) => resolvedCredit(credit, people)),
  };
}

function normalizedRottenTomatoesIdentifier(
  providerIds: Record<string, string> | null | undefined,
  mediaKind: TitleProviderReference["mediaKind"],
) {
  const rawValue = Object.entries(providerIds ?? {}).find(([key]) =>
    ["rottentomatoes", "rotten tomatoes"].includes(key.toLocaleLowerCase("en-US")),
  )?.[1];
  const value = rawValue?.trim();
  if (!value) return null;
  if (/^[a-z0-9](?:[a-z0-9_-]{0,199})$/u.test(value)) return value;
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const expectedCollection = mediaKind === "movie" ? "m" : "tv";
    return url.origin === "https://www.rottentomatoes.com" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      segments.length === 2 &&
      segments[0] === expectedCollection &&
      /^[a-z0-9](?:[a-z0-9_-]{0,199})$/u.test(segments[1] ?? "")
      ? segments[1]!
      : null;
  } catch {
    return null;
  }
}

function normalizeTitleProviderReferences(
  item: z.infer<typeof jellyfinLibraryItemSchema>,
): TitleProviderReference[] {
  const mediaKind = item.Type === "Movie" ? ("movie" as const) : ("series" as const);
  const imdb = normalizedProviderId(item.ProviderIds, "imdb");
  const tmdb = normalizedProviderId(item.ProviderIds, "tmdb");
  const parsedTmdb = tmdb !== null && /^[1-9][0-9]{0,9}$/u.test(tmdb) ? Number(tmdb) : null;
  const rottenTomatoes = normalizedRottenTomatoesIdentifier(item.ProviderIds, mediaKind);
  return [
    ...(imdb !== null && /^tt[0-9]{5,12}$/u.test(imdb)
      ? [{ identifier: imdb, mediaKind, provider: "imdb" as const }]
      : []),
    ...(parsedTmdb !== null && Number.isSafeInteger(parsedTmdb) && parsedTmdb <= 2_147_483_647
      ? [{ identifier: parsedTmdb, mediaKind, provider: "tmdb" as const }]
      : []),
    ...(rottenTomatoes === null
      ? []
      : [{ identifier: rottenTomatoes, mediaKind, provider: "rotten_tomatoes" as const }]),
  ];
}

function normalizeMovieRemovalFacts(
  item: z.infer<typeof jellyfinLibraryItemSchema>,
): JellyfinLibraryRemovalFacts {
  const imdb = normalizedProviderId(item.ProviderIds, "imdb");
  const tmdb = normalizedProviderId(item.ProviderIds, "tmdb");
  const parsedTmdb = tmdb !== null && /^[1-9][0-9]{0,15}$/u.test(tmdb) ? Number(tmdb) : null;
  const sizes = (item.MediaSources ?? []).map(({ Size }) => Size ?? null);
  const sizeBytes =
    sizes.length > 0 && sizes.every((size): size is number => size !== null)
      ? sizes.reduce((total, size) => total + size, 0)
      : null;
  return {
    canDelete: item.CanDelete === true,
    providerIds: {
      imdb: imdb !== null && /^tt[0-9]{5,12}$/u.test(imdb) ? imdb : null,
      tmdb:
        parsedTmdb !== null && Number.isSafeInteger(parsedTmdb) && parsedTmdb > 0
          ? parsedTmdb
          : null,
    },
    sizeBytes: Number.isSafeInteger(sizeBytes) ? sizeBytes : null,
  };
}

function secondsFromTicks(ticks: number) {
  return Math.floor(ticks / JELLYFIN_TICKS_PER_SECOND);
}

function decodeBase83(value: string) {
  let decoded = 0;
  for (const character of value) {
    const digit = BLUR_HASH_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    decoded = decoded * 83 + digit;
  }
  return decoded;
}

function toneMappedAccent(rgb: number) {
  const red = ((rgb >> 16) & 0xff) / 255;
  const green = ((rgb >> 8) & 0xff) / 255;
  const blue = (rgb & 0xff) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta < 1 / 255) return null;

  let hue =
    maximum === red
      ? ((green - blue) / delta) % 6
      : maximum === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  if (hue < 0) hue += 6;

  const sourceLightness = (maximum + minimum) / 2;
  const sourceSaturation = delta / (1 - Math.abs(2 * sourceLightness - 1));
  const saturation = Math.min(0.72, Math.max(0.38, sourceSaturation));
  const lightness = Math.min(0.62, Math.max(0.4, sourceLightness));
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const intermediate = chroma * (1 - Math.abs((hue % 2) - 1));
  const offset = lightness - chroma / 2;
  const [hueRed, hueGreen, hueBlue] =
    hue < 1
      ? [chroma, intermediate, 0]
      : hue < 2
        ? [intermediate, chroma, 0]
        : hue < 3
          ? [0, chroma, intermediate]
          : hue < 4
            ? [0, intermediate, chroma]
            : hue < 5
              ? [intermediate, 0, chroma]
              : [chroma, 0, intermediate];
  return `#${[hueRed, hueGreen, hueBlue]
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function paletteFromBlurHash(blurHash: string) {
  if (blurHash.length < 6 || blurHash.length > 166) return null;
  if ([...blurHash].some((character) => !BLUR_HASH_ALPHABET.includes(character))) return null;
  const sizeFlag = decodeBase83(blurHash[0]!);
  const dc = decodeBase83(blurHash.slice(2, 6));
  if (sizeFlag === null || sizeFlag > 80 || dc === null || dc > 0xff_ffff) return null;
  const componentColumns = (sizeFlag % 9) + 1;
  const componentRows = Math.floor(sizeFlag / 9) + 1;
  if (blurHash.length !== 4 + 2 * componentColumns * componentRows) return null;
  return { accentColor: toneMappedAccent(dc), blurHash };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedBlurHash(imageBlurHashes: unknown, type: "Backdrop" | "Primary", tag: string) {
  if (!isUnknownRecord(imageBlurHashes)) return null;
  const hashesForType = imageBlurHashes[type];
  if (!isUnknownRecord(hashesForType) || !Object.hasOwn(hashesForType, tag)) return null;
  const blurHash = hashesForType[tag];
  return typeof blurHash === "string" && blurHash.length <= 256 ? blurHash : null;
}

function artworkPalette(
  item: { ImageBlurHashes?: unknown },
  posterTag: string | undefined,
  backdropTag: string | undefined,
) {
  for (const [type, tag] of [
    ["Primary", posterTag],
    ["Backdrop", backdropTag],
  ] as const) {
    if (!tag) continue;
    const blurHash = selectedBlurHash(item.ImageBlurHashes, type, tag);
    if (!blurHash) continue;
    const palette = paletteFromBlurHash(blurHash);
    if (palette) return palette;
  }
  return { accentColor: null, blurHash: null };
}

function episodeLabel(item: {
  IndexNumber?: number | null | undefined;
  Name?: string | null | undefined;
  ParentIndexNumber?: number | null | undefined;
}) {
  const season = item.ParentIndexNumber;
  const episode = item.IndexNumber;
  const index =
    season === undefined || episode === undefined
      ? null
      : `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return [index, item.Name].filter(Boolean).join(" · ") || null;
}

function normalizeResumeItem(
  item: z.infer<typeof jellyfinResumeItemSchema>,
): JellyfinContinueWatchingItem | null {
  const runtimeSeconds = secondsFromTicks(item.RunTimeTicks);
  if (runtimeSeconds < 1) return null;
  const positionSeconds = Math.min(
    runtimeSeconds,
    secondsFromTicks(item.UserData.PlaybackPositionTicks),
  );
  if (positionSeconds < 1 || positionSeconds >= runtimeSeconds) return null;

  const isEpisode = item.Type === "Episode";
  const isMovie = item.Type === "Movie";
  const posterTag =
    isEpisode && item.SeriesId && item.SeriesPrimaryImageTag
      ? item.SeriesPrimaryImageTag
      : (item.ImageTags?.Primary ?? undefined);
  const poster =
    isEpisode && item.SeriesId && posterTag
      ? { itemId: item.SeriesId, type: "Primary" as const }
      : posterTag
        ? { itemId: item.Id, type: "Primary" as const }
        : null;
  const backdropTag = item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0];
  const backdropItemId = item.ParentBackdropImageTags?.length
    ? (item.ParentBackdropItemId ?? item.SeriesId)
    : item.BackdropImageTags?.length
      ? item.Id
      : undefined;
  const palette = artworkPalette(item, posterTag, backdropTag);

  return {
    artwork: {
      ...palette,
      backdrop: backdropItemId ? { itemId: backdropItemId, type: "Backdrop" } : null,
      poster,
    },
    contentRating: compactText(item.OfficialRating, 32),
    episodeNumber: isEpisode ? (item.IndexNumber ?? null) : null,
    externalId: item.Id,
    kind: isEpisode ? "episode" : isMovie ? "movie" : "other",
    lastPlayedAt: item.UserData.LastPlayedDate,
    overview: compactText(item.Overview, 2_000),
    positionSeconds,
    runtimeSeconds,
    seasonNumber: isEpisode ? (item.ParentIndexNumber ?? null) : null,
    subtitle: isEpisode ? episodeLabel(item) : null,
    title: isEpisode ? (item.SeriesName ?? item.Name) : item.Name,
    year: item.ProductionYear ?? null,
  };
}

function normalizeViewingHistoryItem(
  item: z.infer<typeof jellyfinViewingHistoryItemSchema>,
): JellyfinViewingHistoryItem | null {
  if ((item.Type !== "Movie" && item.Type !== "Episode") || !item.UserData.LastPlayedDate) {
    return null;
  }
  const runtimeSeconds = secondsFromTicks(item.RunTimeTicks);
  if (runtimeSeconds < 1) return null;
  const played = item.UserData.Played ?? false;
  const positionSeconds = Math.min(
    runtimeSeconds,
    secondsFromTicks(item.UserData.PlaybackPositionTicks ?? 0),
  );
  if (!played && positionSeconds < 1) return null;

  const isEpisode = item.Type === "Episode";
  const posterTag =
    isEpisode && item.SeriesId && item.SeriesPrimaryImageTag
      ? item.SeriesPrimaryImageTag
      : (item.ImageTags?.Primary ?? undefined);
  const poster =
    isEpisode && item.SeriesId && posterTag
      ? { itemId: item.SeriesId, type: "Primary" as const }
      : posterTag
        ? { itemId: item.Id, type: "Primary" as const }
        : null;
  const backdropTag = item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0];
  const backdropItemId = item.ParentBackdropImageTags?.length
    ? (item.ParentBackdropItemId ?? item.SeriesId)
    : item.BackdropImageTags?.length
      ? item.Id
      : undefined;

  return {
    artwork: {
      ...artworkPalette(item, posterTag, backdropTag),
      backdrop: backdropItemId ? { itemId: backdropItemId, type: "Backdrop" } : null,
      poster,
    },
    contentRating: compactText(item.OfficialRating, 32),
    episodeNumber: isEpisode ? (item.IndexNumber ?? null) : null,
    externalId: item.Id,
    kind: isEpisode ? "episode" : "movie",
    lastPlayedAt: item.UserData.LastPlayedDate,
    overview: compactText(item.Overview, 2_000),
    played,
    positionSeconds,
    runtimeSeconds,
    seasonNumber: isEpisode ? (item.ParentIndexNumber ?? null) : null,
    subtitle: isEpisode ? episodeLabel(item) : null,
    title: isEpisode ? (item.SeriesName ?? item.Name) : item.Name,
    year: item.ProductionYear ?? null,
  };
}

function normalizeLibraryItem(
  item: z.infer<typeof jellyfinLibraryItemSchema>,
): JellyfinLibraryItem | null {
  if (!item.Name) return null;
  const isMovie = item.Type === "Movie";
  const runtimeSeconds = item.RunTimeTicks ? secondsFromTicks(item.RunTimeTicks) : null;
  if (isMovie && (runtimeSeconds === null || runtimeSeconds < 1)) return null;
  const posterTag = item.ImageTags?.Primary ?? undefined;
  const poster = posterTag ? { itemId: item.Id, type: "Primary" as const } : null;
  const backdropTag = item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0];
  const backdropItemId = item.ParentBackdropImageTags?.length
    ? item.ParentBackdropItemId
    : item.BackdropImageTags?.length
      ? item.Id
      : undefined;
  const positionSeconds =
    runtimeSeconds === null
      ? 0
      : Math.min(runtimeSeconds, secondsFromTicks(item.UserData?.PlaybackPositionTicks ?? 0));

  return {
    artwork: {
      ...artworkPalette(item, posterTag, backdropTag),
      backdrop: backdropItemId ? { itemId: backdropItemId, type: "Backdrop" } : null,
      poster,
    },
    contentRating: compactText(item.OfficialRating, 32),
    externalId: item.Id,
    kind: isMovie ? "movie" : "series",
    overview: compactText(item.Overview, 2_000),
    played: item.UserData?.Played ?? false,
    positionSeconds,
    runtimeSeconds,
    title: item.Name,
    year:
      item.ProductionYear !== null &&
      item.ProductionYear !== undefined &&
      item.ProductionYear >= 1870 &&
      item.ProductionYear <= 2200
        ? item.ProductionYear
        : null,
  };
}

function normalizedExtraType(value: string | null | undefined, localTrailer: boolean) {
  if (localTrailer) return "trailer" as const;
  switch (value) {
    case "Trailer":
      return "trailer" as const;
    case "Clip":
      return "clip" as const;
    case "BehindTheScenes":
      return "behind_the_scenes" as const;
    case "DeletedScene":
      return "deleted_scene" as const;
    case "Interview":
      return "interview" as const;
    case "Scene":
      return "scene" as const;
    case "Sample":
      return "sample" as const;
    case "Featurette":
      return "featurette" as const;
    case "Short":
      return "short" as const;
    default:
      return "other" as const;
  }
}

function normalizeLibraryExtra(
  item: z.infer<typeof jellyfinLibraryExtraItemSchema>,
  localTrailer: boolean,
): JellyfinLibraryExtra | null {
  if (item.Type !== "Video" && item.Type !== "Movie" && item.Type !== "Episode") return null;
  const runtimeSeconds = secondsFromTicks(item.RunTimeTicks);
  if (runtimeSeconds < 1) return null;
  const posterTag = item.ImageTags?.Primary ?? undefined;
  const backdropTag = item.BackdropImageTags?.[0];
  return {
    artwork: {
      ...artworkPalette(item, posterTag, backdropTag),
      backdrop: backdropTag ? { itemId: item.Id, type: "Backdrop" } : null,
      poster: posterTag ? { itemId: item.Id, type: "Primary" } : null,
    },
    contentRating: compactText(item.OfficialRating, 32),
    externalId: item.Id,
    extraType: normalizedExtraType(item.ExtraType, localTrailer),
    overview: compactText(item.Overview, 2_000),
    played: item.UserData?.Played ?? false,
    positionSeconds: Math.min(
      runtimeSeconds,
      secondsFromTicks(item.UserData?.PlaybackPositionTicks ?? 0),
    ),
    runtimeSeconds,
    title: item.Name,
    year:
      item.ProductionYear !== null &&
      item.ProductionYear !== undefined &&
      item.ProductionYear >= 1870 &&
      item.ProductionYear <= 2200
        ? item.ProductionYear
        : null,
  };
}

const EXTRA_TYPE_ORDER: Readonly<Record<LibraryExtraType, number>> = {
  trailer: 0,
  clip: 1,
  featurette: 2,
  behind_the_scenes: 3,
  deleted_scene: 4,
  interview: 5,
  scene: 6,
  sample: 7,
  short: 8,
  other: 9,
};

function normalizeLibraryEpisode(
  item: z.infer<typeof jellyfinLibraryEpisodeSchema>,
): JellyfinLibraryEpisode | null {
  const runtimeSeconds = secondsFromTicks(item.RunTimeTicks);
  if (runtimeSeconds < 1) return null;
  const posterTag = item.ImageTags?.Primary ?? item.SeriesPrimaryImageTag ?? undefined;
  const poster = posterTag
    ? {
        itemId: item.ImageTags?.Primary ? item.Id : item.SeriesId,
        type: "Primary" as const,
      }
    : null;
  const backdropTag = item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0];
  const backdropItemId = item.ParentBackdropImageTags?.length
    ? (item.ParentBackdropItemId ?? item.SeriesId)
    : item.BackdropImageTags?.length
      ? item.Id
      : undefined;
  return {
    airDate: dateOnly(item.PremiereDate),
    artwork: {
      ...artworkPalette(item, posterTag, backdropTag),
      backdrop: backdropItemId ? { itemId: backdropItemId, type: "Backdrop" } : null,
      poster,
    },
    contentRating: compactText(item.OfficialRating, 32),
    communityRating: boundedRating(item.CommunityRating, 10),
    criticRating: boundedRating(item.CriticRating, 100),
    ...episodeCredits(item.People),
    episodeNumber: item.IndexNumber ?? null,
    externalId: item.Id,
    kind: "episode",
    genres: uniqueText(item.Genres, LIBRARY_EPISODE_MAX_GENRES, 100),
    overview: compactText(item.Overview, 2_000),
    played: item.UserData?.Played ?? false,
    positionSeconds: Math.min(
      runtimeSeconds,
      secondsFromTicks(item.UserData?.PlaybackPositionTicks ?? 0),
    ),
    runtimeSeconds,
    seasonNumber: item.ParentIndexNumber ?? null,
    subtitle: episodeLabel(item),
    title: item.Name,
    studios: uniqueText(
      item.Studios?.flatMap(({ Name }) => (Name === null || Name === undefined ? [] : [Name])),
      LIBRARY_EPISODE_MAX_STUDIOS,
      160,
    ),
    year:
      item.ProductionYear !== null &&
      item.ProductionYear !== undefined &&
      item.ProductionYear >= 1870 &&
      item.ProductionYear <= 2200
        ? item.ProductionYear
        : null,
  };
}

interface JellyfinSeasonProgressFallback {
  episodeCount: number;
  playedEpisodeCount: number | null;
}

function normalizeLibrarySeason(
  item: z.infer<typeof jellyfinLibrarySeasonSchema>,
  fallback?: JellyfinSeasonProgressFallback,
): JellyfinLibrarySeason {
  const episodeCount = item.RecursiveItemCount ?? item.ChildCount ?? fallback?.episodeCount ?? 0;
  const unplayed = Math.min(episodeCount, item.UserData?.UnplayedItemCount ?? episodeCount);
  return {
    episodeCount,
    playedEpisodeCount: item.UserData?.Played
      ? episodeCount
      : item.UserData?.UnplayedItemCount !== null && item.UserData?.UnplayedItemCount !== undefined
        ? episodeCount - unplayed
        : (fallback?.playedEpisodeCount ?? 0),
    seasonNumber: item.IndexNumber,
    title: item.Name,
  };
}

function libraryItemTypes(kind: JellyfinLibraryBrowseInput["kind"]) {
  if (kind === "movies") return "Movie";
  if (kind === "series") return "Series";
  return "Movie,Series";
}

function viewingHistoryItemTypes(kind: ViewingHistoryKind) {
  if (kind === "movies") return "Movie";
  if (kind === "episodes") return "Episode";
  return "Movie,Episode";
}

function librarySort(sort: JellyfinLibraryBrowseInput["sort"]) {
  if (sort === "title") return { SortBy: "SortName", SortOrder: "Ascending" };
  if (sort === "year") {
    return { SortBy: "ProductionYear,SortName", SortOrder: "Descending,Ascending" };
  }
  return { SortBy: "DateCreated", SortOrder: "Descending" };
}

export class JellyfinUserMediaClient {
  readonly #authorization: string;
  readonly #client: SafeHttpClient;

  public constructor(options: JellyfinUserMediaClientOptions) {
    const metadata = jellyfinClientMetadata(options.metadata);
    this.#authorization = jellyfinAuthorization({
      accessToken: options.accessToken,
      deviceId: options.deviceId,
      metadata,
    });
    const target = options.target;
    this.#client = new SafeHttpClient({
      allowInsecureHttp: target.insecureHttpApproved ?? false,
      baseUrl: target.baseUrl,
      ...(target.maxResponseBytes === undefined
        ? { maxResponseBytes: 1_048_576 }
        : { maxResponseBytes: target.maxResponseBytes }),
      ...(target.resolveHost === undefined ? {} : { resolveHost: target.resolveHost }),
      service: "jellyfin",
      ...(target.timeoutMs === undefined ? {} : { timeoutMs: target.timeoutMs }),
      ...(target.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: target.tlsCaCertificatePem }),
      ...(target.tlsPolicy === undefined ? {} : { tlsPolicy: target.tlsPolicy }),
      ...(target.transport === undefined ? {} : { transport: target.transport }),
    });
  }

  public async readContinueWatching(signal?: AbortSignal): Promise<JellyfinContinueWatchingResult> {
    const response = await this.#client.requestJson(
      "UserItems/Resume",
      jellyfinResumeResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.continue_watching",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableUserData: "true",
          ExcludeActiveSessions: "true",
          Fields: "Overview,ProductionYear,OfficialRating,ImageBlurHashes",
          ImageTypeLimit: "1",
          Limit: String(JELLYFIN_CONTINUE_WATCHING_LIMIT + 1),
          MediaTypes: "Video",
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );

    const items = response.Items.slice(0, JELLYFIN_CONTINUE_WATCHING_LIMIT)
      .map(normalizeResumeItem)
      .filter((item): item is JellyfinContinueWatchingItem => item !== null);
    return {
      items,
      truncated:
        response.Items.length > JELLYFIN_CONTINUE_WATCHING_LIMIT ||
        (response.TotalRecordCount ?? 0) > JELLYFIN_CONTINUE_WATCHING_LIMIT,
    };
  }

  public async readViewingHistory(
    rawInput: JellyfinViewingHistoryInput,
    signal?: AbortSignal,
  ): Promise<JellyfinViewingHistoryResult> {
    const input = jellyfinViewingHistoryInputSchema.parse(rawInput);
    const collected: JellyfinViewingHistoryItem[] = [];
    const since = input.since === undefined ? null : Date.parse(input.since);
    let boundaryFound = input.afterItemId === undefined;
    let exhausted = false;
    let startIndex = 0;

    for (let page = 0; page < JELLYFIN_VIEWING_HISTORY_MAX_SCAN_PAGES && !exhausted; page += 1) {
      const response = await this.#client.requestJson(
        `Users/${input.userId}/Items`,
        jellyfinViewingHistoryResponseSchema,
        {
          headers: { authorization: this.#authorization },
          operation: "media.viewing_history",
          query: {
            EnableImageTypes: "Primary,Backdrop",
            EnableTotalRecordCount: "false",
            EnableUserData: "true",
            Fields: "Overview,ProductionYear,OfficialRating,ImageBlurHashes",
            ImageTypeLimit: "1",
            IncludeItemTypes: viewingHistoryItemTypes(input.kind),
            IsMissing: "false",
            IsVirtualItem: "false",
            Limit: String(JELLYFIN_VIEWING_HISTORY_SCAN_PAGE_SIZE),
            Recursive: "true",
            SortBy: "DatePlayed",
            SortOrder: "Descending",
            StartIndex: String(startIndex),
            ...(input.state === "completed"
              ? { Filters: "IsPlayed" }
              : input.state === "in_progress"
                ? { Filters: "IsResumable" }
                : {}),
          },
          ...(signal === undefined ? {} : { signal }),
        },
      );

      for (const rawItem of response.Items) {
        if (!boundaryFound) {
          if (rawItem.Id === input.afterItemId) boundaryFound = true;
          continue;
        }
        const item = normalizeViewingHistoryItem(rawItem);
        if (!item) continue;
        if (input.state === "completed" && !item.played) continue;
        if (input.state === "in_progress" && item.played) continue;
        if (since !== null && Date.parse(item.lastPlayedAt) < since) {
          exhausted = true;
          break;
        }
        collected.push(item);
        if (collected.length > input.limit) break;
      }

      if (collected.length > input.limit) break;
      if (response.Items.length < JELLYFIN_VIEWING_HISTORY_SCAN_PAGE_SIZE) exhausted = true;
      startIndex += response.Items.length;
    }

    if (!exhausted && collected.length <= input.limit) {
      throw this.#client.invalidResponse("media.viewing_history");
    }
    if (!boundaryFound) return { boundaryFound: false, items: [], nextAfterItemId: null };
    const items = collected.slice(0, input.limit);
    return {
      boundaryFound: true,
      items,
      nextAfterItemId:
        collected.length > input.limit && items.length > 0
          ? items[items.length - 1]!.externalId
          : null,
    };
  }

  public async readLibrary(
    rawInput: JellyfinLibraryBrowseInput,
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryResult> {
    const input = jellyfinLibraryQuerySchema.parse(rawInput);
    const response = await this.#client.requestJson(
      `Users/${input.userId}/Items`,
      jellyfinLibraryResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableTotalRecordCount: "true",
          EnableUserData: "true",
          Fields: "Overview,ProductionYear,OfficialRating,ImageBlurHashes",
          ImageTypeLimit: "1",
          IncludeItemTypes: libraryItemTypes(input.kind),
          IsMissing: "false",
          IsVirtualItem: "false",
          Limit: String(input.limit + 1),
          Recursive: "true",
          ...(input.query === undefined ? {} : { SearchTerm: input.query }),
          ...librarySort(input.sort),
          StartIndex: String(input.startIndex),
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const reportedTotalResults = response.TotalRecordCount ?? null;
    const totalResults =
      reportedTotalResults !== null &&
      reportedTotalResults >= input.startIndex + response.Items.length
        ? reportedTotalResults
        : null;
    const consumed = Math.min(response.Items.length, input.limit);
    const nextStartIndex =
      totalResults === null
        ? response.Items.length > input.limit
          ? input.startIndex + consumed
          : null
        : input.startIndex + consumed < totalResults
          ? input.startIndex + consumed
          : null;
    if (nextStartIndex !== null && consumed === 0) {
      throw this.#client.invalidResponse("media.library");
    }
    return {
      items: response.Items.slice(0, input.limit)
        .map(normalizeLibraryItem)
        .filter((item): item is JellyfinLibraryItem => item !== null),
      nextStartIndex,
      totalResults,
      truncated: nextStartIndex !== null,
    };
  }

  async #readPersonIdentities(
    personItemIds: readonly string[],
    userId: string,
    signal?: AbortSignal,
  ): Promise<Map<string, JellyfinLibraryPersonIdentity>> {
    const uniqueIds = [...new Set(personItemIds)];
    const identities = new Map<string, JellyfinLibraryPersonIdentity>();
    for (let offset = 0; offset < uniqueIds.length; offset += JELLYFIN_PERSON_LOOKUP_BATCH_SIZE) {
      const batch = uniqueIds.slice(offset, offset + JELLYFIN_PERSON_LOOKUP_BATCH_SIZE);
      const expected = new Set(batch);
      const response = await this.#client.requestJson("Items", jellyfinPersonItemsResponseSchema, {
        headers: { authorization: this.#authorization },
        operation: "media.library.people",
        query: {
          EnableImages: "false",
          EnableTotalRecordCount: "false",
          EnableUserData: "false",
          Fields: "ProviderIds",
          Ids: batch.join(","),
          IncludeItemTypes: "Person",
          Limit: String(batch.length),
          UserId: userId,
        },
        ...(signal === undefined ? {} : { signal }),
      });
      for (const person of response.Items) {
        if (!expected.has(person.Id) || identities.has(person.Id)) {
          throw this.#client.invalidResponse("media.library.people");
        }
        const tmdbId = normalizedTmdbPersonId(person.ProviderIds);
        if (tmdbId !== null) identities.set(person.Id, { itemId: person.Id, tmdbId });
      }
    }
    return identities;
  }

  public async readLibraryPerson(
    rawInput: { itemId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryPerson> {
    const input = jellyfinLibraryTitleQuerySchema.parse(rawInput);
    const person = await this.#client.requestJson(
      `Items/${input.itemId}`,
      jellyfinPersonItemSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library.people",
        query: { Fields: "ProviderIds", UserId: input.userId },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const tmdbId = normalizedTmdbPersonId(person.ProviderIds);
    if (person.Id !== input.itemId || tmdbId === null) {
      throw this.#client.invalidResponse("media.library.people");
    }
    return { itemId: person.Id, name: person.Name, tmdbId };
  }

  public async readLibraryTitle(
    rawInput: { itemId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryTitleResult> {
    const input = jellyfinLibraryTitleQuerySchema.parse(rawInput);
    const itemResponse = await this.#client.requestJson(
      `Items/${input.itemId}`,
      jellyfinLibraryItemSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          Fields:
            "Overview,ProductionYear,OfficialRating,CommunityRating,CriticRating,PremiereDate,Genres,Studios,Taglines,People,MediaSources,ProviderIds,ImageBlurHashes",
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const item = normalizeLibraryItem(itemResponse);
    if (!item || item.externalId !== input.itemId)
      throw this.#client.invalidResponse("media.library");
    const rawCredits = movieCredits(itemResponse.People);
    const personIds = [...rawCredits.cast, ...rawCredits.crew].flatMap(({ personItemId }) =>
      personItemId === null ? [] : [personItemId],
    );
    const credits = resolvedTitleCredits(
      rawCredits,
      await this.#readPersonIdentities(personIds, input.userId, signal),
    );
    if (item.kind === "movie") {
      return {
        item,
        movie: { ...normalizeMovieDetail(itemResponse), ...credits },
        providerReferences: normalizeTitleProviderReferences(itemResponse),
        removal: normalizeMovieRemovalFacts(itemResponse),
        seasons: [],
        seasonsTruncated: false,
        seriesCredits: null,
      };
    }

    const seasonsResponse = await this.#client.requestJson(
      `Shows/${input.itemId}/Seasons`,
      jellyfinLibrarySeasonsResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableUserData: "true",
          Fields: "ItemCounts",
          ImageTypeLimit: "1",
          IsMissing: "false",
          Limit: String(JELLYFIN_LIBRARY_SEASON_LIMIT + 1),
          SortBy: "IndexNumber",
          SortOrder: "Ascending",
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const seasonItems = seasonsResponse.Items.slice(0, JELLYFIN_LIBRARY_SEASON_LIMIT);
    const fallbackProgress = new Map<string, JellyfinSeasonProgressFallback>();
    const seasonsWithoutCounts = seasonItems.filter(
      (season) =>
        (season.RecursiveItemCount === null || season.RecursiveItemCount === undefined) &&
        (season.ChildCount === null || season.ChildCount === undefined),
    );
    for (
      let offset = 0;
      offset < seasonsWithoutCounts.length;
      offset += JELLYFIN_SEASON_COUNT_CONCURRENCY
    ) {
      const batch = seasonsWithoutCounts.slice(offset, offset + JELLYFIN_SEASON_COUNT_CONCURRENCY);
      const progress = await Promise.all(
        batch.map((season) =>
          this.#readSeasonProgress(
            {
              seasonNumber: season.IndexNumber,
              seriesId: input.itemId,
              userId: input.userId,
            },
            signal,
          ),
        ),
      );
      for (const [index, season] of batch.entries()) {
        fallbackProgress.set(season.Id, progress[index]!);
      }
    }
    return {
      item,
      movie: null,
      providerReferences: normalizeTitleProviderReferences(itemResponse),
      seasons: seasonItems.map((season) =>
        normalizeLibrarySeason(season, fallbackProgress.get(season.Id)),
      ),
      seasonsTruncated: seasonsResponse.Items.length > JELLYFIN_LIBRARY_SEASON_LIMIT,
      seriesCredits: credits,
    };
  }

  public async readOriginalDownloadMetadata(
    rawInput: { itemId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<JellyfinOriginalDownloadMetadata> {
    const input = jellyfinLibraryTitleQuerySchema.parse(rawInput);
    const response = await this.#client.requestJson(
      `Items/${input.itemId}`,
      jellyfinOriginalDownloadItemSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.original_download.metadata",
        query: { Fields: "MediaSources", UserId: input.userId },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const matchingSources = (response.MediaSources ?? []).filter(
      (candidate) => candidate.Id === input.itemId,
    );
    const source = matchingSources.length === 1 ? matchingSources[0]! : null;
    const canDownload = response.CanDownload === true;
    if (
      !response.Name ||
      response.Id !== input.itemId ||
      (canDownload && (!source || !source.Size))
    ) {
      throw this.#client.invalidResponse("media.original_download.metadata");
    }
    const episodeTitle =
      response.Type === "Episode"
        ? [response.SeriesName, episodeLabel(response)].filter(Boolean).join(" - ")
        : response.Name;
    return {
      canDownload,
      container:
        compactText(source?.Container ?? response.Container, 64)?.toLocaleLowerCase("en-US") ??
        null,
      etag: response.Etag ?? null,
      externalId: response.Id,
      sizeBytes: source?.Size ?? null,
      title: episodeTitle.slice(0, 600),
      year:
        response.ProductionYear !== null &&
        response.ProductionYear !== undefined &&
        response.ProductionYear >= 1870 &&
        response.ProductionYear <= 2200
          ? response.ProductionYear
          : null,
    };
  }

  public async streamOriginalDownload(
    rawInput: { itemId: string; maxResponseBytes: number; range?: string },
    signal?: AbortSignal,
  ): Promise<JellyfinOriginalDownloadStream> {
    const input = jellyfinOriginalDownloadInputSchema.parse(rawInput);
    const response = await this.#client.requestStream(
      `Items/${input.itemId}/Download`,
      {
        acceptedStatuses: [200, 206, 416],
        headers: {
          authorization: this.#authorization,
          ...(input.range === undefined ? {} : { range: input.range }),
        },
        operation: "media.original_download.stream",
        ...(signal === undefined ? {} : { signal }),
      },
      input.maxResponseBytes,
    );
    if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
      await response.body.cancel();
      throw this.#client.invalidResponse("media.original_download.stream");
    }
    const contentLengthValue = response.headers.get("content-length");
    const contentLength = contentLengthValue === null ? null : Number(contentLengthValue);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      await response.body.cancel();
      throw this.#client.invalidResponse("media.original_download.stream");
    }
    const contentRange = response.headers.get("content-range");
    if (contentRange !== null && !/^bytes (?:\d+-\d+|\*)\/\d+$/u.test(contentRange)) {
      await response.body.cancel();
      throw this.#client.invalidResponse("media.original_download.stream");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? null;
    if (
      contentType !== null &&
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(contentType)
    ) {
      await response.body.cancel();
      throw this.#client.invalidResponse("media.original_download.stream");
    }
    return {
      acceptRanges: response.headers.get("accept-ranges")?.toLocaleLowerCase("en-US") === "bytes",
      body: response.body,
      contentLength,
      contentRange,
      contentType,
      status: response.status,
    };
  }

  async #readSeasonProgress(
    input: { seasonNumber: number; seriesId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<JellyfinSeasonProgressFallback> {
    const response = await this.#client.requestJson(
      `Shows/${input.seriesId}/Episodes`,
      jellyfinLibraryEpisodeCountResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImages: "false",
          EnableUserData: "true",
          IsMissing: "false",
          Limit: String(JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT + 1),
          Season: String(input.seasonNumber),
          StartIndex: "0",
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (
      response.TotalRecordCount !== undefined &&
      response.TotalRecordCount < response.Items.length
    ) {
      throw this.#client.invalidResponse("media.library");
    }
    const pageIsComplete =
      response.TotalRecordCount === undefined
        ? response.Items.length <= JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT
        : response.Items.length >= response.TotalRecordCount;
    const episodeCount =
      response.TotalRecordCount ?? (pageIsComplete ? response.Items.length : null);
    if (episodeCount === null) throw this.#client.invalidResponse("media.library");
    return {
      episodeCount,
      playedEpisodeCount: pageIsComplete
        ? response.Items.filter((episode) => episode.UserData?.Played).length
        : null,
    };
  }

  public async readLibraryExtras(
    rawInput: { itemId: string; limit: number; startIndex: number; userId: string },
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryExtrasResult> {
    const input = jellyfinLibraryExtrasQuerySchema.parse(rawInput);
    const request = (path: string) =>
      this.#client.requestJson(path, jellyfinLibraryExtrasResponseSchema, {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          Fields: "Overview,ProductionYear,OfficialRating,ImageBlurHashes",
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      });
    const [trailers, features, parent] = await Promise.allSettled([
      request(`Items/${input.itemId}/LocalTrailers`),
      request(`Items/${input.itemId}/SpecialFeatures`),
      this.#client.requestJson(`Items/${input.itemId}`, jellyfinLibraryProviderIdsSchema, {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: { Fields: "ProviderIds", UserId: input.userId },
        ...(signal === undefined ? {} : { signal }),
      }),
    ]);
    if (trailers.status === "rejected" && features.status === "rejected") {
      throw trailers.reason;
    }

    const normalized = [
      ...(trailers.status === "fulfilled"
        ? trailers.value.map((item) => normalizeLibraryExtra(item, true))
        : []),
      ...(features.status === "fulfilled"
        ? features.value.map((item) => normalizeLibraryExtra(item, false))
        : []),
    ].filter((item): item is JellyfinLibraryExtra => item !== null);
    const unique = new Map<string, JellyfinLibraryExtra>();
    for (const item of normalized) {
      if (!unique.has(item.externalId)) unique.set(item.externalId, item);
    }
    const ordered = [...unique.values()].toSorted(
      (left, right) =>
        EXTRA_TYPE_ORDER[left.extraType] - EXTRA_TYPE_ORDER[right.extraType] ||
        left.title.localeCompare(right.title, "en"),
    );
    const items = ordered.slice(input.startIndex, input.startIndex + input.limit);
    const rawTmdbId = parent.status === "fulfilled" ? parent.value.ProviderIds?.Tmdb : undefined;
    const catalogTmdbId = /^\d{1,10}$/u.test(rawTmdbId ?? "") ? Number(rawTmdbId) : null;
    return {
      catalogTmdbId:
        catalogTmdbId !== null && catalogTmdbId > 0 && catalogTmdbId <= 2_147_483_647
          ? catalogTmdbId
          : null,
      items,
      nextStartIndex:
        input.startIndex + items.length < ordered.length ? input.startIndex + items.length : null,
    };
  }

  public async readLibrarySeasonEpisodes(
    rawInput: JellyfinLibrarySeasonEpisodesInput,
    signal?: AbortSignal,
  ): Promise<JellyfinLibrarySeasonEpisodesResult> {
    const input = jellyfinLibrarySeasonEpisodesQuerySchema.parse(rawInput);
    const response = await this.#client.requestJson(
      `Shows/${input.seriesId}/Episodes`,
      jellyfinLibraryEpisodesResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableUserData: "true",
          Fields:
            "Overview,ProductionYear,OfficialRating,CommunityRating,CriticRating,PremiereDate,Genres,Studios,People,ImageBlurHashes",
          ImageTypeLimit: "1",
          IsMissing: "false",
          Limit: String(input.limit + 1),
          Season: String(input.seasonNumber),
          SortBy: "IndexNumber",
          StartIndex: String(input.startIndex),
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const truncated = response.Items.length > input.limit;
    const items = response.Items.slice(0, input.limit)
      .map(normalizeLibraryEpisode)
      .filter((item): item is JellyfinLibraryEpisode => item !== null);
    const personIds = items.flatMap(({ credits }) =>
      credits.flatMap(({ personItemId }) => (personItemId === null ? [] : [personItemId])),
    );
    const people = await this.#readPersonIdentities(personIds, input.userId, signal);
    return {
      items: items.map((item) => ({
        ...item,
        credits: item.credits.map((credit) => resolvedCredit(credit, people)),
      })),
      nextStartIndex: truncated ? input.startIndex + input.limit : null,
      truncated,
    };
  }

  public async updatePlaybackState(
    rawInput: JellyfinPlaybackStateMutationInput,
    signal?: AbortSignal,
  ): Promise<LibraryPlaybackState> {
    const input = jellyfinPlaybackStateMutationInputSchema.parse(rawInput);
    let mutationError: unknown;
    try {
      if (input.action === "reset_progress") {
        await this.#client.requestBytes(`UserItems/${input.itemId}/UserData`, {
          body: JSON.stringify({ PlaybackPositionTicks: 0 }),
          headers: {
            authorization: this.#authorization,
            "content-type": "application/json",
          },
          method: "POST",
          operation: "media.playback_state",
          query: { userId: input.userId },
          ...(signal === undefined ? {} : { signal }),
        });
      } else {
        await this.#client.requestBytes(`UserPlayedItems/${input.itemId}`, {
          headers: { authorization: this.#authorization },
          method: input.action === "mark_watched" ? "POST" : "DELETE",
          operation: "media.playback_state",
          query: { userId: input.userId },
          ...(signal === undefined ? {} : { signal }),
        });
      }
    } catch (error) {
      if (!(error instanceof SafeConnectorError) || !error.retryable) throw error;
      mutationError = error;
    }

    let playback: LibraryPlaybackState;
    try {
      playback = await this.#readPlaybackState(input.itemId, input.userId, signal);
    } catch (error) {
      throw mutationError ?? error;
    }
    const reconciled =
      input.action === "mark_watched"
        ? playback.played && playback.positionSeconds === 0
        : input.action === "mark_unwatched"
          ? !playback.played && playback.positionSeconds === 0
          : playback.positionSeconds === 0;
    if (!reconciled) throw mutationError ?? this.#client.invalidResponse("media.playback_state");
    return playback;
  }

  async #readPlaybackState(
    itemId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<LibraryPlaybackState> {
    const item = await this.#client.requestJson(
      `Items/${itemId}`,
      jellyfinPlaybackStateItemSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.playback_state",
        query: { EnableUserData: "true", UserId: userId },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (item.Id !== itemId) throw this.#client.invalidResponse("media.playback_state");
    const durationSeconds = secondsFromTicks(item.RunTimeTicks);
    if (durationSeconds < 1) throw this.#client.invalidResponse("media.playback_state");
    return {
      durationSeconds,
      played: item.UserData.Played ?? false,
      positionSeconds: Math.min(
        durationSeconds,
        secondsFromTicks(item.UserData.PlaybackPositionTicks ?? 0),
      ),
    };
  }

  public async readImage(input: {
    itemId: string;
    maxWidth: number;
    signal?: AbortSignal;
    type: "Backdrop" | "Primary";
  }): Promise<JellyfinImageResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.itemId)) {
      throw this.#client.invalidResponse("media.image");
    }
    if (!Number.isInteger(input.maxWidth) || input.maxWidth < 64 || input.maxWidth > 3_840) {
      throw this.#client.invalidResponse("media.image");
    }
    const response = await this.#client.requestBytes(`Items/${input.itemId}/Images/${input.type}`, {
      headers: {
        accept: "image/avif,image/webp,image/jpeg,image/png",
        authorization: this.#authorization,
      },
      operation: "media.image",
      query: { maxWidth: String(input.maxWidth), quality: "90" },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType !== "image/avif" &&
      contentType !== "image/jpeg" &&
      contentType !== "image/png" &&
      contentType !== "image/webp"
    ) {
      throw this.#client.invalidResponse("media.image");
    }
    if (response.body.byteLength === 0) throw this.#client.invalidResponse("media.image");
    return { body: response.body, contentType };
  }
}
