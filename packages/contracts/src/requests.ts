import { z } from "zod";

const tmdbIdentifierSchema = z.int().positive().max(2_147_483_647);
const seasonNumberSchema = z.int().nonnegative().max(10_000);
const requestIdentifierSchema = z
  .string()
  .min(9)
  .max(64)
  .regex(/^request:[1-9][0-9]*$/u);

const mediaRequestBase = {
  is4k: z.boolean().default(false),
  tmdbId: tmdbIdentifierSchema,
} as const;

export const movieRequestInputSchema = z.strictObject({
  ...mediaRequestBase,
  kind: z.literal("movie"),
});

export const seriesRequestInputSchema = z.strictObject({
  ...mediaRequestBase,
  kind: z.literal("series"),
  seasons: z
    .union([
      z.literal("all"),
      z
        .array(seasonNumberSchema)
        .min(1)
        .max(100)
        .refine((seasons) => new Set(seasons).size === seasons.length, {
          message: "Requested seasons cannot contain duplicates.",
        }),
    ])
    .default("all"),
});

export const mediaRequestInputSchema = z.discriminatedUnion("kind", [
  movieRequestInputSchema,
  seriesRequestInputSchema,
]);
export type MediaRequestInput = z.infer<typeof mediaRequestInputSchema>;

export const mediaRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "declined",
  "failed",
  "completed",
]);
export type MediaRequestStatus = z.infer<typeof mediaRequestStatusSchema>;

export const mediaRequestResponseSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: requestIdentifierSchema,
  is4k: z.boolean(),
  kind: z.enum(["movie", "series"]),
  seasons: z.array(seasonNumberSchema).max(100).nullable(),
  source: z.literal("seerr"),
  status: mediaRequestStatusSchema,
  tmdbId: tmdbIdentifierSchema,
});
export type MediaRequestResponse = z.infer<typeof mediaRequestResponseSchema>;

export const requestReviewFilterSchema = z.enum(["pending", "approved", "declined", "all"]);
export type RequestReviewFilter = z.infer<typeof requestReviewFilterSchema>;

export const requestReviewCursorSchema = z
  .string()
  .min(10)
  .max(32)
  .regex(/^requests:(?:0|[1-9][0-9]{0,8})$/u);

export const requestReviewQuerySchema = z.strictObject({
  cursor: requestReviewCursorSchema.nullable().default(null),
  limit: z.int().min(1).max(50).default(20),
  status: requestReviewFilterSchema.default("pending"),
});
export type RequestReviewQuery = z.infer<typeof requestReviewQuerySchema>;

export const requestReviewDecisionInputSchema = z.strictObject({
  decision: z.enum(["approve", "decline"]),
});
export type RequestReviewDecisionInput = z.infer<typeof requestReviewDecisionInputSchema>;

export const requestReviewItemSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: requestIdentifierSchema,
  is4k: z.boolean(),
  kind: z.enum(["movie", "series"]),
  requestedBy: z.string().trim().min(1).max(160),
  seasons: z.array(seasonNumberSchema).max(100).nullable(),
  source: z.literal("seerr"),
  status: mediaRequestStatusSchema,
  title: z.string().trim().min(1).max(300),
  tmdbId: tmdbIdentifierSchema,
  updatedAt: z.iso.datetime({ offset: true }),
  year: z.int().min(1870).max(2200).nullable(),
});
export type RequestReviewItem = z.infer<typeof requestReviewItemSchema>;

export const requestReviewPageSchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: true }),
  items: z.array(requestReviewItemSchema).max(50),
  nextCursor: requestReviewCursorSchema.nullable(),
  status: requestReviewFilterSchema,
});
export type RequestReviewPage = z.infer<typeof requestReviewPageSchema>;

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

const mediaRequestWireSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    is4k: z.boolean().optional(),
    kind: z.literal("movie"),
    tmdbId: tmdbIdentifierSchema,
  }),
  z.strictObject({
    is4k: z.boolean().optional(),
    kind: z.literal("series"),
    seasons: z
      .union([
        z.literal("all"),
        z
          .array(seasonNumberSchema)
          .min(1)
          .max(100)
          .refine((seasons) => new Set(seasons).size === seasons.length),
      ])
      .optional(),
    tmdbId: tmdbIdentifierSchema,
  }),
]);

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const mediaRequestInputJsonSchema = withoutSchemaDialect(mediaRequestWireSchema);
export const mediaRequestResponseJsonSchema = withoutSchemaDialect(mediaRequestResponseSchema);
export const requestReviewDecisionInputJsonSchema = withoutSchemaDialect(
  requestReviewDecisionInputSchema,
);
export const requestReviewItemJsonSchema = withoutSchemaDialect(requestReviewItemSchema);
export const requestReviewPageJsonSchema = withoutSchemaDialect(requestReviewPageSchema);
