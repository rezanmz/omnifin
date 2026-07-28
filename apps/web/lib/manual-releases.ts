import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  ManualReleaseGrabIdempotencyKey,
  ManualReleaseGrabInput,
  ManualReleaseGrabResponse,
  ManualReleaseSearchResponse,
  ManualReleaseTargetInput,
} from "@omnifin/contracts/acquisition";

const CSRF_HEADER = "x-omnifin-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";

async function loadContractSchemas() {
  await import("./zod-browser");
  const [acquisition, auth, errors] = await Promise.all([
    import("@omnifin/contracts/acquisition"),
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
  ]);
  return { acquisition, auth, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type ManualReleaseClientErrorKind =
  | "configuration"
  | "conflict"
  | "download_unavailable"
  | "expired"
  | "forbidden"
  | "invalid_response"
  | "override_required"
  | "pending"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class ManualReleaseClientError extends Error {
  public readonly code: string;
  public readonly kind: ManualReleaseClientErrorKind;

  public constructor(kind: ManualReleaseClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "ManualReleaseClientError";
    this.kind = kind;
    this.code = code;
  }
}

export interface ManualReleaseEligibilitySnapshot {
  csrfToken: string;
  principal: SessionPrincipal;
}

export type ManualReleaseEligibility =
  | { snapshot: ManualReleaseEligibilitySnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export interface ManualReleaseGrabCreation {
  grab: ManualReleaseGrabResponse;
  replayed: boolean;
}

export interface GrabManualReleaseOptions {
  csrfToken: string;
  idempotencyKey: ManualReleaseGrabIdempotencyKey;
  signal?: AbortSignal;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ManualReleaseClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable manual release response.",
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
    throw new ManualReleaseClientError(
      "unavailable",
      "service_unavailable",
      "The manual release workbench could not reach the gateway.",
    );
  }
}

function errorKind(status: number, code: string): ManualReleaseClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 429 || code === "manual_release_rate_limited") return "rate_limited";
  if (code === "idempotency_key_conflict") return "conflict";
  if (code === "manual_release_grab_outcome_pending") return "pending";
  if (code === "manual_release_candidate_expired") return "expired";
  if (code === "manual_release_override_required") return "override_required";
  if (code === "manual_release_download_unavailable") return "download_unavailable";
  if (code === "manual_release_response_invalid") return "invalid_response";
  if (
    code === "manual_release_not_configured" ||
    code === "manual_release_configuration_unavailable"
  ) {
    return "configuration";
  }
  return status >= 500 ? "unavailable" : "invalid_response";
}

async function responseError(response: Response) {
  const schemas = await contractSchemas();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = schemas.errors.apiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : "request_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "The manual release operation could not be completed.";
  return new ManualReleaseClientError(errorKind(response.status, code), code, message);
}

export function createManualReleaseGrabIdempotencyKey(): ManualReleaseGrabIdempotencyKey {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new ManualReleaseClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure release identifier.",
    );
  }
  return `manual-grab-${identifier}`;
}

export interface ManualReleaseClient {
  grab(
    input: ManualReleaseGrabInput,
    options: GrabManualReleaseOptions,
  ): Promise<ManualReleaseGrabCreation>;
  loadEligibility(signal?: AbortSignal): Promise<ManualReleaseEligibility>;
  search(
    input: ManualReleaseTargetInput,
    signal?: AbortSignal,
  ): Promise<ManualReleaseSearchResponse>;
}

export const manualReleaseClient: ManualReleaseClient = {
  async grab(input, options) {
    const schemas = await contractSchemas();
    const body = schemas.acquisition.manualReleaseGrabInputSchema.parse(input);
    const idempotencyKey = schemas.acquisition.manualReleaseGrabIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    const response = await fetchSameOrigin("/api/acquisitions/releases/grabs", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: options.csrfToken,
        [IDEMPOTENCY_HEADER]: idempotencyKey,
      },
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.acquisition.manualReleaseGrabResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new ManualReleaseClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned a grab receipt outside the public contract.",
      );
    }
    return {
      grab: parsed.data,
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },

  async loadEligibility(signal) {
    try {
      const response = await fetchSameOrigin("/api/auth/session", {
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        return response.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
      }
      const schemas = await contractSchemas();
      const parsed = schemas.auth.sessionResponseSchema.safeParse(await safeJson(response));
      if (!parsed.success) return { status: "unavailable" };
      const { csrfToken, principal } = parsed.data;
      if (principal === null || csrfToken === null) return { status: "signed_out" };
      if (
        principal.accountState !== "active" ||
        !principal.userId ||
        !principal.permissions.includes("acquisition.manage")
      ) {
        return { status: "forbidden" };
      }
      return { snapshot: { csrfToken, principal }, status: "ready" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return { status: "unavailable" };
    }
  },

  async search(input, signal) {
    const schemas = await contractSchemas();
    const target = schemas.acquisition.manualReleaseTargetInputSchema.parse(input);
    const parameters = new URLSearchParams({
      mediaId: String(target.mediaId),
      service: target.service,
    });
    if (target.episodeId !== undefined) {
      parameters.set("episodeId", String(target.episodeId));
    }
    if (target.seasonNumber !== undefined) {
      parameters.set("seasonNumber", String(target.seasonNumber));
    }
    const response = await fetchSameOrigin(
      `/api/acquisitions/releases?${parameters.toString()}`,
      signal ? { signal } : undefined,
    );
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.acquisition.manualReleaseSearchResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new ManualReleaseClientError(
        "invalid_response",
        "invalid_response",
        "Manual release results did not match the public contract.",
      );
    }
    return parsed.data;
  },
};
