import { z } from "zod";

export const AUDIT_EVENT_PAGE_DEFAULT_COUNT = 25;
export const AUDIT_EVENT_PAGE_MAX_COUNT = 50;

const safeLabelSchema = z.string().trim().min(1).max(160);
const timestampSchema = z.iso.datetime({ offset: true });

export const auditEventCategorySchema = z.enum([
  "access",
  "acquisition",
  "authentication",
  "configuration",
  "downloads",
  "indexers",
  "issues",
  "library",
  "requests",
  "system",
]);
export type AuditEventCategory = z.infer<typeof auditEventCategorySchema>;

export const auditEventOutcomeSchema = z.enum(["success", "denied", "failure"]);
export type AuditEventOutcome = z.infer<typeof auditEventOutcomeSchema>;

export const auditEventActorSchema = z.strictObject({
  authenticationMethod: z.enum(["oidc", "jellyfin", "recovery"]).nullable(),
  displayName: safeLabelSchema,
  kind: z.enum(["user", "recovery", "system", "removed_user"]),
});
export type AuditEventActor = z.infer<typeof auditEventActorSchema>;

export const auditEventSchema = z.strictObject({
  actor: auditEventActorSchema,
  category: auditEventCategorySchema,
  eventType: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-z][a-z0-9_.:-]+$/u),
  id: z.string().regex(/^audit_[A-Za-z0-9_-]{22}$/u),
  occurredAt: timestampSchema,
  outcome: auditEventOutcomeSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditEventCursorSchema = z
  .string()
  .min(64)
  .max(512)
  .regex(/^audit_cursor_v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/u);

export const auditEventListQuerySchema = z.strictObject({
  category: auditEventCategorySchema.optional(),
  cursor: auditEventCursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_EVENT_PAGE_MAX_COUNT)
    .default(AUDIT_EVENT_PAGE_DEFAULT_COUNT),
  outcome: auditEventOutcomeSchema.optional(),
});
export type AuditEventListQuery = z.infer<typeof auditEventListQuerySchema>;

export const auditEventListResponseSchema = z.strictObject({
  events: z.array(auditEventSchema).max(AUDIT_EVENT_PAGE_MAX_COUNT),
  generatedAt: timestampSchema,
  nextCursor: auditEventCursorSchema.nullable(),
});
export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const auditEventListResponseJsonSchema = withoutSchemaDialect(auditEventListResponseSchema);
