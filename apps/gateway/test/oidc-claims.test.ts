import { describe, expect, it } from "vitest";
import {
  OIDC_CLAIM_LIMITS,
  isValidatedOidcClaims,
  readOidcClaim,
  validateOidcClaims,
} from "../src/auth/oidc/claims.js";

function validated(input: unknown) {
  const result = validateOidcClaims(input);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`Expected valid claims, received ${result.code}.`);
  return result.value;
}

describe("OIDC claim normalization", () => {
  it("retains an immutable identity-safe view while keeping assertions non-serializable", () => {
    const claims = validated({
      aud: "omnifin",
      email: "riley@example.test",
      email_verified: true,
      groups: ["viewers", "operators"],
      name: "Riley",
      preferred_username: "riley",
      realm_access: { roles: ["media-operator"] },
      sid: "upstream-session-1",
      sub: "subject-1",
    });

    expect(claims).toMatchObject({
      displayClaims: {
        displayName: "Riley",
        email: "riley@example.test",
        emailVerified: true,
        preferredUsername: "riley",
      },
      sessionId: "upstream-session-1",
      subject: "subject-1",
    });
    expect(Object.isFrozen(claims)).toBe(true);
    expect(Object.isFrozen(claims.displayClaims)).toBe(true);
    expect(isValidatedOidcClaims(claims)).toBe(true);
    expect(JSON.stringify(claims)).not.toContain("groups");
    expect(JSON.stringify(claims)).not.toContain("realm_access");

    const roles = readOidcClaim(claims, ["realm_access", "roles"]);
    expect(roles).toEqual(["media-operator"]);
    expect(Object.isFrozen(roles)).toBe(true);
  });

  it("does not coerce optional display claims or retain unapproved profile assertions", () => {
    const claims = validated({
      email: 42,
      email_verified: "true",
      groups: ["admin"],
      name: false,
      phone_number: "+1-555-0100",
      picture: "https://example.test/private-picture",
      preferred_username: ["riley"],
      sub: "subject-1",
    });

    expect(claims.displayClaims).toEqual({});
    expect(JSON.parse(JSON.stringify(claims))).toEqual({
      displayClaims: {},
      subject: "subject-1",
    });
    expect(readOidcClaim(claims, ["email_verified"])).toBe("true");
  });

  it("normalizes display text and omits malformed or presentation-unsafe profile claims", () => {
    const normalized = validated({
      email: "  riley@example.test  ",
      email_verified: true,
      name: "  Riley  ",
      preferred_username: "  riley  ",
      sub: "subject-1",
    });
    expect(normalized.displayClaims).toEqual({
      displayName: "Riley",
      email: "riley@example.test",
      emailVerified: true,
      preferredUsername: "riley",
    });

    const unsafe = validated({
      email: "not-an-email",
      email_verified: true,
      name: "Admin\u202Eresu",
      preferred_username: "operator\nadmin",
      sub: "subject-2",
    });
    expect(unsafe.displayClaims).toEqual({});
  });

  it("requires exact bounded subject and optional session identifier strings", () => {
    expect(validated({ sub: "s".repeat(OIDC_CLAIM_LIMITS.subjectLength) }).subject).toHaveLength(
      OIDC_CLAIM_LIMITS.subjectLength,
    );
    expect(
      validated({
        sid: "i".repeat(OIDC_CLAIM_LIMITS.sessionIdLength),
        sub: "subject-1",
      }).sessionId,
    ).toHaveLength(OIDC_CLAIM_LIMITS.sessionIdLength);

    for (const input of [
      {},
      { sub: "" },
      { sub: 123 },
      { sub: true },
      { sub: "s".repeat(OIDC_CLAIM_LIMITS.subjectLength + 1) },
    ]) {
      expect(validateOidcClaims(input)).toEqual({ code: "invalid_subject", ok: false });
    }

    for (const sid of ["", 123, false, null, "s".repeat(OIDC_CLAIM_LIMITS.sessionIdLength + 1)]) {
      expect(validateOidcClaims({ sid, sub: "subject-1" })).toEqual({
        code: "invalid_session_id",
        ok: false,
      });
    }
  });

  it("reads only own object properties and never invokes accessors", () => {
    let getterCalls = 0;
    const accessorClaims = { sub: "subject-1" } as Record<string, unknown>;
    Object.defineProperty(accessorClaims, "groups", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return ["admin"];
      },
    });
    expect(validateOidcClaims(accessorClaims)).toEqual({
      code: "invalid_claim_graph",
      ok: false,
    });
    expect(getterCalls).toBe(0);

    const inherited = Object.create({ sub: "inherited-subject" }) as Record<string, unknown>;
    inherited.groups = ["admin"];
    expect(validateOidcClaims(inherited)).toEqual({ code: "invalid_claim_graph", ok: false });

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.sub = "own-subject";
    expect(validated(nullPrototype).subject).toBe("own-subject");
  });

  it("rejects prototype-pollution keys at every level", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const root = JSON.parse(`{"sub":"subject-1","${key}":{"admin":true}}`) as unknown;
      const nested = JSON.parse(
        `{"sub":"subject-1","realm_access":{"${key}":["admin"]}}`,
      ) as unknown;
      expect(validateOidcClaims(root)).toEqual({ code: "unsafe_claim_key", ok: false });
      expect(validateOidcClaims(nested)).toEqual({ code: "unsafe_claim_key", ok: false });
    }

    const symbolClaims = { sub: "subject-1" } as Record<PropertyKey, unknown>;
    symbolClaims[Symbol("groups")] = ["admin"];
    expect(validateOidcClaims(symbolClaims)).toEqual({ code: "unsafe_claim_key", ok: false });
  });

  it("enforces depth, key, array, string, node, and total-key budgets", () => {
    expect(
      validateOidcClaims({
        oversized: "x".repeat(OIDC_CLAIM_LIMITS.stringLength + 1),
        sub: "subject-1",
      }),
    ).toEqual({ code: "claim_limit_exceeded", ok: false });
    expect(
      validateOidcClaims({
        groups: Array.from({ length: OIDC_CLAIM_LIMITS.arrayLength + 1 }, () => "group"),
        sub: "subject-1",
      }),
    ).toEqual({ code: "claim_limit_exceeded", ok: false });
    expect(
      validateOidcClaims({
        ["k".repeat(OIDC_CLAIM_LIMITS.keyLength + 1)]: true,
        sub: "subject-1",
      }),
    ).toEqual({ code: "claim_limit_exceeded", ok: false });

    const tooManyObjectKeys = Object.fromEntries(
      Array.from({ length: OIDC_CLAIM_LIMITS.keysPerObject + 1 }, (_, index) => [
        `claim_${index}`,
        true,
      ]),
    );
    expect(validateOidcClaims({ nested: tooManyObjectKeys, sub: "subject-1" })).toEqual({
      code: "claim_limit_exceeded",
      ok: false,
    });

    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < OIDC_CLAIM_LIMITS.depth; depth += 1) {
      nested = { nested };
    }
    expect(validateOidcClaims({ nested, sub: "subject-1" })).toEqual({
      code: "claim_limit_exceeded",
      ok: false,
    });

    const nodeHeavy = Array.from({ length: 8 }, () =>
      Array.from({ length: OIDC_CLAIM_LIMITS.arrayLength }, () => true),
    );
    expect(validateOidcClaims({ nodeHeavy, sub: "subject-1" })).toEqual({
      code: "claim_limit_exceeded",
      ok: false,
    });

    const keyHeavy = Array.from({ length: 9 }, (_, objectIndex) =>
      Object.fromEntries(
        Array.from({ length: 60 }, (_, keyIndex) => [`claim_${objectIndex}_${keyIndex}`, true]),
      ),
    );
    expect(validateOidcClaims({ keyHeavy, sub: "subject-1" })).toEqual({
      code: "claim_limit_exceeded",
      ok: false,
    });
  });

  it("rejects cycles, non-JSON values, custom objects, and malformed arrays", () => {
    const cyclic: Record<string, unknown> = { sub: "subject-1" };
    cyclic.self = cyclic;
    expect(validateOidcClaims(cyclic)).toEqual({ code: "cyclic_claim_graph", ok: false });

    for (const value of [undefined, 1n, Symbol("claim"), () => true, Number.NaN, Infinity]) {
      expect(validateOidcClaims({ claim: value, sub: "subject-1" })).toEqual({
        code: "unsupported_claim_value",
        ok: false,
      });
    }
    expect(validateOidcClaims({ claim: new Date(), sub: "subject-1" })).toEqual({
      code: "invalid_claim_graph",
      ok: false,
    });

    const sparse = ["viewer", , "operator"];
    expect(validateOidcClaims({ groups: sparse, sub: "subject-1" })).toEqual({
      code: "invalid_claim_graph",
      ok: false,
    });

    const hidden = { sub: "subject-1" };
    Object.defineProperty(hidden, "groups", { enumerable: false, value: ["admin"] });
    expect(validateOidcClaims(hidden)).toEqual({ code: "invalid_claim_graph", ok: false });
  });

  it("converts hostile proxy behavior into a stable validation failure", () => {
    const claims = new Proxy(
      { sub: "subject-1" },
      {
        ownKeys() {
          throw new Error("hostile assertion details");
        },
      },
    );
    expect(validateOidcClaims(claims)).toEqual({ code: "invalid_claim_graph", ok: false });
  });
});
