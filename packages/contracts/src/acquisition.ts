import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";
import { idempotencyKeySchema } from "./requests.js";

export const ACQUISITION_MAX_EVENTS = 250;

const upstreamIdentifierSchema = z.int().positive().max(2_147_483_647);
const seasonNumberSchema = z.int().nonnegative().max(10_000);
const safeLabelSchema = z.string().trim().min(1).max(160);
const releaseTitleSchema = z.string().trim().min(1).max(500);

export const acquisitionServiceSchema = z.enum(["radarr", "sonarr"]);
export type AcquisitionService = z.infer<typeof acquisitionServiceSchema>;

export const acquisitionTargetInputSchema = z
  .strictObject({
    mediaId: z.coerce.number().int().positive().max(2_147_483_647),
    seasonNumber: z.coerce.number().int().nonnegative().max(10_000).optional(),
    service: acquisitionServiceSchema,
  })
  .superRefine((target, context) => {
    if (target.service === "radarr" && target.seasonNumber !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Movie acquisition targets cannot include a season.",
        path: ["seasonNumber"],
      });
    }
  });
export type AcquisitionTargetInput = z.infer<typeof acquisitionTargetInputSchema>;

export const acquisitionTargetSchema = z
  .strictObject({
    kind: z.enum(["movie", "series"]),
    mediaId: upstreamIdentifierSchema,
    seasonNumber: seasonNumberSchema.nullable(),
    service: acquisitionServiceSchema,
  })
  .superRefine((target, context) => {
    const validKind =
      (target.service === "radarr" && target.kind === "movie") ||
      (target.service === "sonarr" && target.kind === "series");
    if (!validKind) {
      context.addIssue({
        code: "custom",
        message: "The media kind must match the acquisition service.",
        path: ["kind"],
      });
    }
    if (target.service === "radarr" && target.seasonNumber !== null) {
      context.addIssue({
        code: "custom",
        message: "Movie acquisition targets cannot include a season.",
        path: ["seasonNumber"],
      });
    }
  });
export type AcquisitionTarget = z.infer<typeof acquisitionTargetSchema>;

export const acquisitionEventKindSchema = z.enum([
  "search_queued",
  "search_started",
  "search_completed",
  "grabbed",
  "queued",
  "downloading",
  "stalled",
  "download_failed",
  "imported",
  "upgraded",
  "ignored",
]);
export type AcquisitionEventKind = z.infer<typeof acquisitionEventKindSchema>;

export const acquisitionEventStateSchema = z.enum([
  "info",
  "active",
  "success",
  "warning",
  "failure",
]);
export type AcquisitionEventState = z.infer<typeof acquisitionEventStateSchema>;

export const acquisitionReleaseSchema = z.strictObject({
  downloadClient: safeLabelSchema.nullable(),
  indexer: safeLabelSchema.nullable(),
  protocol: z.enum(["torrent", "usenet", "unknown"]),
  quality: safeLabelSchema.nullable(),
  sizeBytes: z.int().nonnegative().max(9_007_199_254_740_991).nullable(),
  title: releaseTitleSchema.nullable(),
});
export type AcquisitionRelease = z.infer<typeof acquisitionReleaseSchema>;

export const acquisitionEventSchema = z.strictObject({
  episodeNumbers: z.array(z.int().positive().max(100_000)).max(100),
  id: z
    .string()
    .min(8)
    .max(180)
    .regex(/^(?:radarr|sonarr):(?:command|history|queue):[A-Za-z0-9._:-]+$/u),
  kind: acquisitionEventKindSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  release: acquisitionReleaseSchema,
  seasonNumber: seasonNumberSchema.nullable(),
  state: acquisitionEventStateSchema,
  summary: z.string().trim().min(1).max(240),
});
export type AcquisitionEvent = z.infer<typeof acquisitionEventSchema>;

export const acquisitionProvenanceResponseSchema = z
  .strictObject({
    events: z.array(acquisitionEventSchema).max(ACQUISITION_MAX_EVENTS),
    failures: z.array(partialFailureSchema).max(3),
    generatedAt: z.iso.datetime({ offset: true }),
    state: z.enum(["complete", "degraded"]),
    target: acquisitionTargetSchema,
  })
  .superRefine((response, context) => {
    const ids = new Set<string>();
    let previousTimestamp = Number.POSITIVE_INFINITY;
    for (const [index, event] of response.events.entries()) {
      if (ids.has(event.id)) {
        context.addIssue({
          code: "custom",
          message: "Acquisition event identifiers must be unique.",
          path: ["events", index, "id"],
        });
      }
      ids.add(event.id);
      const timestamp = Date.parse(event.occurredAt);
      if (timestamp > previousTimestamp) {
        context.addIssue({
          code: "custom",
          message: "Acquisition events must be newest first.",
          path: ["events", index, "occurredAt"],
        });
      }
      previousTimestamp = timestamp;
    }
    if ((response.state === "complete") !== (response.failures.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Degraded provenance must include at least one partial failure.",
        path: ["state"],
      });
    }
    for (const [index, failure] of response.failures.entries()) {
      if (failure.service !== response.target.service) {
        context.addIssue({
          code: "custom",
          message: "Partial failures must match the acquisition service.",
          path: ["failures", index, "service"],
        });
      }
    }
  });
export type AcquisitionProvenanceResponse = z.infer<typeof acquisitionProvenanceResponseSchema>;

export const acquisitionSearchInputSchema = acquisitionTargetInputSchema;
export type AcquisitionSearchInput = z.infer<typeof acquisitionSearchInputSchema>;

export const acquisitionSearchIdempotencyKeySchema = idempotencyKeySchema;
export type AcquisitionSearchIdempotencyKey = z.infer<typeof acquisitionSearchIdempotencyKeySchema>;

export const acquisitionSearchResponseSchema = z.strictObject({
  acceptedAt: z.iso.datetime({ offset: true }),
  operationId: z
    .string()
    .min(17)
    .max(64)
    .regex(/^(?:radarr|sonarr):command:[1-9][0-9]*$/u),
  state: z.literal("queued"),
  target: acquisitionTargetSchema,
});
export type AcquisitionSearchResponse = z.infer<typeof acquisitionSearchResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const acquisitionTargetInputJsonSchema = withoutSchemaDialect(acquisitionTargetInputSchema);
export const acquisitionProvenanceResponseJsonSchema = withoutSchemaDialect(
  acquisitionProvenanceResponseSchema,
);
export const acquisitionSearchInputJsonSchema = withoutSchemaDialect(acquisitionSearchInputSchema);
export const acquisitionSearchResponseJsonSchema = withoutSchemaDialect(
  acquisitionSearchResponseSchema,
);
