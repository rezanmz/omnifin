import { roleMappingSchema, type RoleMapping } from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";
import { validateOidcClaims, type ValidatedOidcClaims } from "../src/auth/oidc/claims.js";
import { resolveOidcRole } from "../src/auth/oidc/role-mapping.js";

function claims(input: Record<string, unknown>) {
  const result = validateOidcClaims({ sub: "subject-1", ...input });
  if (!result.ok) throw new Error(`Invalid claim fixture: ${result.code}`);
  return result.value;
}

function mapping(overrides: Partial<RoleMapping> = {}) {
  return roleMappingSchema.parse({
    claimPath: ["groups"],
    enabled: true,
    id: "operators",
    operator: "contains_any",
    priority: 100,
    providerId: "oidc-home",
    role: "operator",
    values: ["media-operators"],
    ...overrides,
  });
}

function resolve(
  normalizedClaims: ValidatedOidcClaims,
  mappings: readonly RoleMapping[],
  providerId = "oidc-home",
) {
  return resolveOidcRole({ claims: normalizedClaims, mappings, providerId });
}

describe("OIDC role mapping", () => {
  it("defaults to viewer when no enabled provider mapping matches", () => {
    const normalized = claims({ groups: ["media-operators"] });
    for (const mappings of [
      [],
      [mapping({ enabled: false })],
      [mapping({ providerId: "oidc-other" })],
      [mapping({ claimPath: ["missing"] })],
      [mapping({ values: ["MEDIA-OPERATORS"] })],
    ]) {
      expect(resolve(normalized, mappings)).toEqual({
        mappingIds: [],
        priority: null,
        role: "viewer",
        source: "default",
        status: "resolved",
      });
    }
  });

  it("uses exact case-sensitive scalar equality without coercion", () => {
    const normalized = claims({
      assurance: 2,
      email_verified: true,
      tenant: "42",
    });
    expect(
      resolve(normalized, [
        mapping({
          claimPath: ["tenant"],
          id: "tenant-string",
          operator: "equals",
          role: "requester",
          values: ["42"],
        }),
      ]),
    ).toMatchObject({ role: "requester", source: "oidc_mapping" });

    for (const candidate of [
      mapping({ claimPath: ["tenant"], operator: "equals", values: [42] }),
      mapping({ claimPath: ["tenant"], operator: "equals", values: ["Tenant"] }),
      mapping({ claimPath: ["assurance"], operator: "equals", values: ["2"] }),
      mapping({ claimPath: ["email_verified"], operator: "equals", values: ["true"] }),
    ]) {
      expect(resolve(normalized, [candidate])).toMatchObject({ role: "viewer", source: "default" });
    }

    expect(
      resolve(normalized, [
        mapping({
          claimPath: ["assurance"],
          id: "assurance-number",
          operator: "equals",
          values: [2],
        }),
      ]),
    ).toMatchObject({ role: "operator", source: "oidc_mapping" });
    expect(
      resolve(normalized, [
        mapping({
          claimPath: ["email_verified"],
          id: "verified-boolean",
          operator: "equals",
          values: [true],
        }),
      ]),
    ).toMatchObject({ role: "operator", source: "oidc_mapping" });
  });

  it("implements array membership for contains_any and contains_all", () => {
    const normalized = claims({ groups: ["trusted", "media-operators", 7] });
    expect(
      resolve(normalized, [
        mapping({
          id: "any",
          operator: "contains_any",
          values: ["missing", "media-operators"],
        }),
      ]),
    ).toMatchObject({ mappingIds: ["any"], role: "operator" });
    expect(
      resolve(normalized, [
        mapping({
          id: "all",
          operator: "contains_all",
          values: ["trusted", "media-operators", 7],
        }),
      ]),
    ).toMatchObject({ mappingIds: ["all"], role: "operator" });
    expect(
      resolve(normalized, [
        mapping({ id: "all-missing", operator: "contains_all", values: ["trusted", "missing"] }),
      ]),
    ).toMatchObject({ role: "viewer", source: "default" });

    const scalar = claims({ groups: "media-operators-and-more" });
    expect(resolve(scalar, [mapping()])).toMatchObject({ role: "viewer", source: "default" });
    const mixed = claims({ groups: ["media-operators", { nested: true }] });
    expect(resolve(mixed, [mapping()])).toMatchObject({ role: "viewer", source: "default" });
  });

  it("matches nested own-property paths from the validated claim graph", () => {
    const normalized = claims({ realm_access: { entitlements: ["media-admin"] } });
    expect(
      resolve(normalized, [
        mapping({
          claimPath: ["realm_access", "entitlements"],
          id: "nested-admin",
          role: "admin",
          values: ["media-admin"],
        }),
      ]),
    ).toMatchObject({ mappingIds: ["nested-admin"], role: "admin" });
  });

  it("selects the highest matching priority independently of input order", () => {
    const normalized = claims({ groups: ["requesters", "operators", "trusted"] });
    const mappings = [
      mapping({ id: "requesters", priority: 10, role: "requester", values: ["requesters"] }),
      mapping({ id: "operators-z", priority: 200, values: ["operators"] }),
      mapping({ id: "operators-a", priority: 200, values: ["trusted"] }),
    ];
    const expected = {
      mappingIds: ["operators-a", "operators-z"],
      priority: 200,
      role: "operator",
      source: "oidc_mapping",
      status: "resolved",
    };
    expect(resolve(normalized, mappings)).toEqual(expected);
    expect(resolve(normalized, [...mappings].reverse())).toEqual(expected);
    expect(Object.isFrozen(resolve(normalized, mappings))).toBe(true);
    expect(Object.isFrozen(resolve(normalized, mappings).mappingIds)).toBe(true);
  });

  it("denies conflicting roles at the same highest matching priority", () => {
    const normalized = claims({ groups: ["requesters", "operators", "admins"] });
    const result = resolve(normalized, [
      mapping({ id: "lower", priority: 50, role: "requester", values: ["requesters"] }),
      mapping({ id: "operator", priority: 200, role: "operator", values: ["operators"] }),
      mapping({ id: "admin", priority: 200, role: "admin", values: ["admins"] }),
    ]);
    expect(result).toEqual({
      mappingIds: ["admin", "operator"],
      priority: 200,
      reason: "ambiguous_highest_priority",
      roles: ["admin", "operator"],
      status: "denied",
    });
  });

  it("ignores lower-priority role differences once a unique highest match exists", () => {
    const normalized = claims({ groups: ["requesters", "admins"] });
    expect(
      resolve(normalized, [
        mapping({ id: "requester", priority: 50, role: "requester", values: ["requesters"] }),
        mapping({ id: "admin", priority: 200, role: "admin", values: ["admins"] }),
      ]),
    ).toMatchObject({ mappingIds: ["admin"], priority: 200, role: "admin", status: "resolved" });
  });

  it("fails closed for forged claims, malformed mappings, and invalid provider context", () => {
    const normalized = claims({ groups: ["media-operators"] });
    expect(
      resolveOidcRole({
        claims: {
          displayClaims: {},
          subject: "forged-subject",
        } as ValidatedOidcClaims,
        mappings: [mapping()],
        providerId: "oidc-home",
      }),
    ).toEqual({
      mappingIds: [],
      priority: null,
      reason: "invalid_claims",
      roles: [],
      status: "denied",
    });

    const malformed = { ...mapping(), claimPath: ["__proto__"] } as unknown as RoleMapping;
    expect(resolve(normalized, [malformed])).toMatchObject({
      reason: "invalid_mapping_contract",
      status: "denied",
    });
    const normalizedIdentifier = {
      ...mapping(),
      providerId: " oidc-home",
    } as unknown as RoleMapping;
    expect(resolve(normalized, [normalizedIdentifier])).toMatchObject({
      reason: "invalid_mapping_contract",
      status: "denied",
    });
    expect(resolve(normalized, [mapping()], " oidc-home")).toMatchObject({
      reason: "invalid_mapping_contract",
      status: "denied",
    });
    expect(
      resolve(
        normalized,
        Array.from({ length: 513 }, () => mapping()),
      ),
    ).toMatchObject({
      reason: "invalid_mapping_contract",
      status: "denied",
    });
  });
});
