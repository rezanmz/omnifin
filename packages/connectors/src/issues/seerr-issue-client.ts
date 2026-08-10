import type {
  MediaIssueFilter,
  MediaIssueStatusUpdate,
  PlaybackIssueCategory,
} from "@omnifin/contracts/issues";
import { mediaIssueFilterSchema, mediaIssueStatusUpdateSchema } from "@omnifin/contracts/issues";
import { z } from "zod";

import { SafeConnectorError, SafeHttpClient } from "../http/safe-http-client.js";
import type { OptionalApiKeyConnectorConfig } from "../types.js";

const upstreamIdentifierSchema = z.int().positive().max(2_147_483_647);
const upstreamIssueStatusSchema = z.union([z.literal(1), z.literal(2)]);
const upstreamIssueTypeSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const upstreamUserSchema = z.object({
  displayName: z.string().trim().min(1).max(160).nullish(),
  jellyfinUsername: z.string().trim().min(1).max(160).nullish(),
  plexUsername: z.string().trim().min(1).max(160).nullish(),
  username: z.string().trim().min(1).max(160).nullish(),
});
const upstreamCommentSchema = z.object({
  id: upstreamIdentifierSchema,
  message: z.string().trim().min(1).max(1_000),
});
const upstreamMediaSchema = z.object({
  id: upstreamIdentifierSchema,
  mediaType: z.enum(["movie", "tv"]),
  tmdbId: upstreamIdentifierSchema,
});
const upstreamIssueSchema = z.object({
  comments: z.array(upstreamCommentSchema).max(1_000).default([]),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: upstreamUserSchema,
  id: upstreamIdentifierSchema,
  issueType: upstreamIssueTypeSchema,
  media: upstreamMediaSchema,
  problemEpisode: z.int().nonnegative().max(100_000).default(0),
  problemSeason: z.int().nonnegative().max(100_000).default(0),
  status: upstreamIssueStatusSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});
const upstreamIssuePageSchema = z.object({
  pageInfo: z.object({
    page: z.int().positive(),
    pages: z.int().nonnegative(),
    pageSize: z.int().nonnegative().max(50),
    results: z.int().nonnegative().max(10_000_000),
  }),
  results: z.array(upstreamIssueSchema).max(50),
});
const movieDetailsSchema = z.object({
  releaseDate: z.string().trim().max(32).nullish(),
  title: z.string().trim().min(1).max(300),
});
const seriesDetailsSchema = z.object({
  firstAirDate: z.string().trim().max(32).nullish(),
  name: z.string().trim().min(1).max(300),
});

interface MediaPresentation {
  title: string;
  year: number | null;
}

export interface SeerrIssueRecord {
  category: PlaybackIssueCategory;
  createdAt: string;
  episodeNumber: number | null;
  kind: "episode" | "movie" | "series";
  positionSeconds: null;
  reportedBy: string;
  seasonNumber: number | null;
  status: "open" | "resolved";
  summary: string | null;
  title: string;
  updatedAt: string;
  upstreamId: number;
  year: number | null;
}

export interface SeerrIssuePage {
  items: SeerrIssueRecord[];
  truncated: boolean;
}

export interface SeerrIssueListInput {
  limit: number;
  status: MediaIssueFilter;
}

export type SeerrIssueErrorReason = "issue_conflict" | "issue_not_found";

export class SeerrIssueError extends Error {
  public readonly reason: SeerrIssueErrorReason;

  public constructor(reason: SeerrIssueErrorReason) {
    super("The Seerr issue operation could not be completed.");
    this.name = "SeerrIssueError";
    this.reason = reason;
  }
}

function categoryFromIssueType(value: z.infer<typeof upstreamIssueTypeSchema>) {
  switch (value) {
    case 1:
      return "video_quality" as const;
    case 2:
      return "audio" as const;
    case 3:
      return "subtitles" as const;
    case 4:
      return "other" as const;
  }
}

function statusFromIssue(value: z.infer<typeof upstreamIssueStatusSchema>) {
  return value === 1 ? ("open" as const) : ("resolved" as const);
}

function yearFromDate(value: string | null | undefined) {
  const match = /^(\d{4})(?:-\d{2}-\d{2})?$/u.exec(value ?? "");
  const year = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isInteger(year) && year >= 1870 && year <= 2200 ? year : null;
}

function reporterName(user: z.infer<typeof upstreamUserSchema>) {
  return (
    user.displayName ?? user.username ?? user.jellyfinUsername ?? user.plexUsername ?? "Seerr user"
  );
}

function issueStatusPath(status: MediaIssueStatusUpdate["status"]) {
  return status === "open" ? "open" : "resolved";
}

function assertUpstreamId(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new SeerrIssueError("issue_not_found");
  }
  return value;
}

export class SeerrIssueClient {
  readonly #apiKey: string;
  readonly #client: SafeHttpClient;

  public constructor(config: OptionalApiKeyConnectorConfig) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr issue management requires configured credentials.",
        operation: "issue.configuration",
        retryable: false,
        service: "seerr",
      });
    }
    this.#apiKey = apiKey;
    this.#client = new SafeHttpClient({
      allowInsecureHttp: config.insecureHttpApproved ?? false,
      baseUrl: config.baseUrl,
      ...(config.maxResponseBytes === undefined
        ? { maxResponseBytes: 2_097_152 }
        : { maxResponseBytes: config.maxResponseBytes }),
      ...(config.resolveHost === undefined ? {} : { resolveHost: config.resolveHost }),
      service: "seerr",
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: config.tlsCaCertificatePem }),
      ...(config.tlsPolicy === undefined ? {} : { tlsPolicy: config.tlsPolicy }),
      ...(config.transport === undefined ? {} : { transport: config.transport }),
      ...(config.lane === undefined ? {} : { lane: config.lane }),
    });
  }

  public async listIssues(
    rawInput: SeerrIssueListInput,
    signal?: AbortSignal,
  ): Promise<SeerrIssuePage> {
    const input = z
      .strictObject({
        limit: z.int().min(1).max(50),
        status: mediaIssueFilterSchema,
      })
      .parse(rawInput);
    const response = await this.#client.requestJson("api/v1/issue", upstreamIssuePageSchema, {
      headers: { "X-Api-Key": this.#apiKey },
      operation: "issue.list",
      query: {
        filter: input.status,
        skip: "0",
        sort: "modified",
        take: String(input.limit),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    const presentations = await this.#readPresentations(response.results, signal);
    return {
      items: response.results.map((issue) =>
        this.#normalize(issue, presentations.get(`${issue.media.mediaType}:${issue.media.tmdbId}`)),
      ),
      truncated: response.pageInfo.pages > 1 || response.pageInfo.results > response.results.length,
    };
  }

  public async updateIssueStatus(
    rawUpstreamId: number,
    rawInput: z.input<typeof mediaIssueStatusUpdateSchema>,
    signal?: AbortSignal,
  ): Promise<SeerrIssueRecord> {
    const upstreamId = assertUpstreamId(rawUpstreamId);
    const input = mediaIssueStatusUpdateSchema.parse(rawInput);
    const response = await this.#client.requestText(
      `api/v1/issue/${upstreamId}/${issueStatusPath(input.status)}`,
      {
        acceptedStatuses: [404, 409],
        headers: { "X-Api-Key": this.#apiKey },
        method: "POST",
        operation: "issue.status.update",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.status === 404) throw new SeerrIssueError("issue_not_found");
    if (response.status === 409) throw new SeerrIssueError("issue_conflict");
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.body);
    } catch {
      throw this.#client.invalidResponse("issue.status.update");
    }
    const parsed = upstreamIssueSchema.safeParse(decoded);
    if (!parsed.success) throw this.#client.invalidResponse("issue.status.update");
    const issue = parsed.data;
    if (issue.id !== upstreamId || statusFromIssue(issue.status) !== input.status) {
      throw this.#client.invalidResponse("issue.status.update");
    }
    const presentations = await this.#readPresentations([issue], signal);
    return this.#normalize(
      issue,
      presentations.get(`${issue.media.mediaType}:${issue.media.tmdbId}`),
    );
  }

  public async readIssue(rawUpstreamId: number, signal?: AbortSignal): Promise<SeerrIssueRecord> {
    const upstreamId = assertUpstreamId(rawUpstreamId);
    const response = await this.#client.requestText(`api/v1/issue/${upstreamId}`, {
      acceptedStatuses: [404],
      headers: { "X-Api-Key": this.#apiKey },
      operation: "issue.read.exact",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 404) throw new SeerrIssueError("issue_not_found");
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.body);
    } catch {
      throw this.#client.invalidResponse("issue.read.exact");
    }
    const parsed = upstreamIssueSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.id !== upstreamId) {
      throw this.#client.invalidResponse("issue.read.exact");
    }
    const issue = parsed.data;
    const presentations = await this.#readPresentations([issue], signal);
    return this.#normalize(
      issue,
      presentations.get(`${issue.media.mediaType}:${issue.media.tmdbId}`),
    );
  }

  async #readPresentations(
    issues: readonly z.infer<typeof upstreamIssueSchema>[],
    signal?: AbortSignal,
  ) {
    const uniqueMedia = [
      ...new Map(
        issues.map((issue) => [`${issue.media.mediaType}:${issue.media.tmdbId}`, issue.media]),
      ).values(),
    ];
    const presentations = new Map<string, MediaPresentation>();
    for (let offset = 0; offset < uniqueMedia.length; offset += 4) {
      const batch = uniqueMedia.slice(offset, offset + 4);
      const settled = await Promise.allSettled(
        batch.map(async (media) => {
          const key = `${media.mediaType}:${media.tmdbId}`;
          if (media.mediaType === "movie") {
            const details = await this.#client.requestJson(
              `api/v1/movie/${media.tmdbId}`,
              movieDetailsSchema,
              {
                headers: { "X-Api-Key": this.#apiKey },
                operation: "issue.media.movie",
                query: { language: "en" },
                ...(signal === undefined ? {} : { signal }),
              },
            );
            return [
              key,
              { title: details.title, year: yearFromDate(details.releaseDate) },
            ] as const;
          }
          const details = await this.#client.requestJson(
            `api/v1/tv/${media.tmdbId}`,
            seriesDetailsSchema,
            {
              headers: { "X-Api-Key": this.#apiKey },
              operation: "issue.media.series",
              query: { language: "en" },
              ...(signal === undefined ? {} : { signal }),
            },
          );
          return [key, { title: details.name, year: yearFromDate(details.firstAirDate) }] as const;
        }),
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      for (const result of settled) {
        if (result.status === "fulfilled") presentations.set(...result.value);
      }
    }
    return presentations;
  }

  #normalize(
    issue: z.infer<typeof upstreamIssueSchema>,
    presentation: MediaPresentation | undefined,
  ): SeerrIssueRecord {
    const episodeNumber = issue.problemEpisode > 0 ? issue.problemEpisode : null;
    const isEpisode = issue.media.mediaType === "tv" && episodeNumber !== null;
    return {
      category: categoryFromIssueType(issue.issueType),
      createdAt: issue.createdAt,
      episodeNumber: isEpisode ? episodeNumber : null,
      kind: issue.media.mediaType === "movie" ? "movie" : isEpisode ? "episode" : "series",
      positionSeconds: null,
      reportedBy: reporterName(issue.createdBy),
      seasonNumber: isEpisode ? issue.problemSeason : null,
      status: statusFromIssue(issue.status),
      summary: issue.comments[0]?.message ?? null,
      title:
        presentation?.title ?? (issue.media.mediaType === "movie" ? "Movie issue" : "Series issue"),
      updatedAt: issue.updatedAt,
      upstreamId: issue.id,
      year: presentation?.year ?? null,
    };
  }
}
