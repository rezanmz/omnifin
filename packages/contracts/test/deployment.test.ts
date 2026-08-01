import { describe, expect, it } from "vitest";

import {
  deploymentReadinessCheckIds,
  deploymentReadinessResponseSchema,
} from "../src/deployment.js";

function response(
  states: readonly ("attention" | "ready")[] = ["ready", "ready", "ready", "ready"],
) {
  const checks = deploymentReadinessCheckIds.map((id, index) => ({
    id,
    state: states[index] ?? "attention",
  }));
  const readyCount = checks.filter(({ state }) => state === "ready").length;
  return {
    checks,
    generatedAt: "2026-08-01T12:00:00.000Z",
    readyCount,
    state: readyCount === checks.length ? ("ready" as const) : ("attention" as const),
    total: 4 as const,
  };
}

describe("deploymentReadinessResponseSchema", () => {
  it("accepts an ordered, internally consistent production posture", () => {
    const value = response();

    expect(deploymentReadinessResponseSchema.parse(value)).toEqual(value);
  });

  it("accepts an attention posture without exposing configuration details", () => {
    const value = response(["attention", "attention", "ready", "ready"]);

    expect(deploymentReadinessResponseSchema.parse(value)).toEqual(value);
    expect(JSON.stringify(value)).not.toMatch(/origin|databasePath|secret|proxy|environment/u);
  });

  it("rejects reordered checks and dishonest aggregate state", () => {
    const value = response();
    [value.checks[0], value.checks[1]] = [value.checks[1]!, value.checks[0]!];
    value.readyCount = 3;
    value.state = "attention";

    expect(deploymentReadinessResponseSchema.safeParse(value).success).toBe(false);
  });
});
