import { z } from "zod";

export const DISCOVERY_SEARCH_MAX_RESULTS = 100;

const tmdbIdentifierSchema = z.int().positive().max(2_147_483_647);
const titleSchema = z.string().trim().min(1).max(300);
const overviewSchema = z.string().trim().max(2_000).nullable();
const yearSchema = z.int().min(1870).max(2200).nullable();

export const discoverySearchQuerySchema = z.strictObject({
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u)
    .default("en"),
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

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const discoverySearchQueryJsonSchema = withoutSchemaDialect(discoverySearchQuerySchema);
export const discoverySearchResponseJsonSchema = withoutSchemaDialect(
  discoverySearchResponseSchema,
);
