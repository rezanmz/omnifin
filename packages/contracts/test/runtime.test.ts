import { describe, expect, it } from "vitest";

import { runtimeIdentitySchema } from "../src/runtime.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function stableIdentity() {
  return {
    channel: "stable" as const,
    license: "AGPL-3.0-only" as const,
    revision,
    schemaVersion: 1 as const,
    sourceUrl: `https://github.com/rezanmz/omnifin/tree/${revision}`,
    verification: "verified" as const,
    version: "1.2.3",
  };
}

describe("runtimeIdentitySchema", () => {
  it("accepts an immutable stable release identity", () => {
    const value = stableIdentity();

    expect(runtimeIdentitySchema.parse(value)).toEqual(value);
  });

  it("accepts an explicitly unverified development identity", () => {
    const value = {
      channel: "development",
      license: "AGPL-3.0-only",
      revision: null,
      schemaVersion: 1,
      sourceUrl: "https://github.com/rezanmz/omnifin",
      verification: "development",
      version: "0.0.0-dev",
    };

    expect(runtimeIdentitySchema.parse(value)).toEqual(value);
  });

  it.each([
    ["a mutable source branch", { sourceUrl: "https://github.com/rezanmz/omnifin/tree/main" }],
    [
      "a source URL for a different revision",
      {
        sourceUrl:
          "https://github.com/rezanmz/omnifin/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    ["a missing stable revision", { revision: null }],
    ["a dishonest verification state", { verification: "development" }],
    ["an insecure source URL", { sourceUrl: `http://github.com/rezanmz/omnifin/tree/${revision}` }],
    [
      "a credential-bearing source URL",
      { sourceUrl: `https://user:secret@github.com/rezanmz/omnifin/tree/${revision}` },
    ],
    ["an invalid license", { license: "MIT" }],
    ["a non-SemVer version", { version: "release-latest" }],
    ["an edge channel without an edge prerelease", { channel: "edge", version: "1.2.3" }],
  ])("rejects %s", (_label, override) => {
    expect(runtimeIdentitySchema.safeParse({ ...stableIdentity(), ...override }).success).toBe(
      false,
    );
  });

  it("rejects a development build that claims an immutable release identity", () => {
    expect(
      runtimeIdentitySchema.safeParse({
        ...stableIdentity(),
        channel: "development",
        verification: "development",
        version: "0.0.0-dev",
      }).success,
    ).toBe(false);
  });

  it("rejects undeclared runtime fields", () => {
    expect(
      runtimeIdentitySchema.safeParse({
        ...stableIdentity(),
        environment: process.env.NODE_ENV,
      }).success,
    ).toBe(false);
  });
});
