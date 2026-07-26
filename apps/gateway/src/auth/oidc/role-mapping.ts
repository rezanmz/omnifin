import {
  OIDC_ROLE_MAPPINGS_MAX_COUNT,
  roleMappingSchema,
  type Role,
  type RoleMapping,
} from "@omnifin/contracts/auth";
import {
  isOidcClaimScalar,
  isValidatedOidcClaims,
  readOidcClaim,
  type OidcClaimScalar,
  type OidcClaimValue,
  type ValidatedOidcClaims,
} from "./claims.js";

export type OidcRoleResolution =
  | {
      readonly mappingIds: readonly [];
      readonly priority: null;
      readonly role: "viewer";
      readonly source: "default";
      readonly status: "resolved";
    }
  | {
      readonly mappingIds: readonly string[];
      readonly priority: number;
      readonly role: Role;
      readonly source: "oidc_mapping";
      readonly status: "resolved";
    }
  | {
      readonly mappingIds: readonly string[];
      readonly priority: number | null;
      readonly reason: "ambiguous_highest_priority" | "invalid_claims" | "invalid_mapping_contract";
      readonly roles: readonly Role[];
      readonly status: "denied";
    };

export interface ResolveOidcRoleInput {
  readonly claims: ValidatedOidcClaims;
  readonly mappings: readonly RoleMapping[];
  readonly providerId: string;
}

function scalarEquals(left: OidcClaimScalar, right: OidcClaimScalar) {
  return typeof left === typeof right && left === right;
}

function scalarArray(value: OidcClaimValue): readonly OidcClaimScalar[] | undefined {
  if (!Array.isArray(value) || !value.every(isOidcClaimScalar)) return undefined;
  return value;
}

function matchesMapping(claims: ValidatedOidcClaims, mapping: RoleMapping) {
  const claim = readOidcClaim(claims, mapping.claimPath);
  if (claim === undefined) return false;

  if (mapping.operator === "equals") {
    return isOidcClaimScalar(claim) && mapping.values.some((value) => scalarEquals(claim, value));
  }

  const claimValues = scalarArray(claim);
  if (!claimValues) return false;
  if (mapping.operator === "contains_any") {
    return mapping.values.some((expected) =>
      claimValues.some((actual) => scalarEquals(actual, expected)),
    );
  }
  return mapping.values.every((expected) =>
    claimValues.some((actual) => scalarEquals(actual, expected)),
  );
}

function invalidResolution(
  reason: "invalid_claims" | "invalid_mapping_contract",
): OidcRoleResolution {
  return Object.freeze({
    mappingIds: Object.freeze([]),
    priority: null,
    reason,
    roles: Object.freeze([]),
    status: "denied",
  });
}

export function resolveOidcRole(input: ResolveOidcRoleInput): OidcRoleResolution {
  if (!isValidatedOidcClaims(input.claims)) return invalidResolution("invalid_claims");
  if (
    typeof input.providerId !== "string" ||
    input.providerId.length === 0 ||
    input.providerId.length > 128 ||
    input.providerId.trim() !== input.providerId ||
    !Array.isArray(input.mappings) ||
    input.mappings.length > OIDC_ROLE_MAPPINGS_MAX_COUNT
  ) {
    return invalidResolution("invalid_mapping_contract");
  }

  const mappings: RoleMapping[] = [];
  try {
    for (const candidate of input.mappings) {
      const parsed = roleMappingSchema.safeParse(candidate);
      if (!parsed.success) return invalidResolution("invalid_mapping_contract");
      if (parsed.data.id !== candidate.id || parsed.data.providerId !== candidate.providerId) {
        return invalidResolution("invalid_mapping_contract");
      }
      mappings.push(parsed.data);
    }
  } catch {
    return invalidResolution("invalid_mapping_contract");
  }

  const matches = mappings.filter(
    (mapping) =>
      mapping.enabled &&
      mapping.providerId === input.providerId &&
      matchesMapping(input.claims, mapping),
  );
  if (matches.length === 0) {
    return Object.freeze({
      mappingIds: Object.freeze([]) as readonly [],
      priority: null,
      role: "viewer",
      source: "default",
      status: "resolved",
    });
  }

  const priority = Math.max(...matches.map((mapping) => mapping.priority));
  const highestPriorityMatches = matches.filter((mapping) => mapping.priority === priority);
  const roles = [...new Set(highestPriorityMatches.map((mapping) => mapping.role))].sort();
  const mappingIds = [...new Set(highestPriorityMatches.map((mapping) => mapping.id))].sort();
  if (roles.length !== 1) {
    return Object.freeze({
      mappingIds: Object.freeze(mappingIds),
      priority,
      reason: "ambiguous_highest_priority",
      roles: Object.freeze(roles),
      status: "denied",
    });
  }
  const role = roles[0];
  if (!role) return invalidResolution("invalid_mapping_contract");

  return Object.freeze({
    mappingIds: Object.freeze(mappingIds),
    priority,
    role,
    source: "oidc_mapping",
    status: "resolved",
  });
}
