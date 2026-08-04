import { z } from "zod";

import { ServarrAcquisitionAdapter } from "./servarr-acquisition.js";
import type { ApiKeyConnectorConfig } from "../types.js";

const libraryMovieIdentitySchema = z
  .strictObject({
    imdb: z
      .string()
      .regex(/^tt[0-9]{5,12}$/u)
      .nullable(),
    tmdb: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .refine(({ imdb, tmdb }) => imdb !== null || tmdb !== null, {
    message: "At least one movie provider identity is required.",
  });

const radarrLibraryMovieSchema = z.object({
  hasFile: z.boolean(),
  id: z.int().positive().max(2_147_483_647),
  imdbId: z.string().max(64).nullish(),
  monitored: z.boolean(),
  movieFile: z
    .object({ size: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish() })
    .nullish(),
  tmdbId: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
});

const radarrLibraryMovieResponseSchema = z.array(radarrLibraryMovieSchema).max(10);

export interface RadarrLibraryMovieOwnership {
  hasFile: boolean;
  mediaId: number;
  monitored: boolean;
  sizeBytes: number | null;
}

export class RadarrAdapter extends ServarrAcquisitionAdapter {
  readonly service = "radarr" as const;
  protected readonly apiPath = "api/v3/system/status";
  protected readonly apiRoot = "api/v3";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }

  async resolveLibraryMovie(
    rawIdentity: { imdb: string | null; tmdb: number | null },
    signal?: AbortSignal,
  ): Promise<RadarrLibraryMovieOwnership | null> {
    const identity = libraryMovieIdentitySchema.parse(rawIdentity);
    const records = await this.client.requestJson(
      `${this.apiRoot}/movie`,
      radarrLibraryMovieResponseSchema,
      {
        headers: { "X-Api-Key": this.apiKey },
        operation: "library.removal.preview",
        query:
          identity.tmdb === null ? { imdbId: identity.imdb! } : { tmdbId: String(identity.tmdb) },
        ...(signal ? { signal } : {}),
      },
    );
    const matches = records.filter(
      (record) =>
        (identity.tmdb === null || record.tmdbId === identity.tmdb) &&
        (identity.imdb === null ||
          record.imdbId === identity.imdb ||
          (identity.tmdb !== null && (record.imdbId === null || record.imdbId === undefined))),
    );
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw this.client.invalidResponse("library.removal.preview");
    const match = matches[0]!;
    return {
      hasFile: match.hasFile,
      mediaId: match.id,
      monitored: match.monitored,
      sizeBytes: match.movieFile?.size ?? null,
    };
  }
}
