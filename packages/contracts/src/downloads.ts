import { z } from "zod";

import {
  connectorIdentifierSchema,
  partialFailureSchema,
  type PartialFailure,
} from "./connectors.js";

export const DOWNLOAD_QUEUE_MAX_ITEMS = 200;
export const DOWNLOAD_QUEUE_MAX_CLIENTS = 20;
export const DOWNLOAD_QUEUE_MAX_BULK_TARGETS = DOWNLOAD_QUEUE_MAX_ITEMS;
export const DOWNLOAD_QUEUE_MAX_ITEM_BYTES = Math.floor(
  Number.MAX_SAFE_INTEGER / DOWNLOAD_QUEUE_MAX_ITEMS,
);

const safeIntegerSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const itemMetricSchema = safeIntegerSchema.max(DOWNLOAD_QUEUE_MAX_ITEM_BYTES);
const safeDisplayTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

const safeQueueTextSchema = safeDisplayTextSchema.regex(/^[^\\/]+$/u);

export const downloadClientServiceSchema = z.enum(["qbittorrent", "sabnzbd"]);
export type DownloadClientService = z.infer<typeof downloadClientServiceSchema>;

export const downloadProtocolSchema = z.enum(["torrent", "usenet"]);
export type DownloadProtocol = z.infer<typeof downloadProtocolSchema>;

export const downloadQueueItemStateSchema = z.enum([
  "queued",
  "downloading",
  "paused",
  "checking",
  "moving",
  "stalled",
  "failed",
  "unknown",
]);
export type DownloadQueueItemState = z.infer<typeof downloadQueueItemStateSchema>;

export const downloadQueueItemIdSchema = z.string().regex(/^download_[A-Za-z0-9_-]{22}$/u);

export const downloadQueueActionSchema = z.enum(["pause", "resume"]);
export type DownloadQueueAction = z.infer<typeof downloadQueueActionSchema>;

const downloadQueuePausableStateSchema = z.enum([
  "queued",
  "downloading",
  "checking",
  "moving",
  "stalled",
]);

export const downloadQueueActionInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("pause"),
    connectorId: connectorIdentifierSchema,
    expectedState: downloadQueuePausableStateSchema,
    itemId: downloadQueueItemIdSchema,
  }),
  z.strictObject({
    action: z.literal("resume"),
    connectorId: connectorIdentifierSchema,
    expectedState: z.literal("paused"),
    itemId: downloadQueueItemIdSchema,
  }),
]);
export type DownloadQueueActionInput = z.infer<typeof downloadQueueActionInputSchema>;

const downloadQueuePauseTargetSchema = z.strictObject({
  connectorId: connectorIdentifierSchema,
  expectedState: downloadQueuePausableStateSchema,
  itemId: downloadQueueItemIdSchema,
});

const downloadQueueResumeTargetSchema = z.strictObject({
  connectorId: connectorIdentifierSchema,
  expectedState: z.literal("paused"),
  itemId: downloadQueueItemIdSchema,
});

function targetsAreUnique(
  targets: readonly { connectorId: string; itemId: string }[],
  context: z.core.$RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const key = `${target.connectorId}\u0000${target.itemId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Bulk download targets must be unique.",
        path: ["targets", index, "itemId"],
      });
    }
    seen.add(key);
  }
}

export const downloadQueueBulkActionInputSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      action: z.literal("pause"),
      targets: z.array(downloadQueuePauseTargetSchema).min(1).max(DOWNLOAD_QUEUE_MAX_BULK_TARGETS),
    }),
    z.strictObject({
      action: z.literal("resume"),
      targets: z.array(downloadQueueResumeTargetSchema).min(1).max(DOWNLOAD_QUEUE_MAX_BULK_TARGETS),
    }),
  ])
  .superRefine((input, context) => targetsAreUnique(input.targets, context));
export type DownloadQueueBulkActionInput = z.infer<typeof downloadQueueBulkActionInputSchema>;

export const downloadQueueItemSchema = z
  .strictObject({
    addedAt: z.iso.datetime({ offset: true }).nullable(),
    category: safeQueueTextSchema.max(80).nullable(),
    client: downloadClientServiceSchema,
    clientName: safeDisplayTextSchema.max(160),
    connectorId: connectorIdentifierSchema,
    etaSeconds: z.int().nonnegative().max(31_536_000).nullable(),
    id: downloadQueueItemIdSchema,
    leechers: z.int().nonnegative().max(2_147_483_647).nullable(),
    progress: z.number().finite().min(0).max(1),
    protocol: downloadProtocolSchema,
    rateBytesPerSecond: itemMetricSchema,
    remainingBytes: itemMetricSchema,
    seeders: z.int().nonnegative().max(2_147_483_647).nullable(),
    sizeBytes: itemMetricSchema,
    state: downloadQueueItemStateSchema,
    title: safeQueueTextSchema,
  })
  .superRefine((item, context) => {
    if (item.remainingBytes > item.sizeBytes) {
      context.addIssue({
        code: "custom",
        message: "Remaining download bytes cannot exceed the total size.",
        path: ["remainingBytes"],
      });
    }
    if (item.client === "qbittorrent" && item.protocol !== "torrent") {
      context.addIssue({
        code: "custom",
        message: "qBittorrent queue items must use the torrent protocol.",
        path: ["protocol"],
      });
    }
    if (item.client === "sabnzbd" && item.protocol !== "usenet") {
      context.addIssue({
        code: "custom",
        message: "SABnzbd queue items must use the Usenet protocol.",
        path: ["protocol"],
      });
    }
    if (item.protocol === "usenet" && (item.seeders !== null || item.leechers !== null)) {
      context.addIssue({
        code: "custom",
        message: "Usenet queue items cannot expose torrent peer counts.",
        path: ["seeders"],
      });
    }
  });
export type DownloadQueueItem = z.infer<typeof downloadQueueItemSchema>;

export const downloadQueueRemovalInputSchema = z.strictObject({
  connectorId: connectorIdentifierSchema,
  expectedState: downloadQueueItemStateSchema,
  itemId: downloadQueueItemIdSchema,
});
export type DownloadQueueRemovalInput = z.infer<typeof downloadQueueRemovalInputSchema>;

export const downloadQueueRemovalOperationIdSchema = z
  .string()
  .regex(/^download_removal_[A-Za-z0-9_-]{22}$/u);

export const downloadQueueRemovalResponseSchema = z.strictObject({
  contentDisposition: z.literal("preserved"),
  item: downloadQueueItemSchema,
  operationId: downloadQueueRemovalOperationIdSchema,
  removedAt: z.iso.datetime({ offset: true }),
  replayed: z.boolean(),
});
export type DownloadQueueRemovalResponse = z.infer<typeof downloadQueueRemovalResponseSchema>;

export const downloadQueuePromotionInputSchema = z.strictObject({
  connectorId: connectorIdentifierSchema,
  expectedState: downloadQueueItemStateSchema,
  itemId: downloadQueueItemIdSchema,
});
export type DownloadQueuePromotionInput = z.infer<typeof downloadQueuePromotionInputSchema>;

export const downloadQueuePromotionResponseSchema = z
  .strictObject({
    item: downloadQueueItemSchema,
    position: z.literal(0),
    previousPosition: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    promotedAt: z.iso.datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .superRefine((response, context) => {
    if ((response.previousPosition === 0) !== response.replayed) {
      context.addIssue({
        code: "custom",
        message: "Only an already-first queue item can replay a promotion.",
        path: ["replayed"],
      });
    }
  });
export type DownloadQueuePromotionResponse = z.infer<typeof downloadQueuePromotionResponseSchema>;

export const downloadQueueClientSchema = z
  .strictObject({
    connectorId: connectorIdentifierSchema,
    displayName: safeDisplayTextSchema.max(160),
    failure: partialFailureSchema.nullable(),
    itemCount: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_ITEMS),
    rateBytesPerSecond: safeIntegerSchema,
    service: downloadClientServiceSchema,
    status: z.enum(["healthy", "unavailable"]),
  })
  .superRefine((client, context) => {
    if ((client.status === "healthy") !== (client.failure === null)) {
      context.addIssue({
        code: "custom",
        message: "Unavailable download clients must include one safe failure.",
        path: ["failure"],
      });
    }
    if (client.failure && client.failure.service !== client.service) {
      context.addIssue({
        code: "custom",
        message: "Download client failures must identify the same service.",
        path: ["failure", "service"],
      });
    }
  });
export type DownloadQueueClient = z.infer<typeof downloadQueueClientSchema>;

export const downloadQueueSummarySchema = z.strictObject({
  attention: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_ITEMS),
  downloading: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_ITEMS),
  paused: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_ITEMS),
  queued: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_ITEMS),
  remainingBytes: safeIntegerSchema,
  total: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_ITEMS),
  totalRateBytesPerSecond: safeIntegerSchema,
});
export type DownloadQueueSummary = z.infer<typeof downloadQueueSummarySchema>;

function countStates(items: readonly DownloadQueueItem[]) {
  return {
    attention: items.filter((item) => item.state === "failed" || item.state === "stalled").length,
    downloading: items.filter((item) => ["checking", "downloading", "moving"].includes(item.state))
      .length,
    paused: items.filter((item) => item.state === "paused").length,
    queued: items.filter((item) => item.state === "queued").length,
  };
}

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

export const downloadQueueResponseSchema = z
  .strictObject({
    clients: z.array(downloadQueueClientSchema).max(DOWNLOAD_QUEUE_MAX_CLIENTS),
    failures: z.array(partialFailureSchema).max(DOWNLOAD_QUEUE_MAX_CLIENTS),
    generatedAt: z.iso.datetime({ offset: true }),
    items: z.array(downloadQueueItemSchema).max(DOWNLOAD_QUEUE_MAX_ITEMS),
    state: z.enum(["complete", "degraded", "unconfigured"]),
    summary: downloadQueueSummarySchema,
    truncated: z.boolean(),
  })
  .superRefine((response, context) => {
    const clientIds = new Set<string>();
    const clientsById = new Map<string, DownloadQueueClient>();
    for (const [index, client] of response.clients.entries()) {
      if (clientIds.has(client.connectorId)) {
        context.addIssue({
          code: "custom",
          message: "Download queue clients must have unique connector identifiers.",
          path: ["clients", index, "connectorId"],
        });
      }
      clientIds.add(client.connectorId);
      clientsById.set(client.connectorId, client);
    }

    const itemIds = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (!clientIds.has(item.connectorId)) {
        context.addIssue({
          code: "custom",
          message: "Every download queue item must belong to a returned client.",
          path: ["items", index, "connectorId"],
        });
      }
      const client = clientsById.get(item.connectorId);
      if (client && (item.client !== client.service || item.clientName !== client.displayName)) {
        context.addIssue({
          code: "custom",
          message: "Download queue items must identify their returned client consistently.",
          path: ["items", index, "client"],
        });
      }
      if (itemIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "Download queue item identifiers must be unique.",
          path: ["items", index, "id"],
        });
      }
      itemIds.add(item.id);
    }

    for (const [index, client] of response.clients.entries()) {
      const clientItems = response.items.filter((item) => item.connectorId === client.connectorId);
      const clientRate = clientItems.reduce((total, item) => total + item.rateBytesPerSecond, 0);
      if (client.itemCount !== clientItems.length || client.rateBytesPerSecond !== clientRate) {
        context.addIssue({
          code: "custom",
          message: "Download client totals must match their returned queue items.",
          path: ["clients", index, "itemCount"],
        });
      }
    }

    const expectedCounts = countStates(response.items);
    const remainingBytes = response.items.reduce((total, item) => total + item.remainingBytes, 0);
    const totalRateBytesPerSecond = response.items.reduce(
      (total, item) => total + item.rateBytesPerSecond,
      0,
    );
    if (!Number.isSafeInteger(remainingBytes) || !Number.isSafeInteger(totalRateBytesPerSecond)) {
      context.addIssue({
        code: "custom",
        message: "Aggregate download queue metrics must remain safe integers.",
        path: ["summary"],
      });
    }
    const expectedSummary = {
      ...expectedCounts,
      remainingBytes,
      total: response.items.length,
      totalRateBytesPerSecond,
    };
    for (const key of Object.keys(expectedSummary) as (keyof typeof expectedSummary)[]) {
      if (response.summary[key] !== expectedSummary[key]) {
        context.addIssue({
          code: "custom",
          message: "The download queue summary must match the returned items.",
          path: ["summary", key],
        });
      }
    }

    const expectedFailures = response.clients
      .map((client) => client.failure)
      .filter((failure): failure is PartialFailure => failure !== null);
    if (
      expectedFailures.length !== response.failures.length ||
      expectedFailures.some((failure, index) => {
        const returnedFailure = response.failures[index];
        return returnedFailure === undefined || !failuresMatch(failure, returnedFailure);
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Top-level download failures must mirror client failures in client order.",
        path: ["failures"],
      });
    }

    const expectedState =
      response.clients.length === 0
        ? "unconfigured"
        : response.failures.length === 0
          ? "complete"
          : "degraded";
    if (response.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "The download queue state must reflect configured clients and failures.",
        path: ["state"],
      });
    }
  });
export type DownloadQueueResponse = z.infer<typeof downloadQueueResponseSchema>;

export const downloadQueueEventCursorSchema = z
  .string()
  .regex(/^download_event_[A-Za-z0-9_-]{22}$/u);

export const downloadQueueSnapshotEventSchema = z.strictObject({
  cursor: downloadQueueEventCursorSchema,
  kind: z.literal("snapshot"),
  queue: downloadQueueResponseSchema,
});
export type DownloadQueueSnapshotEvent = z.infer<typeof downloadQueueSnapshotEventSchema>;

export const downloadQueueActionResponseSchema = z
  .strictObject({
    action: downloadQueueActionSchema,
    item: downloadQueueItemSchema,
    previousState: downloadQueueItemStateSchema,
    replayed: z.boolean(),
    verifiedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((response, context) => {
    const achieved =
      response.action === "pause"
        ? response.item.state === "paused"
        : downloadQueuePausableStateSchema.safeParse(response.item.state).success;
    if (!achieved) {
      context.addIssue({
        code: "custom",
        message: "The returned item must confirm the requested queue state transition.",
        path: ["item", "state"],
      });
    }
    if (response.replayed && response.previousState !== response.item.state) {
      context.addIssue({
        code: "custom",
        message: "A replayed queue action cannot report a state transition.",
        path: ["previousState"],
      });
    }
    if (
      !response.replayed &&
      ((response.action === "pause" &&
        !downloadQueuePausableStateSchema.safeParse(response.previousState).success) ||
        (response.action === "resume" && response.previousState !== "paused"))
    ) {
      context.addIssue({
        code: "custom",
        message: "The previous state must be valid for the reported queue action.",
        path: ["previousState"],
      });
    }
  });
export type DownloadQueueActionResponse = z.infer<typeof downloadQueueActionResponseSchema>;

export const downloadQueueBulkOperationIdSchema = z
  .string()
  .regex(/^download_bulk_[A-Za-z0-9_-]{22}$/u);

export const downloadQueueBulkFailureCodeSchema = z.enum([
  "action_unavailable",
  "action_unconfirmed",
  "configuration_unavailable",
  "rate_limited",
  "state_changed",
  "target_not_found",
]);
export type DownloadQueueBulkFailureCode = z.infer<typeof downloadQueueBulkFailureCodeSchema>;

const downloadQueueBulkTargetSchema = z.strictObject({
  connectorId: connectorIdentifierSchema,
  expectedState: downloadQueueItemStateSchema,
  itemId: downloadQueueItemIdSchema,
});

export const downloadQueueBulkResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    response: downloadQueueActionResponseSchema,
    status: z.literal("succeeded"),
    target: downloadQueueBulkTargetSchema,
  }),
  z.strictObject({
    code: downloadQueueBulkFailureCodeSchema,
    retryable: z.boolean(),
    status: z.literal("failed"),
    target: downloadQueueBulkTargetSchema,
  }),
]);
export type DownloadQueueBulkResult = z.infer<typeof downloadQueueBulkResultSchema>;

export const downloadQueueBulkActionResponseSchema = z
  .strictObject({
    action: downloadQueueActionSchema,
    completedAt: z.iso.datetime({ offset: true }),
    operationId: downloadQueueBulkOperationIdSchema,
    replayed: z.boolean(),
    results: z.array(downloadQueueBulkResultSchema).min(1).max(DOWNLOAD_QUEUE_MAX_BULK_TARGETS),
    state: z.enum(["complete", "failed", "partial"]),
    summary: z.strictObject({
      failed: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_BULK_TARGETS),
      requested: z.int().positive().max(DOWNLOAD_QUEUE_MAX_BULK_TARGETS),
      succeeded: z.int().nonnegative().max(DOWNLOAD_QUEUE_MAX_BULK_TARGETS),
    }),
  })
  .superRefine((bulk, context) => {
    const seen = new Set<string>();
    let succeeded = 0;
    let failed = 0;
    for (const [index, result] of bulk.results.entries()) {
      const key = `${result.target.connectorId}\u0000${result.target.itemId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Bulk download results must identify unique targets.",
          path: ["results", index, "target", "itemId"],
        });
      }
      seen.add(key);
      const targetStateValid =
        bulk.action === "pause"
          ? downloadQueuePausableStateSchema.safeParse(result.target.expectedState).success
          : result.target.expectedState === "paused";
      if (!targetStateValid) {
        context.addIssue({
          code: "custom",
          message: "A bulk result target must be valid for the requested action.",
          path: ["results", index, "target", "expectedState"],
        });
      }
      if (result.status === "succeeded") {
        succeeded += 1;
        if (
          result.response.action !== bulk.action ||
          result.response.item.connectorId !== result.target.connectorId ||
          result.response.item.id !== result.target.itemId ||
          (!result.response.replayed &&
            result.response.previousState !== result.target.expectedState)
        ) {
          context.addIssue({
            code: "custom",
            message: "A successful bulk result must verify the exact requested target.",
            path: ["results", index, "response"],
          });
        }
      } else failed += 1;
    }

    const expectedState = failed === 0 ? "complete" : succeeded === 0 ? "failed" : "partial";
    if (
      bulk.summary.requested !== bulk.results.length ||
      bulk.summary.succeeded !== succeeded ||
      bulk.summary.failed !== failed
    ) {
      context.addIssue({
        code: "custom",
        message: "Bulk download summary counts must match the returned results.",
        path: ["summary"],
      });
    }
    if (bulk.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "Bulk download state must reflect the per-target outcomes.",
        path: ["state"],
      });
    }
  });
export type DownloadQueueBulkActionResponse = z.infer<typeof downloadQueueBulkActionResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const downloadQueueResponseJsonSchema = withoutSchemaDialect(downloadQueueResponseSchema);
export const downloadQueueSnapshotEventJsonSchema = withoutSchemaDialect(
  downloadQueueSnapshotEventSchema,
);
export const downloadQueueActionInputJsonSchema = withoutSchemaDialect(
  downloadQueueActionInputSchema,
);
export const downloadQueueActionResponseJsonSchema = withoutSchemaDialect(
  downloadQueueActionResponseSchema,
);
export const downloadQueueBulkActionInputJsonSchema = withoutSchemaDialect(
  downloadQueueBulkActionInputSchema,
);
export const downloadQueueBulkActionResponseJsonSchema = withoutSchemaDialect(
  downloadQueueBulkActionResponseSchema,
);
export const downloadQueueRemovalInputJsonSchema = withoutSchemaDialect(
  downloadQueueRemovalInputSchema,
);
export const downloadQueueRemovalResponseJsonSchema = withoutSchemaDialect(
  downloadQueueRemovalResponseSchema,
);
export const downloadQueuePromotionInputJsonSchema = withoutSchemaDialect(
  downloadQueuePromotionInputSchema,
);
export const downloadQueuePromotionResponseJsonSchema = withoutSchemaDialect(
  downloadQueuePromotionResponseSchema,
);
