import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";
import { mediaReferenceIdSchema, mediaSummarySchema } from "./dashboard.js";
import { idempotencyKeySchema } from "./requests.js";

export const LIBRARY_ATTENTION_MAX_ITEMS = 100;
export const LIBRARY_ARTWORK_MAX_RESULTS = 40;
export const LIBRARY_BROWSE_MAX_ITEMS = 50;

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

export const libraryBrowseKindSchema = z.enum(["all", "episodes", "movies"]);
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

export const libraryBrowseItemSchema = z
  .strictObject({
    durationSeconds: z.int().positive().max(10_000_000),
    media: mediaSummarySchema,
    played: z.boolean(),
    positionSeconds: z.int().nonnegative().max(10_000_000),
  })
  .superRefine((item, context) => {
    if (!mediaReferenceIdSchema.safeParse(item.media.id).success) {
      context.addIssue({
        code: "custom",
        message: "Library catalogue items must use opaque media references.",
        path: ["media", "id"],
      });
    }
    if (item.media.kind !== "movie" && item.media.kind !== "episode") {
      context.addIssue({
        code: "custom",
        message: "Library catalogue items must be directly playable videos.",
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
    if (item.positionSeconds > item.durationSeconds) {
      context.addIssue({
        code: "custom",
        message: "Library playback position cannot exceed duration.",
        path: ["positionSeconds"],
      });
    }
    for (const [artworkType, path] of Object.entries({
      backdropPath: item.media.artwork.backdropPath,
      posterPath: item.media.artwork.posterPath,
    })) {
      if (path !== null && !path.startsWith(`/v1/media/${item.media.id}/images/`)) {
        context.addIssue({
          code: "custom",
          message: "Library artwork must belong to the same opaque media reference.",
          path: ["media", "artwork", artworkType],
        });
      }
    }
  });
export type LibraryBrowseItem = z.infer<typeof libraryBrowseItemSchema>;

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
