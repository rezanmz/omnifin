import type { ConnectorHealth, ConnectorService } from "@omnifin/contracts/connectors";
import type { SystemSignalSeverity } from "@omnifin/contracts/system";
import { z } from "zod";

import type { ConnectorSystemSignal } from "../system.js";
import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { ApiKeyConnectorConfig } from "../types.js";

const servarrStatusSchema = z.object({
  version: upstreamVersionSchema,
  appName: z.string().optional(),
  instanceName: z.string().optional(),
});

const servarrHealthResultSchema = z.union([
  z.enum(["ok", "notice", "warning", "error"]),
  z.int().min(0).max(3),
]);

const servarrHealthSchema = z
  .array(
    z.object({
      id: z.union([z.int().nonnegative(), z.string().trim().min(1).max(128)]).optional(),
      message: z.string().max(4_096),
      source: z.string().max(512),
      type: servarrHealthResultSchema,
    }),
  )
  .max(250);

const URL_PATTERN = /\bhttps?:\/\/[^\s]+/giu;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s,;]+/gu;
const UNIX_PATH_PATTERN = /(^|[\s("'`])\/(?:[^/\s"'`,;)]+\/)*[^/\s"'`,;)]*/gu;

function cleanText(value: string, fallback: string, protectedValue?: string) {
  let cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(URL_PATTERN, "documentation")
    .replace(WINDOWS_PATH_PATTERN, "configured path")
    .replace(UNIX_PATH_PATTERN, "$1configured path");
  if (protectedValue) cleaned = cleaned.split(protectedValue).join("configured credential");
  cleaned = cleaned.replace(/\s+/gu, " ").trim();
  return (cleaned || fallback).slice(0, 300);
}

function sourceLabel(value: string) {
  const withoutSuffix = value.replace(/(?:Health)?Check$/u, "");
  const spaced = withoutSuffix.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  return cleanText(spaced, "Service check").slice(0, 160);
}

function severity(value: z.infer<typeof servarrHealthResultSchema>): SystemSignalSeverity | null {
  if (value === "ok" || value === 0) return null;
  if (value === "notice" || value === 1) return "notice";
  if (value === "warning" || value === 2) return "warning";
  return "error";
}

export abstract class ServarrAdapter extends ProbeOnlyAdapter {
  abstract override readonly service: Extract<ConnectorService, "radarr" | "sonarr" | "prowlarr">;
  protected abstract readonly apiPath: string;
  protected abstract readonly apiRoot: string;
  protected readonly apiKey: string;

  protected constructor(config: ApiKeyConnectorConfig) {
    super(config, [config.apiKey]);
    this.apiKey = config.apiKey;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const status = await this.client.requestJson(this.apiPath, servarrStatusSchema, {
        operation: "probe",
        headers: { "X-Api-Key": this.apiKey },
        ...(signal ? { signal } : {}),
      });
      return status.version;
    });
  }

  async readSystemHealth(signal?: AbortSignal): Promise<readonly ConnectorSystemSignal[]> {
    const records = await this.client.requestJson(`${this.apiRoot}/health`, servarrHealthSchema, {
      operation: "system.health",
      headers: { "X-Api-Key": this.apiKey },
      ...(signal ? { signal } : {}),
    });
    return records.flatMap((record, index) => {
      const normalizedSeverity = severity(record.type);
      if (normalizedSeverity === null) return [];
      const normalizedSource = sourceLabel(record.source);
      return [
        {
          externalId: `${record.id ?? index}:${record.source}`.slice(0, 640),
          message: cleanText(
            record.message,
            `${this.displayName} reported an operational concern.`,
            this.apiKey,
          ),
          severity: normalizedSeverity,
          sourceLabel: normalizedSource,
        },
      ];
    });
  }
}
