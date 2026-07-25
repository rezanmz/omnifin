import { z } from "zod";

import { connectorServiceSchema, partialFailureSchema } from "./connectors.js";

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
