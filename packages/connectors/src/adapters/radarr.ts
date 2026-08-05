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
    .object({
      id: z.int().positive().max(2_147_483_647),
      size: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
    })
    .nullish(),
  movieFileId: z.int().nonnegative().max(2_147_483_647).nullish(),
  tmdbId: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
});

const radarrLibraryMovieResponseSchema = z.array(radarrLibraryMovieSchema).max(10);

interface RadarrLibraryMovieOwnershipBase {
  mediaId: number;
  monitored: boolean;
  sizeBytes: number | null;
}

export type RadarrLibraryMovieOwnership = RadarrLibraryMovieOwnershipBase &
  ({ fileId: number; hasFile: true } | { fileId: null; hasFile: false });

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
    const nestedFileId = match.movieFile?.id ?? null;
    const compatibilityFileId =
      match.movieFileId && match.movieFileId > 0 ? match.movieFileId : null;
    if (
      nestedFileId !== null &&
      compatibilityFileId !== null &&
      nestedFileId !== compatibilityFileId
    ) {
      throw this.client.invalidResponse("library.removal.preview");
    }
    const fileId = nestedFileId ?? compatibilityFileId;
    const common = {
      mediaId: match.id,
      monitored: match.monitored,
      sizeBytes: match.movieFile?.size ?? null,
    };
    if (match.hasFile) {
      if (fileId === null) throw this.client.invalidResponse("library.removal.preview");
      return { ...common, fileId, hasFile: true };
    }
    if (fileId !== null) throw this.client.invalidResponse("library.removal.preview");
    return { ...common, fileId: null, hasFile: false };
  }

  async deleteLibraryMovieFile(rawFileId: number, signal?: AbortSignal): Promise<void> {
    const fileId = z.int().positive().max(2_147_483_647).parse(rawFileId);
    const response = await this.client.requestText(`${this.apiRoot}/moviefile/${fileId}`, {
      acceptedStatuses: [200, 204],
      headers: { "X-Api-Key": this.apiKey },
      method: "DELETE",
      operation: "library.removal.file_delete",
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200 && response.status !== 204) {
      throw this.client.invalidResponse("library.removal.file_delete");
    }
  }

  async deleteLibraryMovie(rawMediaId: number, signal?: AbortSignal): Promise<void> {
    const mediaId = z.int().positive().max(2_147_483_647).parse(rawMediaId);
    const response = await this.client.requestText(`${this.apiRoot}/movie/${mediaId}`, {
      acceptedStatuses: [200, 204],
      headers: { "X-Api-Key": this.apiKey },
      method: "DELETE",
      operation: "library.removal.manager_delete",
      query: { addImportExclusion: "false", deleteFiles: "true" },
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200 && response.status !== 204) {
      throw this.client.invalidResponse("library.removal.manager_delete");
    }
  }
}
