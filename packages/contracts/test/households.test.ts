import { describe, expect, it } from "vitest";

import {
  conservativeChildPolicy,
  householdParentalPolicySchema,
  householdPolicyContentFactsSchema,
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
});
