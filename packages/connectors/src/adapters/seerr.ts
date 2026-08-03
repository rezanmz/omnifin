import type {
  ConnectorCapability,
  ConnectorHealth,
  PartialFailure,
} from "@omnifin/contracts/connectors";
import {
  DISCOVERY_BROWSE_MAX_ITEMS_PER_PAGE,
  DISCOVERY_DETAIL_MAX_CAST,
  DISCOVERY_DETAIL_MAX_CREW,
  DISCOVERY_DETAIL_MAX_RATINGS,
  DISCOVERY_DETAIL_MAX_RECOMMENDATIONS,
  DISCOVERY_DETAIL_MAX_TRAILERS,
  DISCOVERY_PERSON_MAX_CREDITS,
  discoveryBrowseQuerySchema,
  discoveryMediaDetailParamsSchema,
  discoveryMediaDetailQuerySchema,
  discoveryMediaDetailResponseSchema,
  discoveryFeedQuerySchema,
  type DiscoveryFeedQuery,
  type DiscoveryFeedRailKind,
  discoveryPersonDetailParamsSchema,
  discoveryPersonDetailQuerySchema,
  discoveryPersonDetailResponseSchema,
  discoverySearchQuerySchema,
  discoverySearchResponseSchema,
  type DiscoveryAvailability,
  type DiscoveryBrowseAvailability,
  type DiscoveryBrowseQuery,
  type DiscoveryMediaDetailParams,
  type DiscoveryMediaDetailQuery,
  type DiscoveryMediaDetailResponse,
  type DiscoveryMediaRecommendation,
  type DiscoveryPersonDetailParams,
  type DiscoveryPersonDetailQuery,
  type DiscoveryPersonDetailResponse,
  type DiscoveryRating,
  type DiscoveryTrailer,
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

import { SafeConnectorError, SafeHttpClient } from "../http/safe-http-client.js";
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
const upstreamArtworkPathSchema = z
  .string()
  .trim()
  .min(6)
  .max(300)
  .regex(/^\/[A-Za-z0-9/_-]+\.(?:jpe?g|png|webp)$/iu)
  .refine((value) => !value.includes("..") && !value.includes("//"))
  .nullish();

const upstreamMovieResultSchema = z.object({
  backdropPath: upstreamArtworkPathSchema,
  id: upstreamIdentifierSchema,
  mediaType: z.literal("movie"),
  mediaInfo: upstreamMediaInfoSchema,
  originalTitle: upstreamOptionalTitleSchema,
  overview: upstreamOverviewSchema,
  posterPath: upstreamArtworkPathSchema,
  releaseDate: upstreamDateSchema,
  title: upstreamTitleSchema,
  voteAverage: upstreamVoteAverageSchema,
});

const upstreamSeriesResultSchema = z.object({
  backdropPath: upstreamArtworkPathSchema,
  firstAirDate: upstreamDateSchema,
  id: upstreamIdentifierSchema,
  mediaType: z.literal("tv"),
  mediaInfo: upstreamMediaInfoSchema,
  name: upstreamTitleSchema,
  originalName: upstreamOptionalTitleSchema,
  overview: upstreamOverviewSchema,
  posterPath: upstreamArtworkPathSchema,
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

const upstreamGenreSchema = z.object({
  id: upstreamIdentifierSchema,
  name: z.string().trim().min(1).max(100),
});

const upstreamCastCreditSchema = z.object({
  character: z.string().trim().max(200).nullish(),
  id: upstreamIdentifierSchema,
  name: z.string().trim().min(1).max(160),
  order: z.int().nonnegative().max(100_000).default(100_000),
  profilePath: upstreamArtworkPathSchema,
});

const upstreamCrewCreditSchema = z.object({
  id: upstreamIdentifierSchema,
  job: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
});

function boundedOptionalArray<T>(schema: z.ZodType<T>, maximum: number) {
  return z.preprocess((value) => {
    if (!Array.isArray(value)) return [];
    return value.slice(0, maximum).flatMap((candidate) => {
      const parsed = schema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
  }, z.array(schema).max(maximum));
}

const upstreamCreditsSchema = z
  .object({
    cast: boundedOptionalArray(upstreamCastCreditSchema, 200),
    crew: boundedOptionalArray(upstreamCrewCreditSchema, 200),
  })
  .default({ cast: [], crew: [] });

const upstreamRelatedVideoSchema = z.object({
  key: z
    .string()
    .trim()
    .min(6)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/u),
  name: upstreamTitleSchema,
  site: z.string().trim().min(1).max(80),
  size: z.int().positive().max(8_640).nullish(),
  type: z.enum([
    "Behind the Scenes",
    "Bloopers",
    "Clip",
    "Featurette",
    "Opening Credits",
    "Teaser",
    "Trailer",
  ]),
});

const upstreamRtRatingSchema = z.object({
  audienceRating: z.string().trim().min(1).max(80).nullish(),
  audienceScore: z.number().finite().min(0).max(100).nullish(),
  criticsRating: z.string().trim().min(1).max(80),
  criticsScore: z.number().finite().min(0).max(100),
});

const upstreamImdbRatingSchema = z.object({
  criticsScore: z.number().finite().min(0).max(10),
  criticsScoreCount: z.int().nonnegative().max(1_000_000_000).nullish(),
});

const upstreamCombinedRatingSchema = z.object({
  imdb: upstreamImdbRatingSchema.optional(),
  rt: upstreamRtRatingSchema.optional(),
});

const upstreamMovieRecommendationSchema = upstreamMovieResultSchema.extend({
  mediaType: z.literal("movie").optional(),
});
const upstreamSeriesRecommendationSchema = upstreamSeriesResultSchema.extend({
  mediaType: z.literal("tv").optional(),
});
const upstreamMovieRecommendationPageSchema = z.object({
  results: boundedOptionalArray(upstreamMovieRecommendationSchema, 100),
});
const upstreamSeriesRecommendationPageSchema = z.object({
  results: boundedOptionalArray(upstreamSeriesRecommendationSchema, 100),
});
const upstreamMovieFeedPageSchema = z.object({
  page: z.int().min(1).max(500),
  results: z.array(upstreamMovieRecommendationSchema).max(100).default([]),
  totalPages: z.int().min(0).max(500),
  totalResults: z.int().nonnegative().max(10_000_000),
});
const upstreamSeriesFeedPageSchema = z.object({
  page: z.int().min(1).max(500),
  results: z.array(upstreamSeriesRecommendationSchema).max(100).default([]),
  totalPages: z.int().min(0).max(500),
  totalResults: z.int().nonnegative().max(10_000_000),
});

const upstreamDetailBase = {
  backdropPath: upstreamArtworkPathSchema,
  credits: upstreamCreditsSchema,
  genres: boundedOptionalArray(upstreamGenreSchema, 100),
  id: upstreamIdentifierSchema,
  mediaInfo: upstreamMediaInfoSchema,
  overview: upstreamOverviewSchema,
  posterPath: upstreamArtworkPathSchema,
  relatedVideos: boundedOptionalArray(upstreamRelatedVideoSchema, 100),
  status: z.string().trim().max(100).nullish(),
  tagline: z.string().trim().max(500).nullish(),
  voteAverage: upstreamVoteAverageSchema,
  voteCount: z.int().nonnegative().max(1_000_000_000).nullish(),
} as const;

const upstreamMovieDetailSchema = z.object({
  ...upstreamDetailBase,
  originalTitle: upstreamOptionalTitleSchema,
  releaseDate: upstreamDateSchema,
  runtime: z.int().nonnegative().max(10_000).nullish(),
  title: upstreamTitleSchema,
});

const upstreamSeasonSummarySchema = z.object({
  airDate: upstreamDateSchema,
  episodeCount: z.int().nonnegative().max(10_000),
  name: upstreamTitleSchema,
  seasonNumber: z.int().nonnegative().max(10_000),
});

const upstreamSeriesDetailSchema = z.object({
  ...upstreamDetailBase,
  episodeRunTime: boundedOptionalArray(z.int().nonnegative().max(10_000), 100),
  firstAirDate: upstreamDateSchema,
  name: upstreamTitleSchema,
  numberOfEpisodes: z.int().nonnegative().max(100_000).default(0),
  numberOfSeasons: z.int().nonnegative().max(10_000).default(0),
  originalName: upstreamOptionalTitleSchema,
  seasons: boundedOptionalArray(upstreamSeasonSummarySchema, 100),
});

const upstreamPersonDetailSchema = z.object({
  biography: upstreamOverviewSchema,
  birthday: upstreamDateSchema,
  deathday: upstreamDateSchema,
  id: upstreamIdentifierSchema,
  knownForDepartment: z.string().trim().max(160).nullish(),
  name: upstreamTitleSchema,
  placeOfBirth: z.string().trim().max(300).nullish(),
  profilePath: upstreamArtworkPathSchema,
});

const upstreamPersonCreditSchema = z.object({
  adult: z.boolean().default(false),
  character: z.string().trim().max(200).nullish(),
  department: z.string().trim().max(160).nullish(),
  firstAirDate: upstreamDateSchema,
  id: upstreamIdentifierSchema,
  job: z.string().trim().max(200).nullish(),
  mediaInfo: upstreamMediaInfoSchema,
  mediaType: z.enum(["movie", "tv"]).nullish(),
  name: upstreamOptionalTitleSchema,
  popularity: z.number().finite().nonnegative().max(1_000_000).default(0),
  releaseDate: upstreamDateSchema,
  title: upstreamOptionalTitleSchema,
  voteAverage: upstreamVoteAverageSchema,
});

const upstreamPersonCreditsSchema = z.object({
  cast: boundedOptionalArray(upstreamPersonCreditSchema, 500),
  crew: boundedOptionalArray(upstreamPersonCreditSchema, 500),
  id: upstreamIdentifierSchema,
});

const seerrUserIdentitySchema = z.strictObject({
  jellyfinUserId: z.string().trim().min(1).max(256),
  jellyfinUsername: z.string().trim().min(1).max(160),
});

const seerrRequestServerSchema = z.object({
  activeDirectory: z.string().trim().min(1).max(1_024),
  activeLanguageProfileId: z.int().positive().max(2_147_483_647).optional(),
  activeProfileId: z.int().positive().max(2_147_483_647),
  id: z.int().nonnegative().max(2_147_483_647),
  is4k: z.boolean(),
  isDefault: z.boolean(),
  name: z.string().trim().min(1).max(160),
});

const seerrRequestServerListSchema = z.array(seerrRequestServerSchema).max(20);
const seerrRequestProfileSchema = z.object({
  id: z.int().positive().max(2_147_483_647),
  name: z.string().trim().min(1).max(160),
});
const seerrRequestRootFolderSchema = z.object({
  freeSpace: z.number().finite().nonnegative().nullish(),
  path: z.string().trim().min(1).max(1_024),
  totalSpace: z.number().finite().nonnegative().nullish(),
});
const seerrRequestServerDetailsSchema = z.object({
  languageProfiles: z.array(seerrRequestProfileSchema).max(100).nullish(),
  profiles: z.array(seerrRequestProfileSchema).min(1).max(100),
  rootFolders: z.array(seerrRequestRootFolderSchema).min(1).max(100),
  server: seerrRequestServerSchema,
});

export interface SeerrRequestRouting {
  languageProfileId?: number;
  profileId: number;
  rootFolder: string;
  serverId: number;
}

const seerrRequestRoutingSchema = z.strictObject({
  languageProfileId: z.int().positive().max(2_147_483_647).optional(),
  profileId: z.int().positive().max(2_147_483_647),
  rootFolder: z.string().trim().min(1).max(1_024),
  serverId: z.int().nonnegative().max(2_147_483_647),
});

export interface SeerrRequestRoutingCatalog {
  destinations: Array<{
    activeDirectory: string;
    activeLanguageProfileId: number | null;
    activeProfileId: number;
    id: number;
    isDefault: boolean;
    label: string;
    languageProfiles: Array<{ id: number; label: string }>;
    profiles: Array<{ id: number; label: string }>;
    rootFolders: Array<{
      availableBytes: number | null;
      capacityBytes: number | null;
      path: string;
    }>;
  }>;
  failures: PartialFailure[];
  is4k: boolean;
  kind: "movie" | "series";
}

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
type UpstreamCredits = z.infer<typeof upstreamCreditsSchema>;
type UpstreamMovieDetail = z.infer<typeof upstreamMovieDetailSchema>;
type UpstreamDetailBase = Pick<
  UpstreamMovieDetail,
  | "credits"
  | "genres"
  | "id"
  | "mediaInfo"
  | "overview"
  | "relatedVideos"
  | "status"
  | "tagline"
  | "voteAverage"
  | "voteCount"
>;

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

const FEATURED_CREW_ROLES = new Set([
  "Creator",
  "Director",
  "Director of Photography",
  "Executive Producer",
  "Original Music Composer",
  "Producer",
  "Screenplay",
  "Writer",
]);

function normalizedGenres(genres: readonly z.infer<typeof upstreamGenreSchema>[]) {
  return [...new Set(genres.map((genre) => genre.name))].slice(0, 20);
}

function normalizedCast(credits: UpstreamCredits) {
  const seen = new Set<string>();
  return [...credits.cast]
    .sort((left, right) => left.order - right.order)
    .flatMap((credit) => {
      const character = optionalText(credit.character);
      const key = `${credit.id}\0${character ?? ""}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ character, name: credit.name, personId: credit.id, profilePath: null }];
    })
    .slice(0, DISCOVERY_DETAIL_MAX_CAST);
}

function normalizedCrew(credits: UpstreamCredits) {
  const seen = new Set<string>();
  return credits.crew
    .flatMap((credit) => {
      if (!FEATURED_CREW_ROLES.has(credit.job)) return [];
      const key = `${credit.id}\0${credit.job}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ name: credit.name, personId: credit.id, role: credit.job }];
    })
    .slice(0, DISCOVERY_DETAIL_MAX_CREW);
}

const TRAILER_TYPE: Record<
  z.infer<typeof upstreamRelatedVideoSchema>["type"],
  DiscoveryTrailer["type"] | null
> = {
  "Behind the Scenes": "behind_the_scenes",
  Bloopers: null,
  Clip: "clip",
  Featurette: "featurette",
  "Opening Credits": null,
  Teaser: "teaser",
  Trailer: "trailer",
};

function normalizedTrailers(videos: readonly z.infer<typeof upstreamRelatedVideoSchema>[]) {
  const seen = new Set<string>();
  return videos
    .flatMap((video): DiscoveryTrailer[] => {
      const type = TRAILER_TYPE[video.type];
      if (video.site !== "YouTube" || !type || seen.has(video.key)) return [];
      seen.add(video.key);
      return [
        {
          id: `youtube:${video.key}`,
          provider: "youtube",
          resolution: video.size ?? null,
          title: video.name,
          type,
        },
      ];
    })
    .sort((left, right) => {
      const priority = { trailer: 0, teaser: 1, featurette: 2, clip: 3, behind_the_scenes: 4 };
      return priority[left.type] - priority[right.type];
    })
    .slice(0, DISCOVERY_DETAIL_MAX_TRAILERS);
}

function tmdbRating(
  value: number | null | undefined,
  voteCount: number | null | undefined,
): DiscoveryRating[] {
  if (value === null || value === undefined) return [];
  return [
    {
      audience: "community",
      label: "TMDB",
      scale: 10,
      sentiment: null,
      source: "tmdb",
      value,
      voteCount: voteCount ?? null,
    } satisfies DiscoveryRating,
  ];
}

function normalizedMovieRatings(
  detail: UpstreamMovieDetail,
  response: z.infer<typeof upstreamCombinedRatingSchema> | null,
) {
  const ratings = tmdbRating(detail.voteAverage, detail.voteCount);
  if (response?.imdb) {
    ratings.push({
      audience: "community",
      label: "IMDb",
      scale: 10,
      sentiment: null,
      source: "imdb",
      value: response.imdb.criticsScore,
      voteCount: response.imdb.criticsScoreCount ?? null,
    });
  }
  if (response?.rt) {
    ratings.push({
      audience: "critics",
      label: "Tomatometer",
      scale: 100,
      sentiment: response.rt.criticsRating,
      source: "rotten_tomatoes",
      value: response.rt.criticsScore,
      voteCount: null,
    });
    if (response.rt.audienceScore !== null && response.rt.audienceScore !== undefined) {
      ratings.push({
        audience: "audience",
        label: "RT audience",
        scale: 100,
        sentiment: optionalText(response.rt.audienceRating),
        source: "rotten_tomatoes",
        value: response.rt.audienceScore,
        voteCount: null,
      });
    }
  }
  return ratings.slice(0, DISCOVERY_DETAIL_MAX_RATINGS);
}

function normalizedSeriesRatings(
  value: number | null | undefined,
  voteCount: number | null | undefined,
  response: z.infer<typeof upstreamRtRatingSchema> | null,
) {
  const ratings = tmdbRating(value, voteCount);
  if (response) {
    ratings.push({
      audience: "critics",
      label: "Tomatometer",
      scale: 100,
      sentiment: response.criticsRating,
      source: "rotten_tomatoes",
      value: response.criticsScore,
      voteCount: null,
    });
    if (response.audienceScore !== null && response.audienceScore !== undefined) {
      ratings.push({
        audience: "audience",
        label: "RT audience",
        scale: 100,
        sentiment: optionalText(response.audienceRating),
        source: "rotten_tomatoes",
        value: response.audienceScore,
        voteCount: null,
      });
    }
  }
  return ratings.slice(0, DISCOVERY_DETAIL_MAX_RATINGS);
}

function normalizedMovieRecommendation(
  result: z.infer<typeof upstreamMovieRecommendationSchema>,
): DiscoveryMediaRecommendation {
  return {
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
  };
}

function normalizedSeriesRecommendation(
  result: z.infer<typeof upstreamSeriesRecommendationSchema>,
): DiscoveryMediaRecommendation {
  return {
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
  };
}

export interface SeerrDiscoveryFeedItem {
  artwork: {
    backdropPath: string | null;
    posterPath: string | null;
  };
  media: DiscoveryMediaRecommendation;
}

export interface SeerrDiscoveryFeedPage {
  items: SeerrDiscoveryFeedItem[];
  totalResults: number;
}

export interface SeerrDiscoveryBrowsePage extends SeerrDiscoveryFeedPage {
  page: number;
  totalPages: number;
}

export interface SeerrDiscoveryArtwork {
  body: Uint8Array;
  contentType: "image/avif" | "image/jpeg" | "image/png" | "image/webp";
}

export interface SeerrDiscoveryMediaDetail {
  artwork: {
    backdropPath: string | null;
    castProfilePaths: Array<string | null>;
    posterPath: string | null;
  };
  response: DiscoveryMediaDetailResponse;
}

export interface SeerrDiscoveryPersonDetail {
  profilePath: string | null;
  response: DiscoveryPersonDetailResponse;
}

function feedMovie(
  result: z.infer<typeof upstreamMovieRecommendationSchema>,
): SeerrDiscoveryFeedItem {
  return {
    artwork: {
      backdropPath: result.backdropPath ?? null,
      posterPath: result.posterPath ?? null,
    },
    media: normalizedMovieRecommendation(result),
  };
}

function feedSeries(
  result: z.infer<typeof upstreamSeriesRecommendationSchema>,
): SeerrDiscoveryFeedItem {
  return {
    artwork: {
      backdropPath: result.backdropPath ?? null,
      posterPath: result.posterPath ?? null,
    },
    media: normalizedSeriesRecommendation(result),
  };
}

function boundedFeedItems(items: readonly SeerrDiscoveryFeedItem[]) {
  const seen = new Set<string>();
  return items.filter(({ media }) => {
    if (seen.has(media.id)) return false;
    seen.add(media.id);
    return true;
  });
}

const MOVIE_GENRE_IDS = Object.freeze({
  action: 28,
  adventure: 12,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10_751,
  fantasy: 14,
  history: 36,
  horror: 27,
  music: 10_402,
  mystery: 9_648,
  romance: 10_749,
  "science-fiction": 878,
  thriller: 53,
  war: 10_752,
  western: 37,
} as const);
const SERIES_GENRE_IDS = Object.freeze({
  "action-adventure": 10_759,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10_751,
  kids: 10_762,
  mystery: 9_648,
  news: 10_763,
  reality: 10_764,
  "sci-fi-fantasy": 10_765,
  soap: 10_766,
  talk: 10_767,
  "war-politics": 10_768,
  western: 37,
} as const);
const BROWSE_SORTS = Object.freeze({
  movie: {
    newest: "primary_release_date.desc",
    popularity: "popularity.desc",
    rating: "vote_average.desc",
    title: "original_title.asc",
  },
  series: {
    newest: "first_air_date.desc",
    popularity: "popularity.desc",
    rating: "vote_average.desc",
    title: "original_name.asc",
  },
} as const);

function matchesBrowseAvailability(
  availability: DiscoveryAvailability,
  filter: DiscoveryBrowseAvailability,
) {
  if (filter === "any") return true;
  if (filter === "requestable") return availability === "unavailable";
  return availability === filter;
}

function browseYear(item: SeerrDiscoveryFeedItem) {
  return item.media.year ?? 0;
}

function locallyFilteredBrowseItems(
  items: readonly SeerrDiscoveryFeedItem[],
  criteria: DiscoveryBrowseQuery,
) {
  const filtered = boundedFeedItems(items).filter(({ media }) => {
    const year = media.year;
    return (
      matchesBrowseAvailability(media.availability, criteria.availability) &&
      (criteria.minimumRating === undefined ||
        (media.voteAverage ?? -1) >= criteria.minimumRating) &&
      (criteria.yearFrom === undefined || (year !== null && year >= criteria.yearFrom)) &&
      (criteria.yearTo === undefined || (year !== null && year <= criteria.yearTo))
    );
  });
  if (criteria.query === undefined) return filtered.slice(0, DISCOVERY_BROWSE_MAX_ITEMS_PER_PAGE);
  const sorted = [...filtered];
  if (criteria.sort === "rating") {
    sorted.sort(
      (left, right) =>
        (right.media.voteAverage ?? -1) - (left.media.voteAverage ?? -1) ||
        left.media.title.localeCompare(right.media.title),
    );
  } else if (criteria.sort === "newest") {
    sorted.sort(
      (left, right) =>
        browseYear(right) - browseYear(left) || left.media.title.localeCompare(right.media.title),
    );
  } else if (criteria.sort === "title") {
    sorted.sort((left, right) => left.media.title.localeCompare(right.media.title));
  }
  return sorted.slice(0, DISCOVERY_BROWSE_MAX_ITEMS_PER_PAGE);
}

function artworkContentType(value: string | null) {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg" as const;
  if (
    normalized === "image/avif" ||
    normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/webp"
  ) {
    return normalized;
  }
  return null;
}

async function optionalIntelligence<T>(promise: Promise<T>) {
  try {
    return { state: "ready" as const, value: await promise };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof SafeConnectorError && error.status === 404) {
      return { state: "empty" as const, value: null };
    }
    return { state: "unavailable" as const, value: null };
  }
}

function intelligenceState<T>(state: "empty" | "ready" | "unavailable", values: readonly T[]) {
  return state === "ready" && values.length === 0 ? "empty" : state;
}

function normalizedDate(value: string | null | undefined) {
  const normalized = optionalText(value);
  return normalized && z.iso.date().safeParse(normalized).success ? normalized : null;
}

function normalizedPersonCredits(response: z.infer<typeof upstreamPersonCreditsSchema>) {
  const seen = new Set<string>();
  return [...response.cast, ...response.crew]
    .filter((credit) => !credit.adult && credit.mediaType)
    .sort((left, right) => right.popularity - left.popularity)
    .flatMap((credit) => {
      const kind = credit.mediaType === "movie" ? ("movie" as const) : ("series" as const);
      const title = optionalText(credit.mediaType === "movie" ? credit.title : credit.name);
      const role =
        optionalText(credit.character) ??
        optionalText(credit.job) ??
        optionalText(credit.department);
      if (!title || !role || role === "Thanks") return [];
      const key = `${kind}\0${credit.id}\0${role}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          availability: availabilityFromMediaInfo(credit.mediaInfo),
          kind,
          role,
          title,
          tmdbId: credit.id,
          voteAverage: credit.voteAverage ?? null,
          year: yearFromDate(
            credit.mediaType === "movie" ? credit.releaseDate : credit.firstAirDate,
          ),
        },
      ];
    })
    .slice(0, DISCOVERY_PERSON_MAX_CREDITS);
}

function runtimeMinutes(values: readonly number[]) {
  return values.find((value) => value > 0) ?? null;
}

function invalidDetailResponse() {
  return new SafeConnectorError({
    code: "response_invalid",
    message: "Seerr returned a response that could not be safely interpreted.",
    operation: "discovery.detail",
    retryable: false,
    service: "seerr",
  });
}

function normalizedDetailBase(
  response: UpstreamDetailBase,
  originalTitle: string | null | undefined,
) {
  return {
    artwork: { backdropPath: null, posterPath: null },
    availability: availabilityFromMediaInfo(response.mediaInfo),
    cast: normalizedCast(response.credits),
    crew: normalizedCrew(response.credits),
    genres: normalizedGenres(response.genres),
    originalTitle: optionalText(originalTitle),
    overview: optionalText(response.overview),
    productionStatus: optionalText(response.status),
    source: "seerr" as const,
    tagline: optionalText(response.tagline),
    tmdbId: response.id,
    voteAverage: response.voteAverage ?? null,
    voteCount: response.voteCount ?? null,
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
  #artworkClientInstance: SafeHttpClient | undefined;

  constructor(config: OptionalApiKeyConnectorConfig) {
    const apiKey = config.apiKey?.trim() || null;
    super(config, apiKey ? [apiKey] : []);
    this.#apiKey = apiKey;
    this.capabilities = apiKey
      ? [
          "connector.health",
          "connector.version",
          "media.detail",
          "media.discover",
          "request.configure",
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

  async discover(
    kind: DiscoveryFeedRailKind,
    input: DiscoveryFeedQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryFeedPage> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr discovery requires configured credentials.",
        operation: `discovery.feed.${kind}`,
        retryable: false,
        service: this.service,
      });
    }
    const query = discoveryFeedQuerySchema.parse(input);
    const operation = `discovery.feed.${kind}`;
    const options = {
      headers: { "X-Api-Key": this.#apiKey },
      operation,
      ...(signal ? { signal } : {}),
    } as const;

    if (kind === "trending") {
      const response = await this.client.requestJson(
        "api/v1/discover/trending",
        seerrSearchResponseSchema,
        {
          ...options,
          query: new URLSearchParams({
            language: query.language,
            mediaType: "all",
            page: "1",
            timeWindow: "day",
          }),
        },
      );
      return {
        items: boundedFeedItems(
          response.results.flatMap((result) => {
            if (result.mediaType === "movie") return [feedMovie(result)];
            if (result.mediaType === "tv") return [feedSeries(result)];
            return [];
          }),
        ),
        totalResults: response.totalResults,
      };
    }

    if (kind === "popular_movies") {
      const response = await this.client.requestJson(
        "api/v1/discover/movies",
        upstreamMovieFeedPageSchema,
        {
          ...options,
          headers: { ...options.headers, "Accept-Language": query.language },
          query: new URLSearchParams({
            page: "1",
            sortBy: "popularity.desc",
          }),
        },
      );
      return {
        items: boundedFeedItems(response.results.map(feedMovie)),
        totalResults: response.totalResults,
      };
    }

    if (kind === "popular_series") {
      const response = await this.client.requestJson(
        "api/v1/discover/tv",
        upstreamSeriesFeedPageSchema,
        {
          ...options,
          headers: { ...options.headers, "Accept-Language": query.language },
          query: new URLSearchParams({
            page: "1",
            sortBy: "popularity.desc",
          }),
        },
      );
      return {
        items: boundedFeedItems(response.results.map(feedSeries)),
        totalResults: response.totalResults,
      };
    }

    const parameters = new URLSearchParams({ language: query.language, page: "1" });
    const [movies, series] = await Promise.all([
      this.client.requestJson("api/v1/discover/movies/upcoming", upstreamMovieFeedPageSchema, {
        ...options,
        query: parameters,
      }),
      this.client.requestJson("api/v1/discover/tv/upcoming", upstreamSeriesFeedPageSchema, {
        ...options,
        query: parameters,
      }),
    ]);
    const interleaved = Array.from(
      { length: Math.max(movies.results.length, series.results.length) },
      (_, index) => [movies.results[index], series.results[index]] as const,
    ).flatMap(([movie, show]) => [
      ...(movie === undefined ? [] : [feedMovie(movie)]),
      ...(show === undefined ? [] : [feedSeries(show)]),
    ]);
    return {
      items: boundedFeedItems(interleaved),
      totalResults: Math.min(10_000_000, movies.totalResults + series.totalResults),
    };
  }

  async browse(
    input: DiscoveryBrowseQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryBrowsePage> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr discovery requires configured credentials.",
        operation: "discovery.browse",
        retryable: false,
        service: this.service,
      });
    }
    const criteria = discoveryBrowseQuerySchema.parse(input);
    const options = {
      headers: { "Accept-Language": criteria.locale, "X-Api-Key": this.#apiKey },
      operation: "discovery.browse",
      ...(signal ? { signal } : {}),
    } as const;

    if (criteria.query !== undefined) {
      const response = await this.client.requestJson("api/v1/search", seerrSearchResponseSchema, {
        ...options,
        query: new URLSearchParams({
          language: criteria.locale,
          page: String(criteria.page),
          query: criteria.query,
        }),
      });
      const items = response.results.flatMap((result) => {
        if (criteria.kind === "movie" && result.mediaType === "movie") {
          return [feedMovie(result)];
        }
        if (criteria.kind === "series" && result.mediaType === "tv") {
          return [feedSeries(result)];
        }
        return [];
      });
      return {
        items: locallyFilteredBrowseItems(items, criteria),
        page: response.page,
        totalPages: response.totalPages,
        totalResults: response.totalResults,
      };
    }

    const parameters = new URLSearchParams({
      page: String(criteria.page),
      sortBy: BROWSE_SORTS[criteria.kind][criteria.sort],
    });
    if (criteria.genre !== undefined) {
      const genreId =
        criteria.kind === "movie"
          ? MOVIE_GENRE_IDS[criteria.genre as keyof typeof MOVIE_GENRE_IDS]
          : SERIES_GENRE_IDS[criteria.genre as keyof typeof SERIES_GENRE_IDS];
      parameters.set("genre", String(genreId));
    }
    if (criteria.minimumRating !== undefined) {
      parameters.set("voteAverageGte", String(criteria.minimumRating));
    }
    if (criteria.minimumVotes !== undefined) {
      parameters.set("voteCountGte", String(criteria.minimumVotes));
    }
    if (criteria.originalLanguage !== undefined) {
      parameters.set("language", criteria.originalLanguage);
    }
    if (criteria.runtimeMax !== undefined) {
      parameters.set("withRuntimeLte", String(criteria.runtimeMax));
    }
    if (criteria.yearFrom !== undefined) {
      parameters.set(
        criteria.kind === "movie" ? "primaryReleaseDateGte" : "firstAirDateGte",
        `${criteria.yearFrom}-01-01`,
      );
    }
    if (criteria.yearTo !== undefined) {
      parameters.set(
        criteria.kind === "movie" ? "primaryReleaseDateLte" : "firstAirDateLte",
        `${criteria.yearTo}-12-31`,
      );
    }
    if (criteria.kind === "movie") {
      const response = await this.client.requestJson(
        "api/v1/discover/movies",
        upstreamMovieFeedPageSchema,
        { ...options, query: parameters },
      );
      return {
        items: locallyFilteredBrowseItems(response.results.map(feedMovie), criteria),
        page: response.page,
        totalPages: response.totalPages,
        totalResults: response.totalResults,
      };
    }
    const response = await this.client.requestJson(
      "api/v1/discover/tv",
      upstreamSeriesFeedPageSchema,
      { ...options, query: parameters },
    );
    return {
      items: locallyFilteredBrowseItems(response.results.map(feedSeries), criteria),
      page: response.page,
      totalPages: response.totalPages,
      totalResults: response.totalResults,
    };
  }

  async readDiscoveryArtwork(
    pathInput: string,
    kind: "backdrop" | "poster" | "profile",
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryArtwork> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr artwork requires configured credentials.",
        operation: "discovery.artwork",
        retryable: false,
        service: this.service,
      });
    }
    const path = upstreamArtworkPathSchema.parse(pathInput);
    if (!path) throw this.#artworkClient().invalidResponse("discovery.artwork");
    const size =
      kind === "backdrop"
        ? "w1920_and_h800_multi_faces"
        : kind === "poster"
          ? "w600_and_h900_bestv2"
          : "w300_and_h450_bestv2";
    const response = await this.#artworkClient().requestBytes(
      `imageproxy/tmdb/t/p/${size}${path}`,
      {
        headers: {
          "X-Api-Key": this.#apiKey,
          accept: "image/avif,image/webp,image/jpeg,image/png",
        },
        operation: "discovery.artwork",
        ...(signal ? { signal } : {}),
      },
    );
    const contentType = artworkContentType(response.headers.get("content-type"));
    if (contentType === null || response.body.byteLength === 0) {
      throw this.#artworkClient().invalidResponse("discovery.artwork");
    }
    return Object.freeze({ body: response.body, contentType });
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

  async detail(
    paramsInput: DiscoveryMediaDetailParams,
    queryInput: DiscoveryMediaDetailQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryMediaDetail> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr media details require configured credentials.",
        operation: "discovery.detail",
        retryable: false,
        service: this.service,
      });
    }
    const params = discoveryMediaDetailParamsSchema.parse(paramsInput);
    const query = discoveryMediaDetailQuerySchema.parse(queryInput);
    const options = {
      headers: { "X-Api-Key": this.#apiKey },
      operation: "discovery.detail",
      query: new URLSearchParams({ language: query.language }),
      ...(signal ? { signal } : {}),
    } as const;
    if (params.kind === "movie") {
      const responsePromise = this.client.requestJson(
        `api/v1/movie/${params.tmdbId}`,
        upstreamMovieDetailSchema,
        options,
      );
      const ratingsPromise = optionalIntelligence(
        this.client.requestJson(
          `api/v1/movie/${params.tmdbId}/ratingscombined`,
          upstreamCombinedRatingSchema,
          {
            headers: options.headers,
            operation: "discovery.detail.ratings",
            ...(signal ? { signal } : {}),
          },
        ),
      );
      const recommendationsPromise = optionalIntelligence(
        this.client.requestJson(
          `api/v1/movie/${params.tmdbId}/recommendations`,
          upstreamMovieRecommendationPageSchema,
          {
            headers: options.headers,
            operation: "discovery.detail.recommendations",
            query: new URLSearchParams({ language: query.language, page: "1" }),
            ...(signal ? { signal } : {}),
          },
        ),
      );
      const response = await responsePromise;
      if (response.id !== params.tmdbId) throw invalidDetailResponse();
      const [ratingResult, recommendationResult] = await Promise.all([
        ratingsPromise,
        recommendationsPromise,
      ]);
      const ratings = normalizedMovieRatings(response, ratingResult.value);
      const recommendations = (recommendationResult.value?.results ?? [])
        .map(normalizedMovieRecommendation)
        .slice(0, DISCOVERY_DETAIL_MAX_RECOMMENDATIONS);
      const normalized = discoveryMediaDetailResponseSchema.parse({
        generatedAt: this.clock.now().toISOString(),
        item: {
          ...normalizedDetailBase(response, response.originalTitle),
          id: `movie:${response.id}`,
          intelligence: {
            ratings,
            ratingsState: intelligenceState(ratingResult.state, ratings),
            recommendations,
            recommendationsState: intelligenceState(recommendationResult.state, recommendations),
            trailers: normalizedTrailers(response.relatedVideos),
          },
          kind: "movie",
          runtimeMinutes: response.runtime && response.runtime > 0 ? response.runtime : null,
          title: response.title,
          year: yearFromDate(response.releaseDate),
        },
      });
      return {
        artwork: {
          backdropPath: response.backdropPath ?? null,
          castProfilePaths: normalized.item.cast.map(
            ({ personId }) =>
              response.credits.cast.find((credit) => credit.id === personId)?.profilePath ?? null,
          ),
          posterPath: response.posterPath ?? null,
        },
        response: normalized,
      };
    }

    const responsePromise = this.client.requestJson(
      `api/v1/tv/${params.tmdbId}`,
      upstreamSeriesDetailSchema,
      options,
    );
    const ratingsPromise = optionalIntelligence(
      this.client.requestJson(`api/v1/tv/${params.tmdbId}/ratings`, upstreamRtRatingSchema, {
        headers: options.headers,
        operation: "discovery.detail.ratings",
        ...(signal ? { signal } : {}),
      }),
    );
    const recommendationsPromise = optionalIntelligence(
      this.client.requestJson(
        `api/v1/tv/${params.tmdbId}/recommendations`,
        upstreamSeriesRecommendationPageSchema,
        {
          headers: options.headers,
          operation: "discovery.detail.recommendations",
          query: new URLSearchParams({ language: query.language, page: "1" }),
          ...(signal ? { signal } : {}),
        },
      ),
    );
    const response = await responsePromise;
    if (response.id !== params.tmdbId) throw invalidDetailResponse();
    const [ratingResult, recommendationResult] = await Promise.all([
      ratingsPromise,
      recommendationsPromise,
    ]);
    const ratings = normalizedSeriesRatings(
      response.voteAverage,
      response.voteCount,
      ratingResult.value,
    );
    const recommendations = (recommendationResult.value?.results ?? [])
      .map(normalizedSeriesRecommendation)
      .slice(0, DISCOVERY_DETAIL_MAX_RECOMMENDATIONS);
    const normalized = discoveryMediaDetailResponseSchema.parse({
      generatedAt: this.clock.now().toISOString(),
      item: {
        ...normalizedDetailBase(response, response.originalName),
        episodeCount: response.numberOfEpisodes,
        id: `series:${response.id}`,
        intelligence: {
          ratings,
          ratingsState: intelligenceState(ratingResult.state, ratings),
          recommendations,
          recommendationsState: intelligenceState(recommendationResult.state, recommendations),
          trailers: normalizedTrailers(response.relatedVideos),
        },
        kind: "series",
        runtimeMinutes: runtimeMinutes(response.episodeRunTime),
        seasonCount: response.numberOfSeasons,
        seasons: response.seasons.map((season) => ({
          episodeCount: season.episodeCount,
          number: season.seasonNumber,
          title: season.name,
          year: yearFromDate(season.airDate),
        })),
        title: response.name,
        year: yearFromDate(response.firstAirDate),
      },
    });
    return {
      artwork: {
        backdropPath: response.backdropPath ?? null,
        castProfilePaths: normalized.item.cast.map(
          ({ personId }) =>
            response.credits.cast.find((credit) => credit.id === personId)?.profilePath ?? null,
        ),
        posterPath: response.posterPath ?? null,
      },
      response: normalized,
    };
  }

  async personDetail(
    paramsInput: DiscoveryPersonDetailParams,
    queryInput: DiscoveryPersonDetailQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryPersonDetail> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr person details require configured credentials.",
        operation: "discovery.person.detail",
        retryable: false,
        service: this.service,
      });
    }
    const params = discoveryPersonDetailParamsSchema.parse(paramsInput);
    const query = discoveryPersonDetailQuerySchema.parse(queryInput);
    const headers = { "X-Api-Key": this.#apiKey };
    const responsePromise = this.client.requestJson(
      `api/v1/person/${params.tmdbId}`,
      upstreamPersonDetailSchema,
      {
        headers,
        operation: "discovery.person.detail",
        query: new URLSearchParams({ language: query.language }),
        ...(signal ? { signal } : {}),
      },
    );
    const creditsPromise = optionalIntelligence(
      this.client.requestJson(
        `api/v1/person/${params.tmdbId}/combined_credits`,
        upstreamPersonCreditsSchema,
        {
          headers,
          operation: "discovery.person.credits",
          query: new URLSearchParams({ language: query.language }),
          ...(signal ? { signal } : {}),
        },
      ),
    );
    const response = await responsePromise;
    if (response.id !== params.tmdbId) throw invalidDetailResponse();
    const creditsResult = await creditsPromise;
    if (creditsResult.value && creditsResult.value.id !== params.tmdbId) {
      throw invalidDetailResponse();
    }
    const credits = creditsResult.value ? normalizedPersonCredits(creditsResult.value) : [];
    const normalized = discoveryPersonDetailResponseSchema.parse({
      generatedAt: this.clock.now().toISOString(),
      item: {
        biography: optionalText(response.biography),
        birthday: normalizedDate(response.birthday),
        birthplace: optionalText(response.placeOfBirth),
        credits,
        creditsState: intelligenceState(creditsResult.state, credits),
        deathday: normalizedDate(response.deathday),
        department: optionalText(response.knownForDepartment),
        id: `person:${response.id}`,
        name: response.name,
        profilePath: null,
        source: "seerr",
        tmdbId: response.id,
      },
    });
    return { profilePath: response.profilePath ?? null, response: normalized };
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

  #artworkClient() {
    this.#artworkClientInstance ??= new SafeHttpClient({
      allowInsecureHttp: this.config.insecureHttpApproved ?? false,
      baseUrl: this.config.baseUrl,
      maxResponseBytes: 8 * 1_024 * 1_024,
      service: this.service,
      tlsPolicy: this.config.tlsPolicy ?? "strict",
      ...(this.config.timeoutMs === undefined ? {} : { timeoutMs: this.config.timeoutMs }),
      ...(this.config.resolveHost === undefined ? {} : { resolveHost: this.config.resolveHost }),
      ...(this.config.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: this.config.tlsCaCertificatePem }),
      ...(this.config.transport === undefined ? {} : { transport: this.config.transport }),
    });
    return this.#artworkClientInstance;
  }

  async listRequestRouting(
    kind: "movie" | "series",
    is4k: boolean,
    signal?: AbortSignal,
  ): Promise<SeerrRequestRoutingCatalog> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        code: "configuration_invalid",
        message: "Seerr request routing requires configured credentials.",
        operation: "request.configure",
        retryable: false,
        service: this.service,
      });
    }
    const service = kind === "movie" ? "radarr" : "sonarr";
    const headers = { "X-Api-Key": this.#apiKey };
    const servers = await this.client.requestJson(
      `api/v1/service/${service}`,
      seerrRequestServerListSchema,
      {
        headers,
        operation: "request.configure.list",
        ...(signal ? { signal } : {}),
      },
    );
    const results = await Promise.all(
      servers
        .filter((server) => server.is4k === is4k)
        .map(async (server) => {
          try {
            const details = await this.client.requestJson(
              `api/v1/service/${service}/${server.id}`,
              seerrRequestServerDetailsSchema,
              {
                headers,
                operation: "request.configure.destination",
                ...(signal ? { signal } : {}),
              },
            );
            if (
              details.server.id !== server.id ||
              details.server.is4k !== server.is4k ||
              details.server.name !== server.name
            ) {
              throw invalidRequestResponse("request.configure.destination");
            }
            return {
              destination: {
                activeDirectory: details.server.activeDirectory,
                activeLanguageProfileId: details.server.activeLanguageProfileId ?? null,
                activeProfileId: details.server.activeProfileId,
                id: details.server.id,
                isDefault: details.server.isDefault,
                label: details.server.name,
                languageProfiles: (details.languageProfiles ?? []).map((profile) => ({
                  id: profile.id,
                  label: profile.name,
                })),
                profiles: details.profiles.map((profile) => ({
                  id: profile.id,
                  label: profile.name,
                })),
                rootFolders: details.rootFolders.map((folder) => ({
                  availableBytes: folder.freeSpace ?? null,
                  capacityBytes: folder.totalSpace ?? null,
                  path: folder.path,
                })),
              },
            };
          } catch (error) {
            if (signal?.aborted) throw error;
            const safeError =
              error instanceof SafeConnectorError
                ? error
                : new SafeConnectorError({
                    code: "upstream_error",
                    message: "Seerr could not load a request destination.",
                    operation: "request.configure.destination",
                    retryable: true,
                    service: this.service,
                  });
            return { failure: safeError.toPartialFailure(this.clock.now()) };
          }
        }),
    );
    const destinations: SeerrRequestRoutingCatalog["destinations"] = [];
    const failures: PartialFailure[] = [];
    for (const result of results) {
      if ("destination" in result) destinations.push(result.destination);
      else failures.push(result.failure);
    }
    destinations.sort((left, right) => left.label.localeCompare(right.label) || left.id - right.id);
    return { destinations, failures, is4k, kind };
  }

  async createMediaRequest(
    input: MediaRequestInput,
    seerrUserId: number,
    signal?: AbortSignal,
    routing?: SeerrRequestRouting,
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
    const selectedRouting = routing ? seerrRequestRoutingSchema.parse(routing) : undefined;
    const response = await this.client.requestText("api/v1/request", {
      acceptedStatuses: [202, 403, 409],
      body: JSON.stringify({
        is4k: request.is4k,
        mediaId: request.tmdbId,
        mediaType: request.kind === "movie" ? "movie" : "tv",
        ...(request.kind === "series" ? { seasons: request.seasons } : {}),
        ...(selectedRouting
          ? {
              ...(selectedRouting.languageProfileId === undefined
                ? {}
                : { languageProfileId: selectedRouting.languageProfileId }),
              profileId: selectedRouting.profileId,
              rootFolder: selectedRouting.rootFolder,
              serverId: selectedRouting.serverId,
            }
          : {}),
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
