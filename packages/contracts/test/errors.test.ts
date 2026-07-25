import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  apiErrorJsonSchema,
  apiErrorSchema,
  createApiError,
  cursorPageSchema,
} from "../src/errors.js";

describe("API boundary contracts", () => {
  it("enforces a hard cursor-page bound", () => {
    const pageSchema = cursorPageSchema(z.string(), 2);

    expect(pageSchema.safeParse({ items: ["one", "two"], nextCursor: null }).success).toBe(true);
    expect(pageSchema.safeParse({ items: ["one", "two", "three"], nextCursor: null }).success).toBe(
      false,
    );
    expect(() => cursorPageSchema(z.string(), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("strips non-scalar internal details from public API errors", () => {
    const error = apiErrorSchema.parse({
      error: {
        code: "connector_unavailable",
        message: "The configured connector is unavailable.",
        requestId: "req_fixture",
        details: { connectorId: "radarr-main" },
        stack: "must-not-cross-the-boundary",
      },
    });

    expect(error.error).not.toHaveProperty("stack");
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: "connector_unavailable",
          details: { nested: { secret: "private" } },
          message: "The configured connector is unavailable.",
          requestId: "req_fixture",
        },
      }).success,
    ).toBe(false);
  });

  it("constructs the same error envelope used by gateway response schemas", () => {
    const error = createApiError({
      code: "service_unavailable",
      message: "The service is temporarily unavailable.",
      requestId: "req_fixture",
    });

    expect(apiErrorSchema.parse(error)).toEqual(error);
    expect(apiErrorJsonSchema).not.toHaveProperty("$schema");
  });
});
