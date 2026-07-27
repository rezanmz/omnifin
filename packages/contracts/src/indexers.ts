import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";

export const INDEXER_PAGE_MAX_ITEMS = 50;
export const INDEXER_UPSTREAM_MAX_ITEMS = 250;

const upstreamIdentifierSchema = z.int().positive().max(2_147_483_647);
const safeLabelSchema = z.string().trim().min(1).max(160);
const timestampSchema = z.iso.datetime({ offset: true });

export const indexerCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const indexerPageQuerySchema = z.strictObject({
  cursor: indexerCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(INDEXER_PAGE_MAX_ITEMS).default(25),
});
export type IndexerPageQuery = z.infer<typeof indexerPageQuerySchema>;

export const indexerProtocolSchema = z.enum(["torrent", "usenet", "unknown"]);
export type IndexerProtocol = z.infer<typeof indexerProtocolSchema>;

export const indexerOperationalStateSchema = z.enum([
  "healthy",
  "degraded",
  "cooldown",
  "disabled",
]);
export type IndexerOperationalState = z.infer<typeof indexerOperationalStateSchema>;

export const indexerStatisticsSchema = z.strictObject({
  averageGrabResponseTimeMs: z.int().nonnegative().max(3_600_000),
  averageQueryResponseTimeMs: z.int().nonnegative().max(3_600_000),
  failedGrabs: z.int().nonnegative().max(2_147_483_647),
  failedQueries: z.int().nonnegative().max(2_147_483_647),
  grabs: z.int().nonnegative().max(2_147_483_647),
  queries: z.int().nonnegative().max(2_147_483_647),
  successRate: z.number().finite().min(0).max(1),
});
export type IndexerStatistics = z.infer<typeof indexerStatisticsSchema>;

export const indexerIntelligenceItemSchema = z
  .strictObject({
    disabledUntil: timestampSchema.nullable(),
    enabled: z.boolean(),
    id: upstreamIdentifierSchema,
    initialFailureAt: timestampSchema.nullable(),
    mostRecentFailureAt: timestampSchema.nullable(),
    name: safeLabelSchema,
    privacy: z.enum(["public", "private", "semi_private", "unknown"]),
    protocol: indexerProtocolSchema,
    state: indexerOperationalStateSchema,
    statistics: indexerStatisticsSchema,
    supportsRss: z.boolean(),
    supportsSearch: z.boolean(),
  })
  .superRefine((indexer, context) => {
    if ((indexer.state === "disabled") !== !indexer.enabled) {
      context.addIssue({
        code: "custom",
        message: "Only disabled indexers may use the disabled operational state.",
        path: ["state"],
      });
    }
    if (indexer.state === "cooldown" && indexer.disabledUntil === null) {
      context.addIssue({
        code: "custom",
        message: "A cooling-down indexer must include its disabled-until timestamp.",
        path: ["disabledUntil"],
      });
    }
  });
export type IndexerIntelligenceItem = z.infer<typeof indexerIntelligenceItemSchema>;

export const indexerIntelligenceSummarySchema = z.strictObject({
  attention: z.int().nonnegative().max(INDEXER_UPSTREAM_MAX_ITEMS),
  disabled: z.int().nonnegative().max(INDEXER_UPSTREAM_MAX_ITEMS),
  enabled: z.int().nonnegative().max(INDEXER_UPSTREAM_MAX_ITEMS),
  failedQueries: z.int().nonnegative().max(9_007_199_254_740_991),
  queries: z.int().nonnegative().max(9_007_199_254_740_991),
  total: z.int().nonnegative().max(INDEXER_UPSTREAM_MAX_ITEMS),
});
export type IndexerIntelligenceSummary = z.infer<typeof indexerIntelligenceSummarySchema>;

export const indexerIntelligenceResponseSchema = z
  .strictObject({
    failures: z.array(partialFailureSchema).max(3),
    generatedAt: timestampSchema,
    items: z.array(indexerIntelligenceItemSchema).max(INDEXER_PAGE_MAX_ITEMS),
    nextCursor: indexerCursorSchema.nullable(),
    periodEndedAt: timestampSchema,
    periodStartedAt: timestampSchema,
    state: z.enum(["complete", "degraded"]),
    summary: indexerIntelligenceSummarySchema,
  })
  .superRefine((response, context) => {
    if ((response.state === "complete") !== (response.failures.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Degraded indexer intelligence must include a partial failure.",
        path: ["state"],
      });
    }
    if (Date.parse(response.periodStartedAt) >= Date.parse(response.periodEndedAt)) {
      context.addIssue({
        code: "custom",
        message: "The statistics period must end after it starts.",
        path: ["periodEndedAt"],
      });
    }
    let previousId = 0;
    for (const [index, item] of response.items.entries()) {
      if (item.id <= previousId) {
        context.addIssue({
          code: "custom",
          message: "Indexer pages must be ordered by ascending identifier.",
          path: ["items", index, "id"],
        });
      }
      previousId = item.id;
    }
  });
export type IndexerIntelligenceResponse = z.infer<typeof indexerIntelligenceResponseSchema>;

export const indexerApplicationSyncLevelSchema = z.enum(["disabled", "add_only", "full_sync"]);
export type IndexerApplicationSyncLevel = z.infer<typeof indexerApplicationSyncLevelSchema>;

export const indexerApplicationSchema = z.strictObject({
  id: upstreamIdentifierSchema,
  implementation: safeLabelSchema,
  name: safeLabelSchema,
  syncLevel: indexerApplicationSyncLevelSchema,
});
export type IndexerApplication = z.infer<typeof indexerApplicationSchema>;

export const indexerApplicationListResponseSchema = z.strictObject({
  generatedAt: timestampSchema,
  items: z.array(indexerApplicationSchema).max(INDEXER_PAGE_MAX_ITEMS),
  nextCursor: indexerCursorSchema.nullable(),
});
export type IndexerApplicationListResponse = z.infer<typeof indexerApplicationListResponseSchema>;

export const indexerFailureKindSchema = z.enum([
  "grab",
  "query",
  "rss",
  "authentication",
  "information",
  "unknown",
]);
export type IndexerFailureKind = z.infer<typeof indexerFailureKindSchema>;

export const indexerFailureSchema = z.strictObject({
  id: z
    .string()
    .min(12)
    .max(80)
    .regex(/^prowlarr:history:[1-9][0-9]*$/u),
  indexerId: upstreamIdentifierSchema,
  kind: indexerFailureKindSchema,
  latencyMs: z.int().nonnegative().max(3_600_000).nullable(),
  occurredAt: timestampSchema,
  summary: z.string().trim().min(1).max(160),
});
export type IndexerFailure = z.infer<typeof indexerFailureSchema>;

export const indexerFailureListResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    items: z.array(indexerFailureSchema).max(INDEXER_PAGE_MAX_ITEMS),
    nextCursor: indexerCursorSchema.nullable(),
  })
  .superRefine((response, context) => {
    let previousTimestamp = Number.POSITIVE_INFINITY;
    for (const [index, item] of response.items.entries()) {
      const timestamp = Date.parse(item.occurredAt);
      if (timestamp > previousTimestamp) {
        context.addIssue({
          code: "custom",
          message: "Indexer failures must be ordered newest first.",
          path: ["items", index, "occurredAt"],
        });
      }
      previousTimestamp = timestamp;
    }
  });
export type IndexerFailureListResponse = z.infer<typeof indexerFailureListResponseSchema>;

export const indexerIdentifierParameterSchema = z.strictObject({
  indexerId: z.coerce.number().int().positive().max(2_147_483_647),
});
export type IndexerIdentifierParameter = z.infer<typeof indexerIdentifierParameterSchema>;

export const indexerTestResponseSchema = z.strictObject({
  indexerId: upstreamIdentifierSchema,
  outcome: z.literal("passed"),
  testedAt: timestampSchema,
});
export type IndexerTestResponse = z.infer<typeof indexerTestResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const indexerPageQueryJsonSchema = withoutSchemaDialect(indexerPageQuerySchema);
export const indexerIdentifierParameterJsonSchema = withoutSchemaDialect(
  indexerIdentifierParameterSchema,
);
export const indexerIntelligenceResponseJsonSchema = withoutSchemaDialect(
  indexerIntelligenceResponseSchema,
);
export const indexerApplicationListResponseJsonSchema = withoutSchemaDialect(
  indexerApplicationListResponseSchema,
);
export const indexerFailureListResponseJsonSchema = withoutSchemaDialect(
  indexerFailureListResponseSchema,
);
export const indexerTestResponseJsonSchema = withoutSchemaDialect(indexerTestResponseSchema);
