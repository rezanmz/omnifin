import type {
  SetupReadinessResponse,
  SetupReadinessStep,
  SetupReadinessStepState,
} from "@omnifin/contracts/setup";

export type SetupReadinessStepId = SetupReadinessStep["id"];
export type SetupReadinessModel = SetupReadinessResponse;
export type { SetupReadinessStep, SetupReadinessStepState };

export type SetupReadinessOutcome =
  | { readiness: SetupReadinessResponse; status: "ready" }
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
  let response: Response;
  try {
    response = await (dependencies.request ?? requestReadiness)("/api/admin/setup/readiness", {
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
  const { setupReadinessResponseSchema } = await contractSchema();
  const readiness = setupReadinessResponseSchema.safeParse(body);
  return readiness.success
    ? { readiness: readiness.data, status: "ready" }
    : { status: "unavailable" };
}
