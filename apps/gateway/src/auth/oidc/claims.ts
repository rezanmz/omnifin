import { z } from "zod";

const blockedClaimKeys = new Set(["__proto__", "constructor", "prototype"]);

export const OIDC_CLAIM_LIMITS = Object.freeze({
  arrayLength: 128,
  depth: 8,
  keyLength: 128,
  keysPerObject: 64,
  nodes: 1_024,
  sessionIdLength: 512,
  stringLength: 2_048,
  subjectLength: 512,
  totalKeys: 512,
});

const DISPLAY_NAME_LENGTH = 160;
const DISPLAY_USERNAME_LENGTH = 160;
const DISPLAY_EMAIL_LENGTH = 320;
const unsafeDisplayCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const displayEmailSchema = z.email().max(DISPLAY_EMAIL_LENGTH);

export type OidcClaimScalar = string | number | boolean | null;
export type OidcClaimArray = readonly OidcClaimValue[];
export interface OidcClaimObject {
  readonly [key: string]: OidcClaimValue;
}
export type OidcClaimValue = OidcClaimScalar | OidcClaimArray | OidcClaimObject;

export interface SafeOidcDisplayClaims {
  readonly displayName?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly preferredUsername?: string;
}

const validatedClaimsBrand: unique symbol = Symbol("validated-oidc-claims");

export interface ValidatedOidcClaims {
  readonly [validatedClaimsBrand]: true;
  readonly displayClaims: SafeOidcDisplayClaims;
  readonly sessionId?: string;
  readonly subject: string;
}

export type OidcClaimValidationFailureCode =
  | "claim_limit_exceeded"
  | "cyclic_claim_graph"
  | "invalid_claim_graph"
  | "invalid_session_id"
  | "invalid_subject"
  | "unsafe_claim_key"
  | "unsupported_claim_value";

export type OidcClaimValidationResult =
  | { readonly ok: true; readonly value: ValidatedOidcClaims }
  | { readonly code: OidcClaimValidationFailureCode; readonly ok: false };

interface ValidationState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  totalKeys: number;
}

class ClaimValidationFailure {
  constructor(readonly code: OidcClaimValidationFailureCode) {}
}

const claimGraphs = new WeakMap<ValidatedOidcClaims, OidcClaimObject>();

function fail(code: OidcClaimValidationFailureCode): never {
  throw new ClaimValidationFailure(code);
}

function countNode(state: ValidationState, depth: number) {
  state.nodes += 1;
  if (depth > OIDC_CLAIM_LIMITS.depth || state.nodes > OIDC_CLAIM_LIMITS.nodes) {
    fail("claim_limit_exceeded");
  }
}

function readOwnKeys(value: object): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    fail("invalid_claim_graph");
  }
}

function readPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    fail("invalid_claim_graph");
  }
}

function readDataProperty(value: object, key: PropertyKey): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("invalid_claim_graph");
  }
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    fail("invalid_claim_graph");
  }
  return descriptor.value;
}

function validateArray(
  input: readonly unknown[],
  depth: number,
  state: ValidationState,
): OidcClaimArray {
  if (readPrototype(input) !== Array.prototype || input.length > OIDC_CLAIM_LIMITS.arrayLength) {
    fail(
      input.length > OIDC_CLAIM_LIMITS.arrayLength ? "claim_limit_exceeded" : "invalid_claim_graph",
    );
  }

  const keys = readOwnKeys(input);
  if (
    keys.length !== input.length + 1 ||
    !keys.every((key) =>
      typeof key === "string"
        ? key === "length" || (/^(0|[1-9]\d*)$/.test(key) && Number(key) < input.length)
        : false,
    )
  ) {
    fail("invalid_claim_graph");
  }

  state.ancestors.add(input);
  try {
    const output: OidcClaimValue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const rawValue = readDataProperty(input, String(index));
      output.push(validateValue(rawValue, depth + 1, state));
    }
    return Object.freeze(output);
  } finally {
    state.ancestors.delete(input);
  }
}

function validateObject(input: object, depth: number, state: ValidationState): OidcClaimObject {
  const prototype = readPrototype(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_claim_graph");
  }

  const keys = readOwnKeys(input);
  if (keys.length > OIDC_CLAIM_LIMITS.keysPerObject) fail("claim_limit_exceeded");
  state.totalKeys += keys.length;
  if (state.totalKeys > OIDC_CLAIM_LIMITS.totalKeys) fail("claim_limit_exceeded");

  state.ancestors.add(input);
  try {
    const output: Record<string, OidcClaimValue> = Object.create(null) as Record<
      string,
      OidcClaimValue
    >;
    for (const key of keys) {
      if (typeof key !== "string") fail("unsafe_claim_key");
      if (key.length === 0 || key.length > OIDC_CLAIM_LIMITS.keyLength) {
        fail("claim_limit_exceeded");
      }
      if (blockedClaimKeys.has(key)) fail("unsafe_claim_key");
      const rawValue = readDataProperty(input, key);
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: validateValue(rawValue, depth + 1, state),
        writable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    state.ancestors.delete(input);
  }
}

function validateValue(input: unknown, depth: number, state: ValidationState): OidcClaimValue {
  countNode(state, depth);
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (input.length > OIDC_CLAIM_LIMITS.stringLength) fail("claim_limit_exceeded");
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) fail("unsupported_claim_value");
    return input;
  }
  if (typeof input !== "object") fail("unsupported_claim_value");
  if (state.ancestors.has(input)) fail("cyclic_claim_graph");
  return Array.isArray(input)
    ? validateArray(input, depth, state)
    : validateObject(input, depth, state);
}

function normalizedDisplayString(value: OidcClaimValue | undefined, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().normalize("NFC");
  return normalized.length > 0 &&
    normalized.length <= maximumLength &&
    !unsafeDisplayCharacterPattern.test(normalized)
    ? normalized
    : undefined;
}

function safeDisplayClaims(claims: OidcClaimObject): SafeOidcDisplayClaims {
  const displayName = normalizedDisplayString(claims.name, DISPLAY_NAME_LENGTH);
  const preferredUsername = normalizedDisplayString(
    claims.preferred_username,
    DISPLAY_USERNAME_LENGTH,
  );
  const emailCandidate = normalizedDisplayString(claims.email, DISPLAY_EMAIL_LENGTH);
  const email =
    emailCandidate !== undefined && displayEmailSchema.safeParse(emailCandidate).success
      ? emailCandidate
      : undefined;
  const output: {
    displayName?: string;
    email?: string;
    emailVerified?: boolean;
    preferredUsername?: string;
  } = {};
  if (displayName !== undefined) output.displayName = displayName;
  if (preferredUsername !== undefined) output.preferredUsername = preferredUsername;
  if (email !== undefined) output.email = email;
  if (email !== undefined && typeof claims.email_verified === "boolean") {
    output.emailVerified = claims.email_verified;
  }
  return Object.freeze(output);
}

function ownClaim(claims: OidcClaimObject, key: string): OidcClaimValue | undefined {
  return Object.hasOwn(claims, key) ? claims[key] : undefined;
}

function isClaimObject(value: unknown): value is OidcClaimObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateOidcClaims(input: unknown): OidcClaimValidationResult {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      fail("invalid_claim_graph");
    }
    const state: ValidationState = {
      ancestors: new WeakSet<object>(),
      nodes: 0,
      totalKeys: 0,
    };
    const graph = validateValue(input, 0, state);
    if (!isClaimObject(graph)) fail("invalid_claim_graph");

    const subject = ownClaim(graph, "sub");
    if (
      typeof subject !== "string" ||
      subject.length === 0 ||
      subject.length > OIDC_CLAIM_LIMITS.subjectLength
    ) {
      fail("invalid_subject");
    }

    const rawSessionId = ownClaim(graph, "sid");
    if (
      rawSessionId !== undefined &&
      (typeof rawSessionId !== "string" ||
        rawSessionId.length === 0 ||
        rawSessionId.length > OIDC_CLAIM_LIMITS.sessionIdLength)
    ) {
      fail("invalid_session_id");
    }

    const value = {
      displayClaims: safeDisplayClaims(graph),
      ...(typeof rawSessionId === "string" ? { sessionId: rawSessionId } : {}),
      subject,
    } as ValidatedOidcClaims;
    Object.defineProperty(value, validatedClaimsBrand, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    claimGraphs.set(value, graph);
    return Object.freeze({ ok: true, value: Object.freeze(value) });
  } catch (error) {
    const code =
      error instanceof ClaimValidationFailure ? error.code : ("invalid_claim_graph" as const);
    return Object.freeze({ code, ok: false });
  }
}

export function isValidatedOidcClaims(value: unknown): value is ValidatedOidcClaims {
  return (
    typeof value === "object" && value !== null && claimGraphs.has(value as ValidatedOidcClaims)
  );
}

export function readOidcClaim(
  claims: ValidatedOidcClaims,
  path: readonly string[],
): OidcClaimValue | undefined {
  let current: OidcClaimValue | undefined = claimGraphs.get(claims);
  if (!current || path.length === 0 || path.length > 12) return undefined;

  for (const segment of path) {
    if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      segment.length > OIDC_CLAIM_LIMITS.keyLength ||
      blockedClaimKeys.has(segment) ||
      !isClaimObject(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function isOidcClaimScalar(value: OidcClaimValue): value is OidcClaimScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
