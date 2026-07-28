import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  IdempotencyKey,
  RequestReviewDecisionInput,
  RequestReviewFilter,
  RequestReviewItem,
  RequestReviewPage,
  RequestReviewQuery,
} from "@omnifin/contracts/requests";

const CSRF_HEADER = "x-omnifin-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

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

export type RequestReviewClientErrorKind =
  | "conflict"
  | "forbidden"
  | "invalid_response"
  | "not_configured"
  | "not_found"
  | "pending"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class RequestReviewClientError extends Error {
  public readonly code: string;
  public readonly kind: RequestReviewClientErrorKind;
  public readonly retryAfterSeconds: number | null;

  public constructor(
    kind: RequestReviewClientErrorKind,
    code: string,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "RequestReviewClientError";
    this.kind = kind;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RequestReviewSnapshot {
  csrfToken: string;
  page: RequestReviewPage;
  principal: SessionPrincipal;
}

export type RequestReviewLoadOutcome =
  | { snapshot: RequestReviewSnapshot; status: "ready" }
  | { status: "forbidden" | "not_configured" | "signed_out" | "unavailable" };

export interface RequestReviewMutationOptions {
  csrfToken: string;
  idempotencyKey: IdempotencyKey;
  signal?: AbortSignal;
}

export interface RequestReviewMutationResult {
  replayed: boolean;
  request: RequestReviewItem;
}

export interface RequestReviewClient {
  list(query: RequestReviewQuery, signal?: AbortSignal): Promise<RequestReviewPage>;
  load(signal?: AbortSignal): Promise<RequestReviewLoadOutcome>;
  review(
    requestId: string,
    input: RequestReviewDecisionInput,
    options: RequestReviewMutationOptions,
  ): Promise<RequestReviewMutationResult>;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new RequestReviewClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable request review response.",
    );
  }
}

function retryAfterSeconds(response: Response) {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorKind(status: number, code: string): RequestReviewClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (code === "request_review_conflict" || code === "idempotency_key_conflict") {
    return "conflict";
  }
  if (code === "request_review_outcome_pending") return "pending";
  if (code === "request_review_configuration_unavailable") return "not_configured";
  if (code === "request_review_response_invalid") return "invalid_response";
  return status >= 500 ? "unavailable" : "invalid_response";
}

async function responseError(response: Response) {
  const { errors } = await contractSchemas();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = errors.apiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : "request_review_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "The media request review could not be completed.";
  return new RequestReviewClientError(
    errorKind(response.status, code),
    code,
    message,
    retryAfterSeconds(response),
  );
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
    throw new RequestReviewClientError(
      "unavailable",
      "service_unavailable",
      "The request review workspace could not reach the gateway.",
    );
  }
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new RequestReviewClientError(
      "invalid_response",
      "invalid_request_review_response",
      "The gateway returned request data outside the public contract.",
    );
  }
  return parsed.data;
}

export function createRequestReviewIdempotencyKey(): IdempotencyKey {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new RequestReviewClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure review decision identifier.",
    );
  }
  return `review-${identifier}`;
}

async function listRequestReviews(query: RequestReviewQuery, signal?: AbortSignal) {
  const { requests } = await contractSchemas();
  const safeQuery = requests.requestReviewQuerySchema.parse(query);
  const parameters = new URLSearchParams({
    limit: String(safeQuery.limit),
    status: safeQuery.status,
  });
  if (safeQuery.cursor) parameters.set("cursor", safeQuery.cursor);
  return parsedResponse(
    await fetchSameOrigin(`/api/requests/review?${parameters.toString()}`, {
      ...(signal === undefined ? {} : { signal }),
    }),
    requests.requestReviewPageSchema,
  );
}

export const requestReviewClient: RequestReviewClient = {
  async list(query, signal) {
    return listRequestReviews(query, signal);
  },

  async load(signal) {
    try {
      const response = await fetchSameOrigin("/api/auth/session", {
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        return response.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
      }
      const { auth } = await contractSchemas();
      const session = auth.sessionResponseSchema.safeParse(await safeJson(response));
      if (!session.success) return { status: "unavailable" };
      const { csrfToken, principal } = session.data;
      if (principal === null || csrfToken === null) return { status: "signed_out" };
      if (!principal.permissions.includes("request.review")) return { status: "forbidden" };
      return {
        snapshot: {
          csrfToken,
          page: await listRequestReviews({ cursor: null, limit: 20, status: "pending" }, signal),
          principal,
        },
        status: "ready",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof RequestReviewClientError) {
        if (error.kind === "forbidden" || error.kind === "signed_out") {
          return { status: error.kind };
        }
        if (error.kind === "not_configured") return { status: "not_configured" };
      }
      return { status: "unavailable" };
    }
  },

  async review(requestId, input, options) {
    const { requests } = await contractSchemas();
    const safeId = requests.requestReviewItemSchema.shape.id.parse(requestId);
    const safeInput = requests.requestReviewDecisionInputSchema.parse(input);
    const safeIdempotencyKey = requests.idempotencyKeySchema.parse(options.idempotencyKey);
    const response = await fetchSameOrigin(`/api/requests/${encodeURIComponent(safeId)}/review`, {
      body: JSON.stringify(safeInput),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [CSRF_HEADER]: options.csrfToken,
        [IDEMPOTENCY_HEADER]: safeIdempotencyKey,
      },
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      replayed: response.headers.get("idempotency-replayed") === "true",
      request: await parsedResponse(response, requests.requestReviewItemSchema),
    };
  },
};

export function requestReviewFilterLabel(filter: RequestReviewFilter) {
  if (filter === "pending") return "Awaiting review";
  if (filter === "approved") return "Approved";
  if (filter === "declined") return "Declined";
  return "All requests";
}
