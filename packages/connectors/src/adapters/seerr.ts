import type { ConnectorCapability, ConnectorHealth } from "@omnifin/contracts/connectors";
import {
  discoverySearchQuerySchema,
  discoverySearchResponseSchema,
  type DiscoveryAvailability,
  type DiscoverySearchQuery,
  type DiscoverySearchResult,
  type DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
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

type UpstreamKnownFor = z.infer<typeof upstreamKnownForSchema>;
type UpstreamMediaInfo = z.infer<typeof upstreamMediaInfoSchema>;

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

export class SeerrAdapter extends ProbeOnlyAdapter {
  readonly service = "seerr" as const;
  override readonly capabilities: readonly ConnectorCapability[];
  readonly #apiKey: string | null;

  constructor(config: OptionalApiKeyConnectorConfig) {
    const apiKey = config.apiKey?.trim() || null;
    super(config, apiKey ? [apiKey] : []);
    this.#apiKey = apiKey;
    this.capabilities = apiKey
      ? ["connector.health", "connector.version", "media.discover"]
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
}
