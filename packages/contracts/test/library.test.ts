import { describe, expect, it } from "vitest";

import {
  libraryArtworkSearchResponseSchema,
  libraryAttentionQuerySchema,
  libraryAttentionResponseJsonSchema,
  libraryAttentionResponseSchema,
  libraryItemRefreshRequestSchema,
  libraryMetadataUpdateRequestSchema,
  libraryMutationResponseSchema,
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
  });
});
