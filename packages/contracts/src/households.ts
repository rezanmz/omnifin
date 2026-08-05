import { z } from "zod";

export const HOUSEHOLD_POLICY_MAX_LIST_VALUES = 64;

export const householdIdSchema = z.string().regex(/^household_[A-Za-z0-9_-]{22}$/u);
export type HouseholdId = z.infer<typeof householdIdSchema>;

export const householdProfileIdSchema = z.string().regex(/^profile_[A-Za-z0-9_-]{22}$/u);
export type HouseholdProfileId = z.infer<typeof householdProfileIdSchema>;

export const householdLibraryReferenceIdSchema = z
  .string()
  .regex(/^household_library_[A-Za-z0-9_-]{22}$/u);
export type HouseholdLibraryReferenceId = z.infer<typeof householdLibraryReferenceIdSchema>;

export const householdMediaRuleReferenceIdSchema = z
  .string()
  .regex(/^household_media_[A-Za-z0-9_-]{22}$/u);
export type HouseholdMediaRuleReferenceId = z.infer<typeof householdMediaRuleReferenceIdSchema>;

export const householdProfileKindSchema = z.enum(["adult", "child"]);
export type HouseholdProfileKind = z.infer<typeof householdProfileKindSchema>;

const policyLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
    "Policy labels cannot contain control characters.",
  )
  .transform((value) => value.normalize("NFKC").replaceAll(/\s+/gu, " ").toLocaleLowerCase("en-US"))
  .pipe(
    z
      .string()
      .min(1)
      .max(80)
      .refine(
        (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
        "Policy labels cannot contain control characters.",
      )
      .refine(
        (value) => new TextEncoder().encode(value).length <= 160,
        "Policy labels cannot exceed 160 UTF-8 bytes.",
      ),
  );

function uniqueList<T>(values: T[], context: z.RefinementCtx, path: PropertyKey) {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: "Policy lists cannot contain duplicate values.",
      path: [path],
    });
  }
}

export const householdParentalPolicySchema = z
  .strictObject({
    allowedLibraries: z
      .array(householdLibraryReferenceIdSchema)
      .max(HOUSEHOLD_POLICY_MAX_LIST_VALUES),
    blockedGenres: z.array(policyLabelSchema).max(HOUSEHOLD_POLICY_MAX_LIST_VALUES),
    blockedMedia: z
      .array(householdMediaRuleReferenceIdSchema)
      .max(HOUSEHOLD_POLICY_MAX_LIST_VALUES),
    blockedTags: z.array(policyLabelSchema).max(HOUSEHOLD_POLICY_MAX_LIST_VALUES),
    libraryMode: z.enum(["all_visible", "allowlist"]),
    maximumCertificationAge: z.int().min(0).max(21),
    requestMode: z.enum(["disabled", "approval_required", "allowed"]),
    unknownCertification: z.enum(["block", "allow"]),
    version: z.literal(1),
  })
  .superRefine((policy, context) => {
    uniqueList(policy.allowedLibraries, context, "allowedLibraries");
    uniqueList(policy.blockedGenres, context, "blockedGenres");
    uniqueList(policy.blockedMedia, context, "blockedMedia");
    uniqueList(policy.blockedTags, context, "blockedTags");
    if (policy.libraryMode === "allowlist" && policy.allowedLibraries.length === 0) {
      context.addIssue({
        code: "custom",
        message: "An allowlist policy requires at least one library.",
        path: ["allowedLibraries"],
      });
    }
    if (policy.libraryMode === "all_visible" && policy.allowedLibraries.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "All-visible policies cannot retain an unused library allowlist.",
        path: ["allowedLibraries"],
      });
    }
  });
export type HouseholdParentalPolicy = z.infer<typeof householdParentalPolicySchema>;

function freezeHouseholdPolicy(policy: HouseholdParentalPolicy): HouseholdParentalPolicy {
  Object.freeze(policy.allowedLibraries);
  Object.freeze(policy.blockedGenres);
  Object.freeze(policy.blockedMedia);
  Object.freeze(policy.blockedTags);
  return Object.freeze(policy);
}

export const conservativeChildPolicy = freezeHouseholdPolicy(
  householdParentalPolicySchema.parse({
    allowedLibraries: [],
    blockedGenres: [],
    blockedMedia: [],
    blockedTags: [],
    libraryMode: "all_visible",
    maximumCertificationAge: 12,
    requestMode: "approval_required",
    unknownCertification: "block",
    version: 1,
  }),
);

export const householdPolicyContentFactsSchema = z.strictObject({
  certificationAge: z.int().min(0).max(99).nullable(),
  genres: z.array(policyLabelSchema).max(HOUSEHOLD_POLICY_MAX_LIST_VALUES),
  libraryReferenceId: householdLibraryReferenceIdSchema.nullable(),
  mediaRuleReferenceId: householdMediaRuleReferenceIdSchema.nullable(),
  tags: z.array(policyLabelSchema).max(HOUSEHOLD_POLICY_MAX_LIST_VALUES),
});
export type HouseholdPolicyContentFacts = z.infer<typeof householdPolicyContentFactsSchema>;

export const householdPolicyDecisionReasonSchema = z.enum([
  "allowed",
  "blocked_certification",
  "blocked_genre",
  "blocked_library",
  "blocked_media",
  "blocked_tag",
  "blocked_unknown_certification",
]);
export type HouseholdPolicyDecisionReason = z.infer<typeof householdPolicyDecisionReasonSchema>;

const householdPolicyBlockedReasonSchema = householdPolicyDecisionReasonSchema.exclude(["allowed"]);

export const householdPolicyDecisionSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true), reason: z.literal("allowed") }),
  z.strictObject({ allowed: z.literal(false), reason: householdPolicyBlockedReasonSchema }),
]);
export type HouseholdPolicyDecision = z.infer<typeof householdPolicyDecisionSchema>;

export const householdRequestPolicyDecisionSchema = z.discriminatedUnion("reason", [
  z.strictObject({
    allowed: z.literal(false),
    reason: z.enum(["disabled", "permission_denied"]),
    requiresApproval: z.literal(false),
  }),
  z.strictObject({
    allowed: z.literal(true),
    reason: z.literal("approval_required"),
    requiresApproval: z.literal(true),
  }),
  z.strictObject({
    allowed: z.literal(true),
    reason: z.literal("allowed"),
    requiresApproval: z.literal(false),
  }),
]);
export type HouseholdRequestPolicyDecision = z.infer<typeof householdRequestPolicyDecisionSchema>;
