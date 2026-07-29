import { z } from "zod";

export const playbackIssueIdSchema = z.string().regex(/^issue_[A-Za-z0-9_-]{22}$/u);
export const playbackIssueCategorySchema = z.enum([
  "audio",
  "buffering",
  "subtitles",
  "sync",
  "video_quality",
  "other",
]);
export type PlaybackIssueCategory = z.infer<typeof playbackIssueCategorySchema>;

const issueDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value))
  .nullable();

export const playbackIssueCreateRequestSchema = z.strictObject({
  category: playbackIssueCategorySchema,
  description: issueDescriptionSchema,
  positionSeconds: z.int().nonnegative().max(10_000_000),
});
export type PlaybackIssueCreateRequest = z.infer<typeof playbackIssueCreateRequestSchema>;

export const playbackIssueSchema = z.strictObject({
  category: playbackIssueCategorySchema,
  createdAt: z.iso.datetime({ offset: true }),
  id: playbackIssueIdSchema,
  positionSeconds: z.int().nonnegative().max(10_000_000),
  status: z.enum(["open", "resolved"]),
});
export type PlaybackIssue = z.infer<typeof playbackIssueSchema>;

export const mediaIssueFilterSchema = z.enum(["open", "resolved", "all"]);
export type MediaIssueFilter = z.infer<typeof mediaIssueFilterSchema>;

export const mediaIssueSourceSchema = z.enum(["omnifin", "seerr"]);
export type MediaIssueSource = z.infer<typeof mediaIssueSourceSchema>;

export const mediaIssueSourceFilterSchema = z.enum(["all", "omnifin", "seerr"]);
export type MediaIssueSourceFilter = z.infer<typeof mediaIssueSourceFilterSchema>;

export const mediaIssueSourceStateSchema = z.enum(["available", "unavailable", "unconfigured"]);
export type MediaIssueSourceState = z.infer<typeof mediaIssueSourceStateSchema>;

export const mediaIssueWorkbenchQuerySchema = z.strictObject({
  limit: z.int().min(1).max(50).default(20),
  source: mediaIssueSourceFilterSchema.default("all"),
  status: mediaIssueFilterSchema.default("open"),
});
export type MediaIssueWorkbenchQuery = z.infer<typeof mediaIssueWorkbenchQuerySchema>;

const issuePublicTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));

export const mediaIssueWorkbenchItemSchema = z
  .strictObject({
    category: playbackIssueCategorySchema,
    createdAt: z.iso.datetime({ offset: true }),
    episodeNumber: z.int().nonnegative().max(100_000).nullable(),
    id: playbackIssueIdSchema,
    kind: z.enum(["episode", "movie", "series", "unknown"]),
    positionSeconds: z.int().nonnegative().max(10_000_000).nullable(),
    reportedBy: z.string().trim().min(1).max(160),
    seasonNumber: z.int().nonnegative().max(100_000).nullable(),
    source: mediaIssueSourceSchema,
    status: z.enum(["open", "resolved"]),
    summary: issuePublicTextSchema.nullable(),
    title: z.string().trim().min(1).max(300),
    updatedAt: z.iso.datetime({ offset: true }),
    year: z.int().min(1870).max(2200).nullable(),
  })
  .superRefine((issue, context) => {
    const hasEpisodeCoordinates = issue.seasonNumber !== null && issue.episodeNumber !== null;
    if ((issue.kind === "episode") !== hasEpisodeCoordinates) {
      context.addIssue({
        code: "custom",
        message: "Only episode issues can include complete episode coordinates.",
        path: ["episodeNumber"],
      });
    }
  });
export type MediaIssueWorkbenchItem = z.infer<typeof mediaIssueWorkbenchItemSchema>;

export const mediaIssueWorkbenchPageSchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: true }),
  items: z.array(mediaIssueWorkbenchItemSchema).max(50),
  limit: z.int().min(1).max(50),
  source: mediaIssueSourceFilterSchema,
  sourceStates: z.strictObject({
    omnifin: mediaIssueSourceStateSchema,
    seerr: mediaIssueSourceStateSchema,
  }),
  status: mediaIssueFilterSchema,
  truncated: z.boolean(),
});
export type MediaIssueWorkbenchPage = z.infer<typeof mediaIssueWorkbenchPageSchema>;

export const mediaIssueStatusUpdateSchema = z.strictObject({
  status: z.enum(["open", "resolved"]),
});
export type MediaIssueStatusUpdate = z.infer<typeof mediaIssueStatusUpdateSchema>;

export const playbackIssueCreateRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "description", "positionSeconds"],
  properties: {
    category: {
      enum: ["audio", "buffering", "subtitles", "sync", "video_quality", "other"],
    },
    description: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 1_000 }, { type: "null" }],
    },
    positionSeconds: { type: "integer", minimum: 0, maximum: 10_000_000 },
  },
} as const;

export const playbackIssueJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "createdAt", "id", "positionSeconds", "status"],
  properties: {
    category: {
      enum: ["audio", "buffering", "subtitles", "sync", "video_quality", "other"],
    },
    createdAt: { type: "string" },
    id: { type: "string", pattern: "^issue_[A-Za-z0-9_-]{22}$" },
    positionSeconds: { type: "integer", minimum: 0, maximum: 10_000_000 },
    status: { enum: ["open", "resolved"] },
  },
} as const;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const mediaIssueWorkbenchItemJsonSchema = withoutSchemaDialect(
  mediaIssueWorkbenchItemSchema,
);
export const mediaIssueWorkbenchPageJsonSchema = withoutSchemaDialect(
  mediaIssueWorkbenchPageSchema,
);
export const mediaIssueStatusUpdateJsonSchema = withoutSchemaDialect(mediaIssueStatusUpdateSchema);
