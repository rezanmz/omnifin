import type {
  IndexerApplication,
  IndexerFailure,
  IndexerIntelligenceItem,
  IndexerIntelligenceSummary,
} from "@omnifin/contracts/indexers";
import {
  INDEXER_PAGE_MAX_ITEMS,
  INDEXER_UPSTREAM_MAX_ITEMS,
  indexerApplicationSchema,
  indexerFailureSchema,
  indexerIntelligenceItemSchema,
  indexerIntelligenceSummarySchema,
} from "@omnifin/contracts/indexers";
import type { PartialFailure } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { ServarrAdapter } from "./servarr.js";
import { SafeConnectorError } from "../http/safe-http-client.js";
import type { ApiKeyConnectorConfig } from "../types.js";

const upstreamIdentifierSchema = z.int().positive().max(2_147_483_647);
const upstreamCountSchema = z.int().nonnegative().max(2_147_483_647);
const upstreamDurationSchema = z.int().nonnegative().max(3_600_000);
const optionalTimestampSchema = z.iso.datetime({ offset: true }).nullish();

const prowlarrIndexerSchema = z.object({
  enable: z.boolean(),
  id: upstreamIdentifierSchema,
  name: z.string().trim().min(1).max(160),
  privacy: z.string().trim().min(1).max(64).optional(),
  protocol: z.string().trim().min(1).max(64).optional(),
  supportsRss: z.boolean().optional(),
  supportsSearch: z.boolean().optional(),
});
const prowlarrIndexerListSchema = z.array(prowlarrIndexerSchema).max(INDEXER_UPSTREAM_MAX_ITEMS);

const prowlarrStatisticSchema = z.object({
  averageGrabResponseTime: upstreamDurationSchema,
  averageResponseTime: upstreamDurationSchema,
  indexerId: upstreamIdentifierSchema,
  numberOfAuthQueries: upstreamCountSchema,
  numberOfFailedAuthQueries: upstreamCountSchema,
  numberOfFailedGrabs: upstreamCountSchema,
  numberOfFailedQueries: upstreamCountSchema,
  numberOfFailedRssQueries: upstreamCountSchema,
  numberOfGrabs: upstreamCountSchema,
  numberOfQueries: upstreamCountSchema,
  numberOfRssQueries: upstreamCountSchema,
});
const prowlarrStatisticsSchema = z.object({
  indexers: z.array(prowlarrStatisticSchema).max(INDEXER_UPSTREAM_MAX_ITEMS),
});

const prowlarrStatusSchema = z.object({
  disabledTill: optionalTimestampSchema,
  indexerId: upstreamIdentifierSchema,
  initialFailure: optionalTimestampSchema,
  mostRecentFailure: optionalTimestampSchema,
});
const prowlarrStatusListSchema = z.array(prowlarrStatusSchema).max(INDEXER_UPSTREAM_MAX_ITEMS);

const prowlarrApplicationSchema = z.object({
  id: upstreamIdentifierSchema,
  implementationName: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  syncLevel: z.string().trim().min(1).max(64),
});
const prowlarrApplicationListSchema = z
  .array(prowlarrApplicationSchema)
  .max(INDEXER_UPSTREAM_MAX_ITEMS);

const prowlarrHistoryRecordSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  date: z.iso.datetime({ offset: true }),
  eventType: z.union([z.int(), z.string().trim().min(1).max(64)]),
  id: upstreamIdentifierSchema,
  indexerId: upstreamIdentifierSchema,
  successful: z.boolean(),
});
const prowlarrHistoryPageSchema = z.object({
  records: z.array(prowlarrHistoryRecordSchema).max(INDEXER_PAGE_MAX_ITEMS),
  totalRecords: z.int().nonnegative().max(9_007_199_254_740_991),
});

const prowlarrProviderResourceSchema = z
  .object({
    id: upstreamIdentifierSchema,
    name: z.string().trim().min(1).max(160),
  })
  .loose();

export interface ProwlarrIndexerPage {
  failures: PartialFailure[];
  generatedAt: string;
  hasMore: boolean;
  items: IndexerIntelligenceItem[];
  periodEndedAt: string;
  periodStartedAt: string;
  summary: IndexerIntelligenceSummary;
}

export interface ProwlarrApplicationPage {
  generatedAt: string;
  hasMore: boolean;
  items: IndexerApplication[];
}

export interface ProwlarrFailurePage {
  generatedAt: string;
  hasMore: boolean;
  items: IndexerFailure[];
}

export interface ProwlarrPageInput {
  afterId?: number;
  limit: number;
}

export interface ProwlarrFailurePageInput {
  limit: number;
  page: number;
}

function normalizeProtocol(value: string | undefined): IndexerIntelligenceItem["protocol"] {
  if (value?.toLowerCase() === "torrent") return "torrent";
  if (value?.toLowerCase() === "usenet") return "usenet";
  return "unknown";
}

function normalizePrivacy(value: string | undefined): IndexerIntelligenceItem["privacy"] {
  const normalized = value?.replaceAll("-", "_").toLowerCase();
  if (normalized === "public" || normalized === "private") return normalized;
  if (normalized === "semiprivate" || normalized === "semi_private") return "semi_private";
  return "unknown";
}

function normalizeSyncLevel(value: string): IndexerApplication["syncLevel"] {
  const normalized = value.replaceAll("_", "").toLowerCase();
  if (normalized === "addonly") return "add_only";
  if (normalized === "fullsync") return "full_sync";
  return "disabled";
}

function failureKind(value: number | string): IndexerFailure["kind"] {
  const normalized = typeof value === "number" ? value : value.toLowerCase();
  if (normalized === 1 || normalized === "releasegrabbed") return "grab";
  if (normalized === 2 || normalized === "indexerquery") return "query";
  if (normalized === 3 || normalized === "indexerrss") return "rss";
  if (normalized === 4 || normalized === "indexerauth") return "authentication";
  if (normalized === 5 || normalized === "indexerinfo") return "information";
  return "unknown";
}

function failureSummary(kind: IndexerFailure["kind"]) {
  switch (kind) {
    case "authentication":
      return "Authentication check failed";
    case "grab":
      return "Release grab failed";
    case "information":
      return "Indexer information request failed";
    case "query":
      return "Search query failed";
    case "rss":
      return "RSS query failed";
    case "unknown":
      return "Indexer request failed";
  }
}

function historyLatency(data: Record<string, unknown> | undefined) {
  const value = data?.elapsedTime;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3_600_000) {
    return value;
  }
  if (typeof value === "string" && /^\d{1,7}$/u.test(value)) {
    const parsed = Number(value);
    if (parsed <= 3_600_000) return parsed;
  }
  return null;
}

function safePartialFailure(error: unknown, operation: string, occurredAt: Date): PartialFailure {
  if (error instanceof SafeConnectorError) return error.toPartialFailure(occurredAt);
  return new SafeConnectorError({
    service: "prowlarr",
    operation,
    code: "upstream_error",
    message: "Prowlarr indexer intelligence is partially unavailable.",
    retryable: false,
  }).toPartialFailure(occurredAt);
}

export class ProwlarrAdapter extends ServarrAdapter {
  readonly service = "prowlarr" as const;
  override readonly capabilities = [
    "connector.health",
    "connector.version",
    "indexer.statistics",
    "indexer.test",
  ] as const;
  protected readonly apiPath = "api/v1/system/status";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }

  async readIndexerIntelligencePage(
    input: ProwlarrPageInput,
    signal?: AbortSignal,
  ): Promise<ProwlarrIndexerPage> {
    const generatedAt = this.clock.now();
    const periodEndedAt = generatedAt;
    const periodStartedAt = new Date(periodEndedAt.getTime() - 24 * 60 * 60 * 1_000);
    const headers = { "X-Api-Key": this.apiKey };
    const indexers = await this.client.requestJson("api/v1/indexer", prowlarrIndexerListSchema, {
      headers,
      operation: "indexer.intelligence.definitions",
      ...(signal ? { signal } : {}),
    });
    const [statisticsResult, statusResult] = await Promise.allSettled([
      this.client.requestJson("api/v1/indexerstats", prowlarrStatisticsSchema, {
        headers,
        operation: "indexer.intelligence.statistics",
        query: {
          endDate: periodEndedAt.toISOString(),
          startDate: periodStartedAt.toISOString(),
        },
        ...(signal ? { signal } : {}),
      }),
      this.client.requestJson("api/v1/indexerstatus", prowlarrStatusListSchema, {
        headers,
        operation: "indexer.intelligence.status",
        ...(signal ? { signal } : {}),
      }),
    ]);
    const failures: PartialFailure[] = [];
    if (statisticsResult.status === "rejected") {
      failures.push(
        safePartialFailure(statisticsResult.reason, "indexer.intelligence.statistics", generatedAt),
      );
    }
    if (statusResult.status === "rejected") {
      failures.push(
        safePartialFailure(statusResult.reason, "indexer.intelligence.status", generatedAt),
      );
    }
    const statisticsById = new Map(
      statisticsResult.status === "fulfilled"
        ? statisticsResult.value.indexers.map((statistic) => [statistic.indexerId, statistic])
        : [],
    );
    const statusById = new Map(
      statusResult.status === "fulfilled"
        ? statusResult.value.map((status) => [status.indexerId, status])
        : [],
    );
    const now = generatedAt.getTime();
    const normalized = indexers
      .map((indexer) => {
        const statistic = statisticsById.get(indexer.id);
        const status = statusById.get(indexer.id);
        const queries = statistic
          ? statistic.numberOfQueries + statistic.numberOfRssQueries + statistic.numberOfAuthQueries
          : 0;
        const failedQueries = statistic
          ? statistic.numberOfFailedQueries +
            statistic.numberOfFailedRssQueries +
            statistic.numberOfFailedAuthQueries
          : 0;
        const disabledUntil = status?.disabledTill ?? null;
        const state: IndexerIntelligenceItem["state"] = !indexer.enable
          ? "disabled"
          : disabledUntil && Date.parse(disabledUntil) > now
            ? "cooldown"
            : status
              ? "degraded"
              : "healthy";
        return indexerIntelligenceItemSchema.parse({
          disabledUntil,
          enabled: indexer.enable,
          id: indexer.id,
          initialFailureAt: status?.initialFailure ?? null,
          mostRecentFailureAt: status?.mostRecentFailure ?? null,
          name: indexer.name,
          privacy: normalizePrivacy(indexer.privacy),
          protocol: normalizeProtocol(indexer.protocol),
          state,
          statistics: {
            averageGrabResponseTimeMs: statistic?.averageGrabResponseTime ?? 0,
            averageQueryResponseTimeMs: statistic?.averageResponseTime ?? 0,
            failedGrabs: statistic?.numberOfFailedGrabs ?? 0,
            failedQueries,
            grabs: statistic?.numberOfGrabs ?? 0,
            queries,
            successRate: queries === 0 ? 1 : Math.max(0, (queries - failedQueries) / queries),
          },
          supportsRss: indexer.supportsRss ?? false,
          supportsSearch: indexer.supportsSearch ?? false,
        });
      })
      .sort((left, right) => left.id - right.id);
    const summary = indexerIntelligenceSummarySchema.parse({
      attention: normalized.filter(
        (indexer) => indexer.state === "cooldown" || indexer.state === "degraded",
      ).length,
      disabled: normalized.filter((indexer) => !indexer.enabled).length,
      enabled: normalized.filter((indexer) => indexer.enabled).length,
      failedQueries: normalized.reduce(
        (total, indexer) => total + indexer.statistics.failedQueries,
        0,
      ),
      queries: normalized.reduce((total, indexer) => total + indexer.statistics.queries, 0),
      total: normalized.length,
    });
    const eligible = normalized.filter((indexer) => indexer.id > (input.afterId ?? 0));
    return {
      failures,
      generatedAt: generatedAt.toISOString(),
      hasMore: eligible.length > input.limit,
      items: eligible.slice(0, input.limit),
      periodEndedAt: periodEndedAt.toISOString(),
      periodStartedAt: periodStartedAt.toISOString(),
      summary,
    };
  }

  async readApplicationPage(
    input: ProwlarrPageInput,
    signal?: AbortSignal,
  ): Promise<ProwlarrApplicationPage> {
    const applications = await this.client.requestJson(
      "api/v1/applications",
      prowlarrApplicationListSchema,
      {
        headers: { "X-Api-Key": this.apiKey },
        operation: "indexer.intelligence.applications",
        ...(signal ? { signal } : {}),
      },
    );
    const eligible = applications
      .map((application) =>
        indexerApplicationSchema.parse({
          id: application.id,
          implementation: application.implementationName,
          name: application.name,
          syncLevel: normalizeSyncLevel(application.syncLevel),
        }),
      )
      .sort((left, right) => left.id - right.id)
      .filter((application) => application.id > (input.afterId ?? 0));
    return {
      generatedAt: this.clock.now().toISOString(),
      hasMore: eligible.length > input.limit,
      items: eligible.slice(0, input.limit),
    };
  }

  async readFailurePage(
    input: ProwlarrFailurePageInput,
    signal?: AbortSignal,
  ): Promise<ProwlarrFailurePage> {
    const page = await this.client.requestJson("api/v1/history", prowlarrHistoryPageSchema, {
      headers: { "X-Api-Key": this.apiKey },
      operation: "indexer.intelligence.failures",
      query: {
        page: String(input.page),
        pageSize: String(input.limit),
        sortDirection: "descending",
        sortKey: "date",
        successful: "false",
      },
      ...(signal ? { signal } : {}),
    });
    return {
      generatedAt: this.clock.now().toISOString(),
      hasMore: input.page * input.limit < page.totalRecords,
      items: page.records.map((record) => {
        const kind = failureKind(record.eventType);
        return indexerFailureSchema.parse({
          id: `prowlarr:history:${record.id}`,
          indexerId: record.indexerId,
          kind,
          latencyMs: historyLatency(record.data),
          occurredAt: record.date,
          summary: failureSummary(kind),
        });
      }),
    };
  }

  async testIndexer(indexerId: number, signal?: AbortSignal) {
    const provider = await this.client.requestJson(
      `api/v1/indexer/${indexerId}`,
      prowlarrProviderResourceSchema,
      {
        headers: { "X-Api-Key": this.apiKey },
        operation: "indexer.test.prepare",
        ...(signal ? { signal } : {}),
      },
    );
    if (provider.id !== indexerId) throw this.client.invalidResponse("indexer.test.prepare");
    const body = JSON.stringify(provider);
    if (Buffer.byteLength(body, "utf8") > 512 * 1_024) {
      throw this.client.invalidResponse("indexer.test.prepare");
    }
    await this.client.requestText("api/v1/indexer/test", {
      body,
      headers: { "content-type": "application/json", "X-Api-Key": this.apiKey },
      method: "POST",
      operation: "indexer.test",
      ...(signal ? { signal } : {}),
    });
    return { indexerId, outcome: "passed" as const, testedAt: this.clock.now().toISOString() };
  }
}
