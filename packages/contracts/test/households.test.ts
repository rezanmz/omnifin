import { describe, expect, it } from "vitest";

import {
  conservativeChildPolicy,
  householdParentalPolicySchema,
  householdPolicyContentFactsSchema,
  householdPolicyDecisionSchema,
  householdRequestPolicyDecisionSchema,
} from "../src/households.js";

const library = "household_library_0123456789ABCDEFGHIJKL";

describe("household policy contracts", () => {
  it("provides a conservative bounded child default", () => {
    expect(conservativeChildPolicy).toMatchObject({
      maximumCertificationAge: 12,
      requestMode: "approval_required",
      unknownCertification: "block",
      version: 1,
    });
    expect(Object.isFrozen(conservativeChildPolicy)).toBe(true);
    for (const values of [
      conservativeChildPolicy.allowedLibraries,
      conservativeChildPolicy.blockedGenres,
      conservativeChildPolicy.blockedMedia,
      conservativeChildPolicy.blockedTags,
    ]) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(() => values.push("mutated")).toThrow();
    }
  });

  it("normalizes labels and rejects contradictory or duplicate lists", () => {
    expect(
      householdParentalPolicySchema.parse({
        ...conservativeChildPolicy,
        allowedLibraries: [library],
        blockedGenres: [" ＨＯＲＲＯＲ "],
        libraryMode: "allowlist",
      }),
    ).toMatchObject({ blockedGenres: ["horror"] });

    expect(() =>
      householdParentalPolicySchema.parse({
        ...conservativeChildPolicy,
        blockedTags: ["mature", "mature"],
      }),
    ).toThrow(/duplicate/u);
    expect(() =>
      householdParentalPolicySchema.parse({
        ...conservativeChildPolicy,
        allowedLibraries: [library],
      }),
    ).toThrow(/All-visible/u);
    expect(() =>
      householdParentalPolicySchema.parse({
        ...conservativeChildPolicy,
        libraryMode: "allowlist",
      }),
    ).toThrow(/requires at least one/u);
    expect(() =>
      householdParentalPolicySchema.parse({
        ...conservativeChildPolicy,
        blockedGenres: ["family\nrestricted"],
      }),
    ).toThrow(/control characters/u);
    for (const unsafeLabel of ["mature\u0085", "mature\u200b", "mature\u202e"]) {
      expect(() =>
        householdParentalPolicySchema.parse({
          ...conservativeChildPolicy,
          blockedTags: [unsafeLabel],
        }),
      ).toThrow(/control characters/u);
      expect(() =>
        householdPolicyContentFactsSchema.parse({
          certificationAge: 7,
          genres: [],
          libraryReferenceId: library,
          mediaRuleReferenceId: null,
          tags: [unsafeLabel],
        }),
      ).toThrow(/control characters/u);
    }
  });

  it("bounds and canonicalizes policy facts before evaluation", () => {
    expect(
      householdPolicyContentFactsSchema.parse({
        certificationAge: 13,
        genres: [" Science Fiction "],
        libraryReferenceId: library,
        mediaRuleReferenceId: null,
        tags: [" Family "],
      }),
    ).toEqual({
      certificationAge: 13,
      genres: ["science fiction"],
      libraryReferenceId: library,
      mediaRuleReferenceId: null,
      tags: ["family"],
    });
  });

  it("rejects contradictory content and request decisions", () => {
    expect(() =>
      householdPolicyDecisionSchema.parse({ allowed: true, reason: "blocked_media" }),
    ).toThrow();
    expect(() =>
      householdPolicyDecisionSchema.parse({ allowed: false, reason: "allowed" }),
    ).toThrow();
    expect(() =>
      householdRequestPolicyDecisionSchema.parse({
        allowed: true,
        reason: "approval_required",
        requiresApproval: false,
      }),
    ).toThrow();
  });
});
