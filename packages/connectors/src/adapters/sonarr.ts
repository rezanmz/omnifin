import { z } from "zod";

import { ServarrAcquisitionAdapter } from "./servarr-acquisition.js";
import type { ApiKeyConnectorConfig } from "../types.js";

const librarySeriesIdentitySchema = z
  .strictObject({
    tmdb: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    tvdb: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .refine(({ tmdb, tvdb }) => tmdb !== null || tvdb !== null, {
    message: "At least one series provider identity is required.",
  });

const sonarrLibrarySeriesSchema = z.object({
  id: z.int().positive().max(2_147_483_647),
  titleSlug: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,299}$/u),
  tmdbId: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
  tvdbId: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
});

const sonarrLibrarySeriesResponseSchema = z.array(sonarrLibrarySeriesSchema).max(10);

export interface SonarrLibrarySeriesNavigation {
  mediaId: number;
  titleSlug: string;
}

export class SonarrAdapter extends ServarrAcquisitionAdapter {
  readonly service = "sonarr" as const;
  protected readonly apiPath = "api/v3/system/status";
  protected readonly apiRoot = "api/v3";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }

  async resolveLibrarySeriesNavigation(
    rawIdentity: { tmdb: number | null; tvdb: number | null },
    signal?: AbortSignal,
  ): Promise<SonarrLibrarySeriesNavigation | null> {
    const identity = librarySeriesIdentitySchema.parse(rawIdentity);
    const records = await this.client.requestJson(
      `${this.apiRoot}/series`,
      sonarrLibrarySeriesResponseSchema,
      {
        headers: { "X-Api-Key": this.apiKey },
        operation: "media.library.connected_action",
        query:
          identity.tvdb === null
            ? { tmdbId: String(identity.tmdb) }
            : { tvdbId: String(identity.tvdb) },
        ...(signal ? { signal } : {}),
      },
    );
    const matches = records.filter(
      (record) =>
        (identity.tvdb === null || record.tvdbId === identity.tvdb) &&
        (identity.tmdb === null ||
          record.tmdbId === identity.tmdb ||
          (identity.tvdb !== null && (record.tmdbId === null || record.tmdbId === undefined))),
    );
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw this.client.invalidResponse("media.library.connected_action");
    return { mediaId: matches[0]!.id, titleSlug: matches[0]!.titleSlug };
  }
}
