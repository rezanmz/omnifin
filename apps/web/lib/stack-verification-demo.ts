import {
  stackVerificationCheckIds,
  stackVerificationResponseSchema,
  type StackVerificationCheck,
  type StackVerificationResponse,
} from "@omnifin/contracts/setup";

export type StackVerificationDemoView = "attention" | "ready" | "unconfigured";

function check(
  id: StackVerificationCheck["id"],
  overrides: Partial<StackVerificationCheck> = {},
): StackVerificationCheck {
  return {
    attemptedCount: 1,
    capabilities:
      id === "oidc" ? ["oidc.authorization_code", "oidc.pkce_s256"] : ["connector.health"],
    configuredCount: 1,
    enabledCount: 1,
    findings: [],
    id,
    readyCount: 1,
    state: "ready",
    versions: id === "oidc" ? [] : ["1.0.0"],
    ...overrides,
  };
}

export function stackVerificationDemo(view: StackVerificationDemoView): StackVerificationResponse {
  const checks = stackVerificationCheckIds.map((id, index) => {
    if (view === "unconfigured") {
      return check(id, {
        attemptedCount: 0,
        capabilities: [],
        configuredCount: 0,
        enabledCount: 0,
        readyCount: 0,
        state: "not_configured",
        versions: [],
      });
    }
    if (view === "attention" && id === "sonarr") {
      return check(id, {
        capabilities: [],
        findings: [{ code: "unreachable", count: 1 }],
        readyCount: 0,
        state: "attention",
        versions: [],
      });
    }
    if (view === "attention" && index > 5) {
      return check(id, {
        attemptedCount: 0,
        capabilities: [],
        configuredCount: 0,
        enabledCount: 0,
        readyCount: 0,
        state: "not_configured",
        versions: [],
      });
    }
    return check(id);
  });
  const configuredCount = checks.reduce((total, item) => total + item.configuredCount, 0);
  const readyCount = checks.reduce((total, item) => total + item.readyCount, 0);
  return stackVerificationResponseSchema.parse({
    checks,
    configuredCount,
    format: "omnifin-stack-verification",
    generatedAt: "2026-08-01T12:00:00.000Z",
    readyCount,
    schemaVersion: 1,
    scope: "local_diagnostic",
    state:
      configuredCount === 0
        ? "not_configured"
        : readyCount === configuredCount
          ? "ready"
          : readyCount === 0
            ? "attention"
            : "partial",
  });
}
