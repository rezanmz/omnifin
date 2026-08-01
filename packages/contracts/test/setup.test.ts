import { describe, expect, it } from "vitest";

import { setupReadinessResponseSchema, setupReadinessStepIds } from "../src/setup.js";

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
