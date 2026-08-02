import type { StackVerificationResponse } from "@omnifin/contracts/setup";

const CSRF_HEADER = "x-omnifin-csrf";

export type StackVerificationOutcome =
  | { report: StackVerificationResponse; status: "ready" }
  | { status: "forbidden" | "in_progress" | "signed_out" | "unavailable" };

export interface StackVerificationDependencies {
  request?: (path: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}

async function contractSchemas() {
  await import("./zod-browser");
  const [auth, errors, setup] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/setup"),
  ]);
  return { auth, errors, setup };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function sameOriginRequest(path: string, init: RequestInit) {
  return fetch(path, init);
}

export async function runStackVerification(
  dependencies: StackVerificationDependencies = {},
): Promise<StackVerificationOutcome> {
  const request = dependencies.request ?? sameOriginRequest;
  try {
    const schemas = await contractSchemas();
    const sessionResponse = await request("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    if (!sessionResponse.ok) {
      return sessionResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const session = schemas.auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success) return { status: "unavailable" };
    if (session.data.principal === null || session.data.csrfToken === null) {
      return { status: "signed_out" };
    }
    if (
      !session.data.principal.permissions.includes("connectors.manage") ||
      !session.data.principal.permissions.includes("recovery.oidc.manage")
    ) {
      return { status: "forbidden" };
    }
    const response = await request("/api/admin/setup/verification", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { [CSRF_HEADER]: session.data.csrfToken },
      method: "POST",
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    if (response.status === 401) return { status: "signed_out" };
    if (response.status === 403) return { status: "forbidden" };
    if (!response.ok) {
      const error = schemas.errors.apiErrorSchema.safeParse(await safeJson(response));
      return response.status === 409 &&
        error.success &&
        error.data.error.code === "stack_verification_in_progress"
        ? { status: "in_progress" }
        : { status: "unavailable" };
    }
    const report = schemas.setup.stackVerificationResponseSchema.safeParse(
      await safeJson(response),
    );
    return report.success ? { report: report.data, status: "ready" } : { status: "unavailable" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { status: "unavailable" };
  }
}

export function stackVerificationFilename(generatedAt: string) {
  const timestamp = new Date(generatedAt);
  if (!Number.isFinite(timestamp.getTime())) return "omnifin-stack-verification.json";
  return `omnifin-stack-verification-${timestamp.toISOString().replace(/[-:]/gu, "").replace(".000", "")}.json`;
}

export function downloadStackVerification(report: StackVerificationResponse) {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.download = stackVerificationFilename(report.generatedAt);
    anchor.href = url;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
