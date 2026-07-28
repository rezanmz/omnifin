import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  LibraryArtworkSearchRequest,
  LibraryArtworkSearchResponse,
  LibraryAttentionResponse,
  LibraryItemRefreshRequest,
  LibraryMetadataUpdateRequest,
  LibraryMutationResponse,
} from "@omnifin/contracts/library";

const CSRF_HEADER = "x-omnifin-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";
const PAGE_LIMIT = 30;

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, dashboard, errors, library] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/dashboard"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/library"),
  ]);
  return { auth, dashboard, errors, library };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type LibraryClientErrorKind =
  | "conflict"
  | "expired"
  | "forbidden"
  | "invalid_response"
  | "not_configured"
  | "not_found"
  | "pending"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class LibraryClientError extends Error {
  public readonly code: string;
  public readonly kind: LibraryClientErrorKind;
  public readonly retryAfterSeconds: number | null;

  public constructor(
    kind: LibraryClientErrorKind,
    code: string,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "LibraryClientError";
    this.kind = kind;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface LibrarySnapshot {
  attention: LibraryAttentionResponse;
  csrfToken: string;
  principal: SessionPrincipal;
}

export type LibraryLoadOutcome =
  | { snapshot: LibrarySnapshot; status: "ready" }
  | { status: "forbidden" | "not_configured" | "signed_out" | "unavailable" };

export interface LibraryMutationOptions {
  csrfToken: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface LibrarySearchOptions {
  csrfToken: string;
  signal?: AbortSignal;
}

export interface LibraryMutationResult {
  receipt: LibraryMutationResponse;
  replayed: boolean;
}

export interface LibraryOperationsClient {
  applyArtwork(
    searchId: string,
    resultId: string,
    options: LibraryMutationOptions,
  ): Promise<LibraryMutationResult>;
  load(): Promise<LibraryLoadOutcome>;
  loadAttention(cursor?: string | null, signal?: AbortSignal): Promise<LibraryAttentionResponse>;
  refresh(
    referenceId: string,
    request: LibraryItemRefreshRequest,
    options: LibraryMutationOptions,
  ): Promise<LibraryMutationResult>;
  scan(options: LibraryMutationOptions): Promise<LibraryMutationResult>;
  searchArtwork(
    referenceId: string,
    request: LibraryArtworkSearchRequest,
    options: LibrarySearchOptions,
  ): Promise<LibraryArtworkSearchResponse>;
  updateMetadata(
    referenceId: string,
    request: LibraryMetadataUpdateRequest,
    options: LibraryMutationOptions,
  ): Promise<LibraryMutationResult>;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new LibraryClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable library response.",
    );
  }
}

function retryAfterSeconds(response: Response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorKind(status: number, code: string): LibraryClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (code === "library_artwork_search_expired") return "expired";
  if (code === "library_item_not_found") return "not_found";
  if (code === "idempotency_key_conflict") return "conflict";
  if (code === "library_operation_outcome_pending") return "pending";
  if (code === "library_configuration_unavailable") return "not_configured";
  if (code === "library_response_invalid") return "invalid_response";
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
  const code = parsed.success ? parsed.data.error.code : "library_operation_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "The library operation could not be completed.";
  return new LibraryClientError(
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
    throw new LibraryClientError(
      "unavailable",
      "service_unavailable",
      "The library workspace could not reach the gateway.",
    );
  }
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new LibraryClientError(
      "invalid_response",
      "invalid_library_response",
      "The gateway returned library data outside the public contract.",
    );
  }
  return parsed.data;
}

function mutationHeaders(csrfToken: string, idempotencyKey: string) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    [CSRF_HEADER]: csrfToken,
    [IDEMPOTENCY_HEADER]: idempotencyKey,
  };
}

async function mutationResponse(response: Response): Promise<LibraryMutationResult> {
  const { library } = await contractSchemas();
  return {
    receipt: await parsedResponse(response, library.libraryMutationResponseSchema),
    replayed: response.headers.get("idempotency-replayed") === "true",
  };
}

export function createLibraryIdempotencyKey(kind: string) {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new LibraryClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure library operation identifier.",
    );
  }
  return `library-${kind}-${identifier}`;
}

async function loadAttention(cursor?: string | null, signal?: AbortSignal) {
  const { library } = await contractSchemas();
  const parameters = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) parameters.set("cursor", library.libraryCursorSchema.parse(cursor));
  return parsedResponse(
    await fetchSameOrigin(`/api/library/attention?${parameters.toString()}`, {
      ...(signal === undefined ? {} : { signal }),
    }),
    library.libraryAttentionResponseSchema,
  );
}

export async function loadLibraryWorkspace(): Promise<LibraryLoadOutcome> {
  try {
    const sessionResponse = await fetchSameOrigin("/api/auth/session");
    if (!sessionResponse.ok) {
      return sessionResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const { auth } = await contractSchemas();
    const session = auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success) return { status: "unavailable" };
    if (session.data.principal === null || session.data.csrfToken === null) {
      return { status: "signed_out" };
    }
    if (!session.data.principal.permissions.includes("library.manage")) {
      return { status: "forbidden" };
    }
    return {
      snapshot: {
        attention: await loadAttention(),
        csrfToken: session.data.csrfToken,
        principal: session.data.principal,
      },
      status: "ready",
    };
  } catch (error) {
    if (error instanceof LibraryClientError) {
      if (error.kind === "signed_out" || error.kind === "forbidden") {
        return { status: error.kind };
      }
      if (error.kind === "not_configured") return { status: "not_configured" };
    }
    return { status: "unavailable" };
  }
}

export const libraryOperationsClient: LibraryOperationsClient = {
  async applyArtwork(searchId, resultId, options) {
    const { auth, library } = await contractSchemas();
    const safeSearchId = library.libraryArtworkSearchIdSchema.parse(searchId);
    const safeResultId = library.libraryArtworkResultIdSchema.parse(resultId);
    const csrfToken = auth.csrfTokenSchema.parse(options.csrfToken);
    const idempotencyKey = library.libraryMutationIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    return mutationResponse(
      await fetchSameOrigin(
        `/api/library/artwork-searches/${safeSearchId}/results/${safeResultId}/apply`,
        {
          body: JSON.stringify(library.libraryArtworkApplyRequestSchema.parse({})),
          headers: mutationHeaders(csrfToken, idempotencyKey),
          method: "POST",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      ),
    );
  },
  load: loadLibraryWorkspace,
  loadAttention,
  async refresh(referenceId, request, options) {
    const { auth, dashboard, library } = await contractSchemas();
    const safeReferenceId = dashboard.mediaReferenceIdSchema.parse(referenceId);
    const body = library.libraryItemRefreshRequestSchema.parse(request);
    const csrfToken = auth.csrfTokenSchema.parse(options.csrfToken);
    const idempotencyKey = library.libraryMutationIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    return mutationResponse(
      await fetchSameOrigin(`/api/library/items/${safeReferenceId}/refresh`, {
        body: JSON.stringify(body),
        headers: mutationHeaders(csrfToken, idempotencyKey),
        method: "POST",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  },
  async scan(options) {
    const { auth, library } = await contractSchemas();
    const csrfToken = auth.csrfTokenSchema.parse(options.csrfToken);
    const idempotencyKey = library.libraryMutationIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    return mutationResponse(
      await fetchSameOrigin("/api/library/scans", {
        body: JSON.stringify(library.libraryScanRequestSchema.parse({})),
        headers: mutationHeaders(csrfToken, idempotencyKey),
        method: "POST",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  },
  async searchArtwork(referenceId, request, options) {
    const { auth, dashboard, library } = await contractSchemas();
    const safeReferenceId = dashboard.mediaReferenceIdSchema.parse(referenceId);
    const body = library.libraryArtworkSearchRequestSchema.parse(request);
    const csrfToken = auth.csrfTokenSchema.parse(options.csrfToken);
    return parsedResponse(
      await fetchSameOrigin(`/api/library/items/${safeReferenceId}/artwork/search`, {
        body: JSON.stringify(body),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [CSRF_HEADER]: csrfToken,
        },
        method: "POST",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      library.libraryArtworkSearchResponseSchema,
    );
  },
  async updateMetadata(referenceId, request, options) {
    const { auth, dashboard, library } = await contractSchemas();
    const safeReferenceId = dashboard.mediaReferenceIdSchema.parse(referenceId);
    const body = library.libraryMetadataUpdateRequestSchema.parse(request);
    const csrfToken = auth.csrfTokenSchema.parse(options.csrfToken);
    const idempotencyKey = library.libraryMutationIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    return mutationResponse(
      await fetchSameOrigin(`/api/library/items/${safeReferenceId}/metadata`, {
        body: JSON.stringify(body),
        headers: mutationHeaders(csrfToken, idempotencyKey),
        method: "POST",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  },
};
