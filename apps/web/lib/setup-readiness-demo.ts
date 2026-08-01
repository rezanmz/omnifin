import {
  setupReadinessResponseSchema,
  setupReadinessStepIds,
  type SetupReadinessResponse,
  type SetupReadinessStep,
} from "@omnifin/contracts/setup";
import {
  deploymentReadinessCheckIds,
  deploymentReadinessResponseSchema,
  type DeploymentReadinessCheckState,
} from "@omnifin/contracts/deployment";

import type { SetupReadinessOutcome } from "./setup-readiness";

export type SetupReadinessDemoView =
  | "deployment-attention"
  | "deployment-unavailable"
  | "forbidden"
  | "needs-core"
  | "partial"
  | "provider-unavailable"
  | "ready"
  | "signed-out"
  | "unavailable";

type StepOverrides = Partial<Pick<SetupReadinessStep, "configuredCount" | "readyCount" | "state">>;

function step(id: SetupReadinessStep["id"], overrides: StepOverrides = {}): SetupReadinessStep {
  return {
    configuredCount: 0,
    id,
    readyCount: 0,
    state: "not_configured",
    ...overrides,
  };
}

function response(
  overrides: Partial<Record<SetupReadinessStep["id"], StepOverrides>>,
): SetupReadinessResponse {
  const steps = setupReadinessStepIds.map((id) => step(id, overrides[id]));
  const essentialCompleted = steps
    .slice(0, 2)
    .filter(({ state }) => state === "ready" || state === "partial").length;
  const optionalReady = steps
    .slice(2)
    .filter(({ state }) => state === "ready" || state === "partial").length;
  return setupReadinessResponseSchema.parse({
    coreReady: essentialCompleted === 2,
    essentialCompleted,
    essentialTotal: 2,
    generatedAt: "2026-08-01T12:00:00.000Z",
    optionalReady,
    optionalTotal: 6,
    steps,
  });
}

const READY = response(
  Object.fromEntries(
    setupReadinessStepIds.map((id) => [id, { configuredCount: 1, readyCount: 1, state: "ready" }]),
  ),
);

const PARTIAL = response({
  acquisition: { configuredCount: 2, readyCount: 1, state: "partial" },
  discovery: { configuredCount: 1, readyCount: 1, state: "ready" },
  downloads: { configuredCount: 1, readyCount: 1, state: "ready" },
  identity: { configuredCount: 1, readyCount: 1, state: "ready" },
  jellyfin: { configuredCount: 1, readyCount: 1, state: "ready" },
});

const NEEDS_CORE = response({
  identity: { configuredCount: 1, readyCount: 1, state: "ready" },
  jellyfin: { configuredCount: 1, readyCount: 0, state: "attention" },
});

const PROVIDER_ATTENTION = response({
  identity: { configuredCount: 1, readyCount: 1, state: "ready" },
  jellyfin: { configuredCount: 1, readyCount: 1, state: "ready" },
  oidc: { configuredCount: 1, readyCount: 0, state: "attention" },
});

function deploymentResponse(states: readonly DeploymentReadinessCheckState[]) {
  const checks = deploymentReadinessCheckIds.map((id, index) => ({
    id,
    state: states[index] ?? "attention",
  }));
  const readyCount = checks.filter(({ state }) => state === "ready").length;
  return deploymentReadinessResponseSchema.parse({
    checks,
    generatedAt: "2026-08-01T12:00:00.000Z",
    readyCount,
    state: readyCount === checks.length ? "ready" : "attention",
    total: checks.length,
  });
}

const DEPLOYMENT_READY = deploymentResponse(["ready", "ready", "ready", "ready"]);
const DEPLOYMENT_ATTENTION = deploymentResponse(["attention", "attention", "ready", "ready"]);

export function setupReadinessDemo(view: SetupReadinessDemoView): SetupReadinessOutcome {
  if (view === "forbidden") return { status: "forbidden" };
  if (view === "signed-out") return { status: "signed_out" };
  if (view === "unavailable") return { status: "unavailable" };
  return {
    deployment:
      view === "deployment-unavailable"
        ? { status: "unavailable" }
        : {
            readiness: view === "deployment-attention" ? DEPLOYMENT_ATTENTION : DEPLOYMENT_READY,
            status: "ready",
          },
    readiness:
      view === "ready"
        ? READY
        : view === "needs-core"
          ? NEEDS_CORE
          : view === "provider-unavailable"
            ? PROVIDER_ATTENTION
            : PARTIAL,
    status: "ready",
  };
}
