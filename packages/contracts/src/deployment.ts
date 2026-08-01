import { z } from "zod";

export const deploymentReadinessCheckIds = ["runtime", "transport", "recovery", "storage"] as const;

export const deploymentReadinessCheckStateSchema = z.enum(["attention", "ready"]);
export type DeploymentReadinessCheckState = z.infer<typeof deploymentReadinessCheckStateSchema>;

export const deploymentReadinessCheckSchema = z.strictObject({
  id: z.enum(deploymentReadinessCheckIds),
  state: deploymentReadinessCheckStateSchema,
});
export type DeploymentReadinessCheck = z.infer<typeof deploymentReadinessCheckSchema>;

export const deploymentReadinessResponseSchema = z
  .strictObject({
    checks: z.array(deploymentReadinessCheckSchema).length(deploymentReadinessCheckIds.length),
    generatedAt: z.iso.datetime({ offset: true }),
    readyCount: z.int().min(0).max(deploymentReadinessCheckIds.length),
    state: deploymentReadinessCheckStateSchema,
    total: z.literal(deploymentReadinessCheckIds.length),
  })
  .superRefine((value, context) => {
    for (const [index, expectedId] of deploymentReadinessCheckIds.entries()) {
      if (value.checks[index]?.id !== expectedId) {
        context.addIssue({
          code: "custom",
          message: "Deployment readiness checks must use the canonical order.",
          path: ["checks", index, "id"],
        });
      }
    }

    const readyCount = value.checks.filter(({ state }) => state === "ready").length;
    if (value.readyCount !== readyCount) {
      context.addIssue({
        code: "custom",
        message: "Deployment ready count must match its checks.",
        path: ["readyCount"],
      });
    }
    if (value.state !== (readyCount === value.total ? "ready" : "attention")) {
      context.addIssue({
        code: "custom",
        message: "Deployment state must match its checks.",
        path: ["state"],
      });
    }
  });
export type DeploymentReadinessResponse = z.infer<typeof deploymentReadinessResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const deploymentReadinessResponseJsonSchema = withoutSchemaDialect(
  deploymentReadinessResponseSchema,
);
