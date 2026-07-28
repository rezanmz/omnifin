import {
  ACQUISITION_MAX_EVENTS,
  MANUAL_RELEASE_MAX_RESULTS,
  acquisitionProvenanceResponseSchema,
  acquisitionSearchInputSchema,
  acquisitionSearchResponseSchema,
  acquisitionTargetInputSchema,
  manualReleaseTargetInputSchema,
  type AcquisitionEvent,
  type AcquisitionEventKind,
  type AcquisitionEventState,
  type AcquisitionProvenanceResponse,
  type AcquisitionRelease,
  type AcquisitionSearchInput,
  type AcquisitionSearchResponse,
  type AcquisitionTargetInput,
  type ManualReleaseCandidate,
  type ManualReleaseTarget,
  type ManualReleaseTargetInput,
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
const commandResponseSchema = z.object({ id: safeIdentifierSchema });
const internalReleaseReferenceSchema = z.strictObject({
  guid: z.string().trim().min(1).max(2_048),
  indexerId: safeIdentifierSchema,
});

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

const manualReleaseSchema = z.object({
  ageMinutes: z.number().finite().nonnegative().max(5_256_000),
  approved: z.boolean(),
  customFormats: z
    .array(z.object({ name: safeLabelSchema }))
    .max(64)
    .nullish(),
  customFormatScore: z.number().finite().min(-1_000_000).max(1_000_000).nullish(),
  downloadAllowed: z.boolean(),
  episodeNumbers: z.array(z.int().positive().max(100_000)).max(100).nullish(),
  fullSeason: z.boolean().nullish(),
  guid: internalReleaseReferenceSchema.shape.guid,
  indexer: safeLabelSchema,
  indexerId: internalReleaseReferenceSchema.shape.indexerId,
  languages: z.array(z.object({ name: safeLabelSchema })).max(32).nullish(),
  leechers: z.int().nonnegative().max(MAX_UPSTREAM_IDENTIFIER).nullish(),
  mappedEpisodeNumbers: z.array(z.int().positive().max(100_000)).max(100).nullish(),
  protocol: z.string().trim().min(1).max(32),
  publishDate: dateSchema,
  quality: qualitySchema,
  rejected: z.boolean(),
  rejections: z.array(z.string().trim().min(1).max(1_000)).max(64).nullish(),
  releaseGroup: safeLabelSchema.nullish(),
  seeders: z.int().nonnegative().max(MAX_UPSTREAM_IDENTIFIER).nullish(),
  size: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  temporarilyRejected: z.boolean(),
  title: releaseTitleSchema,
});

const manualReleaseResponseSchema = z.array(manualReleaseSchema).max(1_000);
const manualGrabResponseSchema = z.object({
  guid: internalReleaseReferenceSchema.shape.guid,
  indexerId: internalReleaseReferenceSchema.shape.indexerId,
});

type HistoryRecord = z.infer<typeof historyRecordSchema>;
type QueueRecord = z.infer<typeof queueRecordSchema>;
type ManualReleaseRecord = z.infer<typeof manualReleaseSchema>;

export type ManualReleaseCandidateDetails = Omit<ManualReleaseCandidate, "id">;

export interface ManualReleaseReference {
  guid: string;
  indexerId: number;
}

export interface ManualReleaseSearchResult {
  candidates: {
    details: ManualReleaseCandidateDetails;
    reference: ManualReleaseReference;
  }[];
  generatedAt: string;
  target: ManualReleaseTarget;
}

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

function sanitizeRejectionReason(value: string) {
  const withoutUrls = value.replace(/https?:\/\/\S+/giu, "[redacted URL]");
  const withoutPaths = withoutUrls
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s,;]+/gu, "[redacted path]")
    .replace(/\/(?:[^\s/]+\/){2,}[^\s,;]*/gu, "[redacted path]");
  return withoutPaths.trim().slice(0, 240);
}

function manualTarget(target: ManualReleaseTargetInput): ManualReleaseTarget {
  if (target.service === "radarr") {
    return {
      episodeId: null,
      kind: "movie",
      mediaId: target.mediaId,
      seasonNumber: null,
      service: "radarr",
    };
  }
  if (target.episodeId !== undefined) {
    return {
      episodeId: target.episodeId,
      kind: "episode",
      mediaId: target.mediaId,
      seasonNumber: null,
      service: "sonarr",
    };
  }
  return {
    episodeId: null,
    kind: "season",
    mediaId: target.mediaId,
    seasonNumber: target.seasonNumber ?? null,
    service: "sonarr",
  };
}

function manualReleaseDetails(record: ManualReleaseRecord): ManualReleaseCandidateDetails {
  const decision = record.rejected
    ? ("rejected" as const)
    : record.temporarilyRejected
      ? ("temporarily_rejected" as const)
      : record.approved
        ? ("approved" as const)
        : ("rejected" as const);
  const rejectionReasons =
    decision === "approved"
      ? []
      : [...new Set((record.rejections ?? []).map(sanitizeRejectionReason).filter(Boolean))].slice(
          0,
          32,
        );
  return {
    ageMinutes: Math.round(record.ageMinutes),
    customFormats: [...new Set((record.customFormats ?? []).map(({ name }) => name))].slice(0, 32),
    customFormatScore: Math.round(record.customFormatScore ?? 0),
    decision,
    downloadAllowed: record.downloadAllowed,
    episodeNumbers: [...new Set(record.mappedEpisodeNumbers ?? record.episodeNumbers ?? [])].sort(
      (left, right) => left - right,
    ),
    fullSeason: record.fullSeason ?? false,
    indexer: record.indexer,
    languages: [...new Set((record.languages ?? []).map(({ name }) => name))].slice(0, 16),
    leechers: record.leechers ?? null,
    protocol: protocol(record.protocol),
    publishedAt: record.publishDate,
    quality: qualityName(record.quality) ?? "Unknown quality",
    rejectionReasons,
    releaseGroup: optionalLabel(record.releaseGroup),
    requiresOverride: decision !== "approved",
    seeders: record.seeders ?? null,
    sizeBytes: Math.round(record.size),
    title: record.title,
  };
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
    "acquisition.search",
    "acquisition.grab",
  ];

  async searchManualReleases(
    input: ManualReleaseTargetInput,
    signal?: AbortSignal,
  ): Promise<ManualReleaseSearchResult> {
    const target = manualReleaseTargetInputSchema.parse(input);
    if (target.service !== this.service) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "The manual release target does not match the connector service.",
        operation: "acquisition.release.search",
        retryable: false,
        service: this.service,
      });
    }
    const query = new URLSearchParams();
    if (target.service === "radarr") {
      query.set("movieId", String(target.mediaId));
    } else if (target.episodeId !== undefined) {
      query.set("episodeId", String(target.episodeId));
    } else {
      query.set("seriesId", String(target.mediaId));
      query.set("seasonNumber", String(target.seasonNumber));
    }
    const releases = await this.client.requestJson(
      "api/v3/release",
      manualReleaseResponseSchema,
      {
        headers: { "X-Api-Key": this.apiKey },
        operation: "acquisition.release.search",
        query,
        ...(signal ? { signal } : {}),
      },
    );
    return {
      candidates: releases.slice(0, MANUAL_RELEASE_MAX_RESULTS).map((release) => ({
        details: manualReleaseDetails(release),
        reference: { guid: release.guid, indexerId: release.indexerId },
      })),
      generatedAt: this.clock.now().toISOString(),
      target: manualTarget(target),
    };
  }

  async grabManualRelease(reference: ManualReleaseReference, signal?: AbortSignal): Promise<void> {
    const release = internalReleaseReferenceSchema.parse(reference);
    const response = await this.client.requestJson("api/v3/release", manualGrabResponseSchema, {
      body: JSON.stringify(release),
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      method: "POST",
      operation: "acquisition.release.grab",
      ...(signal ? { signal } : {}),
    });
    if (response.guid !== release.guid || response.indexerId !== release.indexerId) {
      throw new SafeConnectorError({
        code: "response_invalid",
        message: "The acquisition service returned an unexpected release receipt.",
        operation: "acquisition.release.grab",
        retryable: false,
        service: this.service,
      });
    }
  }

  async queueAcquisitionSearch(
    input: AcquisitionSearchInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionSearchResponse> {
    const target = acquisitionSearchInputSchema.parse(input);
    if (target.service !== this.service) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "The acquisition target does not match the connector service.",
        operation: "acquisition.search",
        retryable: false,
        service: this.service,
      });
    }
    const body =
      target.service === "radarr"
        ? { movieIds: [target.mediaId], name: "MoviesSearch" }
        : target.seasonNumber === undefined
          ? { name: "SeriesSearch", seriesId: target.mediaId }
          : {
              name: "SeasonSearch",
              seasonNumber: target.seasonNumber,
              seriesId: target.mediaId,
            };
    const command = await this.client.requestJson("api/v3/command", commandResponseSchema, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      method: "POST",
      operation: "acquisition.search",
      ...(signal ? { signal } : {}),
    });
    return acquisitionSearchResponseSchema.parse({
      acceptedAt: this.clock.now().toISOString(),
      operationId: `${this.service}:command:${command.id}`,
      state: "queued",
      target: {
        kind: this.service === "radarr" ? "movie" : "series",
        mediaId: target.mediaId,
        seasonNumber: target.seasonNumber ?? null,
        service: this.service,
      },
    });
  }

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
