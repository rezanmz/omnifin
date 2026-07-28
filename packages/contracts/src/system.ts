import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";

export const SYSTEM_STATUS_MAX_SOURCES = 12;
export const SYSTEM_STATUS_MAX_SIGNALS_PER_SOURCE = 50;
export const SYSTEM_STATUS_MAX_STORAGE_PER_SOURCE = 16;

const safeLabelSchema = z.string().trim().min(1).max(160);
const safeMessageSchema = z.string().trim().min(1).max(300);
const timestampSchema = z.iso.datetime({ offset: true });
const publicIdentifierSchema = z
  .string()
  .min(29)
  .max(30)
  .regex(/^(?:signal|source|storage)_[A-Za-z0-9_-]{22}$/u);

export const operationalServiceSchema = z.enum(["radarr", "sonarr", "prowlarr"]);
export type OperationalService = z.infer<typeof operationalServiceSchema>;

export const systemSignalSeveritySchema = z.enum(["notice", "warning", "error"]);
export type SystemSignalSeverity = z.infer<typeof systemSignalSeveritySchema>;

export const systemHealthSignalSchema = z.strictObject({
  id: publicIdentifierSchema,
  message: safeMessageSchema,
  severity: systemSignalSeveritySchema,
  sourceLabel: safeLabelSchema,
});
export type SystemHealthSignal = z.infer<typeof systemHealthSignalSchema>;

export const storageCapacityStateSchema = z.enum(["healthy", "warning", "critical"]);
export type StorageCapacityState = z.infer<typeof storageCapacityStateSchema>;

export const storageCapacitySchema = z
  .strictObject({
    freeBytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    id: publicIdentifierSchema,
    label: safeLabelSchema,
    state: storageCapacityStateSchema,
    totalBytes: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((storage, context) => {
    if (storage.freeBytes > storage.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "Free storage cannot exceed total storage.",
        path: ["freeBytes"],
      });
      return;
    }
    const freeRatio = storage.freeBytes / storage.totalBytes;
    const expectedState =
      freeRatio <= 0.05 ? "critical" : freeRatio <= 0.15 ? "warning" : "healthy";
    if (storage.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "Storage state must match the normalized capacity thresholds.",
        path: ["state"],
      });
    }
  });
export type StorageCapacity = z.infer<typeof storageCapacitySchema>;

export const systemStatusSourceSchema = z
  .strictObject({
    displayName: safeLabelSchema,
    failure: partialFailureSchema.nullable(),
    id: publicIdentifierSchema,
    service: operationalServiceSchema,
    signals: z.array(systemHealthSignalSchema).max(SYSTEM_STATUS_MAX_SIGNALS_PER_SOURCE),
    status: z.enum(["healthy", "attention", "unavailable"]),
    storage: z.array(storageCapacitySchema).max(SYSTEM_STATUS_MAX_STORAGE_PER_SOURCE),
  })
  .superRefine((source, context) => {
    const needsAttention =
      source.failure !== null ||
      source.signals.length > 0 ||
      source.storage.some((storage) => storage.state !== "healthy");
    if (source.status === "healthy" && needsAttention) {
      context.addIssue({
        code: "custom",
        message: "A healthy source cannot contain active operational concerns.",
        path: ["status"],
      });
    }
    if (source.status === "attention" && !needsAttention) {
      context.addIssue({
        code: "custom",
        message: "An attention source must explain what needs attention.",
        path: ["status"],
      });
    }
    if (source.status === "unavailable") {
      if (source.failure === null) {
        context.addIssue({
          code: "custom",
          message: "An unavailable source must include a safe failure.",
          path: ["failure"],
        });
      }
      if (source.signals.length > 0 || source.storage.length > 0) {
        context.addIssue({
          code: "custom",
          message: "Unavailable sources cannot include stale operational data.",
          path: ["status"],
        });
      }
    }
    if (source.failure !== null && source.failure.service !== source.service) {
      context.addIssue({
        code: "custom",
        message: "A source failure must identify the same service.",
        path: ["failure", "service"],
      });
    }
  });
export type SystemStatusSource = z.infer<typeof systemStatusSourceSchema>;

export const systemStatusSummarySchema = z.strictObject({
  attentionSources: z.int().nonnegative().max(SYSTEM_STATUS_MAX_SOURCES),
  criticalStorage: z
    .int()
    .nonnegative()
    .max(SYSTEM_STATUS_MAX_SOURCES * SYSTEM_STATUS_MAX_STORAGE_PER_SOURCE),
  errorSignals: z
    .int()
    .nonnegative()
    .max(SYSTEM_STATUS_MAX_SOURCES * SYSTEM_STATUS_MAX_SIGNALS_PER_SOURCE),
  healthySources: z.int().nonnegative().max(SYSTEM_STATUS_MAX_SOURCES),
  noticeSignals: z
    .int()
    .nonnegative()
    .max(SYSTEM_STATUS_MAX_SOURCES * SYSTEM_STATUS_MAX_SIGNALS_PER_SOURCE),
  sources: z.int().nonnegative().max(SYSTEM_STATUS_MAX_SOURCES),
  unavailableSources: z.int().nonnegative().max(SYSTEM_STATUS_MAX_SOURCES),
  warningSignals: z
    .int()
    .nonnegative()
    .max(SYSTEM_STATUS_MAX_SOURCES * SYSTEM_STATUS_MAX_SIGNALS_PER_SOURCE),
  warningStorage: z
    .int()
    .nonnegative()
    .max(SYSTEM_STATUS_MAX_SOURCES * SYSTEM_STATUS_MAX_STORAGE_PER_SOURCE),
});
export type SystemStatusSummary = z.infer<typeof systemStatusSummarySchema>;

export const systemStatusResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    sources: z.array(systemStatusSourceSchema).max(SYSTEM_STATUS_MAX_SOURCES),
    state: z.enum(["complete", "degraded", "unconfigured"]),
    summary: systemStatusSummarySchema,
  })
  .superRefine((response, context) => {
    const expectedState =
      response.sources.length === 0
        ? "unconfigured"
        : response.sources.some(
              (source) => source.status === "unavailable" || source.failure !== null,
            )
          ? "degraded"
          : "complete";
    if (response.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "System status state does not match its source results.",
        path: ["state"],
      });
    }

    const allSignals = response.sources.flatMap((source) => source.signals);
    const allStorage = response.sources.flatMap((source) => source.storage);
    const expectedSummary: SystemStatusSummary = {
      attentionSources: response.sources.filter((source) => source.status === "attention").length,
      criticalStorage: allStorage.filter((storage) => storage.state === "critical").length,
      errorSignals: allSignals.filter((signal) => signal.severity === "error").length,
      healthySources: response.sources.filter((source) => source.status === "healthy").length,
      noticeSignals: allSignals.filter((signal) => signal.severity === "notice").length,
      sources: response.sources.length,
      unavailableSources: response.sources.filter((source) => source.status === "unavailable")
        .length,
      warningSignals: allSignals.filter((signal) => signal.severity === "warning").length,
      warningStorage: allStorage.filter((storage) => storage.state === "warning").length,
    };
    for (const key of Object.keys(expectedSummary) as (keyof SystemStatusSummary)[]) {
      if (response.summary[key] !== expectedSummary[key]) {
        context.addIssue({
          code: "custom",
          message: "System status summary does not match its source results.",
          path: ["summary", key],
        });
      }
    }
  });
export type SystemStatusResponse = z.infer<typeof systemStatusResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const systemStatusResponseJsonSchema = withoutSchemaDialect(systemStatusResponseSchema);
