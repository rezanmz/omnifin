import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  AcquisitionSearchIdempotencyKey,
  AcquisitionSearchInput,
  AcquisitionSearchResponse,
  AcquisitionQueueRecoveryIdempotencyKey,
  AcquisitionQueueRecoveryInput,
  AcquisitionQueueRecoveryResponse,
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
  return contractSchemasPromise.catch((error: unknown) => {
    contractSchemasPromise = undefined;
    throw error;
  });
}

export interface AcquisitionRecoverySnapshot {
  csrfToken: string;
  principal: SessionPrincipal;
}

export type AcquisitionRecoveryEligibility =
  | { snapshot: AcquisitionRecoverySnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export type AcquisitionRecoveryClientErrorKind =
  | "configuration"
  | "forbidden"
  | "invalid_response"
  | "pending"
  | "rate_limited"
  | "signed_out"
  | "stale"
  | "unconfirmed"
  | "unavailable";

export class AcquisitionRecoveryClientError extends Error {
  public readonly code: string;
  public readonly kind: AcquisitionRecoveryClientErrorKind;

  public constructor(kind: AcquisitionRecoveryClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "AcquisitionRecoveryClientError";
    this.kind = kind;
    this.code = code;
  }
}

export interface AcquisitionSearchCreation {
  replayed: boolean;
  search: AcquisitionSearchResponse;
}

export interface QueueAcquisitionSearchOptions {
  csrfToken: string;
  idempotencyKey: AcquisitionSearchIdempotencyKey;
  signal?: AbortSignal;
}

export interface AcquisitionQueueRecoveryCreation {
  recovery: AcquisitionQueueRecoveryResponse;
  replayed: boolean;
}

export interface RecoverAcquisitionQueueOptions {
  csrfToken: string;
  idempotencyKey: AcquisitionQueueRecoveryIdempotencyKey;
  signal?: AbortSignal;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AcquisitionRecoveryClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable acquisition response.",
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
    throw new AcquisitionRecoveryClientError(
      "unavailable",
      "service_unavailable",
      "The acquisition search could not reach the gateway.",
    );
  }
}

function mappedError(status: number, code: string, message: string) {
  if (status === 401) {
    return new AcquisitionRecoveryClientError("signed_out", code, "Your session ended.");
  }
  if (status === 403) return new AcquisitionRecoveryClientError("forbidden", code, message);
  if (status === 429) return new AcquisitionRecoveryClientError("rate_limited", code, message);
  if (code === "acquisition_search_outcome_pending") {
    return new AcquisitionRecoveryClientError("pending", code, message);
  }
  if (code === "acquisition_search_response_invalid") {
    return new AcquisitionRecoveryClientError("invalid_response", code, message);
  }
  if (code === "acquisition_search_configuration_unavailable") {
    return new AcquisitionRecoveryClientError("configuration", code, message);
  }
  if (code === "acquisition_queue_recovery_stale") {
    return new AcquisitionRecoveryClientError("stale", code, message);
  }
  if (
    code === "acquisition_queue_recovery_reference_invalid" ||
    code === "acquisition_queue_recovery_failed"
  ) {
    return new AcquisitionRecoveryClientError("stale", code, message);
  }
  if (code === "acquisition_queue_recovery_pending") {
    return new AcquisitionRecoveryClientError("pending", code, message);
  }
  if (code === "acquisition_queue_recovery_unconfirmed") {
    return new AcquisitionRecoveryClientError("unconfirmed", code, message);
  }
  if (code === "acquisition_queue_recovery_configuration_unavailable") {
    return new AcquisitionRecoveryClientError("configuration", code, message);
  }
  return new AcquisitionRecoveryClientError(
    status >= 500 ? "unavailable" : "invalid_response",
    code,
    message,
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
    : "The acquisition operation could not be completed.";
  return mappedError(response.status, code, message);
}

export function createAcquisitionSearchIdempotencyKey(): AcquisitionSearchIdempotencyKey {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new AcquisitionRecoveryClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure search identifier.",
    );
  }
  return `acquisition-${identifier}`;
}

export function createAcquisitionQueueRecoveryIdempotencyKey(): AcquisitionQueueRecoveryIdempotencyKey {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new AcquisitionRecoveryClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure recovery identifier.",
    );
  }
  return `queue-recovery-${identifier}`;
}

export interface AcquisitionRecoveryClient {
  prepare?(): Promise<void>;
  loadEligibility(signal?: AbortSignal): Promise<AcquisitionRecoveryEligibility>;
  queueSearch(
    input: AcquisitionSearchInput,
    options: QueueAcquisitionSearchOptions,
  ): Promise<AcquisitionSearchCreation>;
  recoverQueueItem?(
    input: AcquisitionQueueRecoveryInput,
    options: RecoverAcquisitionQueueOptions,
  ): Promise<AcquisitionQueueRecoveryCreation>;
}

export const acquisitionRecoveryClient: AcquisitionRecoveryClient = {
  async prepare() {
    await contractSchemas();
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

  async queueSearch(input, options) {
    const schemas = await contractSchemas();
    const body = schemas.acquisition.acquisitionSearchInputSchema.parse(input);
    const idempotencyKey = schemas.acquisition.acquisitionSearchIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    const response = await fetchSameOrigin("/api/acquisitions/searches", {
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
    const parsed = schemas.acquisition.acquisitionSearchResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new AcquisitionRecoveryClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned an acquisition response outside the public contract.",
      );
    }
    return {
      replayed: response.headers.get("idempotency-replayed") === "true",
      search: parsed.data,
    };
  },

  async recoverQueueItem(input, options) {
    const schemas = await contractSchemas();
    const body = schemas.acquisition.acquisitionQueueRecoveryInputSchema.parse(input);
    const idempotencyKey = schemas.acquisition.acquisitionQueueRecoveryIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    const response = await fetchSameOrigin("/api/acquisitions/queue-recoveries", {
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
    const parsed = schemas.acquisition.acquisitionQueueRecoveryResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new AcquisitionRecoveryClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned a queue recovery response outside the public contract.",
      );
    }
    return {
      recovery: parsed.data,
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },
};
