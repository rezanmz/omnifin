import { z } from "zod";

export const DISCOVERY_SEARCH_MAX_RESULTS = 100;
export const DISCOVERY_DETAIL_MAX_CAST = 12;
export const DISCOVERY_DETAIL_MAX_CREW = 12;

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
});

const discoveryCrewCreditSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(160),
});

const discoveryMediaDetailBase = {
  availability: discoveryAvailabilitySchema,
  cast: z.array(discoveryCastCreditSchema).max(DISCOVERY_DETAIL_MAX_CAST),
  crew: z.array(discoveryCrewCreditSchema).max(DISCOVERY_DETAIL_MAX_CREW),
  genres: z.array(z.string().trim().min(1).max(100)).max(20),
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

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const discoverySearchQueryJsonSchema = withoutSchemaDialect(discoverySearchQuerySchema);
export const discoverySearchResponseJsonSchema = withoutSchemaDialect(
  discoverySearchResponseSchema,
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
