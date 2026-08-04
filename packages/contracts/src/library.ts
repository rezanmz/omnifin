import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";
import { mediaReferenceIdSchema, mediaSummarySchema } from "./dashboard.js";
import { discoveryTrailerSchema } from "./discovery.js";
import { idempotencyKeySchema } from "./requests.js";

export const LIBRARY_ATTENTION_MAX_ITEMS = 100;
export const LIBRARY_ARTWORK_MAX_RESULTS = 40;
export const LIBRARY_BROWSE_MAX_ITEMS = 50;
export const LIBRARY_BROWSE_MAX_TOTAL_RESULTS = 10_000_000;
export const LIBRARY_EPISODE_MAX_CREDITS = 24;
export const LIBRARY_EPISODE_MAX_GENRES = 20;
export const LIBRARY_EPISODE_MAX_STUDIOS = 12;
export const LIBRARY_EXTRAS_MAX_ITEMS = 24;
export const LIBRARY_MOVIE_MAX_AUDIO_TRACKS = 32;
export const LIBRARY_MOVIE_MAX_CAST = 24;
export const LIBRARY_MOVIE_MAX_CREW = 16;
export const LIBRARY_MOVIE_MAX_GENRES = 20;
export const LIBRARY_MOVIE_MAX_MEDIA_SOURCES = 8;
export const LIBRARY_MOVIE_MAX_STUDIOS = 12;
export const LIBRARY_MOVIE_MAX_SUBTITLE_TRACKS = 64;
export const LIBRARY_SEASON_EPISODES_MAX_ITEMS = 50;
export const LIBRARY_TITLE_MAX_SEASONS = 100;
export const VIEWING_HISTORY_MAX_ITEMS = 50;

const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const timestampSchema = z.iso.datetime({ offset: true });
const yearSchema = z.int().min(1870).max(2200).nullable();

export const libraryCursorSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+$/u);
export type LibraryCursor = z.infer<typeof libraryCursorSchema>;

export const libraryBrowseKindSchema = z.enum(["all", "movies", "series"]);
export type LibraryBrowseKind = z.infer<typeof libraryBrowseKindSchema>;

export const libraryBrowseSortSchema = z.enum(["recent", "title", "year"]);
export type LibraryBrowseSort = z.infer<typeof libraryBrowseSortSchema>;

export const libraryBrowseQuerySchema = z.strictObject({
  cursor: libraryCursorSchema.optional(),
  kind: libraryBrowseKindSchema.default("all"),
  limit: z.coerce.number().int().positive().max(LIBRARY_BROWSE_MAX_ITEMS).default(30),
  query: safeTextSchema.max(100).optional(),
  sort: libraryBrowseSortSchema.default("recent"),
});
export type LibraryBrowseQuery = z.infer<typeof libraryBrowseQuerySchema>;

export const libraryPlaybackStateSchema = z
  .strictObject({
    durationSeconds: z.int().positive().max(10_000_000),
    played: z.boolean(),
    positionSeconds: z.int().nonnegative().max(10_000_000),
  })
  .refine((playback) => playback.positionSeconds <= playback.durationSeconds, {
    message: "Library playback position cannot exceed duration.",
    path: ["positionSeconds"],
  });
export type LibraryPlaybackState = z.infer<typeof libraryPlaybackStateSchema>;

export const libraryPlaybackStateActionSchema = z.enum([
  "mark_watched",
  "mark_unwatched",
  "reset_progress",
]);
export type LibraryPlaybackStateAction = z.infer<typeof libraryPlaybackStateActionSchema>;

export const libraryPlaybackStateMutationRequestSchema = z.strictObject({
  action: libraryPlaybackStateActionSchema,
});
export type LibraryPlaybackStateMutationRequest = z.infer<
  typeof libraryPlaybackStateMutationRequestSchema
>;

export const libraryPlaybackStateMutationResponseSchema = z
  .strictObject({
    action: libraryPlaybackStateActionSchema,
    playback: libraryPlaybackStateSchema,
    referenceId: mediaReferenceIdSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((response, context) => {
    const reconciled =
      response.action === "mark_watched"
        ? response.playback.played && response.playback.positionSeconds === 0
        : response.action === "mark_unwatched"
          ? !response.playback.played && response.playback.positionSeconds === 0
          : response.playback.positionSeconds === 0;
    if (!reconciled) {
      context.addIssue({
        code: "custom",
        message: "Playback state must reflect the completed Jellyfin action.",
        path: ["playback"],
      });
    }
  });
export type LibraryPlaybackStateMutationResponse = z.infer<
  typeof libraryPlaybackStateMutationResponseSchema
>;

export const viewingHistoryKindSchema = z.enum(["all", "movies", "episodes"]);
export type ViewingHistoryKind = z.infer<typeof viewingHistoryKindSchema>;

export const viewingHistoryStateSchema = z.enum(["all", "completed", "in_progress"]);
export type ViewingHistoryState = z.infer<typeof viewingHistoryStateSchema>;

export const viewingHistoryRangeSchema = z.enum(["all", "7_days", "30_days", "90_days", "1_year"]);
export type ViewingHistoryRange = z.infer<typeof viewingHistoryRangeSchema>;

export const viewingHistoryCursorSchema = z
  .string()
  .min(16)
  .max(1_024)
  .regex(/^[A-Za-z0-9_.-]+$/u);

export const viewingHistoryQuerySchema = z.strictObject({
  cursor: viewingHistoryCursorSchema.optional(),
  kind: viewingHistoryKindSchema.default("all"),
  limit: z.coerce.number().int().positive().max(VIEWING_HISTORY_MAX_ITEMS).default(24),
  range: viewingHistoryRangeSchema.default("30_days"),
  state: viewingHistoryStateSchema.default("all"),
});
export type ViewingHistoryQuery = z.infer<typeof viewingHistoryQuerySchema>;

export const viewingHistoryEntrySchema = z
  .strictObject({
    activity: z.enum(["completed", "in_progress"]),
    lastPlayedAt: timestampSchema,
    media: mediaSummarySchema,
    playback: libraryPlaybackStateSchema,
  })
  .superRefine((entry, context) => {
    if (!mediaReferenceIdSchema.safeParse(entry.media.id).success) {
      context.addIssue({
        code: "custom",
        message: "Viewing history must use opaque media references.",
        path: ["media", "id"],
      });
    }
    if (
      (entry.media.kind !== "movie" && entry.media.kind !== "episode") ||
      entry.media.availability !== "available"
    ) {
      context.addIssue({
        code: "custom",
        message: "Viewing history entries must be available movies or episodes.",
        path: ["media", "kind"],
      });
    }
    const completed = entry.activity === "completed" && entry.playback.played;
    const inProgress =
      entry.activity === "in_progress" &&
      !entry.playback.played &&
      entry.playback.positionSeconds > 0;
    if (!completed && !inProgress) {
      context.addIssue({
        code: "custom",
        message: "Viewing activity must match the current Jellyfin playback state.",
        path: ["activity"],
      });
    }
    validateLibraryMediaArtwork(entry.media, context);
  });
export type ViewingHistoryEntry = z.infer<typeof viewingHistoryEntrySchema>;

export const viewingHistorySourceSchema = z
  .strictObject({
    displayName: safeTextSchema.max(160),
    failure: partialFailureSchema.nullable(),
    status: z.enum(["healthy", "unavailable"]),
  })
  .superRefine((source, context) => {
    if ((source.status === "healthy") !== (source.failure === null)) {
      context.addIssue({
        code: "custom",
        message: "An unavailable viewing-history source must include one safe failure.",
        path: ["failure"],
      });
    }
    if (
      source.failure &&
      (source.failure.service !== "jellyfin" ||
        (source.failure.operation !== "media.viewing_history" &&
          source.failure.operation !== "media.reference"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Viewing-history failures must identify Jellyfin history or media references.",
        path: ["failure"],
      });
    }
  });
export type ViewingHistorySource = z.infer<typeof viewingHistorySourceSchema>;

export const viewingHistoryResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    items: z.array(viewingHistoryEntrySchema).max(VIEWING_HISTORY_MAX_ITEMS),
    nextCursor: viewingHistoryCursorSchema.nullable(),
    source: viewingHistorySourceSchema,
    state: z.enum(["complete", "empty", "unavailable"]),
  })
  .superRefine((response, context) => {
    const references = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (references.has(item.media.id)) {
        context.addIssue({
          code: "custom",
          message: "Viewing-history references must be unique within a page.",
          path: ["items", index, "media", "id"],
        });
      }
      references.add(item.media.id);
    }
    const complete =
      response.state === "complete" &&
      response.items.length > 0 &&
      response.source.status === "healthy";
    const empty =
      response.state === "empty" &&
      response.items.length === 0 &&
      response.nextCursor === null &&
      response.source.status === "healthy";
    const unavailable =
      response.state === "unavailable" &&
      response.items.length === 0 &&
      response.nextCursor === null &&
      response.source.status === "unavailable";
    if (!complete && !empty && !unavailable) {
      context.addIssue({
        code: "custom",
        message: "Viewing-history state must match its items and Jellyfin source.",
        path: ["state"],
      });
    }
  });
export type ViewingHistoryResponse = z.infer<typeof viewingHistoryResponseSchema>;

function validateLibraryMediaArtwork(
  media: z.infer<typeof mediaSummarySchema>,
  context: z.RefinementCtx,
) {
  for (const [artworkType, path] of Object.entries({
    backdropPath: media.artwork.backdropPath,
    posterPath: media.artwork.posterPath,
  })) {
    if (path !== null && !path.startsWith(`/v1/media/${media.id}/images/`)) {
      context.addIssue({
        code: "custom",
        message: "Library artwork must belong to the same opaque media reference.",
        path: ["media", "artwork", artworkType],
      });
    }
  }
}

export const libraryBrowseItemSchema = z
  .strictObject({
    media: mediaSummarySchema,
    playback: libraryPlaybackStateSchema.nullable(),
  })
  .superRefine((item, context) => {
    if (!mediaReferenceIdSchema.safeParse(item.media.id).success) {
      context.addIssue({
        code: "custom",
        message: "Library catalogue items must use opaque media references.",
        path: ["media", "id"],
      });
    }
    if (item.media.kind !== "movie" && item.media.kind !== "series") {
      context.addIssue({
        code: "custom",
        message: "Library catalogue items must be movie or series titles.",
        path: ["media", "kind"],
      });
    }
    if (item.media.availability !== "available") {
      context.addIssue({
        code: "custom",
        message: "Library catalogue items must be available to the paired Jellyfin user.",
        path: ["media", "availability"],
      });
    }
    if ((item.media.kind === "movie") !== (item.playback !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only movie catalogue titles can include direct playback state.",
        path: ["playback"],
      });
    }
    validateLibraryMediaArtwork(item.media, context);
  });
export type LibraryBrowseItem = z.infer<typeof libraryBrowseItemSchema>;

export const librarySeasonSummarySchema = z
  .strictObject({
    episodeCount: z.int().nonnegative().max(100_000),
    playedEpisodeCount: z.int().nonnegative().max(100_000),
    seasonNumber: z.int().nonnegative().max(100_000),
    title: safeTextSchema.max(300),
  })
  .refine((season) => season.playedEpisodeCount <= season.episodeCount, {
    message: "Played episode count cannot exceed the season episode count.",
    path: ["playedEpisodeCount"],
  });
export type LibrarySeasonSummary = z.infer<typeof librarySeasonSummarySchema>;

export const libraryMovieCreditSchema = z.strictObject({
  imagePath: z
    .string()
    .max(840)
    .regex(/^\/v1\/media\/media_[A-Za-z0-9_-]{22}\/images\/people\/[A-Za-z0-9_.-]{64,768}$/u)
    .nullable(),
  name: safeTextSchema.max(160),
  role: safeTextSchema.max(200).nullable(),
  type: z.enum(["cast", "director", "writer", "producer"]),
});
export type LibraryMovieCredit = z.infer<typeof libraryMovieCreditSchema>;

const libraryMovieTrackSchema = z.strictObject({
  bitrateKbps: z.int().nonnegative().max(10_000_000).nullable(),
  codec: safeTextSchema.max(64).nullable(),
  language: safeTextSchema.max(80).nullable(),
  title: safeTextSchema.max(160).nullable(),
});

export const libraryMovieAudioTrackSchema = libraryMovieTrackSchema.extend({
  channels: z.int().positive().max(64).nullable(),
});
export type LibraryMovieAudioTrack = z.infer<typeof libraryMovieAudioTrackSchema>;

export const libraryMovieSubtitleTrackSchema = libraryMovieTrackSchema
  .omit({
    bitrateKbps: true,
  })
  .extend({
    default: z.boolean(),
    forced: z.boolean(),
  });
export type LibraryMovieSubtitleTrack = z.infer<typeof libraryMovieSubtitleTrackSchema>;

export const libraryMovieVideoSchema = z.strictObject({
  bitrateKbps: z.int().nonnegative().max(10_000_000).nullable(),
  bitDepth: z.int().positive().max(64).nullable(),
  codec: safeTextSchema.max(64).nullable(),
  hdrFormat: safeTextSchema.max(80).nullable(),
  height: z.int().positive().max(100_000).nullable(),
  profile: safeTextSchema.max(80).nullable(),
  width: z.int().positive().max(100_000).nullable(),
});
export type LibraryMovieVideo = z.infer<typeof libraryMovieVideoSchema>;

export const libraryMovieMediaSourceSchema = z.strictObject({
  audio: z.array(libraryMovieAudioTrackSchema).max(LIBRARY_MOVIE_MAX_AUDIO_TRACKS),
  audioTruncated: z.boolean(),
  bitrateKbps: z.int().nonnegative().max(10_000_000).nullable(),
  container: safeTextSchema.max(64).nullable(),
  label: safeTextSchema.max(160),
  sizeBytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  subtitles: z.array(libraryMovieSubtitleTrackSchema).max(LIBRARY_MOVIE_MAX_SUBTITLE_TRACKS),
  subtitlesTruncated: z.boolean(),
  video: libraryMovieVideoSchema.nullable(),
});
export type LibraryMovieMediaSource = z.infer<typeof libraryMovieMediaSourceSchema>;

export const libraryMovieDetailSchema = z.strictObject({
  cast: z.array(libraryMovieCreditSchema).max(LIBRARY_MOVIE_MAX_CAST),
  castTruncated: z.boolean(),
  communityRating: z.number().finite().min(0).max(10).nullable(),
  crew: z.array(libraryMovieCreditSchema).max(LIBRARY_MOVIE_MAX_CREW),
  crewTruncated: z.boolean(),
  criticRating: z.number().finite().min(0).max(100).nullable(),
  genres: z.array(safeTextSchema.max(100)).max(LIBRARY_MOVIE_MAX_GENRES),
  mediaSources: z.array(libraryMovieMediaSourceSchema).max(LIBRARY_MOVIE_MAX_MEDIA_SOURCES),
  mediaSourcesTruncated: z.boolean(),
  premiereDate: z.iso.date().nullable(),
  studios: z.array(safeTextSchema.max(160)).max(LIBRARY_MOVIE_MAX_STUDIOS),
  tagline: safeTextSchema.max(500).nullable(),
});
export type LibraryMovieDetail = z.infer<typeof libraryMovieDetailSchema>;

export const libraryTitleDetailResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    media: mediaSummarySchema,
    movie: libraryMovieDetailSchema.nullable(),
    playback: libraryPlaybackStateSchema.nullable(),
    seasons: z.array(librarySeasonSummarySchema).max(LIBRARY_TITLE_MAX_SEASONS),
    seasonsTruncated: z.boolean(),
  })
  .superRefine((detail, context) => {
    if (!mediaReferenceIdSchema.safeParse(detail.media.id).success) {
      context.addIssue({
        code: "custom",
        message: "Library title details must use an opaque media reference.",
        path: ["media", "id"],
      });
    }
    if (detail.media.kind !== "movie" && detail.media.kind !== "series") {
      context.addIssue({
        code: "custom",
        message: "Library title details must describe a movie or series.",
        path: ["media", "kind"],
      });
    }
    if (detail.media.availability !== "available") {
      context.addIssue({
        code: "custom",
        message: "Library title details must remain available to the paired Jellyfin user.",
        path: ["media", "availability"],
      });
    }
    const movieShape =
      detail.media.kind === "movie" &&
      detail.movie !== null &&
      detail.playback !== null &&
      detail.seasons.length === 0 &&
      !detail.seasonsTruncated;
    const seriesShape =
      detail.media.kind === "series" && detail.movie === null && detail.playback === null;
    if (!movieShape && !seriesShape) {
      context.addIssue({
        code: "custom",
        message: "Library title hierarchy must match its media kind.",
        path: ["playback"],
      });
    }
    if (
      new Set(detail.seasons.map(({ seasonNumber }) => seasonNumber)).size !== detail.seasons.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Library seasons must have unique numbers.",
        path: ["seasons"],
      });
    }
    for (const collection of ["cast", "crew"] as const) {
      for (const [index, credit] of (detail.movie?.[collection] ?? []).entries()) {
        const expectedPrefix = `/v1/media/${detail.media.id}/images/people/`;
        if (credit.imagePath !== null && !credit.imagePath.startsWith(expectedPrefix)) {
          context.addIssue({
            code: "custom",
            message: "Library person artwork must belong to the same opaque media reference.",
            path: ["movie", collection, index, "imagePath"],
          });
        }
      }
    }
    validateLibraryMediaArtwork(detail.media, context);
  });
export type LibraryTitleDetailResponse = z.infer<typeof libraryTitleDetailResponseSchema>;

export const libraryExtraTypeSchema = z.enum([
  "trailer",
  "clip",
  "behind_the_scenes",
  "deleted_scene",
  "interview",
  "scene",
  "sample",
  "featurette",
  "short",
  "other",
]);
export type LibraryExtraType = z.infer<typeof libraryExtraTypeSchema>;

export const libraryExtrasQuerySchema = z.strictObject({
  cursor: libraryCursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(LIBRARY_EXTRAS_MAX_ITEMS).default(12),
});
export type LibraryExtrasQuery = z.infer<typeof libraryExtrasQuerySchema>;

export const libraryExtraSchema = z
  .strictObject({
    extraType: libraryExtraTypeSchema,
    media: mediaSummarySchema,
    playback: libraryPlaybackStateSchema,
    source: z.literal("local"),
  })
  .superRefine((extra, context) => {
    if (!mediaReferenceIdSchema.safeParse(extra.media.id).success) {
      context.addIssue({
        code: "custom",
        message: "Library extras must use opaque media references.",
        path: ["media", "id"],
      });
    }
    if (extra.media.kind !== "other" || extra.media.availability !== "available") {
      context.addIssue({
        code: "custom",
        message: "Library extras must be available local bonus videos.",
        path: ["media", "kind"],
      });
    }
    validateLibraryMediaArtwork(extra.media, context);
  });
export type LibraryExtra = z.infer<typeof libraryExtraSchema>;

export const libraryExtrasSourceSchema = z
  .strictObject({
    displayName: safeTextSchema.max(160),
    failure: partialFailureSchema.nullable(),
    status: z.enum(["healthy", "unavailable"]),
  })
  .superRefine((source, context) => {
    if ((source.status === "healthy") !== (source.failure === null)) {
      context.addIssue({
        code: "custom",
        message: "An unavailable extras source must include one safe failure.",
        path: ["failure"],
      });
    }
    if (
      source.failure &&
      (source.failure.service !== "jellyfin" ||
        (source.failure.operation !== "media.library" &&
          source.failure.operation !== "media.reference"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Library-extra failures must identify Jellyfin library access or references.",
        path: ["failure"],
      });
    }
  });
export type LibraryExtrasSource = z.infer<typeof libraryExtrasSourceSchema>;

export const libraryOnlineExtrasSourceSchema = z
  .strictObject({
    displayName: safeTextSchema.max(160),
    failure: partialFailureSchema.nullable(),
    status: z.enum(["healthy", "unavailable", "unconfigured"]),
  })
  .superRefine((source, context) => {
    const healthy = source.status === "healthy" && source.failure === null;
    const unconfigured = source.status === "unconfigured" && source.failure === null;
    const unavailable =
      source.status === "unavailable" &&
      source.failure?.service === "seerr" &&
      source.failure.operation === "discovery.detail";
    if (!healthy && !unconfigured && !unavailable) {
      context.addIssue({
        code: "custom",
        message: "Online-extra source health must match its safe failure.",
        path: ["failure"],
      });
    }
  });
export type LibraryOnlineExtrasSource = z.infer<typeof libraryOnlineExtrasSourceSchema>;

export const libraryExtrasResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    items: z.array(libraryExtraSchema).max(LIBRARY_EXTRAS_MAX_ITEMS),
    nextCursor: libraryCursorSchema.nullable(),
    onlineItems: z.array(discoveryTrailerSchema).max(LIBRARY_EXTRAS_MAX_ITEMS),
    onlineSource: libraryOnlineExtrasSourceSchema,
    onlineState: z.enum(["ready", "empty", "unavailable", "unconfigured"]),
    parentReferenceId: mediaReferenceIdSchema,
    source: libraryExtrasSourceSchema,
    state: z.enum(["complete", "empty", "unavailable"]),
  })
  .superRefine((response, context) => {
    const references = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (item.media.id === response.parentReferenceId || references.has(item.media.id)) {
        context.addIssue({
          code: "custom",
          message: "Library extras must use unique child references.",
          path: ["items", index, "media", "id"],
        });
      }
      references.add(item.media.id);
    }
    const complete =
      response.state === "complete" &&
      response.items.length > 0 &&
      response.source.status === "healthy";
    const empty =
      response.state === "empty" &&
      response.items.length === 0 &&
      response.nextCursor === null &&
      response.source.status === "healthy";
    const unavailable =
      response.state === "unavailable" &&
      response.items.length === 0 &&
      response.nextCursor === null &&
      response.source.status === "unavailable";
    if (!complete && !empty && !unavailable) {
      context.addIssue({
        code: "custom",
        message: "Library-extra state must match its items and Jellyfin source.",
        path: ["state"],
      });
    }
    const onlineReady =
      response.onlineState === "ready" &&
      response.onlineItems.length > 0 &&
      response.onlineSource.status === "healthy";
    const onlineEmpty =
      response.onlineState === "empty" &&
      response.onlineItems.length === 0 &&
      response.onlineSource.status === "healthy";
    const onlineUnavailable =
      response.onlineState === "unavailable" &&
      response.onlineItems.length === 0 &&
      response.onlineSource.status === "unavailable";
    const onlineUnconfigured =
      response.onlineState === "unconfigured" &&
      response.onlineItems.length === 0 &&
      response.onlineSource.status === "unconfigured";
    if (!onlineReady && !onlineEmpty && !onlineUnavailable && !onlineUnconfigured) {
      context.addIssue({
        code: "custom",
        message: "Online-extra state must match its items and discovery source.",
        path: ["onlineState"],
      });
    }
  });
export type LibraryExtrasResponse = z.infer<typeof libraryExtrasResponseSchema>;

export const librarySeasonEpisodesQuerySchema = z.strictObject({
  cursor: libraryCursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(LIBRARY_SEASON_EPISODES_MAX_ITEMS).default(30),
});
export type LibrarySeasonEpisodesQuery = z.infer<typeof librarySeasonEpisodesQuerySchema>;

export const libraryEpisodeCreditSchema = z.strictObject({
  name: safeTextSchema.max(160),
  role: safeTextSchema.max(200).nullable(),
  type: z.enum(["cast", "director", "writer"]),
});
export type LibraryEpisodeCredit = z.infer<typeof libraryEpisodeCreditSchema>;

export const librarySeasonEpisodeSchema = z
  .strictObject({
    airDate: z.iso.date().nullable(),
    communityRating: z.number().finite().min(0).max(10).nullable(),
    credits: z.array(libraryEpisodeCreditSchema).max(LIBRARY_EPISODE_MAX_CREDITS),
    creditsTruncated: z.boolean(),
    criticRating: z.number().finite().min(0).max(100).nullable(),
    genres: z.array(safeTextSchema.max(100)).max(LIBRARY_EPISODE_MAX_GENRES),
    media: mediaSummarySchema,
    playback: libraryPlaybackStateSchema,
    studios: z.array(safeTextSchema.max(160)).max(LIBRARY_EPISODE_MAX_STUDIOS),
  })
  .superRefine((episode, context) => {
    if (!mediaReferenceIdSchema.safeParse(episode.media.id).success) {
      context.addIssue({
        code: "custom",
        message: "Library episodes must use opaque media references.",
        path: ["media", "id"],
      });
    }
    if (episode.media.kind !== "episode" || episode.media.availability !== "available") {
      context.addIssue({
        code: "custom",
        message: "Library season entries must be available episodes.",
        path: ["media", "kind"],
      });
    }
    validateLibraryMediaArtwork(episode.media, context);
  });
export type LibrarySeasonEpisode = z.infer<typeof librarySeasonEpisodeSchema>;

export const librarySeasonEpisodesResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    items: z.array(librarySeasonEpisodeSchema).max(LIBRARY_SEASON_EPISODES_MAX_ITEMS),
    nextCursor: libraryCursorSchema.nullable(),
    seasonNumber: z.int().nonnegative().max(100_000),
    titleReferenceId: mediaReferenceIdSchema,
  })
  .superRefine((response, context) => {
    const references = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (references.has(item.media.id)) {
        context.addIssue({
          code: "custom",
          message: "Library episode references must be unique within a page.",
          path: ["items", index, "media", "id"],
        });
      }
      references.add(item.media.id);
    }
    if (response.items.length === 0 && response.nextCursor !== null) {
      context.addIssue({
        code: "custom",
        message: "An empty season page cannot include a continuation cursor.",
        path: ["nextCursor"],
      });
    }
  });
export type LibrarySeasonEpisodesResponse = z.infer<typeof librarySeasonEpisodesResponseSchema>;

export const libraryBrowseSourceSchema = z
  .strictObject({
    displayName: safeTextSchema.max(160),
    failure: partialFailureSchema.nullable(),
    status: z.enum(["healthy", "unavailable"]),
  })
  .superRefine((source, context) => {
    if ((source.status === "healthy") !== (source.failure === null)) {
      context.addIssue({
        code: "custom",
        message: "An unavailable library source must include one safe failure.",
        path: ["failure"],
      });
    }
    if (source.failure && source.failure.service !== "jellyfin") {
      context.addIssue({
        code: "custom",
        message: "Library source failures must identify Jellyfin.",
        path: ["failure", "service"],
      });
    }
    if (
      source.failure &&
      source.failure.operation !== "media.library" &&
      source.failure.operation !== "media.reference"
    ) {
      context.addIssue({
        code: "custom",
        message: "Library source failures must identify a catalogue operation.",
        path: ["failure", "operation"],
      });
    }
  });
export type LibraryBrowseSource = z.infer<typeof libraryBrowseSourceSchema>;

export const libraryBrowseResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    items: z.array(libraryBrowseItemSchema).max(LIBRARY_BROWSE_MAX_ITEMS),
    nextCursor: libraryCursorSchema.nullable(),
    source: libraryBrowseSourceSchema,
    state: z.enum(["complete", "empty", "unavailable"]),
    totalResults: z.int().nonnegative().max(LIBRARY_BROWSE_MAX_TOTAL_RESULTS).nullable(),
  })
  .superRefine((response, context) => {
    const references = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (references.has(item.media.id)) {
        context.addIssue({
          code: "custom",
          message: "Library media references must be unique within a page.",
          path: ["items", index, "media", "id"],
        });
      }
      references.add(item.media.id);
    }
    const healthy = response.source.status === "healthy";
    const expectedState = !healthy
      ? "unavailable"
      : response.items.length === 0
        ? "empty"
        : "complete";
    if (response.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "Library catalogue state must match source health and returned items.",
        path: ["state"],
      });
    }
    if (!healthy && (response.items.length > 0 || response.nextCursor !== null)) {
      context.addIssue({
        code: "custom",
        message: "Unavailable library sources cannot return media or pagination.",
        path: ["items"],
      });
    }
    if (healthy !== (response.totalResults !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only a healthy library source can report an exact result total.",
        path: ["totalResults"],
      });
    }
    if (
      response.totalResults !== null &&
      (response.totalResults < response.items.length ||
        (response.items.length === 0) !== (response.totalResults === 0))
    ) {
      context.addIssue({
        code: "custom",
        message: "Library result totals must agree with the returned catalogue state.",
        path: ["totalResults"],
      });
    }
    if (response.items.length === 0 && response.nextCursor !== null) {
      context.addIssue({
        code: "custom",
        message: "An empty library page cannot include a continuation cursor.",
        path: ["nextCursor"],
      });
    }
  });
export type LibraryBrowseResponse = z.infer<typeof libraryBrowseResponseSchema>;

export const libraryAttentionQuerySchema = z.strictObject({
  cursor: libraryCursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(LIBRARY_ATTENTION_MAX_ITEMS).default(30),
});
export type LibraryAttentionQuery = z.infer<typeof libraryAttentionQuerySchema>;

export const libraryAttentionIssueSchema = z.enum([
  "missing_identity",
  "missing_overview",
  "missing_poster",
  "missing_year",
]);
export type LibraryAttentionIssue = z.infer<typeof libraryAttentionIssueSchema>;

const attentionIssueOrder: readonly LibraryAttentionIssue[] = [
  "missing_identity",
  "missing_overview",
  "missing_poster",
  "missing_year",
];

export const libraryAttentionItemSchema = z
  .strictObject({
    identityState: z.enum(["identified", "unmatched"]),
    issues: z.array(libraryAttentionIssueSchema).min(1).max(attentionIssueOrder.length),
    kind: z.enum(["movie", "series"]),
    overview: safeTextSchema.max(2_000).nullable(),
    posterPath: z.string().max(512).nullable(),
    referenceId: mediaReferenceIdSchema,
    title: safeTextSchema.max(300),
    year: yearSchema,
  })
  .superRefine((item, context) => {
    const uniqueIssues = new Set(item.issues);
    if (uniqueIssues.size !== item.issues.length) {
      context.addIssue({
        code: "custom",
        message: "Library attention issues must be unique.",
        path: ["issues"],
      });
    }
    const canonicalIssues = attentionIssueOrder.filter((issue) => uniqueIssues.has(issue));
    if (canonicalIssues.some((issue, index) => issue !== item.issues[index])) {
      context.addIssue({
        code: "custom",
        message: "Library attention issues must use canonical priority order.",
        path: ["issues"],
      });
    }
    if ((item.identityState === "unmatched") !== uniqueIssues.has("missing_identity")) {
      context.addIssue({
        code: "custom",
        message: "Unmatched library items must report a missing identity.",
        path: ["identityState"],
      });
    }
    if ((item.overview === null) !== uniqueIssues.has("missing_overview")) {
      context.addIssue({
        code: "custom",
        message: "Library overview state must match its attention issue.",
        path: ["overview"],
      });
    }
    if ((item.year === null) !== uniqueIssues.has("missing_year")) {
      context.addIssue({
        code: "custom",
        message: "Library year state must match its attention issue.",
        path: ["year"],
      });
    }
    const expectedPosterPath = `/v1/media/${item.referenceId}/images/poster`;
    if (
      (item.posterPath === null) !== uniqueIssues.has("missing_poster") ||
      (item.posterPath !== null && item.posterPath !== expectedPosterPath)
    ) {
      context.addIssue({
        code: "custom",
        message: "Library poster state must use its same-origin opaque media reference.",
        path: ["posterPath"],
      });
    }
  });
export type LibraryAttentionItem = z.infer<typeof libraryAttentionItemSchema>;

export const libraryAttentionResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    items: z.array(libraryAttentionItemSchema).max(LIBRARY_ATTENTION_MAX_ITEMS),
    nextCursor: libraryCursorSchema.nullable(),
    scanned: z.int().nonnegative().max(10_000),
    truncated: z.boolean(),
  })
  .superRefine((response, context) => {
    const references = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (references.has(item.referenceId)) {
        context.addIssue({
          code: "custom",
          message: "Library attention references must be unique within a page.",
          path: ["items", index, "referenceId"],
        });
      }
      references.add(item.referenceId);
    }
    if (response.items.length > response.scanned) {
      context.addIssue({
        code: "custom",
        message: "Library attention pages cannot return more items than they scanned.",
        path: ["scanned"],
      });
    }
    if ((response.nextCursor !== null) !== response.truncated) {
      context.addIssue({
        code: "custom",
        message: "Truncated library attention pages require a continuation cursor.",
        path: ["nextCursor"],
      });
    }
  });
export type LibraryAttentionResponse = z.infer<typeof libraryAttentionResponseSchema>;

export const libraryOperationIdSchema = z.string().regex(/^library_operation_[A-Za-z0-9_-]{22}$/u);
export const libraryRemovalPreviewIdSchema = z
  .string()
  .regex(/^library_removal_preview_[A-Za-z0-9_-]{22}$/u);
export const libraryArtworkSearchIdSchema = z
  .string()
  .regex(/^library_artwork_search_[A-Za-z0-9_-]{22}$/u);
export const libraryArtworkResultIdSchema = z
  .string()
  .regex(/^library_artwork_result_[A-Za-z0-9_-]{22}$/u);

export const libraryMutationIdempotencyKeySchema = idempotencyKeySchema;
export type LibraryMutationIdempotencyKey = z.infer<typeof libraryMutationIdempotencyKeySchema>;

export const libraryDownloadGrantIdSchema = z.string().regex(/^media_download_[A-Za-z0-9_-]{22}$/u);
export type LibraryDownloadGrantId = z.infer<typeof libraryDownloadGrantIdSchema>;

export const libraryDownloadPrepareRequestSchema = z.strictObject({});
export type LibraryDownloadPrepareRequest = z.infer<typeof libraryDownloadPrepareRequestSchema>;

const libraryDownloadFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !/[\p{Cc}\p{Cf}/\\"]/u.test(value) && value !== "." && value !== "..");

const libraryDownloadContentTypeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);

export const libraryDownloadPrepareResponseSchema = z
  .strictObject({
    archiveRetrieval: z.enum(["unknown", "possible"]),
    contentType: libraryDownloadContentTypeSchema,
    expiresAt: timestampSchema,
    filename: libraryDownloadFilenameSchema,
    generatedAt: timestampSchema,
    grantId: libraryDownloadGrantIdSchema,
    path: z.string().max(160),
    referenceId: mediaReferenceIdSchema,
    sizeBytes: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((response, context) => {
    if (response.path !== `/v1/media/library/downloads/${response.grantId}`) {
      context.addIssue({
        code: "custom",
        message: "Original-download paths must belong to their opaque grant.",
        path: ["path"],
      });
    }
    if (Date.parse(response.expiresAt) <= Date.parse(response.generatedAt)) {
      context.addIssue({
        code: "custom",
        message: "Original-download grants must expire after they are generated.",
        path: ["expiresAt"],
      });
    }
  });
export type LibraryDownloadPrepareResponse = z.infer<typeof libraryDownloadPrepareResponseSchema>;

export const libraryRemovalModeSchema = z.enum([
  "delete_files_keep_monitored",
  "delete_files_and_unmonitor",
  "remove_from_radarr_and_delete_files",
  "delete_unmanaged_files",
]);
export type LibraryRemovalMode = z.infer<typeof libraryRemovalModeSchema>;

export const libraryRemovalSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("managed"),
    monitored: z.boolean(),
    service: z.literal("radarr"),
  }),
  z.strictObject({
    kind: z.literal("unmanaged"),
    monitored: z.null(),
    service: z.literal("jellyfin"),
  }),
]);
export type LibraryRemovalSource = z.infer<typeof libraryRemovalSourceSchema>;

const libraryRemovalEffectsSchema = z.strictObject({
  managerRecord: z.enum(["retained", "removed", "not_applicable"]),
  monitoring: z.enum(["monitored", "unmonitored", "removed", "not_applicable"]),
  organizedFiles: z.literal("deleted"),
  reacquisitionRisk: z.enum(["possible", "prevented", "not_managed"]),
  requestHistory: z.literal("retained"),
  seedingCopies: z.literal("unchanged"),
  storageReclamation: z.literal("may_be_delayed"),
});

export const libraryRemovalOptionSchema = z.strictObject({
  effects: libraryRemovalEffectsSchema,
  mode: libraryRemovalModeSchema,
});
export type LibraryRemovalOption = z.infer<typeof libraryRemovalOptionSchema>;

const commonRemovalEffects = {
  organizedFiles: "deleted",
  requestHistory: "retained",
  seedingCopies: "unchanged",
  storageReclamation: "may_be_delayed",
} as const;

const expectedRemovalEffects = {
  delete_files_keep_monitored: {
    ...commonRemovalEffects,
    managerRecord: "retained",
    monitoring: "monitored",
    reacquisitionRisk: "possible",
  },
  delete_files_and_unmonitor: {
    ...commonRemovalEffects,
    managerRecord: "retained",
    monitoring: "unmonitored",
    reacquisitionRisk: "prevented",
  },
  remove_from_radarr_and_delete_files: {
    ...commonRemovalEffects,
    managerRecord: "removed",
    monitoring: "removed",
    reacquisitionRisk: "prevented",
  },
  delete_unmanaged_files: {
    ...commonRemovalEffects,
    managerRecord: "not_applicable",
    monitoring: "not_applicable",
    reacquisitionRisk: "not_managed",
  },
} as const satisfies Record<LibraryRemovalMode, z.infer<typeof libraryRemovalEffectsSchema>>;

const managedRemovalModes = [
  "delete_files_keep_monitored",
  "delete_files_and_unmonitor",
  "remove_from_radarr_and_delete_files",
] as const satisfies readonly LibraryRemovalMode[];

export const libraryRemovalPreviewSchema = z
  .strictObject({
    confirmation: z.strictObject({
      expectedTitle: safeTextSchema.max(300),
      kind: z.literal("exact_title"),
      recentAuthenticationRequired: z.literal(true),
    }),
    expiresAt: timestampSchema,
    generatedAt: timestampSchema,
    options: z.array(libraryRemovalOptionSchema).min(1).max(managedRemovalModes.length),
    previewId: libraryRemovalPreviewIdSchema,
    referenceId: mediaReferenceIdSchema,
    sizeBytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    source: libraryRemovalSourceSchema,
    title: safeTextSchema.max(300),
    year: yearSchema,
  })
  .superRefine((preview, context) => {
    if (Date.parse(preview.expiresAt) <= Date.parse(preview.generatedAt)) {
      context.addIssue({
        code: "custom",
        message: "Library removal previews must expire after generation.",
        path: ["expiresAt"],
      });
    }
    if (preview.confirmation.expectedTitle !== preview.title) {
      context.addIssue({
        code: "custom",
        message: "Library removal confirmation must use the exact displayed title.",
        path: ["confirmation", "expectedTitle"],
      });
    }

    const expectedModes: readonly LibraryRemovalMode[] =
      preview.source.kind === "managed" ? managedRemovalModes : ["delete_unmanaged_files"];
    if (
      preview.options.length !== expectedModes.length ||
      preview.options.some((option, index) => option.mode !== expectedModes[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Library removal modes must match the resolved source of truth.",
        path: ["options"],
      });
    }

    for (const [index, option] of preview.options.entries()) {
      const expected = expectedRemovalEffects[option.mode];
      for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
        if (option.effects[key] !== expected[key]) {
          context.addIssue({
            code: "custom",
            message: "Library removal effects must match the selected mode.",
            path: ["options", index, "effects", key],
          });
        }
      }
    }
  });
export type LibraryRemovalPreview = z.infer<typeof libraryRemovalPreviewSchema>;

export const libraryScanRequestSchema = z.strictObject({});
export type LibraryScanRequest = z.infer<typeof libraryScanRequestSchema>;

export const libraryItemRefreshRequestSchema = z.strictObject({
  imageMode: z.enum(["missing", "replace"]).default("missing"),
  metadataMode: z.enum(["missing", "replace"]).default("missing"),
});
export type LibraryItemRefreshRequest = z.infer<typeof libraryItemRefreshRequestSchema>;

export const libraryMetadataUpdateRequestSchema = z
  .strictObject({
    overview: z.union([safeTextSchema.max(2_000), z.null()]).optional(),
    title: safeTextSchema.max(300).optional(),
    year: yearSchema.optional(),
  })
  .refine(
    (request) =>
      request.overview !== undefined || request.title !== undefined || request.year !== undefined,
    { message: "At least one editable metadata field is required." },
  );
export type LibraryMetadataUpdateRequest = z.infer<typeof libraryMetadataUpdateRequestSchema>;

export const libraryMutationResponseSchema = z.strictObject({
  acceptedAt: timestampSchema,
  operationId: libraryOperationIdSchema,
  referenceId: mediaReferenceIdSchema.nullable(),
  state: z.literal("accepted"),
});
export type LibraryMutationResponse = z.infer<typeof libraryMutationResponseSchema>;

export const libraryArtworkKindSchema = z.enum(["backdrop", "poster"]);
export type LibraryArtworkKind = z.infer<typeof libraryArtworkKindSchema>;

export const libraryArtworkSearchRequestSchema = z.strictObject({
  includeAllLanguages: z.boolean().default(false),
  kind: libraryArtworkKindSchema,
});
export type LibraryArtworkSearchRequest = z.infer<typeof libraryArtworkSearchRequestSchema>;

export const libraryArtworkCandidateSchema = z
  .strictObject({
    communityRating: z.number().finite().min(0).max(10).nullable(),
    height: z.int().positive().max(32_768).nullable(),
    id: libraryArtworkResultIdSchema,
    language: safeTextSchema.max(80).nullable(),
    previewPath: z.string().max(512),
    providerName: safeTextSchema.max(120),
    voteCount: z.int().nonnegative().max(2_147_483_647).nullable(),
    width: z.int().positive().max(32_768).nullable(),
  })
  .superRefine((candidate, context) => {
    if (!candidate.previewPath.endsWith(`/results/${candidate.id}/preview`)) {
      context.addIssue({
        code: "custom",
        message: "Artwork previews must use their opaque result identifier.",
        path: ["previewPath"],
      });
    }
  });
export type LibraryArtworkCandidate = z.infer<typeof libraryArtworkCandidateSchema>;

export const libraryArtworkSearchResponseSchema = z
  .strictObject({
    expiresAt: timestampSchema,
    generatedAt: timestampSchema,
    kind: libraryArtworkKindSchema,
    referenceId: mediaReferenceIdSchema,
    results: z.array(libraryArtworkCandidateSchema).max(LIBRARY_ARTWORK_MAX_RESULTS),
    searchId: libraryArtworkSearchIdSchema,
  })
  .superRefine((response, context) => {
    if (Date.parse(response.expiresAt) <= Date.parse(response.generatedAt)) {
      context.addIssue({
        code: "custom",
        message: "Artwork searches must expire after they are generated.",
        path: ["expiresAt"],
      });
    }
    const resultIds = new Set<string>();
    for (const [index, result] of response.results.entries()) {
      const expectedPath = `/v1/library/artwork-searches/${response.searchId}/results/${result.id}/preview`;
      if (result.previewPath !== expectedPath) {
        context.addIssue({
          code: "custom",
          message: "Artwork preview paths must belong to their search.",
          path: ["results", index, "previewPath"],
        });
      }
      if (resultIds.has(result.id)) {
        context.addIssue({
          code: "custom",
          message: "Artwork result identifiers must be unique within a search.",
          path: ["results", index, "id"],
        });
      }
      resultIds.add(result.id);
    }
  });
export type LibraryArtworkSearchResponse = z.infer<typeof libraryArtworkSearchResponseSchema>;

export const libraryArtworkApplyRequestSchema = z.strictObject({});
export type LibraryArtworkApplyRequest = z.infer<typeof libraryArtworkApplyRequestSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const libraryAttentionResponseJsonSchema = withoutSchemaDialect(
  libraryAttentionResponseSchema,
);
export const libraryBrowseQueryJsonSchema = withoutSchemaDialect(libraryBrowseQuerySchema);
export const libraryBrowseResponseJsonSchema = withoutSchemaDialect(libraryBrowseResponseSchema);
export const libraryPlaybackStateMutationRequestJsonSchema = withoutSchemaDialect(
  libraryPlaybackStateMutationRequestSchema,
);
export const libraryPlaybackStateMutationResponseJsonSchema = withoutSchemaDialect(
  libraryPlaybackStateMutationResponseSchema,
);
export const viewingHistoryQueryJsonSchema = withoutSchemaDialect(viewingHistoryQuerySchema);
export const viewingHistoryResponseJsonSchema = withoutSchemaDialect(viewingHistoryResponseSchema);
export const libraryTitleDetailResponseJsonSchema = withoutSchemaDialect(
  libraryTitleDetailResponseSchema,
);
export const libraryExtrasQueryJsonSchema = withoutSchemaDialect(libraryExtrasQuerySchema);
export const libraryExtrasResponseJsonSchema = withoutSchemaDialect(libraryExtrasResponseSchema);
export const librarySeasonEpisodesQueryJsonSchema = withoutSchemaDialect(
  librarySeasonEpisodesQuerySchema,
);
export const librarySeasonEpisodesResponseJsonSchema = withoutSchemaDialect(
  librarySeasonEpisodesResponseSchema,
);
export const libraryDownloadPrepareRequestJsonSchema = withoutSchemaDialect(
  libraryDownloadPrepareRequestSchema,
);
export const libraryDownloadPrepareResponseJsonSchema = withoutSchemaDialect(
  libraryDownloadPrepareResponseSchema,
);
export const libraryScanRequestJsonSchema = withoutSchemaDialect(libraryScanRequestSchema);
export const libraryItemRefreshRequestJsonSchema = withoutSchemaDialect(
  libraryItemRefreshRequestSchema,
);
export const libraryMetadataUpdateRequestJsonSchema = withoutSchemaDialect(
  libraryMetadataUpdateRequestSchema,
);
export const libraryMutationResponseJsonSchema = withoutSchemaDialect(
  libraryMutationResponseSchema,
);
export const libraryRemovalPreviewJsonSchema = withoutSchemaDialect(libraryRemovalPreviewSchema);
export const libraryArtworkSearchRequestJsonSchema = withoutSchemaDialect(
  libraryArtworkSearchRequestSchema,
);
export const libraryArtworkSearchResponseJsonSchema = withoutSchemaDialect(
  libraryArtworkSearchResponseSchema,
);
export const libraryArtworkApplyRequestJsonSchema = withoutSchemaDialect(
  libraryArtworkApplyRequestSchema,
);
