import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  IdempotencyKey,
  MediaRequestInput,
  MediaRequestResponse,
} from "@omnifin/contracts/requests";

const CSRF_HEADER = "x-omnifin-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors, requests] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/requests"),
  ]);
  return { auth, errors, requests };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export interface MediaRequestEligibilitySnapshot {
  csrfToken: string;
  jellyfinDisplayName: string;
  jellyfinHealth: "linked" | "unavailable";
  principal: SessionPrincipal;
}

export type MediaRequestEligibility =
  | { snapshot: MediaRequestEligibilitySnapshot; status: "ready" }
  | { status: "forbidden" | "link_required" | "signed_out" | "unavailable" };

export type MediaRequestClientErrorKind =
  | "already_exists"
  | "configuration"
  | "denied"
  | "forbidden"
  | "identity"
  | "invalid_response"
  | "no_seasons"
  | "pending"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export type MediaRequestRetryMode = "new_key" | "none" | "same_key";

export class MediaRequestClientError extends Error {
  public readonly code: string;
  public readonly kind: MediaRequestClientErrorKind;
  public readonly retryMode: MediaRequestRetryMode;

  public constructor(
    kind: MediaRequestClientErrorKind,
    code: string,
    message: string,
    retryMode: MediaRequestRetryMode = "none",
  ) {
    super(message);
    this.name = "MediaRequestClientError";
    this.kind = kind;
    this.code = code;
    this.retryMode = retryMode;
  }
}

export interface MediaRequestCreation {
  replayed: boolean;
  request: MediaRequestResponse;
}

export interface CreateMediaRequestOptions {
  csrfToken: string;
  idempotencyKey: IdempotencyKey;
  signal?: AbortSignal;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MediaRequestClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
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
    throw new MediaRequestClientError(
      "unavailable",
      "service_unavailable",
      "The request could not reach the gateway. Its idempotency key was preserved.",
      "same_key",
    );
  }
}

function mappedError(status: number, code: string, message: string): MediaRequestClientError {
  if (status === 401) {
    return new MediaRequestClientError("signed_out", code, "Your session ended. Sign in again.");
  }
  if (status === 429) {
    return new MediaRequestClientError(
      "rate_limited",
      code,
      "Requests are cooling down. Wait a moment before starting a new attempt.",
      "new_key",
    );
  }
  if (code === "request_identity_link_required") {
    return new MediaRequestClientError("identity", code, message);
  }
  if (code === "request_identity_unavailable") {
    return new MediaRequestClientError("identity", code, message);
  }
  if (code === "request_denied") {
    return new MediaRequestClientError("denied", code, message);
  }
  if (code === "request_no_seasons_available") {
    return new MediaRequestClientError("no_seasons", code, message);
  }
  if (code === "request_already_exists") {
    return new MediaRequestClientError("already_exists", code, message);
  }
  if (code === "request_outcome_pending") {
    return new MediaRequestClientError("pending", code, message, "same_key");
  }
  if (code === "request_configuration_unavailable") {
    return new MediaRequestClientError("configuration", code, message, "new_key");
  }
  if (code === "request_temporarily_unavailable") {
    return new MediaRequestClientError("unavailable", code, message, "new_key");
  }
  if (code === "request_response_invalid") {
    return new MediaRequestClientError("invalid_response", code, message);
  }
  if (status === 403) return new MediaRequestClientError("forbidden", code, message);
  return new MediaRequestClientError(
    status >= 500 ? "unavailable" : "invalid_response",
    code,
    message,
    status >= 500 ? "new_key" : "none",
  );
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
    : "The media request could not be completed.";
  return mappedError(response.status, code, message);
}

export function createMediaRequestIdempotencyKey(): IdempotencyKey {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new MediaRequestClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure request identifier.",
    );
  }
  return `media-${identifier}`;
}

export interface MediaRequestClient {
  create(
    input: MediaRequestInput,
    options: CreateMediaRequestOptions,
  ): Promise<MediaRequestCreation>;
  loadEligibility(signal?: AbortSignal): Promise<MediaRequestEligibility>;
}

export const mediaRequestClient: MediaRequestClient = {
  async create(input, options) {
    const schemas = await contractSchemas();
    const body = schemas.requests.mediaRequestInputSchema.parse(input);
    const idempotencyKey = schemas.requests.idempotencyKeySchema.parse(options.idempotencyKey);
    const response = await fetchSameOrigin("/api/requests", {
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
    const parsed = schemas.requests.mediaRequestResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success) {
      throw new MediaRequestClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned a response that did not match the public contract.",
      );
    }
    return {
      replayed: response.headers.get("idempotency-replayed") === "true",
      request: parsed.data,
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
      if (principal.accountState !== "active") return { status: "link_required" };
      if (!principal.permissions.includes("request.create")) return { status: "forbidden" };
      const jellyfin = principal.linkedServices.find(
        (link) =>
          link.service === "jellyfin" &&
          (link.health === "linked" || link.health === "unavailable") &&
          link.externalUserId !== null &&
          link.username !== null,
      );
      if (!jellyfin) return { status: "link_required" };
      const jellyfinHealth =
        jellyfin.health === "linked" || jellyfin.health === "unavailable" ? jellyfin.health : null;
      if (jellyfinHealth === null) return { status: "link_required" };
      return {
        snapshot: {
          csrfToken,
          jellyfinDisplayName: jellyfin.displayName ?? jellyfin.username ?? "Jellyfin account",
          jellyfinHealth,
          principal,
        },
        status: "ready",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return { status: "unavailable" };
    }
  },
};
