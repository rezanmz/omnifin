import { z } from "zod";

import {
  connectorIdentifierSchema,
  connectorServiceSchema,
  partialFailureSchema,
  type PartialFailure,
} from "./connectors.js";

export const CONTINUE_WATCHING_MAX_ITEMS = 50;

const internalIdSchema = z.string().trim().min(1).max(256);
const titleSchema = z.string().trim().min(1).max(300);
const proxiedAssetPathSchema = z
  .string()
  .regex(/^\/v1\/media\/[A-Za-z0-9][A-Za-z0-9/_-]*$/)
  .max(2_048)
  .nullable();

export const mediaKindSchema = z.enum(["movie", "series", "season", "episode", "music", "other"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const mediaSummarySchema = z.object({
  id: internalIdSchema,
  kind: mediaKindSchema,
  title: titleSchema,
  subtitle: z.string().trim().max(300).nullable(),
  overview: z.string().trim().max(2_000).nullable(),
  year: z.int().min(1870).max(2200).nullable(),
  contentRating: z.string().trim().max(32).nullable(),
  runtimeMinutes: z.int().positive().max(100_000).nullable(),
  artwork: z.object({
    posterPath: proxiedAssetPathSchema,
    backdropPath: proxiedAssetPathSchema,
    blurHash: z.string().max(256).nullable(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
  }),
  availability: z.enum(["available", "partial", "requested", "unavailable", "unknown"]),
});
export type MediaSummary = z.infer<typeof mediaSummarySchema>;

export const continueWatchingItemSchema = z
  .object({
    media: mediaSummarySchema,
    progressPercent: z.number().finite().min(0).max(100),
    positionSeconds: z.int().nonnegative(),
    durationSeconds: z.int().positive(),
    lastPlayedAt: z.iso.datetime({ offset: true }),
  })
  .refine((item) => item.positionSeconds <= item.durationSeconds, {
    path: ["positionSeconds"],
    message: "Playback position cannot exceed duration.",
  });
export type ContinueWatchingItem = z.infer<typeof continueWatchingItemSchema>;

export const mediaReferenceIdSchema = z.string().regex(/^media_[A-Za-z0-9_-]{22}$/u);

export const continueWatchingSourceSchema = z
  .strictObject({
    connectorId: connectorIdentifierSchema,
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    failure: partialFailureSchema.nullable(),
    status: z.enum(["healthy", "unavailable"]),
  })
  .superRefine((source, context) => {
    if ((source.status === "healthy") !== (source.failure === null)) {
      context.addIssue({
        code: "custom",
        message: "An unavailable Continue Watching source must include one safe failure.",
        path: ["failure"],
      });
    }
    if (source.failure && source.failure.service !== "jellyfin") {
      context.addIssue({
        code: "custom",
        message: "Continue Watching failures must identify Jellyfin.",
        path: ["failure", "service"],
      });
    }
  });
export type ContinueWatchingSource = z.infer<typeof continueWatchingSourceSchema>;

function failuresMatch(left: PartialFailure, right: PartialFailure) {
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.occurredAt === right.occurredAt &&
    left.operation === right.operation &&
    left.retryable === right.retryable &&
    left.retryAfterSeconds === right.retryAfterSeconds &&
    left.service === right.service
  );
}

export const continueWatchingResponseSchema = z
  .strictObject({
    failures: z.array(partialFailureSchema).max(1),
    generatedAt: z.iso.datetime({ offset: true }),
    items: z.array(continueWatchingItemSchema).max(CONTINUE_WATCHING_MAX_ITEMS),
    source: continueWatchingSourceSchema,
    state: z.enum(["complete", "empty", "unavailable"]),
    truncated: z.boolean(),
  })
  .superRefine((response, context) => {
    const itemIds = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (!mediaReferenceIdSchema.safeParse(item.media.id).success) {
        context.addIssue({
          code: "custom",
          message: "Continue Watching items must use opaque media references.",
          path: ["items", index, "media", "id"],
        });
      }
      if (itemIds.has(item.media.id)) {
        context.addIssue({
          code: "custom",
          message: "Continue Watching media references must be unique.",
          path: ["items", index, "media", "id"],
        });
      }
      itemIds.add(item.media.id);
      if (item.media.availability !== "available") {
        context.addIssue({
          code: "custom",
          message: "Continue Watching items must be available to the linked Jellyfin user.",
          path: ["items", index, "media", "availability"],
        });
      }
      for (const [artworkType, path] of Object.entries({
        backdropPath: item.media.artwork.backdropPath,
        posterPath: item.media.artwork.posterPath,
      })) {
        if (path !== null && !path.startsWith(`/v1/media/${item.media.id}/images/`)) {
          context.addIssue({
            code: "custom",
            message: "Continue Watching artwork must belong to the same opaque media reference.",
            path: ["items", index, "media", "artwork", artworkType],
          });
        }
      }
    }

    const failure = response.source.failure;
    const isHealthy = response.source.status === "healthy";
    if (isHealthy && response.failures.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A healthy Continue Watching response cannot include failures.",
        path: ["failures"],
      });
    }
    if (
      !isHealthy &&
      (failure === null ||
        response.failures.length !== 1 ||
        !failuresMatch(response.failures[0]!, failure))
    ) {
      context.addIssue({
        code: "custom",
        message: "An unavailable Continue Watching response must surface its source failure once.",
        path: ["failures"],
      });
    }

    const expectedState = !isHealthy
      ? "unavailable"
      : response.items.length === 0
        ? "empty"
        : "complete";
    if (response.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "Continue Watching state must match source health and returned items.",
        path: ["state"],
      });
    }
    if (!isHealthy && (response.items.length > 0 || response.truncated)) {
      context.addIssue({
        code: "custom",
        message: "Unavailable Continue Watching sources cannot return media or truncation.",
        path: ["items"],
      });
    }
    if (response.items.length === 0 && response.truncated) {
      context.addIssue({
        code: "custom",
        message: "An empty Continue Watching response cannot be truncated.",
        path: ["truncated"],
      });
    }
  });
export type ContinueWatchingResponse = z.infer<typeof continueWatchingResponseSchema>;

export const continueWatchingResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["failures", "generatedAt", "items", "source", "state", "truncated"],
  properties: {
    failures: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["service", "operation", "code", "message", "retryable", "occurredAt"],
        properties: {
          service: { const: "jellyfin" },
          operation: { type: "string" },
          code: {
            enum: [
              "configuration_invalid",
              "destination_blocked",
              "invalid_credentials",
              "rate_limited",
              "response_invalid",
              "timeout",
              "unreachable",
              "unsupported_version",
              "upstream_error",
            ],
          },
          message: { type: "string" },
          retryable: { type: "boolean" },
          occurredAt: { type: "string" },
          retryAfterSeconds: { type: "integer", minimum: 0, maximum: 86_400 },
        },
      },
    },
    generatedAt: { type: "string" },
    items: {
      type: "array",
      maxItems: CONTINUE_WATCHING_MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "media",
          "progressPercent",
          "positionSeconds",
          "durationSeconds",
          "lastPlayedAt",
        ],
        properties: {
          media: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "kind",
              "title",
              "subtitle",
              "overview",
              "year",
              "contentRating",
              "runtimeMinutes",
              "artwork",
              "availability",
            ],
            properties: {
              id: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" },
              kind: { enum: ["movie", "series", "season", "episode", "music", "other"] },
              title: { type: "string" },
              subtitle: { anyOf: [{ type: "string" }, { type: "null" }] },
              overview: { anyOf: [{ type: "string" }, { type: "null" }] },
              year: { anyOf: [{ type: "integer" }, { type: "null" }] },
              contentRating: { anyOf: [{ type: "string" }, { type: "null" }] },
              runtimeMinutes: { anyOf: [{ type: "integer" }, { type: "null" }] },
              artwork: {
                type: "object",
                additionalProperties: false,
                required: ["posterPath", "backdropPath", "blurHash", "accentColor"],
                properties: {
                  posterPath: { anyOf: [{ type: "string" }, { type: "null" }] },
                  backdropPath: { anyOf: [{ type: "string" }, { type: "null" }] },
                  blurHash: { anyOf: [{ type: "string" }, { type: "null" }] },
                  accentColor: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
              },
              availability: { const: "available" },
            },
          },
          progressPercent: { type: "number", minimum: 0, maximum: 100 },
          positionSeconds: { type: "integer", minimum: 0 },
          durationSeconds: { type: "integer", minimum: 1 },
          lastPlayedAt: { type: "string" },
        },
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["connectorId", "displayName", "failure", "status"],
      properties: {
        connectorId: { type: "string" },
        displayName: { type: "string" },
        failure: {
          anyOf: [{ type: "null" }, { $ref: "#/properties/failures/items" }],
        },
        status: { enum: ["healthy", "unavailable"] },
      },
    },
    state: { enum: ["complete", "empty", "unavailable"] },
    truncated: { type: "boolean" },
  },
} as const;

export const discoveryRailSchema = z.object({
  id: internalIdSchema,
  title: titleSchema,
  description: z.string().trim().max(300).nullable(),
  items: z.array(mediaSummarySchema).max(50),
});
export type DiscoveryRail = z.infer<typeof discoveryRailSchema>;

export const upcomingItemSchema = z.object({
  id: internalIdSchema,
  mediaId: internalIdSchema,
  kind: z.enum(["episode", "movie"]),
  title: titleSchema,
  episodeLabel: z.string().trim().max(80).nullable(),
  airsAt: z.iso.datetime({ offset: true }),
  acquisitionState: z.enum(["monitored", "searching", "queued", "available", "missing", "unknown"]),
});
export type UpcomingItem = z.infer<typeof upcomingItemSchema>;

export const operationSummarySchema = z.object({
  id: internalIdSchema,
  service: connectorServiceSchema,
  title: titleSchema,
  state: z.enum([
    "queued",
    "downloading",
    "processing",
    "importing",
    "paused",
    "failed",
    "completed",
  ]),
  progressPercent: z.number().finite().min(0).max(100).nullable(),
  bytesPerSecond: z.number().finite().nonnegative().nullable(),
  etaSeconds: z.int().nonnegative().nullable(),
  warning: z.string().trim().max(300).nullable(),
});
export type OperationSummary = z.infer<typeof operationSummarySchema>;

export const dashboardSnapshotSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  state: z.enum(["ready", "partial", "empty"]),
  hero: mediaSummarySchema.nullable(),
  continueWatching: z.array(continueWatchingItemSchema).max(50),
  discoveryRails: z.array(discoveryRailSchema).max(20),
  upcoming: z.array(upcomingItemSchema).max(100),
  operations: z.array(operationSummarySchema).max(200),
  failures: z.array(partialFailureSchema).max(50),
});
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;
