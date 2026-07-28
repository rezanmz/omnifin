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
