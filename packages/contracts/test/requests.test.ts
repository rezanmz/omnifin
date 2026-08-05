import { describe, expect, it } from "vitest";

import {
  idempotencyKeySchema,
  mediaRequestInputJsonSchema,
  mediaRequestInputSchema,
  mediaRequestResponseJsonSchema,
  mediaRequestResponseSchema,
  mediaRequestRoutingOptionsResponseJsonSchema,
  mediaRequestRoutingOptionsResponseSchema,
  mediaRequestRoutingSelectionSchema,
  requestReviewDecisionInputJsonSchema,
  requestReviewDecisionInputSchema,
  requestReviewItemJsonSchema,
  requestReviewItemSchema,
  requestReviewPageJsonSchema,
  requestReviewPageSchema,
  requestReviewQuerySchema,
} from "../src/requests.js";

describe("media request contracts", () => {
  const routingReference = (suffix: string) =>
    `routing-v1.v2.AAAAAAAAAAAAAAAA.${"B".repeat(48)}${suffix}.${"C".repeat(22)}`;

  it("normalizes the smallest safe movie and series inputs", () => {
    expect(mediaRequestInputSchema.parse({ kind: "movie", tmdbId: 550 })).toEqual({
      is4k: false,
      kind: "movie",
      tmdbId: 550,
    });
    expect(
      mediaRequestInputSchema.parse({
        is4k: true,
        kind: "series",
        seasons: [3, 1, 0],
        tmdbId: 1399,
      }),
    ).toEqual({ is4k: true, kind: "series", seasons: [3, 1, 0], tmdbId: 1399 });
    expect(mediaRequestInputSchema.parse({ kind: "series", tmdbId: 1399 })).toEqual({
      is4k: false,
      kind: "series",
      seasons: "all",
      tmdbId: 1399,
    });
  });

  it("rejects upstream administration fields and ambiguous season inputs", () => {
    expect(
      mediaRequestInputSchema.safeParse({
        kind: "movie",
        profileId: 1,
        rootFolder: "/private/media",
        tmdbId: 550,
        userId: 1,
      }).success,
    ).toBe(false);
    expect(
      mediaRequestInputSchema.safeParse({
        kind: "series",
        seasons: [1, 1],
        tmdbId: 1399,
      }).success,
    ).toBe(false);
    expect(
      mediaRequestInputSchema.safeParse({ kind: "series", seasons: [], tmdbId: 1399 }).success,
    ).toBe(false);
  });

  it("accepts only opaque routing selections and normalized routing options", () => {
    const routing = {
      destination: routingReference("destination"),
      languageProfile: null,
      qualityProfile: routingReference("profile"),
      rootFolder: routingReference("root"),
    };
    expect(mediaRequestRoutingSelectionSchema.parse(routing)).toEqual(routing);
    expect(
      mediaRequestRoutingSelectionSchema.safeParse({
        ...routing,
        rootFolder: "/private/media/movies",
      }).success,
    ).toBe(false);

    const response = {
      destinations: [
        {
          id: routing.destination,
          isDefault: true,
          label: "Cinema",
          languageProfiles: [],
          qualityProfiles: [{ id: routing.qualityProfile, isDefault: true, label: "1080p" }],
          rootFolders: [
            {
              availableBytes: 1_000_000,
              capacityBytes: 2_000_000,
              id: routing.rootFolder,
              isDefault: true,
              label: "Movies",
            },
          ],
          service: "radarr",
        },
      ],
      expiresAt: "2026-07-29T17:15:00.000Z",
      failures: [],
      generatedAt: "2026-07-29T17:00:00.000Z",
      is4k: false,
      kind: "movie",
    } as const;
    expect(mediaRequestRoutingOptionsResponseSchema.parse(response)).toEqual(response);
    expect(JSON.stringify(response)).not.toContain("/private/media");
  });

  it("accepts only bounded replay keys", () => {
    expect(idempotencyKeySchema.parse("request-01HQZ6TQ8E8QD0N4GZ4TVEW4WD")).toBe(
      "request-01HQZ6TQ8E8QD0N4GZ4TVEW4WD",
    );
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("../../private").success).toBe(false);
  });

  it("keeps the response normalized and rejects raw upstream relations", () => {
    const response = {
      createdAt: "2026-07-27T16:30:00.000Z",
      id: "request:42",
      is4k: false,
      kind: "movie",
      qualityProfile: "1080p",
      seasons: null,
      source: "seerr",
      status: "approved",
      tmdbId: 550,
    } as const;
    expect(mediaRequestResponseSchema.parse(response)).toEqual(response);
    expect(
      mediaRequestResponseSchema.safeParse({
        ...response,
        requestedBy: { email: "private@example.test" },
      }).success,
    ).toBe(false);
  });

  it("publishes dialect-neutral route schemas", () => {
    expect(mediaRequestInputJsonSchema).not.toHaveProperty("$schema");
    expect(mediaRequestResponseJsonSchema).not.toHaveProperty("$schema");
    expect(mediaRequestRoutingOptionsResponseJsonSchema).not.toHaveProperty("$schema");
    expect(requestReviewDecisionInputJsonSchema).not.toHaveProperty("$schema");
    expect(requestReviewItemJsonSchema).not.toHaveProperty("$schema");
    expect(requestReviewPageJsonSchema).not.toHaveProperty("$schema");
  });

  it("normalizes bounded request-review pagination and decisions", () => {
    expect(requestReviewQuerySchema.parse({})).toEqual({
      cursor: null,
      limit: 20,
      status: "pending",
    });
    expect(
      requestReviewQuerySchema.parse({ cursor: "requests:20", limit: 12, status: "all" }),
    ).toEqual({ cursor: "requests:20", limit: 12, status: "all" });
    expect(requestReviewQuerySchema.safeParse({ cursor: "20" }).success).toBe(false);
    expect(requestReviewQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(requestReviewDecisionInputSchema.parse({ decision: "approve" })).toEqual({
      decision: "approve",
    });
    expect(
      requestReviewDecisionInputSchema.safeParse({ decision: "approve", requestId: 42 }).success,
    ).toBe(false);
  });

  it("allows only normalized request-review records", () => {
    const item = {
      createdAt: "2026-07-28T16:30:00.000Z",
      id: "request:42",
      is4k: false,
      kind: "movie",
      qualityProfile: "1080p",
      requestedBy: "Alex",
      seasons: null,
      source: "seerr",
      status: "pending",
      title: "The Long Meridian",
      tmdbId: 550,
      updatedAt: "2026-07-28T16:35:00.000Z",
      year: 2026,
    } as const;
    expect(requestReviewItemSchema.parse(item)).toEqual(item);
    expect(
      requestReviewPageSchema.parse({
        generatedAt: "2026-07-28T16:36:00.000Z",
        items: [item],
        nextCursor: "requests:20",
        status: "pending",
      }),
    ).toMatchObject({ items: [item], nextCursor: "requests:20" });
    expect(
      requestReviewItemSchema.safeParse({
        ...item,
        requestedBy: { email: "private@example.test" },
      }).success,
    ).toBe(false);
  });
});
