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

export const stackVerificationCheckIds = [
  "oidc",
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "bazarr",
  "qbittorrent",
  "sabnzbd",
] as const;

export const stackVerificationCapabilities = [
  "connector.health",
  "connector.version",
  "identity.authenticate",
  "identity.quick_connect",
  "media.detail",
  "media.discover",
  "media.library.read",
  "media.library.mutate",
  "media.playback",
  "media.watch_state",
  "request.configure",
  "request.create",
  "request.review",
  "acquisition.search",
  "acquisition.grab",
  "acquisition.history",
  "acquisition.calendar",
  "acquisition.monitoring",
  "acquisition.queue.mutate",
  "indexer.statistics",
  "indexer.test",
  "system.health",
  "storage.read",
  "download.queue.read",
  "download.queue.mutate",
  "subtitle.search",
  "subtitle.download",
  "issue.read",
  "issue.manage",
  "oidc.authorization_code",
  "oidc.pkce_s256",
  "oidc.userinfo",
  "oidc.logout.rp_initiated",
  "oidc.logout.front_channel",
  "oidc.logout.back_channel",
] as const;

export const stackVerificationFindingCodes = [
  "configuration_invalid",
  "destination_blocked",
  "disabled",
  "invalid_credentials",
  "rate_limited",
  "response_invalid",
  "timeout",
  "unreachable",
  "unsupported_version",
  "upstream_error",
  "verification_unavailable",
  "version_redacted",
] as const;

export type StackVerificationCapability = (typeof stackVerificationCapabilities)[number];
export type StackVerificationFindingCode = (typeof stackVerificationFindingCodes)[number];

export const stackVerificationStateSchema = z.enum([
  "attention",
  "not_configured",
  "partial",
  "ready",
]);
export type StackVerificationState = z.infer<typeof stackVerificationStateSchema>;

const normalizedVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^v?[0-9]{1,8}(?:\.[0-9]{1,8}){1,5}$/u);

export const stackVerificationFindingSchema = z.strictObject({
  code: z.enum(stackVerificationFindingCodes),
  count: z.int().min(1).max(100),
});
export type StackVerificationFinding = z.infer<typeof stackVerificationFindingSchema>;

export const stackVerificationCheckSchema = z.strictObject({
  attemptedCount: z.int().min(0).max(100),
  capabilities: z
    .array(z.enum(stackVerificationCapabilities))
    .max(stackVerificationCapabilities.length),
  configuredCount: z.int().min(0).max(100),
  enabledCount: z.int().min(0).max(100),
  findings: z.array(stackVerificationFindingSchema).max(stackVerificationFindingCodes.length),
  id: z.enum(stackVerificationCheckIds),
  readyCount: z.int().min(0).max(100),
  state: stackVerificationStateSchema,
  versions: z.array(normalizedVersionSchema).max(16),
});
export type StackVerificationCheck = z.infer<typeof stackVerificationCheckSchema>;

function isCanonicalUniqueOrder(values: readonly string[], canonical: readonly string[]) {
  const positions = values.map((value) => canonical.indexOf(value));
  return (
    positions.every((position) => position >= 0) &&
    new Set(values).size === values.length &&
    positions.every((position, index) => index === 0 || position > positions[index - 1]!)
  );
}

function verificationState(configuredCount: number, readyCount: number) {
  if (configuredCount === 0) return "not_configured" as const;
  if (readyCount === configuredCount) return "ready" as const;
  if (readyCount === 0) return "attention" as const;
  return "partial" as const;
}

export const stackVerificationResponseSchema = z
  .strictObject({
    checks: z.array(stackVerificationCheckSchema).length(stackVerificationCheckIds.length),
    configuredCount: z.int().min(0).max(150),
    format: z.literal("omnifin-stack-verification"),
    generatedAt: z.iso.datetime({ offset: true }),
    readyCount: z.int().min(0).max(150),
    schemaVersion: z.literal(1),
    scope: z.literal("local_diagnostic"),
    state: stackVerificationStateSchema,
  })
  .superRefine((value, context) => {
    for (const [index, expectedId] of stackVerificationCheckIds.entries()) {
      const check = value.checks[index];
      if (check?.id !== expectedId) {
        context.addIssue({
          code: "custom",
          message: "Verification checks must use the canonical order.",
          path: ["checks", index, "id"],
        });
      }
      if (!check) continue;
      if (
        check.attemptedCount > check.configuredCount ||
        check.enabledCount > check.configuredCount ||
        check.readyCount > check.enabledCount ||
        check.readyCount > check.attemptedCount
      ) {
        context.addIssue({
          code: "custom",
          message: "Verification counts are inconsistent.",
          path: ["checks", index],
        });
      }
      if (check.state !== verificationState(check.configuredCount, check.readyCount)) {
        context.addIssue({
          code: "custom",
          message: "Verification state must match configured and ready counts.",
          path: ["checks", index, "state"],
        });
      }
      if (
        !isCanonicalUniqueOrder(check.capabilities, stackVerificationCapabilities) ||
        !isCanonicalUniqueOrder(
          check.findings.map(({ code }) => code),
          stackVerificationFindingCodes,
        ) ||
        [...check.versions]
          .sort((left, right) => left.localeCompare(right))
          .some((version, versionIndex) => version !== check.versions[versionIndex]) ||
        new Set(check.versions).size !== check.versions.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Verification details must be unique and canonical.",
          path: ["checks", index],
        });
      }
    }
    const configuredCount = value.checks.reduce((total, check) => total + check.configuredCount, 0);
    const readyCount = value.checks.reduce((total, check) => total + check.readyCount, 0);
    if (value.configuredCount !== configuredCount || value.readyCount !== readyCount) {
      context.addIssue({
        code: "custom",
        message: "Verification totals must match the checks.",
        path: ["configuredCount"],
      });
    }
    if (value.state !== verificationState(configuredCount, readyCount)) {
      context.addIssue({
        code: "custom",
        message: "Verification summary state must match its totals.",
        path: ["state"],
      });
    }
  });
export type StackVerificationResponse = z.infer<typeof stackVerificationResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const setupReadinessResponseJsonSchema = withoutSchemaDialect(setupReadinessResponseSchema);
export const stackVerificationResponseJsonSchema = withoutSchemaDialect(
  stackVerificationResponseSchema,
);
