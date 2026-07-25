import { z } from "zod";

const safeDetailKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const safeDetailValueSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const apiErrorDetailsSchema = z
  .record(safeDetailKeySchema, safeDetailValueSchema)
  .refine((details) => Object.keys(details).length <= 32, "API errors support at most 32 details");

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    message: z.string().trim().min(1).max(300),
    details: apiErrorDetailsSchema.optional(),
    requestId: z.string().trim().min(1).max(128),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export interface CreateApiErrorOptions {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, string | number | boolean | null>;
}

export function createApiError(options: CreateApiErrorOptions): ApiError {
  return apiErrorSchema.parse({
    error: {
      code: options.code,
      message: options.message,
      requestId: options.requestId,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  });
}

export const apiErrorJsonSchema = z.toJSONSchema(apiErrorSchema);
delete apiErrorJsonSchema.$schema;

export const cursorPageSchema = <T extends z.ZodType>(itemSchema: T, maximumItems = 200) => {
  if (!Number.isInteger(maximumItems) || maximumItems < 1 || maximumItems > 1_000) {
    throw new RangeError("Cursor page limits must be between 1 and 1,000 items.");
  }
  return z.object({
    items: z.array(itemSchema).max(maximumItems),
    nextCursor: z.string().min(1).max(2_048).nullable(),
  });
};

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
