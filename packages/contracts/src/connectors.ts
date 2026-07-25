import { z } from "zod";

export const connectorServiceSchema = z.enum([
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "bazarr",
  "qbittorrent",
  "sabnzbd",
  "tmdb",
]);
export type ConnectorService = z.infer<typeof connectorServiceSchema>;

export const connectorCapabilitySchema = z.enum([
  "connector.health",
  "connector.version",
  "identity.authenticate",
  "identity.quick_connect",
  "media.discover",
  "media.library.read",
  "media.library.mutate",
  "media.playback",
  "media.watch_state",
  "request.create",
  "request.review",
  "acquisition.search",
  "acquisition.grab",
  "acquisition.history",
  "indexer.statistics",
  "indexer.test",
  "download.queue.read",
  "download.queue.mutate",
  "subtitle.search",
  "subtitle.download",
]);
export type ConnectorCapability = z.infer<typeof connectorCapabilitySchema>;

export const connectorFailureCodeSchema = z.enum([
  "configuration_invalid",
  "destination_blocked",
  "invalid_credentials",
  "rate_limited",
  "response_invalid",
  "timeout",
  "unreachable",
  "unsupported_version",
  "upstream_error",
]);
export type ConnectorFailureCode = z.infer<typeof connectorFailureCodeSchema>;

export const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export const partialFailureSchema = z.object({
  service: connectorServiceSchema,
  operation: z.string().trim().min(1).max(128),
  code: connectorFailureCodeSchema,
  message: z.string().trim().min(1).max(300),
  retryable: z.boolean(),
  occurredAt: z.iso.datetime({ offset: true }),
  retryAfterSeconds: z.int().nonnegative().max(MAX_RETRY_AFTER_SECONDS).optional(),
});
export type PartialFailure = z.infer<typeof partialFailureSchema>;

export const connectorHealthSchema = z
  .object({
    connectorId: z.string().trim().min(1).max(128),
    service: connectorServiceSchema,
    displayName: z.string().trim().min(1).max(160),
    status: z.enum(["healthy", "degraded", "unavailable", "misconfigured", "unknown"]),
    checkedAt: z.iso.datetime({ offset: true }),
    latencyMs: z.number().finite().nonnegative(),
    version: z.string().trim().min(1).max(128).nullable(),
    capabilities: z.array(connectorCapabilitySchema),
    failure: partialFailureSchema.nullable(),
  })
  .superRefine((health, context) => {
    if (new Set(health.capabilities).size !== health.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Connector capabilities cannot contain duplicates.",
      });
    }
    if (health.failure && health.failure.service !== health.service) {
      context.addIssue({
        code: "custom",
        path: ["failure", "service"],
        message: "Connector failures must identify the same service as their health record.",
      });
    }
    if (health.status === "healthy" && health.failure !== null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "A healthy connector cannot include a failure.",
      });
    }
    if (health.status !== "healthy" && health.status !== "unknown" && health.failure === null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "A non-healthy connector must explain its failure.",
      });
    }
  });
export type ConnectorHealth = z.infer<typeof connectorHealthSchema>;

export const connectorSnapshotSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  overallStatus: z.enum(["healthy", "degraded", "unavailable", "unconfigured"]),
  connectors: z.array(connectorHealthSchema).max(100),
});
export type ConnectorSnapshot = z.infer<typeof connectorSnapshotSchema>;
