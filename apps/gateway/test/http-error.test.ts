import { describe, expect, it } from "vitest";
import { isSafeHttpError, SafeHttpError } from "../src/http-error.js";

describe("SafeHttpError", () => {
  it("accepts only bounded public error data", () => {
    expect(
      new SafeHttpError({
        code: "permission_denied",
        message: "This action is not permitted.",
        statusCode: 403,
      }),
    ).toMatchObject({
      code: "permission_denied",
      message: "This action is not permitted.",
      name: "SafeHttpError",
      statusCode: 403,
    });

    expect(
      () => new SafeHttpError({ code: "Invalid Code", message: "Denied.", statusCode: 403 }),
    ).toThrow(/error-code format/i);
    expect(
      () => new SafeHttpError({ code: "permission_denied", message: "Denied.", statusCode: 200 }),
    ).toThrow(/between 400 and 599/i);
    expect(
      () => new SafeHttpError({ code: "permission_denied", message: "   ", statusCode: 403 }),
    ).toThrow(/between 1 and 300/i);
  });

  it("does not mistake arbitrary status-bearing errors for safe public errors", () => {
    expect(isSafeHttpError(new Error("private failure"))).toBe(false);
    expect(
      isSafeHttpError(
        new SafeHttpError({
          code: "authentication_required",
          message: "Sign in to continue.",
          statusCode: 401,
        }),
      ),
    ).toBe(true);
  });

  it("copies and validates public details at construction time", () => {
    const source = { relinkRequired: true };
    const error = new SafeHttpError({
      code: "authentication_required",
      details: source,
      message: "Sign in to continue.",
      statusCode: 401,
    });
    source.relinkRequired = false;

    expect(error.details).toEqual({ relinkRequired: true });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(
      () =>
        new SafeHttpError({
          code: "invalid_request",
          details: { nested: { secret: "must-not-escape" } } as never,
          message: "The request is invalid.",
          statusCode: 400,
        }),
    ).toThrow(/bounded scalars/i);
  });
});
