import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  MediaIssueStatusUpdate,
  MediaIssueWorkbenchItem,
  MediaIssueWorkbenchPage,
  MediaIssueWorkbenchQuery,
} from "@omnifin/contracts/issues";
import type { IdempotencyKey } from "@omnifin/contracts/requests";

const CSRF_HEADER = "x-omnifin-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors, issues, requests] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/issues"),
    import("@omnifin/contracts/requests"),
  ]);
  return { auth, errors, issues, requests };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type MediaIssueClientErrorKind =
  | "conflict"
  | "forbidden"
  | "invalid_response"
  | "not_found"
  | "pending"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class MediaIssueClientError extends Error {
  public readonly code: string;
  public readonly kind: MediaIssueClientErrorKind;
  public readonly retryAfterSeconds: number | null;

  public constructor(
    kind: MediaIssueClientErrorKind,
    code: string,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "MediaIssueClientError";
    this.kind = kind;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface MediaIssueSnapshot {
  csrfToken: string;
  page: MediaIssueWorkbenchPage;
  principal: SessionPrincipal;
}

export type MediaIssueLoadOutcome =
  | { snapshot: MediaIssueSnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export interface MediaIssueMutationOptions {
  csrfToken: string;
  idempotencyKey: IdempotencyKey;
  signal?: AbortSignal;
}

export interface MediaIssueMutationResult {
  issue: MediaIssueWorkbenchItem;
  replayed: boolean;
}

export interface MediaIssueClient {
  list(query: MediaIssueWorkbenchQuery, signal?: AbortSignal): Promise<MediaIssueWorkbenchPage>;
  load(signal?: AbortSignal): Promise<MediaIssueLoadOutcome>;
  updateStatus(
    issueId: string,
    input: MediaIssueStatusUpdate,
    options: MediaIssueMutationOptions,
  ): Promise<MediaIssueMutationResult>;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MediaIssueClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable issue response.",
    );
  }
}

function retryAfterSeconds(response: Response) {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorKind(status: number, code: string): MediaIssueClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (code === "media_issue_conflict" || code === "idempotency_key_conflict") {
    return "conflict";
  }
  if (code === "media_issue_outcome_pending") return "pending";
  if (code === "media_issue_response_invalid") return "invalid_response";
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
  const code = parsed.success ? parsed.data.error.code : "media_issue_operation_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "The issue decision could not be completed.";
  return new MediaIssueClientError(
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
    throw new MediaIssueClientError(
      "unavailable",
      "service_unavailable",
      "The issue workspace could not reach the gateway.",
    );
  }
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new MediaIssueClientError(
      "invalid_response",
      "invalid_media_issue_response",
      "The gateway returned issue data outside the public contract.",
    );
  }
  return parsed.data;
}

export function createMediaIssueIdempotencyKey(): IdempotencyKey {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new MediaIssueClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure issue decision identifier.",
    );
  }
  return `issue-status-${identifier}`;
}

async function listIssues(query: MediaIssueWorkbenchQuery, signal?: AbortSignal) {
  const { issues } = await contractSchemas();
  const safeQuery = issues.mediaIssueWorkbenchQuerySchema.parse(query);
  const parameters = new URLSearchParams({
    limit: String(safeQuery.limit),
    source: safeQuery.source,
    status: safeQuery.status,
  });
  return parsedResponse(
    await fetchSameOrigin(`/api/issues?${parameters.toString()}`, {
      ...(signal === undefined ? {} : { signal }),
    }),
    issues.mediaIssueWorkbenchPageSchema,
  );
}

export const mediaIssueClient: MediaIssueClient = {
  async list(query, signal) {
    return listIssues(query, signal);
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
      if (!principal.permissions.includes("issue.manage")) return { status: "forbidden" };
      return {
        snapshot: {
          csrfToken,
          page: await listIssues({ limit: 50, source: "all", status: "open" }, signal),
          principal,
        },
        status: "ready",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof MediaIssueClientError) {
        if (error.kind === "forbidden" || error.kind === "signed_out") {
          return { status: error.kind };
        }
      }
      return { status: "unavailable" };
    }
  },

  async updateStatus(issueId, input, options) {
    const { issues, requests } = await contractSchemas();
    const safeId = issues.playbackIssueIdSchema.parse(issueId);
    const safeInput = issues.mediaIssueStatusUpdateSchema.parse(input);
    const safeIdempotencyKey = requests.idempotencyKeySchema.parse(options.idempotencyKey);
    const response = await fetchSameOrigin(`/api/issues/${encodeURIComponent(safeId)}/status`, {
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
      issue: await parsedResponse(response, issues.mediaIssueWorkbenchItemSchema),
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },
};
