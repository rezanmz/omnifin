import {
  householdParentalPolicySchema,
  householdPolicyContentFactsSchema,
  householdPolicyDecisionSchema,
  householdRequestPolicyDecisionSchema,
  type HouseholdParentalPolicy,
  type HouseholdPolicyContentFacts,
  type HouseholdPolicyDecision,
  type HouseholdRequestPolicyDecision,
} from "@omnifin/contracts/households";

function blocked(
  reason: Exclude<HouseholdPolicyDecision["reason"], "allowed">,
): HouseholdPolicyDecision {
  return householdPolicyDecisionSchema.parse({ allowed: false, reason });
}

/**
 * Evaluates normalized facts without performing I/O. Callers must apply the
 * decision before allocating media/artwork references or computing public
 * counts. Child-facing routes intentionally collapse every denial reason.
 */
export function evaluateHouseholdContentPolicy(
  policyInput: HouseholdParentalPolicy,
  factsInput: HouseholdPolicyContentFacts,
): HouseholdPolicyDecision {
  const policy = householdParentalPolicySchema.parse(policyInput);
  const facts = householdPolicyContentFactsSchema.parse(factsInput);

  if (
    policy.libraryMode === "allowlist" &&
    (facts.libraryReferenceId === null ||
      !policy.allowedLibraries.includes(facts.libraryReferenceId))
  ) {
    return blocked("blocked_library");
  }
  if (
    facts.mediaRuleReferenceId !== null &&
    policy.blockedMedia.includes(facts.mediaRuleReferenceId)
  ) {
    return blocked("blocked_media");
  }
  if (facts.genres.some((genre) => policy.blockedGenres.includes(genre))) {
    return blocked("blocked_genre");
  }
  if (facts.tags.some((tag) => policy.blockedTags.includes(tag))) {
    return blocked("blocked_tag");
  }
  if (facts.certificationAge === null) {
    return policy.unknownCertification === "allow"
      ? householdPolicyDecisionSchema.parse({ allowed: true, reason: "allowed" })
      : blocked("blocked_unknown_certification");
  }
  if (facts.certificationAge > policy.maximumCertificationAge) {
    return blocked("blocked_certification");
  }
  return householdPolicyDecisionSchema.parse({ allowed: true, reason: "allowed" });
}

/**
 * Intersects request policy with an already-authorized local principal. An
 * approval-required result permits request creation only when the mutation
 * path can force the request into review rather than upstream auto-approval.
 */
export function evaluateHouseholdRequestPolicy(
  policyInput: HouseholdParentalPolicy,
  hasRequestPermission: boolean,
): HouseholdRequestPolicyDecision {
  const policy = householdParentalPolicySchema.parse(policyInput);
  if (!hasRequestPermission) {
    return householdRequestPolicyDecisionSchema.parse({
      allowed: false,
      reason: "permission_denied",
      requiresApproval: false,
    });
  }
  if (policy.requestMode === "disabled") {
    return householdRequestPolicyDecisionSchema.parse({
      allowed: false,
      reason: "disabled",
      requiresApproval: false,
    });
  }
  return policy.requestMode === "approval_required"
    ? householdRequestPolicyDecisionSchema.parse({
        allowed: true,
        reason: "approval_required",
        requiresApproval: true,
      })
    : householdRequestPolicyDecisionSchema.parse({
        allowed: true,
        reason: "allowed",
        requiresApproval: false,
      });
}
