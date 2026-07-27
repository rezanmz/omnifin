import {
  ACQUISITION_MAX_EVENTS,
  acquisitionProvenanceResponseSchema,
  acquisitionTargetInputSchema,
  type AcquisitionEvent,
  type AcquisitionEventKind,
  type AcquisitionEventState,
  type AcquisitionProvenanceResponse,
  type AcquisitionRelease,
  type AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";
import type { ConnectorCapability, PartialFailure } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { SafeConnectorError } from "../http/safe-http-client.js";
import { ServarrAdapter } from "./servarr.js";

const MAX_UPSTREAM_IDENTIFIER = 2_147_483_647;
const safeIdentifierSchema = z.int().positive().max(MAX_UPSTREAM_IDENTIFIER);
const safeLabelSchema = z.string().trim().min(1).max(160);
const releaseTitleSchema = z.string().trim().min(1).max(500);
const dateSchema = z.iso.datetime({ offset: true });

const qualitySchema = z
  .object({
    quality: z.object({ name: safeLabelSchema.nullish() }).nullish(),
  })
  .nullish();

const historyDataSchema = z
  .object({
    downloadClientName: safeLabelSchema.nullish(),
    indexer: safeLabelSchema.nullish(),
    isUpgrade: z.enum(["true", "false"]).nullish(),
    protocol: z.string().trim().min(1).max(32).nullish(),
  })
  .nullish();

const historyRecordSchema = z.object({
  data: historyDataSchema,
  date: dateSchema,
  episode: z
    .object({
      episodeNumber: z.int().positive().max(100_000).nullish(),
      seasonNumber: z.int().nonnegative().max(10_000).nullish(),
    })
    .nullish(),
  episodeId: safeIdentifierSchema.nullish(),
  eventType: z.enum([
    "unknown",
    "grabbed",
    "seriesFolderImported",
    "downloadFolderImported",
    "downloadFailed",
    "episodeFileDeleted",
    "episodeFileRenamed",
    "movieFileDeleted",
    "movieFolderImported",
    "movieFileRenamed",
    "downloadIgnored",
  ]),
  id: safeIdentifierSchema,
  movieId: safeIdentifierSchema.nullish(),
  quality: qualitySchema,
  seriesId: safeIdentifierSchema.nullish(),
  sourceTitle: releaseTitleSchema.nullish(),
});

const historyResponseSchema = z.object({
  records: z.array(historyRecordSchema).max(ACQUISITION_MAX_EVENTS).nullish(),
  totalRecords: z.int().nonnegative().max(10_000_000),
});

const queueRecordSchema = z.object({
  added: dateSchema.nullish(),
  downloadClient: safeLabelSchema.nullish(),
  episode: z
    .object({
      episodeNumber: z.int().positive().max(100_000).nullish(),
      seasonNumber: z.int().nonnegative().max(10_000).nullish(),
    })
    .nullish(),
  episodeId: safeIdentifierSchema.nullish(),
  id: safeIdentifierSchema,
  indexer: safeLabelSchema.nullish(),
  movieId: safeIdentifierSchema.nullish(),
  protocol: z.string().trim().min(1).max(32).nullish(),
  quality: qualitySchema,
  seasonNumber: z.int().nonnegative().max(10_000).nullish(),
  seriesId: safeIdentifierSchema.nullish(),
  size: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  status: z.string().trim().min(1).max(64).nullish(),
  title: releaseTitleSchema.nullish(),
  trackedDownloadState: z.string().trim().min(1).max(64).nullish(),
  trackedDownloadStatus: z.string().trim().min(1).max(64).nullish(),
});

const queueResponseSchema = z.object({
  records: z.array(queueRecordSchema).max(ACQUISITION_MAX_EVENTS).nullish(),
  totalRecords: z.int().nonnegative().max(10_000_000),
});

type HistoryRecord = z.infer<typeof historyRecordSchema>;
type QueueRecord = z.infer<typeof queueRecordSchema>;

function optionalLabel(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function qualityName(value: z.infer<typeof qualitySchema>) {
  return optionalLabel(value?.quality?.name);
}

function protocol(value: string | null | undefined): AcquisitionRelease["protocol"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "torrent" || normalized === "usenet") return normalized;
  return "unknown";
}

function emptyRelease(): AcquisitionRelease {
  return {
    downloadClient: null,
    indexer: null,
    protocol: "unknown",
    quality: null,
    sizeBytes: null,
    title: null,
  };
}

function historyKind(record: HistoryRecord): {
  kind: AcquisitionEventKind;
  state: AcquisitionEventState;
  summary: string;
} | null {
  switch (record.eventType) {
    case "grabbed":
      return {
        kind: "grabbed",
        state: "success",
        summary: "Release was sent to the download client.",
      };
    case "downloadFolderImported":
    case "movieFolderImported":
    case "seriesFolderImported":
      return record.data?.isUpgrade === "true"
        ? {
            kind: "upgraded",
            state: "success",
            summary: "A higher-quality release replaced the previous file.",
          }
        : {
            kind: "imported",
            state: "success",
            summary: "Download was imported into the media library.",
          };
    case "downloadFailed":
      return {
        kind: "download_failed",
        state: "failure",
        summary: "The download failed before it could be imported.",
      };
    case "downloadIgnored":
      return {
        kind: "ignored",
        state: "warning",
        summary: "The download was ignored after evaluation.",
      };
    case "episodeFileDeleted":
    case "episodeFileRenamed":
    case "movieFileDeleted":
    case "movieFileRenamed":
    case "unknown":
      return null;
  }
}

function queueKind(record: QueueRecord): {
  kind: AcquisitionEventKind;
  state: AcquisitionEventState;
  summary: string;
} {
  const trackedStatus = record.trackedDownloadStatus?.toLowerCase();
  const trackedState = record.trackedDownloadState?.toLowerCase();
  const status = record.status?.toLowerCase();
  if (
    trackedStatus === "warning" ||
    trackedStatus === "error" ||
    trackedState === "importblocked" ||
    trackedState === "importpending"
  ) {
    return {
      kind: "stalled",
      state: trackedStatus === "error" ? "failure" : "warning",
      summary: "Download needs operator attention before import can continue.",
    };
  }
  if (status === "downloading" || trackedState === "downloading") {
    return {
      kind: "downloading",
      state: "active",
      summary: "Download is moving through the configured client.",
    };
  }
  return {
    kind: "queued",
    state: "active",
    summary: "Release is waiting in the download queue.",
  };
}

function matchesTarget(
  record: {
    episode?: { seasonNumber?: number | null | undefined } | null | undefined;
    movieId?: number | null | undefined;
    seasonNumber?: number | null | undefined;
    seriesId?: number | null | undefined;
  },
  target: AcquisitionTargetInput,
) {
  if (target.service === "radarr") return record.movieId === target.mediaId;
  const seasonNumber = record.episode?.seasonNumber ?? record.seasonNumber ?? null;
  return (
    record.seriesId === target.mediaId &&
    (target.seasonNumber === undefined || seasonNumber === target.seasonNumber)
  );
}

function historyEvent(
  service: "radarr" | "sonarr",
  record: HistoryRecord,
): AcquisitionEvent | null {
  const normalized = historyKind(record);
  if (!normalized) return null;
  return {
    episodeNumbers: record.episode?.episodeNumber ? [record.episode.episodeNumber] : [],
    id: `${service}:history:${record.id}`,
    kind: normalized.kind,
    occurredAt: record.date,
    release: {
      downloadClient: optionalLabel(record.data?.downloadClientName),
      indexer: optionalLabel(record.data?.indexer),
      protocol: protocol(record.data?.protocol),
      quality: qualityName(record.quality),
      sizeBytes: null,
      title: optionalLabel(record.sourceTitle),
    },
    seasonNumber: record.episode?.seasonNumber ?? null,
    state: normalized.state,
    summary: normalized.summary,
  };
}

function queueEvent(
  service: "radarr" | "sonarr",
  record: QueueRecord,
  generatedAt: string,
): AcquisitionEvent {
  const normalized = queueKind(record);
  return {
    episodeNumbers: record.episode?.episodeNumber ? [record.episode.episodeNumber] : [],
    id: `${service}:queue:${record.id}`,
    kind: normalized.kind,
    occurredAt: record.added ?? generatedAt,
    release: {
      ...emptyRelease(),
      downloadClient: optionalLabel(record.downloadClient),
      indexer: optionalLabel(record.indexer),
      protocol: protocol(record.protocol),
      quality: qualityName(record.quality),
      sizeBytes: record.size === undefined || record.size === null ? null : Math.round(record.size),
      title: optionalLabel(record.title),
    },
    seasonNumber: record.episode?.seasonNumber ?? record.seasonNumber ?? null,
    state: normalized.state,
    summary: normalized.summary,
  };
}

export abstract class ServarrAcquisitionAdapter extends ServarrAdapter {
  abstract override readonly service: "radarr" | "sonarr";
  override readonly capabilities: readonly ConnectorCapability[] = [
    "connector.health",
    "connector.version",
    "acquisition.history",
  ];

  async readAcquisitionProvenance(
    input: AcquisitionTargetInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionProvenanceResponse> {
    const target = acquisitionTargetInputSchema.parse(input);
    if (target.service !== this.service) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "The acquisition target does not match the connector service.",
        operation: "acquisition.provenance",
        retryable: false,
        service: this.service,
      });
    }
    const generatedAt = this.clock.now().toISOString();
    const requests = await Promise.allSettled([
      this.client.requestJson("api/v3/history", historyResponseSchema, {
        headers: { "X-Api-Key": this.apiKey },
        operation: "acquisition.history",
        query: this.historyQuery(target),
        ...(signal ? { signal } : {}),
      }),
      this.client.requestJson("api/v3/queue", queueResponseSchema, {
        headers: { "X-Api-Key": this.apiKey },
        operation: "acquisition.queue",
        query: this.queueQuery(target),
        ...(signal ? { signal } : {}),
      }),
    ]);
    const events: AcquisitionEvent[] = [];
    const failures: PartialFailure[] = [];
    const [history, queue] = requests;
    if (history.status === "rejected" && queue.status === "rejected") {
      const safeFailure = [history.reason, queue.reason].find(
        (error): error is SafeConnectorError => error instanceof SafeConnectorError,
      );
      throw (
        safeFailure ??
        new SafeConnectorError({
          code: "upstream_error",
          message: `${this.service} acquisition history is temporarily unavailable.`,
          operation: "acquisition.provenance",
          retryable: true,
          service: this.service,
        })
      );
    }
    if (history.status === "fulfilled") {
      for (const record of history.value.records ?? []) {
        if (!matchesTarget(record, target)) continue;
        const event = historyEvent(this.service, record);
        if (event) events.push(event);
      }
    } else {
      failures.push(this.failure(history.reason, "acquisition.history"));
    }
    if (queue.status === "fulfilled") {
      for (const record of queue.value.records ?? []) {
        if (matchesTarget(record, target)) {
          events.push(queueEvent(this.service, record, generatedAt));
        }
      }
    } else {
      failures.push(this.failure(queue.reason, "acquisition.queue"));
    }
    events.sort((left, right) => {
      const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
    });
    return acquisitionProvenanceResponseSchema.parse({
      events: events.slice(0, ACQUISITION_MAX_EVENTS),
      failures,
      generatedAt,
      state: failures.length === 0 ? "complete" : "degraded",
      target: {
        kind: this.service === "radarr" ? "movie" : "series",
        mediaId: target.mediaId,
        seasonNumber: target.seasonNumber ?? null,
        service: this.service,
      },
    });
  }

  private historyQuery(target: AcquisitionTargetInput) {
    const query = new URLSearchParams({
      page: "1",
      pageSize: String(ACQUISITION_MAX_EVENTS),
      sortDirection: "descending",
      sortKey: "date",
    });
    query.set(target.service === "radarr" ? "movieIds" : "seriesIds", String(target.mediaId));
    return query;
  }

  private queueQuery(target: AcquisitionTargetInput) {
    const query = new URLSearchParams({
      page: "1",
      pageSize: String(ACQUISITION_MAX_EVENTS),
      sortDirection: "descending",
      sortKey: "added",
    });
    query.set(target.service === "radarr" ? "movieIds" : "seriesIds", String(target.mediaId));
    return query;
  }

  private failure(error: unknown, operation: string): PartialFailure {
    const safeError =
      error instanceof SafeConnectorError
        ? error
        : new SafeConnectorError({
            code: "upstream_error",
            message: `${this.service} acquisition data is temporarily unavailable.`,
            operation,
            retryable: false,
            service: this.service,
          });
    return safeError.toPartialFailure(this.clock.now());
  }
}
