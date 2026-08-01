import type {
  SetupReadinessResponse,
  SetupReadinessStep,
  SetupReadinessStepState,
} from "@omnifin/contracts/setup";

import { loadDeploymentReadiness, type DeploymentReadinessOutcome } from "./deployment-readiness";

export type SetupReadinessStepId = SetupReadinessStep["id"];
export type SetupReadinessModel = SetupReadinessResponse;
export type { SetupReadinessStep, SetupReadinessStepState };

export type SetupReadinessOutcome =
  | {
      deployment: Extract<DeploymentReadinessOutcome, { status: "ready" | "unavailable" }>;
      readiness: SetupReadinessResponse;
      status: "ready";
    }
  | { status: "forbidden" | "signed_out" | "unavailable" };

interface SetupReadinessDependencies {
  request?: (path: string, init: RequestInit) => Promise<Response>;
}

async function contractSchema() {
  await import("./zod-browser");
  return import("@omnifin/contracts/setup");
}

async function requestReadiness(path: string, init: RequestInit) {
  return fetch(path, init);
}

export async function loadSetupReadiness(
  dependencies: SetupReadinessDependencies = {},
): Promise<SetupReadinessOutcome> {
  const request = dependencies.request ?? requestReadiness;
  let response: Response;
  let deployment: DeploymentReadinessOutcome;
  try {
    [response, deployment] = await Promise.all([
      request("/api/admin/setup/readiness", {
        cache: "no-store",
        credentials: "same-origin",
      }),
      loadDeploymentReadiness({ request }),
    ]);
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 401) return { status: "signed_out" };
  if (response.status === 403) return { status: "forbidden" };
  if (!response.ok) return { status: "unavailable" };
  if (deployment.status === "signed_out") return { status: "signed_out" };
  if (deployment.status === "forbidden") return { status: "forbidden" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable" };
  }
  const { setupReadinessResponseSchema } = await contractSchema();
  const readiness = setupReadinessResponseSchema.safeParse(body);
  return readiness.success
    ? { deployment, readiness: readiness.data, status: "ready" }
    : { status: "unavailable" };
}
