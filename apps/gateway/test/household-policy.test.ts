import {
  conservativeChildPolicy,
  type HouseholdParentalPolicy,
  type HouseholdPolicyContentFacts,
} from "@omnifin/contracts/households";
import { describe, expect, it } from "vitest";

import {
  evaluateHouseholdContentPolicy,
  evaluateHouseholdRequestPolicy,
} from "../src/auth/household-policy.js";

const library = "household_library_0123456789ABCDEFGHIJKL";
const otherLibrary = "household_library_ABCDEFGHIJKLMNOPQRSTUV";
const media = "household_media_0123456789ABCDEFGHIJKL";

function facts(overrides: Record<string, unknown> = {}) {
  return {
    certificationAge: 7,
    genres: ["family"],
    libraryReferenceId: library,
    mediaRuleReferenceId: null,
    tags: [],
    ...overrides,
  };
}

describe("household content policy", () => {
  it("allows content only after every configured rule passes", () => {
    expect(evaluateHouseholdContentPolicy(conservativeChildPolicy, facts())).toEqual({
      allowed: true,
      reason: "allowed",
    });
  });

  it.each([
    [
      "blocked_library",
      {
        allowedLibraries: [library],
        libraryMode: "allowlist",
      },
      facts({ libraryReferenceId: otherLibrary }),
    ],
    ["blocked_media", { blockedMedia: [media] }, facts({ mediaRuleReferenceId: media })],
    ["blocked_genre", { blockedGenres: ["horror"] }, facts({ genres: ["horror"] })],
    ["blocked_tag", { blockedTags: ["mature"] }, facts({ tags: ["mature"] })],
    ["blocked_certification", { maximumCertificationAge: 12 }, facts({ certificationAge: 13 })],
    [
      "blocked_unknown_certification",
      { unknownCertification: "block" },
      facts({ certificationAge: null }),
    ],
  ])("returns the internal %s decision without leaking content", (reason, policy, content) => {
    expect(
      evaluateHouseholdContentPolicy(
        {
          ...conservativeChildPolicy,
          ...(policy as Partial<HouseholdParentalPolicy>),
        },
        content as HouseholdPolicyContentFacts,
      ),
    ).toEqual({ allowed: false, reason });
  });

  it("permits unknown certification only when an administrator explicitly opts in", () => {
    expect(
      evaluateHouseholdContentPolicy(
        { ...conservativeChildPolicy, unknownCertification: "allow" },
        facts({ certificationAge: null }),
      ),
    ).toEqual({ allowed: true, reason: "allowed" });
  });

  it("fails validation rather than evaluating unbounded or contradictory input", () => {
    expect(() =>
      evaluateHouseholdContentPolicy(
        { ...conservativeChildPolicy, allowedLibraries: [library] },
        facts(),
      ),
    ).toThrow(/All-visible/u);
    expect(() =>
      evaluateHouseholdContentPolicy(conservativeChildPolicy, facts({ certificationAge: 120 })),
    ).toThrow();
  });

  it.each([
    [false, "allowed", { allowed: false, reason: "permission_denied", requiresApproval: false }],
    [true, "disabled", { allowed: false, reason: "disabled", requiresApproval: false }],
    [
      true,
      "approval_required",
      { allowed: true, reason: "approval_required", requiresApproval: true },
    ],
    [true, "allowed", { allowed: true, reason: "allowed", requiresApproval: false }],
  ] as const)(
    "intersects permission %s with request mode %s",
    (hasRequestPermission, requestMode, expected) => {
      expect(
        evaluateHouseholdRequestPolicy(
          { ...conservativeChildPolicy, requestMode },
          hasRequestPermission,
        ),
      ).toEqual(expected);
    },
  );
});
