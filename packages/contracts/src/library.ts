import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";
import { mediaReferenceIdSchema, mediaSummarySchema } from "./dashboard.js";
import { idempotencyKeySchema } from "./requests.js";

export const LIBRARY_ATTENTION_MAX_ITEMS = 100;
export const LIBRARY_ARTWORK_MAX_RESULTS = 40;
export const LIBRARY_BROWSE_MAX_ITEMS = 50;
export const LIBRARY_EPISODE_MAX_CREDITS = 24;
export const LIBRARY_EPISODE_MAX_GENRES = 20;
export const LIBRARY_EPISODE_MAX_STUDIOS = 12;
export const LIBRARY_SEASON_EPISODES_MAX_ITEMS = 50;
export const LIBRARY_TITLE_MAX_SEASONS = 100;

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

export const libraryTitleDetailResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    media: mediaSummarySchema,
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
      detail.playback !== null &&
      detail.seasons.length === 0 &&
      !detail.seasonsTruncated;
    const seriesShape = detail.media.kind === "series" && detail.playback === null;
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
    validateLibraryMediaArtwork(detail.media, context);
  });
export type LibraryTitleDetailResponse = z.infer<typeof libraryTitleDetailResponseSchema>;

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
export const libraryArtworkSearchIdSchema = z
  .string()
  .regex(/^library_artwork_search_[A-Za-z0-9_-]{22}$/u);
export const libraryArtworkResultIdSchema = z
  .string()
  .regex(/^library_artwork_result_[A-Za-z0-9_-]{22}$/u);

export const libraryMutationIdempotencyKeySchema = idempotencyKeySchema;
export type LibraryMutationIdempotencyKey = z.infer<typeof libraryMutationIdempotencyKeySchema>;

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
export const libraryTitleDetailResponseJsonSchema = withoutSchemaDialect(
  libraryTitleDetailResponseSchema,
);
export const librarySeasonEpisodesQueryJsonSchema = withoutSchemaDialect(
  librarySeasonEpisodesQuerySchema,
);
export const librarySeasonEpisodesResponseJsonSchema = withoutSchemaDialect(
  librarySeasonEpisodesResponseSchema,
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
export const libraryArtworkSearchRequestJsonSchema = withoutSchemaDialect(
  libraryArtworkSearchRequestSchema,
);
export const libraryArtworkSearchResponseJsonSchema = withoutSchemaDialect(
  libraryArtworkSearchResponseSchema,
);
export const libraryArtworkApplyRequestJsonSchema = withoutSchemaDialect(
  libraryArtworkApplyRequestSchema,
);
