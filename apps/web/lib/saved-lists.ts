import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  SavedFavoriteMutationRequest,
  SavedFavoriteMutationResponse,
  SavedDiscoveryTargetIssueRequest,
  SavedListCreateRequest,
  SavedListDeleteResponse,
  SavedListItemsQuery,
  SavedListItemsResponse,
  SavedListMembershipDeleteResponse,
  SavedListMembershipRequest,
  SavedListMembershipResponse,
  SavedListMutationResponse,
  SavedListReorderRequest,
  SavedListReorderResponse,
  SavedListsResponse,
  SavedListSummary,
  SavedListUpdateRequest,
  SavedMembershipSummary,
} from "@omnifin/contracts/saved";

const CSRF_HEADER = "x-omnifin-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";
const STRONG_ETAG_PATTERN = /^"saved_[A-Za-z0-9_-]{22}"$/u;

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors, saved] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/saved"),
  ]);
  return { auth, errors, saved };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type SavedListsClientErrorKind =
  | "conflict"
  | "expired"
  | "forbidden"
  | "invalid_response"
  | "not_found"
  | "precondition"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export type SavedListsRetryMode = "none" | "refresh" | "same_key";

export class SavedListsClientError extends Error {
  public readonly code: string;
  public readonly kind: SavedListsClientErrorKind;
  public readonly retryAfterSeconds: number | null;
  public readonly retryMode: SavedListsRetryMode;

  public constructor(
    kind: SavedListsClientErrorKind,
    code: string,
    message: string,
    options: { retryAfterSeconds?: number | null; retryMode?: SavedListsRetryMode } = {},
  ) {
    super(message);
    this.name = "SavedListsClientError";
    this.kind = kind;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.retryMode = options.retryMode ?? "none";
  }
}

export interface SavedWorkspaceSnapshot {
  csrfToken: string;
  lists: SavedListsResponse;
  principal: SessionPrincipal;
}

export type SavedWorkspaceLoadOutcome =
  | { snapshot: SavedWorkspaceSnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export interface SavedVersionedResponse<T> {
  data: T;
  etag: string;
}

export interface SavedReplayableResponse<T> extends SavedVersionedResponse<T> {
  replayed: boolean;
}

export interface SavedMutationOptions {
  csrfToken: string;
  etag?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface SavedListsClient {
  addItem(
    listId: string,
    input: SavedListMembershipRequest,
    options: SavedMutationOptions,
  ): Promise<SavedReplayableResponse<SavedListMembershipResponse>>;
  createList(
    input: SavedListCreateRequest,
    options: SavedMutationOptions,
  ): Promise<SavedReplayableResponse<SavedListMutationResponse>>;
  deleteList(
    listId: string,
    options: SavedMutationOptions,
  ): Promise<SavedVersionedResponse<SavedListDeleteResponse>>;
  issueLibraryTarget(
    referenceId: string,
    options: Pick<SavedMutationOptions, "csrfToken" | "signal">,
  ): Promise<SavedMembershipSummary>;
  issueDiscoveryTarget(
    input: SavedDiscoveryTargetIssueRequest,
    options: Pick<SavedMutationOptions, "csrfToken" | "signal">,
  ): Promise<SavedMembershipSummary>;
  list(signal?: AbortSignal): Promise<SavedListsResponse>;
  listItems(
    listId: string,
    query: SavedListItemsQuery,
    signal?: AbortSignal,
  ): Promise<SavedVersionedResponse<SavedListItemsResponse>>;
  load(signal?: AbortSignal): Promise<SavedWorkspaceLoadOutcome>;
  readList(listId: string, signal?: AbortSignal): Promise<SavedVersionedResponse<SavedListSummary>>;
  removeItem(
    listId: string,
    catalogReferenceId: string,
    options: SavedMutationOptions,
  ): Promise<SavedVersionedResponse<SavedListMembershipDeleteResponse>>;
  reorderItems(
    listId: string,
    input: SavedListReorderRequest,
    options: SavedMutationOptions,
  ): Promise<SavedReplayableResponse<SavedListReorderResponse>>;
  restoreList(
    listId: string,
    options: SavedMutationOptions,
  ): Promise<SavedReplayableResponse<SavedListMutationResponse>>;
  updateFavorite(
    targetReferenceId: string,
    input: SavedFavoriteMutationRequest,
    options: Pick<SavedMutationOptions, "csrfToken" | "signal">,
  ): Promise<SavedFavoriteMutationResponse>;
  updateList(
    listId: string,
    input: SavedListUpdateRequest,
    options: SavedMutationOptions,
  ): Promise<SavedVersionedResponse<SavedListMutationResponse>>;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SavedListsClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable private-list response.",
    );
  }
}

function retryAfterSeconds(response: Response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mappedError(status: number, code: string, message: string, response: Response) {
  if (status === 401) {
    return new SavedListsClientError("signed_out", code, "Your session ended. Sign in again.");
  }
  if (status === 403) return new SavedListsClientError("forbidden", code, message);
  if (status === 404) {
    return new SavedListsClientError("not_found", code, message, { retryMode: "refresh" });
  }
  if (status === 410) {
    return new SavedListsClientError("expired", code, message, { retryMode: "refresh" });
  }
  if (status === 412 || status === 428) {
    return new SavedListsClientError("precondition", code, message, { retryMode: "refresh" });
  }
  if (status === 429) {
    return new SavedListsClientError("rate_limited", code, message, {
      retryAfterSeconds: retryAfterSeconds(response),
    });
  }
  if (status === 409) {
    return new SavedListsClientError("conflict", code, message, {
      retryMode: code === "saved_list_operation_in_progress" ? "same_key" : "refresh",
    });
  }
  return new SavedListsClientError(
    status >= 500 ? "unavailable" : "invalid_response",
    code,
    message,
    { retryMode: status >= 500 ? "same_key" : "none" },
  );
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
  return mappedError(
    response.status,
    parsed.success ? parsed.data.error.code : "saved_list_request_failed",
    parsed.success ? parsed.data.error.message : "The private-list operation could not complete.",
    response,
  );
}

async function fetchSameOrigin(path: string, init: RequestInit = {}) {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SavedListsClientError(
      "unavailable",
      "service_unavailable",
      "Private lists could not reach the gateway.",
      { retryMode: "same_key" },
    );
  }
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new SavedListsClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned private-list data outside the public contract.",
    );
  }
  return parsed.data;
}

function responseEtag(response: Response) {
  const etag = response.headers.get("etag");
  if (!etag || !STRONG_ETAG_PATTERN.test(etag)) {
    throw new SavedListsClientError(
      "invalid_response",
      "invalid_response",
      "The gateway omitted the private-list version proof.",
    );
  }
  return etag;
}

function mutationHeaders(options: SavedMutationOptions, replayable: boolean) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    [CSRF_HEADER]: options.csrfToken,
  };
  if (options.etag) headers["if-match"] = options.etag;
  if (replayable) {
    if (!options.idempotencyKey) {
      throw new SavedListsClientError(
        "invalid_response",
        "idempotency_key_required",
        "This private-list change needs a stable retry identifier.",
      );
    }
    headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;
  }
  return headers;
}

function queryParameters(input: SavedListItemsQuery) {
  const parameters = new URLSearchParams({
    availability: input.availability,
    limit: String(input.limit),
    sort: input.sort,
  });
  if (input.cursor) parameters.set("cursor", input.cursor);
  const query = input.query?.trim();
  if (query) parameters.set("query", query);
  return parameters;
}

export function browserSavedArtworkPath(path: string | null) {
  if (path === null) return null;
  const match = path.match(
    /^\/v1\/saved\/catalog\/(catalog_[A-Za-z0-9_-]{22})\/images\/(backdrop|poster)$/u,
  );
  if (!match) {
    throw new SavedListsClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unsafe saved-artwork reference.",
    );
  }
  return `/api/saved/catalog/${match[1]}/images/${match[2]}`;
}

function browserListItems(response: SavedListItemsResponse): SavedListItemsResponse {
  return {
    ...response,
    items: response.items.map((item) => ({
      ...item,
      catalog: {
        ...item.catalog,
        artwork: {
          ...item.catalog.artwork,
          backdropPath: browserSavedArtworkPath(item.catalog.artwork.backdropPath),
          posterPath: browserSavedArtworkPath(item.catalog.artwork.posterPath),
        },
      },
    })),
  };
}

function assertListId(value: string, schema: ResponseSchema<string>) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SavedListsClientError(
      "invalid_response",
      "invalid_reference",
      "The selected private-list reference is invalid.",
    );
  }
  return parsed.data;
}

function assertCatalogId(value: string, schema: ResponseSchema<string>) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SavedListsClientError(
      "invalid_response",
      "invalid_reference",
      "The selected saved-title reference is invalid.",
    );
  }
  return parsed.data;
}

function assertEtag(options: SavedMutationOptions) {
  if (!options.etag || !STRONG_ETAG_PATTERN.test(options.etag)) {
    throw new SavedListsClientError(
      "precondition",
      "saved_list_precondition_required",
      "Refresh this private list before changing it.",
      { retryMode: "refresh" },
    );
  }
  return options.etag;
}

export function createSavedListIdempotencyKey() {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new SavedListsClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure private-list retry identifier.",
    );
  }
  return `saved-${identifier}`;
}

async function listSaved(signal?: AbortSignal) {
  const { saved } = await contractSchemas();
  return parsedResponse(
    await fetchSameOrigin("/api/saved/lists?limit=50", {
      ...(signal === undefined ? {} : { signal }),
    }),
    saved.savedListsResponseSchema,
  );
}

export const savedListsClient: SavedListsClient = {
  async addItem(listId, input, options) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    const body = saved.savedListMembershipRequestSchema.parse(input);
    assertEtag(options);
    const response = await fetchSameOrigin(`/api/saved/lists/${safeListId}/items`, {
      body: JSON.stringify(body),
      headers: mutationHeaders(options, true),
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      data: await parsedResponse(response, saved.savedListMembershipResponseSchema),
      etag: responseEtag(response),
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },

  async createList(input, options) {
    const { saved } = await contractSchemas();
    const body = saved.savedListCreateRequestSchema.parse(input);
    const response = await fetchSameOrigin("/api/saved/lists", {
      body: JSON.stringify(body),
      headers: mutationHeaders(options, true),
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      data: await parsedResponse(response, saved.savedListMutationResponseSchema),
      etag: responseEtag(response),
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },

  async deleteList(listId, options) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    assertEtag(options);
    const response = await fetchSameOrigin(`/api/saved/lists/${safeListId}`, {
      headers: mutationHeaders(options, false),
      method: "DELETE",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      data: await parsedResponse(response, saved.savedListDeleteResponseSchema),
      etag: responseEtag(response),
    };
  },

  async issueLibraryTarget(referenceId, options) {
    const { saved } = await contractSchemas();
    if (!/^media_[A-Za-z0-9_-]{22}$/u.test(referenceId)) {
      throw new SavedListsClientError(
        "invalid_response",
        "invalid_reference",
        "The selected library reference is invalid.",
      );
    }
    const response = await fetchSameOrigin(`/api/saved/targets/library/${referenceId}`, {
      body: "{}",
      headers: mutationHeaders(options, false),
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parsedResponse(response, saved.savedMembershipSummarySchema);
  },

  async issueDiscoveryTarget(input, options) {
    const { saved } = await contractSchemas();
    const body = saved.savedDiscoveryTargetIssueRequestSchema.parse(input);
    const response = await fetchSameOrigin("/api/saved/targets/discovery", {
      body: JSON.stringify(body),
      headers: mutationHeaders(options, false),
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parsedResponse(response, saved.savedMembershipSummarySchema);
  },

  list: listSaved,

  async listItems(listId, query, signal) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    const safeQuery = saved.savedListItemsQuerySchema.parse(query);
    const response = await fetchSameOrigin(
      `/api/saved/lists/${safeListId}/items?${queryParameters(safeQuery).toString()}`,
      { ...(signal === undefined ? {} : { signal }) },
    );
    const data = await parsedResponse(response, saved.savedListItemsResponseSchema);
    return { data: browserListItems(data), etag: responseEtag(response) };
  },

  async load(signal) {
    try {
      const { auth } = await contractSchemas();
      const response = await fetchSameOrigin("/api/auth/session", {
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        return response.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
      }
      const session = auth.sessionResponseSchema.safeParse(await safeJson(response));
      if (!session.success) return { status: "unavailable" };
      const { csrfToken, principal } = session.data;
      if (principal === null || csrfToken === null) return { status: "signed_out" };
      if (!principal.permissions.includes("saved.lists.self.manage")) {
        return { status: "forbidden" };
      }
      return {
        snapshot: { csrfToken, lists: await listSaved(signal), principal },
        status: "ready",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof SavedListsClientError) {
        if (error.kind === "signed_out" || error.kind === "forbidden") {
          return { status: error.kind };
        }
      }
      return { status: "unavailable" };
    }
  },

  async readList(listId, signal) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    const response = await fetchSameOrigin(`/api/saved/lists/${safeListId}`, {
      ...(signal === undefined ? {} : { signal }),
    });
    const data = await parsedResponse(response, saved.savedListMutationResponseSchema);
    return { data: data.list, etag: responseEtag(response) };
  },

  async removeItem(listId, catalogReferenceId, options) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    const safeCatalogId = assertCatalogId(catalogReferenceId, saved.savedCatalogReferenceIdSchema);
    assertEtag(options);
    const response = await fetchSameOrigin(
      `/api/saved/lists/${safeListId}/items/${safeCatalogId}`,
      {
        headers: mutationHeaders(options, false),
        method: "DELETE",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return {
      data: await parsedResponse(response, saved.savedListMembershipDeleteResponseSchema),
      etag: responseEtag(response),
    };
  },

  async reorderItems(listId, input, options) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    const body = saved.savedListReorderRequestSchema.parse(input);
    assertEtag(options);
    const response = await fetchSameOrigin(`/api/saved/lists/${safeListId}/items/order`, {
      body: JSON.stringify(body),
      headers: mutationHeaders(options, true),
      method: "PATCH",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      data: await parsedResponse(response, saved.savedListReorderResponseSchema),
      etag: responseEtag(response),
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },

  async restoreList(listId, options) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    assertEtag(options);
    const response = await fetchSameOrigin(`/api/saved/lists/${safeListId}/restore`, {
      body: "{}",
      headers: mutationHeaders(options, true),
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      data: await parsedResponse(response, saved.savedListMutationResponseSchema),
      etag: responseEtag(response),
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },

  async updateFavorite(targetReferenceId, input, options) {
    const { saved } = await contractSchemas();
    const safeTarget = saved.savedTargetReferenceIdSchema.parse(targetReferenceId);
    const body = saved.savedFavoriteMutationRequestSchema.parse(input);
    const response = await fetchSameOrigin(`/api/saved/favorites/${safeTarget}`, {
      body: JSON.stringify(body),
      headers: mutationHeaders(options, false),
      method: "PUT",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parsedResponse(response, saved.savedFavoriteMutationResponseSchema);
  },

  async updateList(listId, input, options) {
    const { saved } = await contractSchemas();
    const safeListId = assertListId(listId, saved.savedListIdSchema);
    const body = saved.savedListUpdateRequestSchema.parse(input);
    assertEtag(options);
    const response = await fetchSameOrigin(`/api/saved/lists/${safeListId}`, {
      body: JSON.stringify(body),
      headers: mutationHeaders(options, false),
      method: "PATCH",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      data: await parsedResponse(response, saved.savedListMutationResponseSchema),
      etag: responseEtag(response),
    };
  },
};
