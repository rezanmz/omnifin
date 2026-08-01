import type { DeploymentReadinessResponse } from "@omnifin/contracts/deployment";

export type DeploymentReadinessOutcome =
  | { readiness: DeploymentReadinessResponse; status: "ready" }
  | { status: "forbidden" }
  | { status: "signed_out" }
  | { status: "unavailable" };

interface DeploymentReadinessDependencies {
  request?: (path: string, init: RequestInit) => Promise<Response>;
}

async function contractSchema() {
  await import("./zod-browser");
  return import("@omnifin/contracts/deployment");
}

async function requestReadiness(path: string, init: RequestInit) {
  return fetch(path, init);
}

export async function loadDeploymentReadiness(
  dependencies: DeploymentReadinessDependencies = {},
): Promise<DeploymentReadinessOutcome> {
  let response: Response;
  try {
    response = await (dependencies.request ?? requestReadiness)("/api/admin/setup/deployment", {
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 401) return { status: "signed_out" };
  if (response.status === 403) return { status: "forbidden" };
  if (!response.ok) return { status: "unavailable" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable" };
  }
  const { deploymentReadinessResponseSchema } = await contractSchema();
  const readiness = deploymentReadinessResponseSchema.safeParse(body);
  return readiness.success
    ? { readiness: readiness.data, status: "ready" }
    : { status: "unavailable" };
}
