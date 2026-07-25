import { apiErrorDetailsSchema, type CreateApiErrorOptions } from "@omnifin/contracts/errors";

type SafeDetails = NonNullable<CreateApiErrorOptions["details"]>;

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{2,63}$/;

export class SafeHttpError extends Error {
  public readonly code: string;
  public readonly details?: SafeDetails;
  public readonly statusCode: number;

  public constructor(options: {
    cause?: unknown;
    code: string;
    details?: SafeDetails;
    message: string;
    statusCode: number;
  }) {
    if (!SAFE_ERROR_CODE.test(options.code)) {
      throw new TypeError("Safe HTTP error codes must use the public error-code format.");
    }
    if (
      !Number.isInteger(options.statusCode) ||
      options.statusCode < 400 ||
      options.statusCode > 599
    ) {
      throw new RangeError("Safe HTTP error status codes must be between 400 and 599.");
    }
    const message = options.message.trim();
    if (message.length === 0 || message.length > 300) {
      throw new RangeError("Safe HTTP error messages must contain between 1 and 300 characters.");
    }

    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SafeHttpError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    if (options.details !== undefined) {
      const details = apiErrorDetailsSchema.safeParse(options.details);
      if (!details.success) throw new TypeError("Safe HTTP error details must be bounded scalars.");
      this.details = Object.freeze({ ...details.data });
    }
  }
}

export function isSafeHttpError(error: unknown): error is SafeHttpError {
  return error instanceof SafeHttpError;
}
