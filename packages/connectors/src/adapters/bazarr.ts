import type { ConnectorCapability, ConnectorHealth } from "@omnifin/contracts/connectors";
import {
  SUBTITLE_SEARCH_MAX_RESULTS,
  subtitleMediaTargetSchema,
  type SubtitleMediaTarget,
} from "@omnifin/contracts/subtitles";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { ApiKeyConnectorConfig } from "../types.js";

const upstreamIdentifierSchema = z.int().positive().max(2_147_483_647);
const upstreamTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const upstreamBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false", "True", "False"])])
  .transform((value) => value === true || value === "true" || value === "True");
const upstreamYearSchema = z
  .union([
    z.int().min(1870).max(2200),
    z
      .string()
      .regex(/^\d{4}$/u)
      .transform(Number),
  ])
  .nullable();

const bazarrStatusSchema = z.object({
  data: z.object({
    bazarr_version: upstreamVersionSchema,
  }),
});

const bazarrSearchResultSchema = z
  .object({
    radarrId: upstreamIdentifierSchema.optional(),
    sonarrSeriesId: upstreamIdentifierSchema.optional(),
    title: upstreamTextSchema.max(300),
    year: upstreamYearSchema,
  })
  .refine(
    (result) => (result.radarrId === undefined) !== (result.sonarrSeriesId === undefined),
    "A Bazarr library result must identify exactly one media service.",
  );
const bazarrSearchResponseSchema = z.array(bazarrSearchResultSchema).max(500);

const bazarrEpisodeSchema = z.object({
  episode: z.int().nonnegative().max(100_000),
  season: z.int().nonnegative().max(100_000),
  sonarrEpisodeId: upstreamIdentifierSchema,
  sonarrSeriesId: upstreamIdentifierSchema,
});
const bazarrEpisodeResponseSchema = z.object({
  data: z.array(bazarrEpisodeSchema).max(10_000),
});

const bazarrSubtitleResultSchema = z.object({
  dont_matches: z.array(upstreamTextSchema.max(240)).max(100),
  forced: upstreamBooleanSchema,
  hearing_impaired: upstreamBooleanSchema,
  language: upstreamTextSchema.max(80),
  matches: z.array(upstreamTextSchema.max(240)).max(100),
  original_format: upstreamBooleanSchema,
  provider: upstreamTextSchema.max(80),
  release_info: z.array(upstreamTextSchema).max(100),
  score: z.number().finite().min(0).max(100),
  subtitle: upstreamTextSchema.max(4_096),
  uploader: upstreamTextSchema.max(160).nullish(),
  url: z.string().max(4_096).nullish(),
});
const bazarrSubtitleResponseSchema = z.object({
  data: z.array(bazarrSubtitleResultSchema).max(500),
});
const mutationOperationIdSchema = z
  .string()
  .length(40)
  .regex(/^mutation_dispatch_[A-Za-z0-9_-]{22}$/u);

export type BazarrSubtitleTarget =
  { kind: "movie"; radarrId: number } | { episodeId: number; kind: "episode"; seriesId: number };

export interface BazarrSubtitleCandidate {
  dontMatches: string[];
  forced: boolean;
  hearingImpaired: boolean;
  language: string;
  matches: string[];
  originalFormat: boolean;
  provider: string;
  releaseNames: string[];
  score: number;
  subtitleToken: string;
  uploader: string | null;
}

export interface BazarrSubtitleSearchResult {
  candidates: BazarrSubtitleCandidate[];
  target: BazarrSubtitleTarget;
}

export type BazarrTargetErrorReason = "ambiguous" | "not_found" | "unsupported";

export class BazarrTargetError extends Error {
  public readonly reason: BazarrTargetErrorReason;

  public constructor(reason: BazarrTargetErrorReason) {
    super("Bazarr could not safely match the selected Jellyfin media item.");
    this.name = "BazarrTargetError";
    this.reason = reason;
  }
}

function normalizedTitle(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function exactlyOne<T>(items: readonly T[]): T {
  if (items.length === 0) throw new BazarrTargetError("not_found");
  if (items.length > 1) throw new BazarrTargetError("ambiguous");
  return items[0]!;
}

function containsProtectedValue(value: unknown, protectedValue: string) {
  return protectedValue.length > 0 && JSON.stringify(value).includes(protectedValue);
}

export class BazarrAdapter extends ProbeOnlyAdapter {
  readonly service = "bazarr" as const;
  override readonly capabilities: readonly ConnectorCapability[] = [
    "connector.health",
    "connector.version",
    "subtitle.search",
    "subtitle.download",
  ];
  readonly #apiKey: string;

  constructor(config: ApiKeyConnectorConfig) {
    super(config, [config.apiKey]);
    this.#apiKey = config.apiKey;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const status = await this.client.requestJson("api/system/status", bazarrStatusSchema, {
        operation: "probe",
        headers: this.#headers(),
        ...(signal ? { signal } : {}),
      });
      return status.data.bazarr_version;
    });
  }

  public async searchSubtitles(
    input: SubtitleMediaTarget,
    signal?: AbortSignal,
  ): Promise<BazarrSubtitleSearchResult> {
    const media = subtitleMediaTargetSchema.parse(input);
    const target = await this.#resolveTarget(media, signal);
    const path = target.kind === "movie" ? "api/providers/movies" : "api/providers/episodes";
    const query =
      target.kind === "movie"
        ? new URLSearchParams({ radarrid: String(target.radarrId) })
        : new URLSearchParams({ episodeid: String(target.episodeId) });
    const response = await this.client.requestJson(path, bazarrSubtitleResponseSchema, {
      headers: this.#headers(),
      operation: "subtitle.search",
      query,
      ...(signal ? { signal } : {}),
    });
    if (containsProtectedValue(response, this.#apiKey)) {
      throw this.client.invalidResponse("subtitle.search");
    }

    return {
      candidates: response.data.slice(0, SUBTITLE_SEARCH_MAX_RESULTS).map((candidate) => ({
        dontMatches: candidate.dont_matches.slice(0, 32),
        forced: candidate.forced,
        hearingImpaired: candidate.hearing_impaired,
        language: candidate.language,
        matches: candidate.matches.slice(0, 32),
        originalFormat: candidate.original_format,
        provider: candidate.provider,
        releaseNames: candidate.release_info.slice(0, 20),
        score: candidate.score,
        subtitleToken: candidate.subtitle,
        uploader: candidate.uploader?.trim() || null,
      })),
      target,
    };
  }

  public async downloadSubtitle(
    target: BazarrSubtitleTarget,
    candidate: BazarrSubtitleCandidate,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<void> {
    const validatedTarget = this.#validatedTarget(target);
    const validatedCandidate = this.#validatedCandidate(candidate);
    const normalizedOperationId =
      operationId === undefined ? undefined : mutationOperationIdSchema.parse(operationId);
    const body = new URLSearchParams({
      forced: String(validatedCandidate.forced),
      hi: String(validatedCandidate.hearingImpaired),
      original_format: String(validatedCandidate.originalFormat),
      provider: validatedCandidate.provider,
      subtitle: validatedCandidate.subtitleToken,
    });
    const path =
      validatedTarget.kind === "movie" ? "api/providers/movies" : "api/providers/episodes";
    if (validatedTarget.kind === "movie") {
      body.set("radarrid", String(validatedTarget.radarrId));
    } else {
      body.set("seriesid", String(validatedTarget.seriesId));
      body.set("episodeid", String(validatedTarget.episodeId));
    }
    const response = await this.client.requestText(path, {
      body,
      headers: {
        ...this.#headers(),
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        ...(normalizedOperationId === undefined
          ? {}
          : { "X-Omnifin-Operation-Id": normalizedOperationId }),
      },
      method: "POST",
      operation: "subtitle.download",
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 204) throw this.client.invalidResponse("subtitle.download");
  }

  async #resolveTarget(
    media: SubtitleMediaTarget,
    signal?: AbortSignal,
  ): Promise<BazarrSubtitleTarget> {
    const library = await this.client.requestJson(
      "api/system/searches",
      bazarrSearchResponseSchema,
      {
        headers: this.#headers(),
        operation: "subtitle.target.resolve",
        query: new URLSearchParams({ query: media.title }),
        ...(signal ? { signal } : {}),
      },
    );
    const title = normalizedTitle(media.title);
    if (media.kind === "movie") {
      const movie = exactlyOne(
        library.filter(
          (candidate) =>
            candidate.radarrId !== undefined &&
            normalizedTitle(candidate.title) === title &&
            (media.year === null || candidate.year === media.year),
        ),
      );
      return { kind: "movie", radarrId: movie.radarrId! };
    }

    const series = exactlyOne(
      library.filter(
        (candidate) =>
          candidate.sonarrSeriesId !== undefined && normalizedTitle(candidate.title) === title,
      ),
    );
    const seriesId = series.sonarrSeriesId!;
    const episodes = await this.client.requestJson("api/episodes", bazarrEpisodeResponseSchema, {
      headers: this.#headers(),
      operation: "subtitle.target.resolve",
      query: new URLSearchParams({ "seriesid[]": String(seriesId) }),
      ...(signal ? { signal } : {}),
    });
    const episode = exactlyOne(
      episodes.data.filter(
        (candidate) =>
          candidate.sonarrSeriesId === seriesId &&
          candidate.season === media.seasonNumber &&
          candidate.episode === media.episodeNumber,
      ),
    );
    return { episodeId: episode.sonarrEpisodeId, kind: "episode", seriesId };
  }

  #headers() {
    return { "X-API-KEY": this.#apiKey } as const;
  }

  #validatedTarget(target: BazarrSubtitleTarget): BazarrSubtitleTarget {
    const movie = z.strictObject({ kind: z.literal("movie"), radarrId: upstreamIdentifierSchema });
    const episode = z.strictObject({
      episodeId: upstreamIdentifierSchema,
      kind: z.literal("episode"),
      seriesId: upstreamIdentifierSchema,
    });
    return z.discriminatedUnion("kind", [movie, episode]).parse(target);
  }

  #validatedCandidate(candidate: BazarrSubtitleCandidate): BazarrSubtitleCandidate {
    return z
      .strictObject({
        dontMatches: z.array(upstreamTextSchema.max(240)).max(32),
        forced: z.boolean(),
        hearingImpaired: z.boolean(),
        language: upstreamTextSchema.max(80),
        matches: z.array(upstreamTextSchema.max(240)).max(32),
        originalFormat: z.boolean(),
        provider: upstreamTextSchema.max(80),
        releaseNames: z.array(upstreamTextSchema).max(20),
        score: z.number().finite().min(0).max(100),
        subtitleToken: upstreamTextSchema.max(4_096),
        uploader: upstreamTextSchema.max(160).nullable(),
      })
      .parse(candidate);
  }
}
