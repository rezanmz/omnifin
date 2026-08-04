import { z } from "zod";

import { partialFailureSchema, type PartialFailure } from "./connectors.js";

export const DISCOVERY_SEARCH_MAX_RESULTS = 100;
export const DISCOVERY_DETAIL_MAX_CAST = 12;
export const DISCOVERY_DETAIL_MAX_CREW = 12;
export const DISCOVERY_DETAIL_MAX_RATINGS = 6;
export const DISCOVERY_DETAIL_MAX_RECOMMENDATIONS = 12;
export const DISCOVERY_DETAIL_MAX_TRAILERS = 6;
export const DISCOVERY_PERSON_MAX_CREDITS = 24;
export const DISCOVERY_PERSON_MAX_CREDIT_PAGES = 100;
export const DISCOVERY_FEED_RAIL_COUNT = 4;
export const DISCOVERY_FEED_MAX_ITEMS_PER_RAIL = 18;
export const DISCOVERY_BROWSE_MAX_ITEMS_PER_PAGE = 40;

export const DISCOVERY_MOVIE_GENRES = [
  "action",
  "adventure",
  "animation",
  "comedy",
  "crime",
  "documentary",
  "drama",
  "family",
  "fantasy",
  "history",
  "horror",
  "music",
  "mystery",
  "romance",
  "science-fiction",
  "thriller",
  "war",
  "western",
] as const;
export const DISCOVERY_SERIES_GENRES = [
  "action-adventure",
  "animation",
  "comedy",
  "crime",
  "documentary",
  "drama",
  "family",
  "kids",
  "mystery",
  "news",
  "reality",
  "sci-fi-fantasy",
  "soap",
  "talk",
  "war-politics",
  "western",
] as const;

const tmdbIdentifierSchema = z.int().positive().max(2_147_483_647);
const titleSchema = z.string().trim().min(1).max(300);
const overviewSchema = z.string().trim().max(2_000).nullable();
const yearSchema = z.int().min(1870).max(2200).nullable();
const languageSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u);

export const discoverySearchQuerySchema = z.strictObject({
  language: languageSchema.default("en"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  query: z.string().trim().min(2).max(200),
});
export type DiscoverySearchQuery = z.infer<typeof discoverySearchQuerySchema>;

export const discoveryAvailabilitySchema = z.enum([
  "available",
  "partial",
  "requested",
  "processing",
  "unavailable",
  "unknown",
]);
export type DiscoveryAvailability = z.infer<typeof discoveryAvailabilitySchema>;

const discoveryKnownForSchema = z.strictObject({
  kind: z.enum(["movie", "series"]),
  title: titleSchema,
  year: yearSchema,
});

const discoveryResultBase = {
  id: z
    .string()
    .min(3)
    .max(64)
    .regex(/^(?:movie|person|series):[1-9][0-9]*$/u),
  source: z.literal("seerr"),
  tmdbId: tmdbIdentifierSchema,
  title: titleSchema,
} as const;

const discoveryMediaResultBase = {
  ...discoveryResultBase,
  availability: discoveryAvailabilitySchema,
  originalTitle: titleSchema.nullable(),
  overview: overviewSchema,
  voteAverage: z.number().finite().min(0).max(10).nullable(),
  year: yearSchema,
} as const;

export const discoveryMovieResultSchema = z.strictObject({
  ...discoveryMediaResultBase,
  kind: z.literal("movie"),
});
export type DiscoveryMovieResult = z.infer<typeof discoveryMovieResultSchema>;

export const discoverySeriesResultSchema = z.strictObject({
  ...discoveryMediaResultBase,
  kind: z.literal("series"),
});
export type DiscoverySeriesResult = z.infer<typeof discoverySeriesResultSchema>;

export const discoveryPersonResultSchema = z.strictObject({
  ...discoveryResultBase,
  kind: z.literal("person"),
  knownFor: z.array(discoveryKnownForSchema).max(8),
});
export type DiscoveryPersonResult = z.infer<typeof discoveryPersonResultSchema>;

export const discoverySearchResultSchema = z.discriminatedUnion("kind", [
  discoveryMovieResultSchema,
  discoverySeriesResultSchema,
  discoveryPersonResultSchema,
]);
export type DiscoverySearchResult = z.infer<typeof discoverySearchResultSchema>;

export const discoverySearchResponseSchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: true }),
  items: z.array(discoverySearchResultSchema).max(DISCOVERY_SEARCH_MAX_RESULTS),
  page: z.int().min(1).max(500),
  query: z.string().trim().min(2).max(200),
  totalPages: z.int().min(0).max(500),
  totalResults: z.int().nonnegative().max(10_000_000),
});
export type DiscoverySearchResponse = z.infer<typeof discoverySearchResponseSchema>;

export const discoveryFeedQuerySchema = z.strictObject({
  language: languageSchema.default("en"),
});
export type DiscoveryFeedQuery = z.infer<typeof discoveryFeedQuerySchema>;

export const discoveryBrowseKindSchema = z.enum(["movie", "series"]);
export type DiscoveryBrowseKind = z.infer<typeof discoveryBrowseKindSchema>;
export const discoveryBrowseSortSchema = z.enum(["popularity", "rating", "newest", "title"]);
export type DiscoveryBrowseSort = z.infer<typeof discoveryBrowseSortSchema>;
export const discoveryBrowseAvailabilitySchema = z.enum([
  "any",
  "available",
  "partial",
  "requested",
  "processing",
  "requestable",
]);
export type DiscoveryBrowseAvailability = z.infer<typeof discoveryBrowseAvailabilitySchema>;
export const discoveryBrowseGenreSchema = z.enum([
  ...DISCOVERY_MOVIE_GENRES,
  ...DISCOVERY_SERIES_GENRES,
]);
export type DiscoveryBrowseGenre = z.infer<typeof discoveryBrowseGenreSchema>;
export const discoveryBrowseOriginalLanguageSchema = z.enum([
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "ko",
  "pt",
  "zh",
]);
export type DiscoveryBrowseOriginalLanguage = z.infer<typeof discoveryBrowseOriginalLanguageSchema>;

const movieBrowseGenres = new Set<string>(DISCOVERY_MOVIE_GENRES);
const seriesBrowseGenres = new Set<string>(DISCOVERY_SERIES_GENRES);
export const discoveryBrowseQuerySchema = z
  .strictObject({
    availability: discoveryBrowseAvailabilitySchema.default("any"),
    genre: discoveryBrowseGenreSchema.optional(),
    kind: discoveryBrowseKindSchema.default("movie"),
    locale: languageSchema.default("en"),
    minimumRating: z.coerce.number().finite().min(0).max(10).optional(),
    minimumVotes: z.coerce.number().int().min(0).max(1_000_000).optional(),
    originalLanguage: discoveryBrowseOriginalLanguageSchema.optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    query: z.string().trim().min(2).max(120).optional(),
    runtimeMax: z.coerce.number().int().min(15).max(600).optional(),
    sort: discoveryBrowseSortSchema.default("popularity"),
    yearFrom: z.coerce.number().int().min(1870).max(2200).optional(),
    yearTo: z.coerce.number().int().min(1870).max(2200).optional(),
  })
  .superRefine((query, context) => {
    if (
      query.yearFrom !== undefined &&
      query.yearTo !== undefined &&
      query.yearFrom > query.yearTo
    ) {
      context.addIssue({
        code: "custom",
        message: "The beginning of the release range cannot follow its end.",
        path: ["yearFrom"],
      });
    }
    if (
      query.genre !== undefined &&
      !(query.kind === "movie" ? movieBrowseGenres : seriesBrowseGenres).has(query.genre)
    ) {
      context.addIssue({
        code: "custom",
        message: "The selected genre is not available for this media type.",
        path: ["genre"],
      });
    }
    if (
      query.query !== undefined &&
      (query.genre !== undefined ||
        query.minimumVotes !== undefined ||
        query.originalLanguage !== undefined ||
        query.runtimeMax !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Title search cannot be combined with discovery-only filters.",
        path: ["query"],
      });
    }
  });
export type DiscoveryBrowseQuery = z.infer<typeof discoveryBrowseQuerySchema>;

export const discoveryFeedRailKindSchema = z.enum([
  "trending",
  "popular_movies",
  "popular_series",
  "upcoming",
]);
export type DiscoveryFeedRailKind = z.infer<typeof discoveryFeedRailKindSchema>;

export const discoveryArtworkReferenceIdSchema = z
  .string()
  .regex(/^discovery_art_[A-Za-z0-9_-]{22}$/u);

const discoveryArtworkPathSchema = z
  .string()
  .regex(/^\/v1\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u)
  .max(96)
  .nullable();

export const discoveryFeedArtworkSchema = z.strictObject({
  backdropPath: discoveryArtworkPathSchema,
  posterPath: discoveryArtworkPathSchema,
});
export type DiscoveryFeedArtwork = z.infer<typeof discoveryFeedArtworkSchema>;

export const discoveryFeedMovieSchema = discoveryMovieResultSchema.extend({
  artwork: discoveryFeedArtworkSchema,
});
export const discoveryFeedSeriesSchema = discoverySeriesResultSchema.extend({
  artwork: discoveryFeedArtworkSchema,
});
export const discoveryFeedItemSchema = z.discriminatedUnion("kind", [
  discoveryFeedMovieSchema,
  discoveryFeedSeriesSchema,
]);
export type DiscoveryFeedItem = z.infer<typeof discoveryFeedItemSchema>;

export const discoveryBrowseResponseSchema = z
  .strictObject({
    criteria: discoveryBrowseQuerySchema,
    generatedAt: z.iso.datetime({ offset: true }),
    items: z.array(discoveryFeedItemSchema).max(DISCOVERY_BROWSE_MAX_ITEMS_PER_PAGE),
    page: z.int().min(1).max(500),
    totalPages: z.int().min(0).max(500),
    totalResults: z.int().nonnegative().max(10_000_000),
  })
  .superRefine((response, context) => {
    const ids = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (item.kind !== response.criteria.kind) {
        context.addIssue({
          code: "custom",
          message: "Browse results must match the selected media type.",
          path: ["items", index, "kind"],
        });
      }
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "Browse results must be unique within a page.",
          path: ["items", index, "id"],
        });
      }
      ids.add(item.id);
    }
    if (response.page !== response.criteria.page) {
      context.addIssue({
        code: "custom",
        message: "Browse result pagination must match the requested page.",
        path: ["page"],
      });
    }
  });
export type DiscoveryBrowseResponse = z.infer<typeof discoveryBrowseResponseSchema>;

function failuresMatch(left: PartialFailure, right: PartialFailure) {
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.occurredAt === right.occurredAt &&
    left.operation === right.operation &&
    left.retryable === right.retryable &&
    left.retryAfterSeconds === right.retryAfterSeconds &&
    left.service === right.service
  );
}

export const discoveryFeedRailSchema = z
  .strictObject({
    failure: partialFailureSchema.nullable(),
    items: z.array(discoveryFeedItemSchema).max(DISCOVERY_FEED_MAX_ITEMS_PER_RAIL),
    kind: discoveryFeedRailKindSchema,
    totalResults: z.int().nonnegative().max(10_000_000),
    truncated: z.boolean(),
  })
  .superRefine((rail, context) => {
    const ids = new Set<string>();
    for (const [index, item] of rail.items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "Discovery feed items must be unique within a rail.",
          path: ["items", index, "id"],
        });
      }
      ids.add(item.id);
    }
    if (rail.failure !== null) {
      if (rail.failure.service !== "seerr") {
        context.addIssue({
          code: "custom",
          message: "Discovery feed failures must identify Seerr.",
          path: ["failure", "service"],
        });
      }
      if (rail.items.length > 0 || rail.totalResults !== 0 || rail.truncated) {
        context.addIssue({
          code: "custom",
          message: "An unavailable discovery rail cannot contain media or truncation.",
          path: ["items"],
        });
      }
      return;
    }
    if (rail.totalResults < rail.items.length) {
      context.addIssue({
        code: "custom",
        message: "Discovery rail totals cannot be smaller than the returned media.",
        path: ["totalResults"],
      });
    }
    if (rail.truncated !== rail.totalResults > rail.items.length) {
      context.addIssue({
        code: "custom",
        message: "Discovery rail truncation must match the returned result count.",
        path: ["truncated"],
      });
    }
  });
export type DiscoveryFeedRail = z.infer<typeof discoveryFeedRailSchema>;

export const discoveryFeedResponseSchema = z
  .strictObject({
    failures: z.array(partialFailureSchema).max(DISCOVERY_FEED_RAIL_COUNT),
    generatedAt: z.iso.datetime({ offset: true }),
    rails: z.array(discoveryFeedRailSchema).length(DISCOVERY_FEED_RAIL_COUNT),
    state: z.enum(["complete", "degraded", "empty", "unavailable"]),
  })
  .superRefine((response, context) => {
    const kinds = new Set(response.rails.map((rail) => rail.kind));
    if (kinds.size !== DISCOVERY_FEED_RAIL_COUNT) {
      context.addIssue({
        code: "custom",
        message: "A discovery feed must contain every rail exactly once.",
        path: ["rails"],
      });
    }
    const railFailures = response.rails.flatMap((rail) =>
      rail.failure === null ? [] : [rail.failure],
    );
    if (
      railFailures.length !== response.failures.length ||
      railFailures.some(
        (failure) => !response.failures.some((candidate) => failuresMatch(failure, candidate)),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Discovery feed failures must match unavailable rails exactly.",
        path: ["failures"],
      });
    }
    const failed = railFailures.length;
    const items = response.rails.reduce((total, rail) => total + rail.items.length, 0);
    const expectedState =
      failed === DISCOVERY_FEED_RAIL_COUNT
        ? "unavailable"
        : failed > 0
          ? "degraded"
          : items === 0
            ? "empty"
            : "complete";
    if (response.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "Discovery feed state must match its rails and failures.",
        path: ["state"],
      });
    }
  });
export type DiscoveryFeedResponse = z.infer<typeof discoveryFeedResponseSchema>;

export const discoveryMediaKindSchema = z.enum(["movie", "series"]);
export type DiscoveryMediaKind = z.infer<typeof discoveryMediaKindSchema>;

export const discoveryMediaDetailParamsSchema = z.strictObject({
  kind: discoveryMediaKindSchema,
  tmdbId: z.coerce.number().int().positive().max(2_147_483_647),
});
export type DiscoveryMediaDetailParams = z.infer<typeof discoveryMediaDetailParamsSchema>;

export const discoveryMediaDetailQuerySchema = z.strictObject({
  language: languageSchema.default("en"),
});
export type DiscoveryMediaDetailQuery = z.infer<typeof discoveryMediaDetailQuerySchema>;

const discoveryCastCreditSchema = z.strictObject({
  character: z.string().trim().min(1).max(200).nullable(),
  name: z.string().trim().min(1).max(160),
  personId: tmdbIdentifierSchema,
  profilePath: discoveryArtworkPathSchema,
});

const discoveryCrewCreditSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  personId: tmdbIdentifierSchema,
  role: z.string().trim().min(1).max(160),
});

export const discoveryIntelligenceStateSchema = z.enum(["ready", "empty", "unavailable"]);
export type DiscoveryIntelligenceState = z.infer<typeof discoveryIntelligenceStateSchema>;

const discoveryRatingBase = {
  audience: z.enum(["audience", "community", "critics"]),
  label: z.string().trim().min(1).max(80),
  sentiment: z.string().trim().min(1).max(80).nullable(),
  source: z.enum(["imdb", "rotten_tomatoes", "tmdb"]),
  voteCount: z.int().nonnegative().max(1_000_000_000).nullable(),
} as const;

export const discoveryRatingSchema = z.discriminatedUnion("scale", [
  z.strictObject({
    ...discoveryRatingBase,
    scale: z.literal(10),
    value: z.number().finite().min(0).max(10),
  }),
  z.strictObject({
    ...discoveryRatingBase,
    scale: z.literal(100),
    value: z.number().finite().min(0).max(100),
  }),
]);
export type DiscoveryRating = z.infer<typeof discoveryRatingSchema>;

export const discoveryTrailerSchema = z.strictObject({
  id: z
    .string()
    .min(10)
    .max(48)
    .regex(/^youtube:[A-Za-z0-9_-]{6,32}$/u),
  provider: z.literal("youtube"),
  resolution: z.int().positive().max(8_640).nullable(),
  title: titleSchema,
  type: z.enum(["behind_the_scenes", "clip", "featurette", "teaser", "trailer"]),
});
export type DiscoveryTrailer = z.infer<typeof discoveryTrailerSchema>;

const discoveryMediaRecommendationSchema = z.discriminatedUnion("kind", [
  discoveryMovieResultSchema,
  discoverySeriesResultSchema,
]);
export type DiscoveryMediaRecommendation = z.infer<typeof discoveryMediaRecommendationSchema>;

const discoveryMediaIntelligenceSchema = z.strictObject({
  ratings: z.array(discoveryRatingSchema).max(DISCOVERY_DETAIL_MAX_RATINGS),
  ratingsState: discoveryIntelligenceStateSchema,
  recommendations: z
    .array(discoveryMediaRecommendationSchema)
    .max(DISCOVERY_DETAIL_MAX_RECOMMENDATIONS),
  recommendationsState: discoveryIntelligenceStateSchema,
  trailers: z.array(discoveryTrailerSchema).max(DISCOVERY_DETAIL_MAX_TRAILERS),
});

const discoveryMediaDetailBase = {
  artwork: discoveryFeedArtworkSchema,
  availability: discoveryAvailabilitySchema,
  cast: z.array(discoveryCastCreditSchema).max(DISCOVERY_DETAIL_MAX_CAST),
  crew: z.array(discoveryCrewCreditSchema).max(DISCOVERY_DETAIL_MAX_CREW),
  genres: z.array(z.string().trim().min(1).max(100)).max(20),
  intelligence: discoveryMediaIntelligenceSchema,
  originalTitle: titleSchema.nullable(),
  overview: overviewSchema,
  productionStatus: z.string().trim().min(1).max(100).nullable(),
  runtimeMinutes: z.int().positive().max(10_000).nullable(),
  source: z.literal("seerr"),
  tagline: z.string().trim().min(1).max(500).nullable(),
  title: titleSchema,
  tmdbId: tmdbIdentifierSchema,
  voteAverage: z.number().finite().min(0).max(10).nullable(),
  voteCount: z.int().nonnegative().max(1_000_000_000).nullable(),
  year: yearSchema,
} as const;

export const discoveryMovieDetailSchema = z.strictObject({
  ...discoveryMediaDetailBase,
  id: z
    .string()
    .min(7)
    .max(64)
    .regex(/^movie:[1-9][0-9]*$/u),
  kind: z.literal("movie"),
});
export type DiscoveryMovieDetail = z.infer<typeof discoveryMovieDetailSchema>;

const discoverySeasonSummarySchema = z.strictObject({
  episodeCount: z.int().nonnegative().max(10_000),
  number: z.int().nonnegative().max(10_000),
  title: titleSchema,
  year: yearSchema,
});

export const discoverySeriesDetailSchema = z.strictObject({
  ...discoveryMediaDetailBase,
  episodeCount: z.int().nonnegative().max(100_000),
  id: z
    .string()
    .min(8)
    .max(64)
    .regex(/^series:[1-9][0-9]*$/u),
  kind: z.literal("series"),
  seasonCount: z.int().nonnegative().max(10_000),
  seasons: z.array(discoverySeasonSummarySchema).max(100),
});
export type DiscoverySeriesDetail = z.infer<typeof discoverySeriesDetailSchema>;

export const discoveryMediaDetailSchema = z.discriminatedUnion("kind", [
  discoveryMovieDetailSchema,
  discoverySeriesDetailSchema,
]);
export type DiscoveryMediaDetail = z.infer<typeof discoveryMediaDetailSchema>;

export const discoveryMediaDetailResponseSchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: true }),
  item: discoveryMediaDetailSchema,
});
export type DiscoveryMediaDetailResponse = z.infer<typeof discoveryMediaDetailResponseSchema>;

export const discoveryPersonDetailParamsSchema = z.strictObject({
  tmdbId: z.coerce.number().int().positive().max(2_147_483_647),
});
export type DiscoveryPersonDetailParams = z.infer<typeof discoveryPersonDetailParamsSchema>;

export const discoveryPersonDetailQuerySchema = discoveryMediaDetailQuerySchema;
export type DiscoveryPersonDetailQuery = z.infer<typeof discoveryPersonDetailQuerySchema>;

export const discoveryPersonCreditSchema = z.strictObject({
  availability: discoveryAvailabilitySchema,
  kind: discoveryMediaKindSchema,
  role: z.string().trim().min(1).max(200),
  title: titleSchema,
  tmdbId: tmdbIdentifierSchema,
  voteAverage: z.number().finite().min(0).max(10).nullable(),
  year: yearSchema,
});
export type DiscoveryPersonCredit = z.infer<typeof discoveryPersonCreditSchema>;

export const discoveryPersonDetailSchema = z
  .strictObject({
    biography: overviewSchema,
    birthday: z.iso.date().nullable(),
    birthplace: z.string().trim().min(1).max(300).nullable(),
    credits: z.array(discoveryPersonCreditSchema).max(DISCOVERY_PERSON_MAX_CREDITS),
    creditsState: discoveryIntelligenceStateSchema,
    creditsTotal: z
      .int()
      .nonnegative()
      .max(DISCOVERY_PERSON_MAX_CREDITS * DISCOVERY_PERSON_MAX_CREDIT_PAGES),
    deathday: z.iso.date().nullable(),
    department: z.string().trim().min(1).max(160).nullable(),
    id: z
      .string()
      .min(8)
      .max(64)
      .regex(/^person:[1-9][0-9]*$/u),
    name: titleSchema,
    profilePath: discoveryArtworkPathSchema,
    source: z.literal("seerr"),
    tmdbId: tmdbIdentifierSchema,
  })
  .superRefine((value, context) => {
    if (value.creditsTotal < value.credits.length) {
      context.addIssue({
        code: "custom",
        message: "Credit total cannot be smaller than the included page.",
        path: ["creditsTotal"],
      });
    }
  });
export type DiscoveryPersonDetail = z.infer<typeof discoveryPersonDetailSchema>;

export const discoveryPersonDetailResponseSchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: true }),
  item: discoveryPersonDetailSchema,
});
export type DiscoveryPersonDetailResponse = z.infer<typeof discoveryPersonDetailResponseSchema>;

export const discoveryPersonCreditsQuerySchema = z.strictObject({
  language: languageSchema.default("en"),
  page: z.coerce.number().int().min(1).max(DISCOVERY_PERSON_MAX_CREDIT_PAGES).default(1),
});
export type DiscoveryPersonCreditsQuery = z.infer<typeof discoveryPersonCreditsQuerySchema>;

export const discoveryPersonCreditsResponseSchema = z
  .strictObject({
    generatedAt: z.iso.datetime({ offset: true }),
    items: z.array(discoveryPersonCreditSchema).max(DISCOVERY_PERSON_MAX_CREDITS),
    page: z.int().min(1).max(DISCOVERY_PERSON_MAX_CREDIT_PAGES),
    pageSize: z.literal(DISCOVERY_PERSON_MAX_CREDITS),
    totalPages: z.int().nonnegative().max(DISCOVERY_PERSON_MAX_CREDIT_PAGES),
    totalResults: z
      .int()
      .nonnegative()
      .max(DISCOVERY_PERSON_MAX_CREDITS * DISCOVERY_PERSON_MAX_CREDIT_PAGES),
  })
  .superRefine((value, context) => {
    const expectedPages = Math.ceil(value.totalResults / DISCOVERY_PERSON_MAX_CREDITS);
    const expectedItems =
      value.page > expectedPages
        ? 0
        : Math.min(
            DISCOVERY_PERSON_MAX_CREDITS,
            value.totalResults - (value.page - 1) * DISCOVERY_PERSON_MAX_CREDITS,
          );
    if (value.totalPages !== expectedPages) {
      context.addIssue({
        code: "custom",
        message: "Credit page count does not match the bounded total.",
        path: ["totalPages"],
      });
    }
    if (value.items.length !== expectedItems) {
      context.addIssue({
        code: "custom",
        message: "Credit page length does not match its page metadata.",
        path: ["items"],
      });
    }
  });
export type DiscoveryPersonCreditsResponse = z.infer<typeof discoveryPersonCreditsResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const discoverySearchQueryJsonSchema = withoutSchemaDialect(discoverySearchQuerySchema);
export const discoverySearchResponseJsonSchema = withoutSchemaDialect(
  discoverySearchResponseSchema,
);
export const discoveryFeedQueryJsonSchema = withoutSchemaDialect(discoveryFeedQuerySchema);
export const discoveryFeedResponseJsonSchema = withoutSchemaDialect(discoveryFeedResponseSchema);
export const discoveryBrowseQueryJsonSchema = withoutSchemaDialect(discoveryBrowseQuerySchema);
export const discoveryBrowseResponseJsonSchema = withoutSchemaDialect(
  discoveryBrowseResponseSchema,
);
export const discoveryMediaDetailParamsJsonSchema = withoutSchemaDialect(
  discoveryMediaDetailParamsSchema,
);
export const discoveryMediaDetailQueryJsonSchema = withoutSchemaDialect(
  discoveryMediaDetailQuerySchema,
);
export const discoveryMediaDetailResponseJsonSchema = withoutSchemaDialect(
  discoveryMediaDetailResponseSchema,
);
export const discoveryPersonDetailParamsJsonSchema = withoutSchemaDialect(
  discoveryPersonDetailParamsSchema,
);
export const discoveryPersonDetailQueryJsonSchema = withoutSchemaDialect(
  discoveryPersonDetailQuerySchema,
);
export const discoveryPersonDetailResponseJsonSchema = withoutSchemaDialect(
  discoveryPersonDetailResponseSchema,
);
export const discoveryPersonCreditsQueryJsonSchema = withoutSchemaDialect(
  discoveryPersonCreditsQuerySchema,
);
export const discoveryPersonCreditsResponseJsonSchema = withoutSchemaDialect(
  discoveryPersonCreditsResponseSchema,
);
