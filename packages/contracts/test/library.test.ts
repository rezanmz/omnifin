import { describe, expect, it } from "vitest";

import {
  libraryArtworkSearchResponseSchema,
  libraryAttentionQuerySchema,
  libraryAttentionResponseJsonSchema,
  libraryAttentionResponseSchema,
  libraryBrowseQueryJsonSchema,
  libraryBrowseQuerySchema,
  libraryBrowseResponseJsonSchema,
  libraryBrowseResponseSchema,
  libraryItemRefreshRequestSchema,
  libraryMetadataUpdateRequestSchema,
  libraryMutationResponseSchema,
  librarySeasonEpisodesQueryJsonSchema,
  librarySeasonEpisodesQuerySchema,
  librarySeasonEpisodesResponseJsonSchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseJsonSchema,
  libraryTitleDetailResponseSchema,
} from "../src/library.js";

const referenceId = `media_${"m".repeat(22)}`;
const searchId = `library_artwork_search_${"s".repeat(22)}`;
const resultId = `library_artwork_result_${"r".repeat(22)}`;

const attention = {
  generatedAt: "2026-07-28T14:00:00.000Z",
  items: [
    {
      identityState: "unmatched" as const,
      issues: ["missing_identity", "missing_overview", "missing_poster"] as const,
      kind: "movie" as const,
      overview: null,
      posterPath: null,
      referenceId,
      title: "The Far Meridian",
      year: 2026,
    },
  ],
  nextCursor: "bGlicmFyeQ.c2lnbmF0dXJl",
  scanned: 30,
  truncated: true,
};

const catalogue = {
  generatedAt: "2026-07-28T14:00:00.000Z",
  items: [
    {
      media: {
        artwork: {
          accentColor: "#336699",
          backdropPath: `/v1/media/${referenceId}/images/backdrop`,
          blurHash: "005?}k",
          posterPath: `/v1/media/${referenceId}/images/poster`,
        },
        availability: "available" as const,
        contentRating: "TV-14",
        id: referenceId,
        kind: "movie" as const,
        overview: "A receiver resolves a signal beyond the ice.",
        runtimeMinutes: 45,
        subtitle: null,
        title: "The Long Meridian",
        year: 2026,
      },
      playback: { durationSeconds: 2_700, played: false, positionSeconds: 900 },
    },
  ],
  nextCursor: "bGlicmFyeQ.c2lnbmF0dXJl",
  source: { displayName: "Home Jellyfin", failure: null, status: "healthy" as const },
  state: "complete" as const,
};

describe("library operation contracts", () => {
  it("normalizes attention items without paths or upstream identifiers", () => {
    expect(libraryAttentionResponseSchema.parse(attention)).toEqual(attention);
    expect(JSON.stringify(attention)).not.toMatch(/\/media\/|upstream|providerId/iu);
  });

  it("requires attention state, issue order, and poster references to agree", () => {
    expect(
      libraryAttentionResponseSchema.safeParse({
        ...attention,
        items: [{ ...attention.items[0], identityState: "identified" }],
      }).success,
    ).toBe(false);
    expect(
      libraryAttentionResponseSchema.safeParse({
        ...attention,
        items: [
          {
            ...attention.items[0],
            issues: ["missing_poster", "missing_identity", "missing_overview"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryAttentionResponseSchema.safeParse({
        ...attention,
        items: [
          {
            ...attention.items[0],
            issues: ["missing_identity", "missing_overview"],
            posterPath: "https://jellyfin.example/Items/upstream/Images/Primary",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("coerces bounded paging and defaults safe refresh modes", () => {
    expect(libraryAttentionQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(libraryAttentionQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(libraryItemRefreshRequestSchema.parse({})).toEqual({
      imageMode: "missing",
      metadataMode: "missing",
    });
  });

  it("normalizes a title-level paired-user catalogue with opaque references", () => {
    expect(libraryBrowseResponseSchema.parse(catalogue)).toEqual(catalogue);
    expect(JSON.stringify(catalogue)).not.toMatch(/external|jellyfin\.example|upstream/iu);
    expect(libraryBrowseQuerySchema.parse({ limit: "25" })).toEqual({
      kind: "all",
      limit: 25,
      sort: "recent",
    });
    expect(
      libraryBrowseQuerySchema.parse({ kind: "series", query: "  Meridian  ", sort: "title" }),
    ).toEqual({ kind: "series", limit: 30, query: "Meridian", sort: "title" });
    expect(libraryBrowseQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });

  it("rejects mismatched playback, cross-reference, or inconsistent catalogue state", () => {
    const item = catalogue.items[0]!;

    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [
          {
            ...item,
            media: { ...item.media, kind: "series" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [
          {
            ...item,
            media: {
              ...item.media,
              artwork: {
                ...item.media.artwork,
                posterPath: `/v1/media/media_${"z".repeat(22)}/images/poster`,
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [],
        nextCursor: null,
        state: "complete",
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [],
        nextCursor: null,
        source: {
          displayName: "Home Jellyfin",
          failure: null,
          status: "unavailable",
        },
        state: "unavailable",
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [],
        nextCursor: null,
        source: {
          displayName: "Home Jellyfin",
          failure: {
            code: "upstream_error",
            message: "The source is unavailable.",
            occurredAt: catalogue.generatedAt,
            operation: "media.continue_watching",
            retryable: true,
            service: "jellyfin",
          },
          status: "unavailable",
        },
        state: "unavailable",
      }).success,
    ).toBe(false);
  });

  it("models series details and bounded season episode pages without upstream identity", () => {
    const seriesReferenceId = `media_${"s".repeat(22)}`;
    const episodeReferenceId = `media_${"e".repeat(22)}`;
    const seriesMedia = {
      ...catalogue.items[0]!.media,
      artwork: {
        ...catalogue.items[0]!.media.artwork,
        backdropPath: `/v1/media/${seriesReferenceId}/images/backdrop`,
        posterPath: `/v1/media/${seriesReferenceId}/images/poster`,
      },
      id: seriesReferenceId,
      kind: "series" as const,
      runtimeMinutes: null,
      title: "Northern Lights",
    };
    const season = {
      episodeCount: 8,
      playedEpisodeCount: 3,
      seasonNumber: 2,
      title: "Season 2",
    };
    const detail = {
      generatedAt: catalogue.generatedAt,
      media: seriesMedia,
      playback: null,
      seasons: [season],
      seasonsTruncated: false,
    };
    expect(libraryTitleDetailResponseSchema.parse(detail)).toEqual(detail);

    const episodes = {
      generatedAt: catalogue.generatedAt,
      items: [
        {
          media: {
            ...catalogue.items[0]!.media,
            artwork: {
              ...catalogue.items[0]!.media.artwork,
              backdropPath: `/v1/media/${episodeReferenceId}/images/backdrop`,
              posterPath: `/v1/media/${episodeReferenceId}/images/poster`,
            },
            id: episodeReferenceId,
            kind: "episode" as const,
            subtitle: "S02E03",
            title: "The Long Meridian",
          },
          playback: { durationSeconds: 2_700, played: false, positionSeconds: 900 },
        },
      ],
      nextCursor: "bGlicmFyeQ.c2lnbmF0dXJl",
      seasonNumber: 2,
      titleReferenceId: seriesReferenceId,
    };
    expect(librarySeasonEpisodesResponseSchema.parse(episodes)).toEqual(episodes);
    expect(librarySeasonEpisodesQuerySchema.parse({ limit: "20" })).toEqual({ limit: 20 });
    expect(JSON.stringify({ detail, episodes })).not.toMatch(
      /external|jellyfin\.example|upstream/iu,
    );
  });

  it("requires a bounded editable metadata field", () => {
    expect(libraryMetadataUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      libraryMetadataUpdateRequestSchema.parse({ overview: null, title: "The Far Meridian" }),
    ).toEqual({ overview: null, title: "The Far Meridian" });
    expect(libraryMetadataUpdateRequestSchema.safeParse({ path: "/private/media" }).success).toBe(
      false,
    );
  });

  it("accepts an asynchronous mutation receipt", () => {
    expect(
      libraryMutationResponseSchema.parse({
        acceptedAt: "2026-07-28T14:02:00.000Z",
        operationId: `library_operation_${"o".repeat(22)}`,
        referenceId,
        state: "accepted",
      }).state,
    ).toBe("accepted");
  });

  it("binds opaque artwork previews to their short-lived search", () => {
    const response = {
      expiresAt: "2026-07-28T14:20:00.000Z",
      generatedAt: "2026-07-28T14:00:00.000Z",
      kind: "poster" as const,
      referenceId,
      results: [
        {
          communityRating: 8.4,
          height: 3_000,
          id: resultId,
          language: "en",
          previewPath: `/v1/library/artwork-searches/${searchId}/results/${resultId}/preview`,
          providerName: "TMDb",
          voteCount: 412,
          width: 2_000,
        },
      ],
      searchId,
    };
    expect(libraryArtworkSearchResponseSchema.parse(response)).toEqual(response);
    expect(
      libraryArtworkSearchResponseSchema.safeParse({
        ...response,
        results: [{ ...response.results[0], previewPath: "https://image.tmdb.org/private" }],
      }).success,
    ).toBe(false);
  });

  it("exports Fastify-compatible response schema", () => {
    expect(libraryAttentionResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryAttentionResponseJsonSchema).toMatchObject({ type: "object" });
    expect(libraryBrowseQueryJsonSchema).not.toHaveProperty("$schema");
    expect(libraryBrowseQueryJsonSchema).toMatchObject({ type: "object" });
    expect(libraryBrowseResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryBrowseResponseJsonSchema).toMatchObject({ type: "object" });
    expect(libraryTitleDetailResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryTitleDetailResponseJsonSchema).toMatchObject({ type: "object" });
    expect(librarySeasonEpisodesQueryJsonSchema).not.toHaveProperty("$schema");
    expect(librarySeasonEpisodesResponseJsonSchema).not.toHaveProperty("$schema");
  });
});
