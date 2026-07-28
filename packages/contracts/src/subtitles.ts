import { z } from "zod";

import { idempotencyKeySchema } from "./requests.js";

export const SUBTITLE_SEARCH_MAX_RESULTS = 100;

const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const titleSchema = safeTextSchema.max(300);
const yearSchema = z.int().min(1870).max(2200).nullable();
const episodeNumberSchema = z.int().nonnegative().max(100_000);

export const subtitleSearchIdSchema = z.string().regex(/^subtitle_search_[A-Za-z0-9_-]{22}$/u);
export const subtitleResultIdSchema = z.string().regex(/^subtitle_result_[A-Za-z0-9_-]{22}$/u);

const subtitleMovieTargetSchema = z.strictObject({
  kind: z.literal("movie"),
  title: titleSchema,
  year: yearSchema,
});

const subtitleEpisodeTargetSchema = z.strictObject({
  episodeNumber: episodeNumberSchema,
  kind: z.literal("episode"),
  seasonNumber: episodeNumberSchema,
  title: titleSchema,
  year: yearSchema,
});

export const subtitleMediaTargetSchema = z.discriminatedUnion("kind", [
  subtitleMovieTargetSchema,
  subtitleEpisodeTargetSchema,
]);
export type SubtitleMediaTarget = z.infer<typeof subtitleMediaTargetSchema>;

export const subtitleCandidateSchema = z.strictObject({
  dontMatches: z.array(safeTextSchema).max(32),
  forced: z.boolean(),
  hearingImpaired: z.boolean(),
  id: subtitleResultIdSchema,
  language: safeTextSchema.max(80),
  matches: z.array(safeTextSchema).max(32),
  originalFormat: z.boolean(),
  provider: safeTextSchema.max(80),
  releaseNames: z.array(safeTextSchema.max(500)).max(20),
  score: z.number().finite().min(0).max(100),
  uploader: safeTextSchema.max(160).nullable(),
});
export type SubtitleCandidate = z.infer<typeof subtitleCandidateSchema>;

export const subtitleSearchRequestSchema = z.strictObject({});
export type SubtitleSearchRequest = z.infer<typeof subtitleSearchRequestSchema>;

export const subtitleSearchResponseSchema = z
  .strictObject({
    expiresAt: z.iso.datetime({ offset: true }),
    generatedAt: z.iso.datetime({ offset: true }),
    media: subtitleMediaTargetSchema,
    results: z.array(subtitleCandidateSchema).max(SUBTITLE_SEARCH_MAX_RESULTS),
    searchId: subtitleSearchIdSchema,
  })
  .superRefine((response, context) => {
    if (Date.parse(response.expiresAt) <= Date.parse(response.generatedAt)) {
      context.addIssue({
        code: "custom",
        message: "A subtitle search must expire after it is generated.",
        path: ["expiresAt"],
      });
    }
    const ids = new Set<string>();
    for (const [index, candidate] of response.results.entries()) {
      if (ids.has(candidate.id)) {
        context.addIssue({
          code: "custom",
          message: "Subtitle result identifiers must be unique within a search.",
          path: ["results", index, "id"],
        });
      }
      ids.add(candidate.id);
    }
  });
export type SubtitleSearchResponse = z.infer<typeof subtitleSearchResponseSchema>;

export const subtitleDownloadRequestSchema = z.strictObject({});
export type SubtitleDownloadRequest = z.infer<typeof subtitleDownloadRequestSchema>;

export const subtitleDownloadIdempotencyKeySchema = idempotencyKeySchema;
export type SubtitleDownloadIdempotencyKey = z.infer<typeof subtitleDownloadIdempotencyKeySchema>;

export const subtitleDownloadResponseSchema = z.strictObject({
  acceptedAt: z.iso.datetime({ offset: true }),
  resultId: subtitleResultIdSchema,
  searchId: subtitleSearchIdSchema,
  status: z.literal("accepted"),
});
export type SubtitleDownloadResponse = z.infer<typeof subtitleDownloadResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const subtitleSearchRequestJsonSchema = withoutSchemaDialect(subtitleSearchRequestSchema);
export const subtitleSearchResponseJsonSchema = withoutSchemaDialect(subtitleSearchResponseSchema);
export const subtitleDownloadRequestJsonSchema = withoutSchemaDialect(
  subtitleDownloadRequestSchema,
);
export const subtitleDownloadResponseJsonSchema = withoutSchemaDialect(
  subtitleDownloadResponseSchema,
);
