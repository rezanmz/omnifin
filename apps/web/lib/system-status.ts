import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type { SystemStatusResponse } from "@omnifin/contracts/system";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors, system] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/system"),
  ]);
  return { auth, errors, system };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type SystemStatusClientErrorKind =
  "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class SystemStatusClientError extends Error {
  public readonly code: string;
  public readonly kind: SystemStatusClientErrorKind;

  public constructor(kind: SystemStatusClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "SystemStatusClientError";
    this.kind = kind;
    this.code = code;
  }
}

export interface SystemStatusSnapshot {
  principal: SessionPrincipal;
  status: SystemStatusResponse;
}

export type SystemStatusLoadOutcome =
  | { snapshot: SystemStatusSnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SystemStatusClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned unreadable system telemetry.",
    );
  }
}

async function fetchSameOrigin(path: string, init?: RequestInit) {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SystemStatusClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached.",
    );
  }
}

async function responseError(response: Response) {
  if (response.status === 401) {
    return new SystemStatusClientError(
      "signed_out",
      "authentication_required",
      "Sign in to inspect system telemetry.",
    );
  }
  if (response.status === 403) {
    return new SystemStatusClientError(
      "forbidden",
      "permission_denied",
      "Operator access is required for system telemetry.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  return new SystemStatusClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    parsed.success ? parsed.data.error.code : "request_failed",
    parsed.success ? parsed.data.error.message : "System telemetry could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new SystemStatusClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned system telemetry outside the public contract.",
    );
  }
  return parsed.data;
}

export async function loadSystemStatus(signal?: AbortSignal): Promise<SystemStatusLoadOutcome> {
  try {
    const sessionResponse = await fetchSameOrigin("/api/auth/session", {
      ...(signal ? { signal } : {}),
    });
    if (!sessionResponse.ok) {
      return sessionResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const schemas = await contractSchemas();
    const session = schemas.auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success || session.data.principal === null) return { status: "signed_out" };
    if (!session.data.principal.permissions.includes("acquisition.manage")) {
      return { status: "forbidden" };
    }
    const status = await parsedResponse(
      await fetchSameOrigin("/api/system/status", { ...(signal ? { signal } : {}) }),
      schemas.system.systemStatusResponseSchema,
    );
    return { snapshot: { principal: session.data.principal, status }, status: "ready" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof SystemStatusClientError) {
      if (error.kind === "forbidden" || error.kind === "signed_out") {
        return { status: error.kind };
      }
    }
    return { status: "unavailable" };
  }
}

export interface SystemStatusClient {
  load(signal?: AbortSignal): Promise<SystemStatusLoadOutcome>;
}

export const systemStatusClient: SystemStatusClient = { load: loadSystemStatus };
