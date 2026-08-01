import { z } from "zod";

export const setupReadinessStepIds = [
  "identity",
  "jellyfin",
  "oidc",
  "discovery",
  "acquisition",
  "indexers",
  "subtitles",
  "downloads",
] as const;

export const setupReadinessStepStateSchema = z.enum([
  "attention",
  "not_configured",
  "partial",
  "ready",
]);
export type SetupReadinessStepState = z.infer<typeof setupReadinessStepStateSchema>;

export const setupReadinessStepSchema = z.strictObject({
  configuredCount: z.int().min(0).max(250),
  id: z.enum(setupReadinessStepIds),
  readyCount: z.int().min(0).max(250),
  state: setupReadinessStepStateSchema,
});
export type SetupReadinessStep = z.infer<typeof setupReadinessStepSchema>;

export const setupReadinessResponseSchema = z
  .strictObject({
    coreReady: z.boolean(),
    essentialCompleted: z.int().min(0).max(2),
    essentialTotal: z.literal(2),
    generatedAt: z.iso.datetime({ offset: true }),
    optionalReady: z.int().min(0).max(6),
    optionalTotal: z.literal(6),
    steps: z.array(setupReadinessStepSchema).length(setupReadinessStepIds.length),
  })
  .superRefine((value, context) => {
    for (const [index, expectedId] of setupReadinessStepIds.entries()) {
      if (value.steps[index]?.id !== expectedId) {
        context.addIssue({
          code: "custom",
          message: "Readiness steps must use the canonical order.",
          path: ["steps", index, "id"],
        });
      }
    }
    for (const [index, step] of value.steps.entries()) {
      if (step.readyCount > step.configuredCount) {
        context.addIssue({
          code: "custom",
          message: "Ready count cannot exceed configured count.",
          path: ["steps", index, "readyCount"],
        });
      }
      const expectedState =
        step.configuredCount === 0
          ? "not_configured"
          : step.readyCount === 0
            ? "attention"
            : step.readyCount === step.configuredCount
              ? "ready"
              : "partial";
      if (step.state !== expectedState) {
        context.addIssue({
          code: "custom",
          message: "Readiness state must match the configured and ready counts.",
          path: ["steps", index, "state"],
        });
      }
    }
    const derivedEssential = value.steps
      .slice(0, 2)
      .filter(({ state }) => state === "ready" || state === "partial").length;
    const derivedOptional = value.steps
      .slice(2)
      .filter(({ state }) => state === "ready" || state === "partial").length;
    if (value.essentialCompleted !== derivedEssential) {
      context.addIssue({
        code: "custom",
        message: "Essential completion count must match the readiness steps.",
        path: ["essentialCompleted"],
      });
    }
    if (value.optionalReady !== derivedOptional) {
      context.addIssue({
        code: "custom",
        message: "Optional completion count must match the readiness steps.",
        path: ["optionalReady"],
      });
    }
    if (value.coreReady !== (derivedEssential === value.essentialTotal)) {
      context.addIssue({
        code: "custom",
        message: "Core readiness must match essential completion.",
        path: ["coreReady"],
      });
    }
  });
export type SetupReadinessResponse = z.infer<typeof setupReadinessResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const setupReadinessResponseJsonSchema = withoutSchemaDialect(setupReadinessResponseSchema);
