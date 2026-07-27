import { describe, expect, it } from "vitest";

import {
  idempotencyKeySchema,
  mediaRequestInputJsonSchema,
  mediaRequestInputSchema,
  mediaRequestResponseJsonSchema,
  mediaRequestResponseSchema,
} from "../src/requests.js";

describe("media request contracts", () => {
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
  });
});
