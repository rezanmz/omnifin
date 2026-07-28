import type { ConnectorCapability, ConnectorHealth } from "@omnifin/contracts/connectors";
import {
  discoverySearchQuerySchema,
  discoverySearchResponseSchema,
  type DiscoveryAvailability,
  type DiscoverySearchQuery,
  type DiscoverySearchResult,
  type DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import {
  mediaRequestInputSchema,
  mediaRequestResponseSchema,
  requestReviewDecisionInputSchema,
  requestReviewItemSchema,
  requestReviewPageSchema,
  requestReviewQuerySchema,
  type MediaRequestInput,
  type MediaRequestResponse,
  type MediaRequestStatus,
  type RequestReviewDecisionInput,
  type RequestReviewItem,
  type RequestReviewPage,
  type RequestReviewQuery,
} from "@omnifin/contracts/requests";
import { z } from "zod";

import { SafeConnectorError } from "../http/safe-http-client.js";
import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { OptionalApiKeyConnectorConfig } from "../types.js";

const seerrStatusSchema = z.object({
  version: upstreamVersionSchema,
  commitTag: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  commitsBehind: z.number().optional(),
  restartRequired: z.boolean().optional(),
});

const upstreamIdentifierSchema = z.int().positive().max(2_147_483_647);
const upstreamTitleSchema = z.string().trim().min(1).max(300);
const upstreamOptionalTitleSchema = z.string().trim().max(300).nullish();
const upstreamOverviewSchema = z.string().trim().max(2_000).nullish();
const upstreamDateSchema = z.string().trim().max(32).nullish();
const upstreamVoteAverageSchema = z.number().finite().min(0).max(10).nullish();
const upstreamMediaInfoSchema = z.object({ status: z.int().min(1).max(6) }).nullish();

const upstreamMovieResultSchema = z.object({
  id: upstreamIdentifierSchema,
  mediaType: z.literal("movie"),
  mediaInfo: upstreamMediaInfoSchema,
  originalTitle: upstreamOptionalTitleSchema,
  overview: upstreamOverviewSchema,
  releaseDate: upstreamDateSchema,
  title: upstreamTitleSchema,
  voteAverage: upstreamVoteAverageSchema,
});

const upstreamSeriesResultSchema = z.object({
  firstAirDate: upstreamDateSchema,
  id: upstreamIdentifierSchema,
  mediaType: z.literal("tv"),
  mediaInfo: upstreamMediaInfoSchema,
  name: upstreamTitleSchema,
  originalName: upstreamOptionalTitleSchema,
  overview: upstreamOverviewSchema,
  voteAverage: upstreamVoteAverageSchema,
});

const upstreamKnownForSchema = z.discriminatedUnion("mediaType", [
  upstreamMovieResultSchema.omit({ mediaInfo: true }),
  upstreamSeriesResultSchema.omit({ mediaInfo: true }),
]);

const upstreamPersonResultSchema = z.object({
  id: upstreamIdentifierSchema,
  knownFor: z.array(upstreamKnownForSchema).max(20).default([]),
  mediaType: z.literal("person"),
  name: upstreamTitleSchema,
});

const upstreamCollectionResultSchema = z.object({
  id: upstreamIdentifierSchema,
  mediaType: z.literal("collection"),
});

const seerrSearchResponseSchema = z.object({
  page: z.int().min(1).max(500),
  results: z
    .array(
      z.discriminatedUnion("mediaType", [
        upstreamMovieResultSchema,
        upstreamSeriesResultSchema,
        upstreamPersonResultSchema,
        upstreamCollectionResultSchema,
      ]),
    )
    .max(100),
  totalPages: z.int().min(0).max(500),
  totalResults: z.int().nonnegative().max(10_000_000),
});

const seerrUserIdentitySchema = z.strictObject({
  jellyfinUserId: z.string().trim().min(1).max(256),
  jellyfinUsername: z.string().trim().min(1).max(160),
});

const seerrUserListResponseSchema = z.object({
  pageInfo: z.object({
    page: z.int().positive(),
    pageSize: z.int().nonnegative().max(100),
    pages: z.int().nonnegative(),
    results: z.int().nonnegative(),
  }),
  results: z
    .array(
      z.object({
        id: z.int().positive().max(2_147_483_647),
        jellyfinUserId: z.string().trim().min(1).max(256).nullish(),
        jellyfinUsername: z.string().trim().min(1).max(160).nullish(),
      }),
    )
    .max(100),
});

const seerrCreatedRequestSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.int().positive().max(2_147_483_647),
  is4k: z.boolean().default(false),
  media: z.object({ tmdbId: upstreamIdentifierSchema }),
  seasons: z
    .array(z.object({ seasonNumber: z.int().nonnegative().max(10_000) }))
    .max(100)
    .default([]),
  status: z.int().min(1).max(5),
  type: z.enum(["movie", "tv"]),
});

const seerrReviewRequestSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: upstreamIdentifierSchema,
  is4k: z.boolean().default(false),
  media: z.object({
    mediaType: z.enum(["movie", "tv"]),
    tmdbId: upstreamIdentifierSchema,
  }),
  requestedBy: z.object({
    jellyfinUsername: z.string().trim().min(1).max(160).nullish(),
    username: z.string().trim().min(1).max(160).nullish(),
  }),
  seasons: z
    .array(z.object({ seasonNumber: z.int().nonnegative().max(10_000) }))
    .max(100)
    .default([]),
  status: z.int().min(1).max(5),
  updatedAt: z.iso.datetime({ offset: true }),
});

const seerrReviewListSchema = z.object({
  pageInfo: z.object({
    results: z.int().nonnegative().max(10_000_000),
  }),
  results: z.array(seerrReviewRequestSchema).max(50),
});

const seerrMovieDetailsSchema = z.object({
  releaseDate: upstreamDateSchema,
  title: upstreamTitleSchema,
});

const seerrSeriesDetailsSchema = z.object({
  firstAirDate: upstreamDateSchema,
  name: upstreamTitleSchema,
});

type UpstreamKnownFor = z.infer<typeof upstreamKnownForSchema>;
type UpstreamMediaInfo = z.infer<typeof upstreamMediaInfoSchema>;

export interface SeerrUserIdentity {
  jellyfinUserId: string;
  jellyfinUsername: string;
}

export type SeerrRequestErrorReason =
  | "identity_ambiguous"
  | "identity_not_found"
  | "no_seasons_available"
  | "request_conflict"
  | "request_denied"
  | "request_not_found";

export class SeerrRequestError extends Error {
  public readonly reason: SeerrRequestErrorReason;

  public constructor(reason: SeerrRequestErrorReason) {
    super("The Seerr media request could not be completed.");
    this.name = "SeerrRequestError";
    this.reason = reason;
  }
}

function optionalText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function yearFromDate(value: string | null | undefined) {
  const match = /^(\d{4})(?:-\d{2}-\d{2})?$/u.exec(value ?? "");
  const year = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isInteger(year) && year >= 1870 && year <= 2200 ? year : null;
}

function availabilityFromMediaInfo(mediaInfo: UpstreamMediaInfo): DiscoveryAvailability {
  switch (mediaInfo?.status) {
    case 2:
      return "requested";
    case 3:
      return "processing";
    case 4:
      return "partial";
    case 5:
      return "available";
    case 6:
      return "unavailable";
    case 1:
      return "unknown";
    default:
      return "unavailable";
  }
}

function knownForResult(result: UpstreamKnownFor) {
  return {
    kind: result.mediaType === "movie" ? ("movie" as const) : ("series" as const),
    title: result.mediaType === "movie" ? result.title : result.name,
    year: yearFromDate(result.mediaType === "movie" ? result.releaseDate : result.firstAirDate),
  };
}

function requestStatus(status: number, operation = "request.create"): MediaRequestStatus {
  switch (status) {
    case 1:
      return "pending";
    case 2:
      return "approved";
    case 3:
      return "declined";
    case 4:
      return "failed";
    case 5:
      return "completed";
    default:
      throw new SafeConnectorError({
        code: "response_invalid",
        message: "Seerr returned a response that could not be safely interpreted.",
        operation,
        retryable: false,
        service: "seerr",
      });
  }
}

function invalidRequestResponse(operation = "request.create") {
  return new SafeConnectorError({
    code: "response_invalid",
    message: "Seerr returned a response that could not be safely interpreted.",
    operation,
    retryable: false,
    service: "seerr",
  });
}

export class SeerrAdapter extends ProbeOnlyAdapter {
  readonly service = "seerr" as const;
  override readonly capabilities: readonly ConnectorCapability[];
  readonly #apiKey: string | null;

  constructor(config: OptionalApiKeyConnectorConfig) {
    const apiKey = config.apiKey?.trim() || null;
    super(config, apiKey ? [apiKey] : []);
    this.#apiKey = apiKey;
    this.capabilities = apiKey
      ? [
          "connector.health",
          "connector.version",
          "media.discover",
          "request.create",
          "request.review",
          "issue.read",
          "issue.manage",
        ]
      : ["connector.health", "connector.version"];
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const status = await this.client.requestJson("api/v1/status", seerrStatusSchema, {
        operation: "probe",
        ...(this.#apiKey ? { headers: { "X-Api-Key": this.#apiKey } } : {}),
        ...(signal ? { signal } : {}),
      });
      return status.version;
    });
  }

  async search(
    input: DiscoverySearchQuery,
    signal?: AbortSignal,
  ): Promise<DiscoverySearchResponse> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr discovery requires configured credentials.",
        operation: "discovery.search",
        retryable: false,
        service: this.service,
      });
    }
    const query = discoverySearchQuerySchema.parse(input);
    const parameters = new URLSearchParams({
      language: query.language,
      page: String(query.page),
      query: query.query,
    });
    const response = await this.client.requestJson("api/v1/search", seerrSearchResponseSchema, {
      headers: { "X-Api-Key": this.#apiKey },
      operation: "discovery.search",
      query: parameters,
      ...(signal ? { signal } : {}),
    });
    const items: DiscoverySearchResult[] = [];
    for (const result of response.results) {
      switch (result.mediaType) {
        case "movie":
          items.push({
            availability: availabilityFromMediaInfo(result.mediaInfo),
            id: `movie:${result.id}`,
            kind: "movie",
            originalTitle: optionalText(result.originalTitle),
            overview: optionalText(result.overview),
            source: "seerr",
            title: result.title,
            tmdbId: result.id,
            voteAverage: result.voteAverage ?? null,
            year: yearFromDate(result.releaseDate),
          });
          break;
        case "tv":
          items.push({
            availability: availabilityFromMediaInfo(result.mediaInfo),
            id: `series:${result.id}`,
            kind: "series",
            originalTitle: optionalText(result.originalName),
            overview: optionalText(result.overview),
            source: "seerr",
            title: result.name,
            tmdbId: result.id,
            voteAverage: result.voteAverage ?? null,
            year: yearFromDate(result.firstAirDate),
          });
          break;
        case "person":
          items.push({
            id: `person:${result.id}`,
            kind: "person",
            knownFor: result.knownFor.slice(0, 8).map(knownForResult),
            source: "seerr",
            title: result.name,
            tmdbId: result.id,
          });
          break;
        case "collection":
          break;
      }
    }
    return discoverySearchResponseSchema.parse({
      generatedAt: this.clock.now().toISOString(),
      items,
      page: response.page,
      query: query.query,
      totalPages: response.totalPages,
      totalResults: response.totalResults,
    });
  }

  async resolveUser(identity: SeerrUserIdentity, signal?: AbortSignal): Promise<number> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr requests require configured credentials.",
        operation: "request.identity.resolve",
        retryable: false,
        service: this.service,
      });
    }
    const parsedIdentity = seerrUserIdentitySchema.parse(identity);
    const response = await this.client.requestJson("api/v1/user", seerrUserListResponseSchema, {
      headers: { "X-Api-Key": this.#apiKey },
      operation: "request.identity.resolve",
      query: new URLSearchParams({
        q: parsedIdentity.jellyfinUsername,
        skip: "0",
        take: "100",
      }),
      ...(signal ? { signal } : {}),
    });
    const matches = response.results.filter(
      (candidate) => candidate.jellyfinUserId === parsedIdentity.jellyfinUserId,
    );
    if (matches.length === 0) throw new SeerrRequestError("identity_not_found");
    if (matches.length > 1) throw new SeerrRequestError("identity_ambiguous");
    return matches[0]!.id;
  }

  async createMediaRequest(
    input: MediaRequestInput,
    seerrUserId: number,
    signal?: AbortSignal,
  ): Promise<MediaRequestResponse> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr requests require configured credentials.",
        operation: "request.create",
        retryable: false,
        service: this.service,
      });
    }
    if (!Number.isSafeInteger(seerrUserId) || seerrUserId < 1 || seerrUserId > 2_147_483_647) {
      throw new SeerrRequestError("identity_not_found");
    }
    const request = mediaRequestInputSchema.parse(input);
    const response = await this.client.requestText("api/v1/request", {
      acceptedStatuses: [202, 403, 409],
      body: JSON.stringify({
        is4k: request.is4k,
        mediaId: request.tmdbId,
        mediaType: request.kind === "movie" ? "movie" : "tv",
        ...(request.kind === "series" ? { seasons: request.seasons } : {}),
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.#apiKey,
        "X-Api-User": String(seerrUserId),
      },
      method: "POST",
      operation: "request.create",
      ...(signal ? { signal } : {}),
    });
    switch (response.status) {
      case 202:
        throw new SeerrRequestError("no_seasons_available");
      case 403:
        throw new SeerrRequestError("request_denied");
      case 409:
        throw new SeerrRequestError("request_conflict");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.body);
    } catch {
      throw invalidRequestResponse();
    }
    const parsed = seerrCreatedRequestSchema.safeParse(decoded);
    if (!parsed.success) throw invalidRequestResponse();
    const created = parsed.data;
    return mediaRequestResponseSchema.parse({
      createdAt: created.createdAt,
      id: `request:${created.id}`,
      is4k: created.is4k,
      kind: created.type === "movie" ? "movie" : "series",
      seasons:
        created.type === "movie"
          ? null
          : created.seasons.map((season) => season.seasonNumber).sort((a, b) => a - b),
      source: "seerr",
      status: requestStatus(created.status),
      tmdbId: created.media.tmdbId,
    });
  }

  async listMediaRequests(
    input: RequestReviewQuery,
    signal?: AbortSignal,
  ): Promise<RequestReviewPage> {
    this.#requireRequestReview();
    const query = requestReviewQuerySchema.parse(input);
    const skip = query.cursor ? Number(query.cursor.slice("requests:".length)) : 0;
    const parameters = new URLSearchParams({
      filter: query.status,
      mediaType: "all",
      skip: String(skip),
      sort: "added",
      sortDirection: "desc",
      take: String(query.limit),
    });
    const response = await this.client.requestJson("api/v1/request", seerrReviewListSchema, {
      headers: { "X-Api-Key": this.#apiKey! },
      operation: "request.review.list",
      query: parameters,
      ...(signal ? { signal } : {}),
    });
    const items: RequestReviewItem[] = [];
    for (let index = 0; index < response.results.length; index += 5) {
      items.push(
        ...(await Promise.all(
          response.results
            .slice(index, index + 5)
            .map((request) => this.#reviewItem(request, signal)),
        )),
      );
    }
    const nextOffset = skip + response.results.length;
    return requestReviewPageSchema.parse({
      generatedAt: this.clock.now().toISOString(),
      items,
      nextCursor: nextOffset < response.pageInfo.results ? `requests:${nextOffset}` : null,
      status: query.status,
    });
  }

  async reviewMediaRequest(
    requestId: string,
    input: RequestReviewDecisionInput,
    signal?: AbortSignal,
  ): Promise<RequestReviewItem> {
    this.#requireRequestReview();
    const match = /^request:([1-9][0-9]*)$/u.exec(requestId);
    const upstreamId = Number(match?.[1]);
    if (!Number.isSafeInteger(upstreamId) || upstreamId > 2_147_483_647) {
      throw invalidRequestResponse("request.review");
    }
    const decision = requestReviewDecisionInputSchema.parse(input);
    const response = await this.client.requestText(
      `api/v1/request/${upstreamId}/${decision.decision}`,
      {
        acceptedStatuses: [403, 404, 409],
        headers: { "X-Api-Key": this.#apiKey! },
        method: "POST",
        operation: "request.review",
        ...(signal ? { signal } : {}),
      },
    );
    switch (response.status) {
      case 403:
        throw new SeerrRequestError("request_denied");
      case 404:
        throw new SeerrRequestError("request_not_found");
      case 409:
        throw new SeerrRequestError("request_conflict");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.body);
    } catch {
      throw invalidRequestResponse("request.review");
    }
    const parsed = seerrReviewRequestSchema.safeParse(decoded);
    if (!parsed.success) throw invalidRequestResponse("request.review");
    const reviewed = parsed.data;
    const expectedStatus = decision.decision === "approve" ? "approved" : "declined";
    if (requestStatus(reviewed.status, "request.review") !== expectedStatus) {
      throw invalidRequestResponse("request.review");
    }
    return this.#reviewItem(reviewed, signal);
  }

  #requireRequestReview() {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr request review requires configured credentials.",
        operation: "request.review",
        retryable: false,
        service: this.service,
      });
    }
  }

  async #reviewItem(
    request: z.infer<typeof seerrReviewRequestSchema>,
    signal?: AbortSignal,
  ): Promise<RequestReviewItem> {
    const common = {
      createdAt: request.createdAt,
      id: `request:${request.id}`,
      is4k: request.is4k,
      requestedBy:
        optionalText(request.requestedBy.jellyfinUsername) ??
        optionalText(request.requestedBy.username) ??
        "Seerr user",
      seasons:
        request.media.mediaType === "movie"
          ? null
          : request.seasons.map((season) => season.seasonNumber).sort((a, b) => a - b),
      source: "seerr" as const,
      status: requestStatus(request.status, "request.review"),
      tmdbId: request.media.tmdbId,
      updatedAt: request.updatedAt,
    };
    if (request.media.mediaType === "movie") {
      const details = await this.client.requestJson(
        `api/v1/movie/${request.media.tmdbId}`,
        seerrMovieDetailsSchema,
        {
          headers: { "X-Api-Key": this.#apiKey! },
          operation: "request.review.details",
          ...(signal ? { signal } : {}),
        },
      );
      return requestReviewItemSchema.parse({
        ...common,
        kind: "movie",
        title: details.title,
        year: yearFromDate(details.releaseDate),
      });
    }
    const details = await this.client.requestJson(
      `api/v1/tv/${request.media.tmdbId}`,
      seerrSeriesDetailsSchema,
      {
        headers: { "X-Api-Key": this.#apiKey! },
        operation: "request.review.details",
        ...(signal ? { signal } : {}),
      },
    );
    return requestReviewItemSchema.parse({
      ...common,
      kind: "series",
      title: details.name,
      year: yearFromDate(details.firstAirDate),
    });
  }
}
