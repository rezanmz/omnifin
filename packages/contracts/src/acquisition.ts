import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";
import { idempotencyKeySchema } from "./requests.js";

export const ACQUISITION_MAX_EVENTS = 250;
export const MANUAL_RELEASE_MAX_RESULTS = 250;

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

export const acquisitionQueueRecoveryReferenceSchema = z
  .string()
  .min(96)
  .max(2_048)
  .regex(/^aqr_v2\.[A-Za-z0-9_.-]+$/u);

export const acquisitionQueueRecoveryOfferSchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }),
  reference: acquisitionQueueRecoveryReferenceSchema,
});
export type AcquisitionQueueRecoveryOffer = z.infer<typeof acquisitionQueueRecoveryOfferSchema>;

export const acquisitionEventSchema = z
  .strictObject({
    episodeNumbers: z.array(z.int().positive().max(100_000)).max(100),
    id: z
      .string()
      .min(8)
      .max(180)
      .regex(
        /^(?:(?:radarr|sonarr):(?:command|history|queue):[A-Za-z0-9._:-]+|acquisition_[A-Za-z0-9_-]{22})$/u,
      ),
    kind: acquisitionEventKindSchema,
    occurredAt: z.iso.datetime({ offset: true }),
    release: acquisitionReleaseSchema,
    recovery: acquisitionQueueRecoveryOfferSchema.optional(),
    seasonNumber: seasonNumberSchema.nullable(),
    state: acquisitionEventStateSchema,
    summary: z.string().trim().min(1).max(240),
  })
  .superRefine((event, context) => {
    if (
      event.recovery &&
      (event.kind !== "stalled" ||
        !["failure", "warning"].includes(event.state) ||
        !event.id.startsWith("acquisition_"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Queue recovery is available only for an opaque stalled event.",
        path: ["recovery"],
      });
    }
  });
export type AcquisitionEvent = z.infer<typeof acquisitionEventSchema>;

export const acquisitionQueueRecoveryInputSchema = z.strictObject({
  reference: acquisitionQueueRecoveryReferenceSchema,
});
export type AcquisitionQueueRecoveryInput = z.infer<typeof acquisitionQueueRecoveryInputSchema>;

export const acquisitionQueueRecoveryIdempotencyKeySchema = idempotencyKeySchema;
export type AcquisitionQueueRecoveryIdempotencyKey = z.infer<
  typeof acquisitionQueueRecoveryIdempotencyKeySchema
>;

export const acquisitionQueueRecoveryResponseSchema = z.strictObject({
  completedAt: z.iso.datetime({ offset: true }),
  eventId: z.string().regex(/^acquisition_[A-Za-z0-9_-]{22}$/u),
  operationId: z
    .string()
    .min(43)
    .max(64)
    .regex(/^acquisition_recovery_[A-Za-z0-9_-]+$/u),
  service: acquisitionServiceSchema,
  state: z.literal("removed_and_blocklisted"),
});
export type AcquisitionQueueRecoveryResponse = z.infer<
  typeof acquisitionQueueRecoveryResponseSchema
>;

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

export const acquisitionProvenanceEventCursorSchema = z
  .string()
  .regex(/^provenance_event_[A-Za-z0-9_-]{22}$/u);

export const acquisitionProvenanceSnapshotEventSchema = z.strictObject({
  cursor: acquisitionProvenanceEventCursorSchema,
  kind: z.literal("snapshot"),
  provenance: acquisitionProvenanceResponseSchema,
});
export type AcquisitionProvenanceSnapshotEvent = z.infer<
  typeof acquisitionProvenanceSnapshotEventSchema
>;

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

export const acquisitionMonitoringTargetInputSchema = z.strictObject({
  mediaId: z.coerce.number().int().positive().max(2_147_483_647),
  service: acquisitionServiceSchema,
});
export type AcquisitionMonitoringTargetInput = z.infer<
  typeof acquisitionMonitoringTargetInputSchema
>;

export const acquisitionMonitoringTargetSchema = z
  .strictObject({
    kind: z.enum(["movie", "series"]),
    mediaId: upstreamIdentifierSchema,
    service: acquisitionServiceSchema,
  })
  .superRefine((target, context) => {
    const validKind =
      (target.service === "radarr" && target.kind === "movie") ||
      (target.service === "sonarr" && target.kind === "series");
    if (!validKind) {
      context.addIssue({
        code: "custom",
        message: "The monitoring target kind must match its acquisition service.",
        path: ["kind"],
      });
    }
  });
export type AcquisitionMonitoringTarget = z.infer<typeof acquisitionMonitoringTargetSchema>;

export const acquisitionMonitoringStateSchema = z.strictObject({
  monitored: z.boolean(),
  target: acquisitionMonitoringTargetSchema,
  verifiedAt: z.iso.datetime({ offset: true }),
});
export type AcquisitionMonitoringState = z.infer<typeof acquisitionMonitoringStateSchema>;

export const acquisitionMonitoringUpdateInputSchema = acquisitionMonitoringTargetInputSchema
  .extend({
    expectedMonitored: z.boolean(),
    monitored: z.boolean(),
  })
  .refine((input) => input.expectedMonitored !== input.monitored, {
    message: "A monitoring update must request a state change.",
    path: ["monitored"],
  });
export type AcquisitionMonitoringUpdateInput = z.infer<
  typeof acquisitionMonitoringUpdateInputSchema
>;

export const manualReleaseTargetInputSchema = z
  .strictObject({
    episodeId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
    mediaId: z.coerce.number().int().positive().max(2_147_483_647),
    seasonNumber: z.coerce.number().int().nonnegative().max(10_000).optional(),
    service: acquisitionServiceSchema,
  })
  .superRefine((target, context) => {
    if (target.service === "radarr") {
      if (target.episodeId !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Movie release targets cannot include an episode.",
          path: ["episodeId"],
        });
      }
      if (target.seasonNumber !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Movie release targets cannot include a season.",
          path: ["seasonNumber"],
        });
      }
      return;
    }
    if ((target.episodeId === undefined) === (target.seasonNumber === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Series release targets require exactly one episode or season.",
        path: ["episodeId"],
      });
    }
  });
export type ManualReleaseTargetInput = z.infer<typeof manualReleaseTargetInputSchema>;

export const manualReleaseTargetSchema = z
  .strictObject({
    episodeId: upstreamIdentifierSchema.nullable(),
    kind: z.enum(["movie", "episode", "season"]),
    mediaId: upstreamIdentifierSchema,
    seasonNumber: seasonNumberSchema.nullable(),
    service: acquisitionServiceSchema,
  })
  .superRefine((target, context) => {
    const validMovie =
      target.service === "radarr" &&
      target.kind === "movie" &&
      target.episodeId === null &&
      target.seasonNumber === null;
    const validEpisode =
      target.service === "sonarr" &&
      target.kind === "episode" &&
      target.episodeId !== null &&
      target.seasonNumber === null;
    const validSeason =
      target.service === "sonarr" &&
      target.kind === "season" &&
      target.episodeId === null &&
      target.seasonNumber !== null;
    if (!validMovie && !validEpisode && !validSeason) {
      context.addIssue({
        code: "custom",
        message: "The manual release target shape must match its service and kind.",
        path: ["kind"],
      });
    }
  });
export type ManualReleaseTarget = z.infer<typeof manualReleaseTargetSchema>;

export const manualReleaseDecisionSchema = z.enum(["approved", "temporarily_rejected", "rejected"]);
export type ManualReleaseDecision = z.infer<typeof manualReleaseDecisionSchema>;

export const manualReleaseCandidateSchema = z
  .strictObject({
    ageMinutes: z.int().nonnegative().max(5_256_000),
    customFormats: z.array(safeLabelSchema).max(32),
    customFormatScore: z.int().min(-1_000_000).max(1_000_000),
    decision: manualReleaseDecisionSchema,
    downloadAllowed: z.boolean(),
    episodeNumbers: z.array(z.int().positive().max(100_000)).max(100),
    fullSeason: z.boolean(),
    id: z
      .string()
      .length(40)
      .regex(/^release_[A-Za-z0-9_-]{32}$/u),
    indexer: safeLabelSchema,
    languages: z.array(safeLabelSchema).max(16),
    leechers: z.int().nonnegative().max(2_147_483_647).nullable(),
    protocol: z.enum(["torrent", "usenet", "unknown"]),
    publishedAt: z.iso.datetime({ offset: true }),
    quality: safeLabelSchema,
    rejectionReasons: z.array(z.string().trim().min(1).max(240)).max(32),
    releaseGroup: safeLabelSchema.nullable(),
    requiresOverride: z.boolean(),
    seeders: z.int().nonnegative().max(2_147_483_647).nullable(),
    sizeBytes: z.int().nonnegative().max(9_007_199_254_740_991),
    title: releaseTitleSchema,
  })
  .superRefine((candidate, context) => {
    if ((candidate.decision !== "approved") !== candidate.requiresOverride) {
      context.addIssue({
        code: "custom",
        message: "Rejected releases must require explicit override confirmation.",
        path: ["requiresOverride"],
      });
    }
    if (candidate.decision === "approved" && candidate.rejectionReasons.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Approved releases cannot include rejection reasons.",
        path: ["rejectionReasons"],
      });
    }
  });
export type ManualReleaseCandidate = z.infer<typeof manualReleaseCandidateSchema>;

export const manualReleaseSearchResponseSchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }),
  generatedAt: z.iso.datetime({ offset: true }),
  releases: z.array(manualReleaseCandidateSchema).max(MANUAL_RELEASE_MAX_RESULTS),
  target: manualReleaseTargetSchema,
});
export type ManualReleaseSearchResponse = z.infer<typeof manualReleaseSearchResponseSchema>;

export const manualReleaseGrabInputSchema = z.strictObject({
  overrideRejections: z.boolean(),
  releaseId: manualReleaseCandidateSchema.shape.id,
});
export type ManualReleaseGrabInput = z.infer<typeof manualReleaseGrabInputSchema>;

export const manualReleaseGrabIdempotencyKeySchema = idempotencyKeySchema;
export type ManualReleaseGrabIdempotencyKey = z.infer<typeof manualReleaseGrabIdempotencyKeySchema>;

export const manualReleaseGrabResponseSchema = z.strictObject({
  acceptedAt: z.iso.datetime({ offset: true }),
  operationId: z
    .string()
    .length(45)
    .regex(/^release_grab_[A-Za-z0-9_-]{32}$/u),
  releaseId: manualReleaseCandidateSchema.shape.id,
  service: acquisitionServiceSchema,
  state: z.literal("accepted"),
});
export type ManualReleaseGrabResponse = z.infer<typeof manualReleaseGrabResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const acquisitionTargetInputJsonSchema = withoutSchemaDialect(acquisitionTargetInputSchema);
export const acquisitionProvenanceResponseJsonSchema = withoutSchemaDialect(
  acquisitionProvenanceResponseSchema,
);
export const acquisitionProvenanceSnapshotEventJsonSchema = withoutSchemaDialect(
  acquisitionProvenanceSnapshotEventSchema,
);
export const acquisitionQueueRecoveryInputJsonSchema = withoutSchemaDialect(
  acquisitionQueueRecoveryInputSchema,
);
export const acquisitionQueueRecoveryResponseJsonSchema = withoutSchemaDialect(
  acquisitionQueueRecoveryResponseSchema,
);
export const acquisitionSearchInputJsonSchema = withoutSchemaDialect(acquisitionSearchInputSchema);
export const acquisitionSearchResponseJsonSchema = withoutSchemaDialect(
  acquisitionSearchResponseSchema,
);
export const acquisitionMonitoringTargetInputJsonSchema = withoutSchemaDialect(
  acquisitionMonitoringTargetInputSchema,
);
export const acquisitionMonitoringStateJsonSchema = withoutSchemaDialect(
  acquisitionMonitoringStateSchema,
);
export const acquisitionMonitoringUpdateInputJsonSchema = withoutSchemaDialect(
  acquisitionMonitoringUpdateInputSchema,
);
export const manualReleaseTargetInputJsonSchema = withoutSchemaDialect(
  manualReleaseTargetInputSchema,
);
export const manualReleaseSearchResponseJsonSchema = withoutSchemaDialect(
  manualReleaseSearchResponseSchema,
);
export const manualReleaseGrabInputJsonSchema = withoutSchemaDialect(manualReleaseGrabInputSchema);
export const manualReleaseGrabResponseJsonSchema = withoutSchemaDialect(
  manualReleaseGrabResponseSchema,
);
