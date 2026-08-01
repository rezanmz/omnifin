import { describe, expect, it } from "vitest";

import {
  setupReadinessResponseSchema,
  setupReadinessStepIds,
  stackVerificationCheckIds,
  stackVerificationResponseSchema,
} from "../src/setup.js";

function response() {
  return {
    coreReady: true,
    essentialCompleted: 2,
    essentialTotal: 2,
    generatedAt: "2026-08-01T12:00:00.000Z",
    optionalReady: 0,
    optionalTotal: 6,
    steps: setupReadinessStepIds.map((id, index) => ({
      configuredCount: index < 2 ? 1 : 0,
      id,
      readyCount: index < 2 ? 1 : 0,
      state: index < 2 ? ("ready" as const) : ("not_configured" as const),
    })),
  };
}

describe("setupReadinessResponseSchema", () => {
  it("accepts a canonical, internally consistent readiness summary", () => {
    expect(setupReadinessResponseSchema.parse(response())).toEqual(response());
  });

  it("rejects reordered steps and dishonest aggregate counts", () => {
    const value = response();
    [value.steps[2], value.steps[3]] = [value.steps[3]!, value.steps[2]!];
    value.optionalReady = 6;

    expect(setupReadinessResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects ready counts greater than configured counts", () => {
    const value = response();
    value.steps[0]!.readyCount = 2;

    expect(setupReadinessResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects step states that contradict their configured and ready counts", () => {
    const value = response();
    value.steps[2]!.state = "ready";
    value.optionalReady = 1;

    expect(setupReadinessResponseSchema.safeParse(value).success).toBe(false);
  });
});

function verification() {
  return {
    checks: stackVerificationCheckIds.map((id, index) => ({
      attemptedCount: index < 2 ? 1 : 0,
      capabilities:
        id === "oidc"
          ? (["oidc.authorization_code", "oidc.pkce_s256"] as const)
          : id === "jellyfin"
            ? (["connector.health", "media.library.read"] as const)
            : [],
      configuredCount: index < 2 ? 1 : 0,
      enabledCount: index < 2 ? 1 : 0,
      findings: [],
      id,
      readyCount: index < 2 ? 1 : 0,
      state: index < 2 ? ("ready" as const) : ("not_configured" as const),
      versions: id === "jellyfin" ? ["10.10.7"] : [],
    })),
    configuredCount: 2,
    format: "omnifin-stack-verification" as const,
    generatedAt: "2026-08-01T12:00:00.000Z",
    readyCount: 2,
    schemaVersion: 1 as const,
    scope: "local_diagnostic" as const,
    state: "ready" as const,
  };
}

describe("stackVerificationResponseSchema", () => {
  it("accepts a canonical privacy-safe diagnostic report", () => {
    expect(stackVerificationResponseSchema.parse(verification())).toEqual(verification());
  });

  it("rejects private or unnormalized upstream version values", () => {
    const value = verification();
    value.checks[1]!.versions = ["10.10.7 https://private.example.test/token"];

    expect(stackVerificationResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects reordered, duplicate, or dishonest details", () => {
    const value = verification();
    value.checks[0]!.capabilities = ["oidc.pkce_s256", "oidc.authorization_code"];
    value.checks[0]!.readyCount = 0;

    expect(stackVerificationResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects extra fields that could expand the exported privacy surface", () => {
    expect(
      stackVerificationResponseSchema.safeParse({
        ...verification(),
        connectorUrls: ["https://private.example.test"],
      }).success,
    ).toBe(false);
  });
});
