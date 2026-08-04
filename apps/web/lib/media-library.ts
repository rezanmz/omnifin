import type {
  LibraryBrowseKind,
  LibraryBrowseResponse,
  LibraryBrowseSort,
  LibraryExtrasResponse,
  LibraryPlaybackStateMutationRequest,
  LibraryPlaybackStateMutationResponse,
  LibrarySeasonEpisodesResponse,
  LibraryTitleDetailResponse,
} from "@omnifin/contracts/library";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, library, errors] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/library"),
    import("@omnifin/contracts/errors"),
  ]);
  return { auth, errors, library };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export interface MediaLibraryParameters {
  cursor?: string;
  kind: LibraryBrowseKind;
  limit?: number;
  query?: string;
  sort: LibraryBrowseSort;
}

export type MediaLibraryClientErrorKind =
  "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class MediaLibraryClientError extends Error {
  public readonly code: string;
  public readonly kind: MediaLibraryClientErrorKind;

  public constructor(kind: MediaLibraryClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "MediaLibraryClientError";
    this.kind = kind;
    this.code = code;
  }
}

export type MediaLibraryLoadOutcome =
  | { feed: LibraryBrowseResponse; status: "ready" }
  | { status: "forbidden" | "loading" | "signed_out" | "unavailable" };

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MediaLibraryClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable library response.",
    );
  }
}

async function responseError(response: Response): Promise<MediaLibraryClientError> {
  if (response.status === 401) {
    return new MediaLibraryClientError(
      "signed_out",
      "authentication_required",
      "Sign in to open your Jellyfin library.",
    );
  }
  if (response.status === 403) {
    return new MediaLibraryClientError(
      "forbidden",
      "permission_denied",
      "Your account cannot view Jellyfin media.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new MediaLibraryClientError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new MediaLibraryClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    "request_failed",
    "The library could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new MediaLibraryClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned library data that did not match the public contract.",
    );
  }
  return parsed.data;
}

function requestParameters(input: MediaLibraryParameters) {
  const parameters = new URLSearchParams({
    kind: input.kind,
    limit: String(input.limit ?? 30),
    sort: input.sort,
  });
  const query = input.query?.trim();
  if (query) parameters.set("query", query);
  if (input.cursor) parameters.set("cursor", input.cursor);
  return parameters;
}

export interface MediaLibraryClient {
  load(input: MediaLibraryParameters, signal?: AbortSignal): Promise<LibraryBrowseResponse>;
  loadSeasonEpisodes?(
    referenceId: string,
    seasonNumber: number,
    input?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<LibrarySeasonEpisodesResponse>;
  loadExtras?(
    referenceId: string,
    input?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<LibraryExtrasResponse>;
  loadTitle?(referenceId: string, signal?: AbortSignal): Promise<LibraryTitleDetailResponse>;
  updatePlaybackState?(
    referenceId: string,
    request: LibraryPlaybackStateMutationRequest,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<LibraryPlaybackStateMutationResponse>;
}

const MEDIA_REFERENCE_PATTERN = /^media_[A-Za-z0-9_-]{22}$/u;

function assertMediaReference(referenceId: string) {
  if (!MEDIA_REFERENCE_PATTERN.test(referenceId)) {
    throw new MediaLibraryClientError(
      "invalid_response",
      "invalid_reference",
      "The selected library reference is invalid.",
    );
  }
}

async function fetchLibraryJson<T>(path: string, schema: ResponseSchema<T>, signal?: AbortSignal) {
  const response = await fetchLibraryResponse(
    path,
    { headers: { accept: "application/json" } },
    signal,
  );
  return parsedResponse(response, schema);
}

async function fetchLibraryResponse(path: string, init: RequestInit = {}, signal?: AbortSignal) {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new MediaLibraryClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached.",
    );
  }
}

export const mediaLibraryClient: MediaLibraryClient = {
  async load(input, signal) {
    const schemas = (await contractSchemas()).library;
    return fetchLibraryJson(
      `/api/media/library?${requestParameters(input).toString()}`,
      schemas.libraryBrowseResponseSchema,
      signal,
    );
  },
  async loadSeasonEpisodes(referenceId, seasonNumber, input = {}, signal) {
    assertMediaReference(referenceId);
    if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 100_000) {
      throw new MediaLibraryClientError(
        "invalid_response",
        "invalid_season",
        "The selected season is invalid.",
      );
    }
    const parameters = new URLSearchParams({ limit: String(input.limit ?? 30) });
    if (input.cursor) parameters.set("cursor", input.cursor);
    const schemas = (await contractSchemas()).library;
    return fetchLibraryJson(
      `/api/media/library/${referenceId}/seasons/${seasonNumber}/episodes?${parameters.toString()}`,
      schemas.librarySeasonEpisodesResponseSchema,
      signal,
    );
  },
  async loadExtras(referenceId, input = {}, signal) {
    assertMediaReference(referenceId);
    const parameters = new URLSearchParams({ limit: String(input.limit ?? 12) });
    if (input.cursor) parameters.set("cursor", input.cursor);
    const schemas = (await contractSchemas()).library;
    return fetchLibraryJson(
      `/api/media/library/${referenceId}/extras?${parameters.toString()}`,
      schemas.libraryExtrasResponseSchema,
      signal,
    );
  },
  async loadTitle(referenceId, signal) {
    assertMediaReference(referenceId);
    const schemas = (await contractSchemas()).library;
    return fetchLibraryJson(
      `/api/media/library/${referenceId}`,
      schemas.libraryTitleDetailResponseSchema,
      signal,
    );
  },
  async updatePlaybackState(referenceId, request, signal, idempotencyKey = crypto.randomUUID()) {
    assertMediaReference(referenceId);
    const schemas = await contractSchemas();
    const body = schemas.library.libraryPlaybackStateMutationRequestSchema.parse(request);
    const sessionResponse = await fetchLibraryResponse(
      "/api/auth/session",
      { headers: { accept: "application/json" } },
      signal,
    );
    if (!sessionResponse.ok) throw await responseError(sessionResponse);
    const session = schemas.auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success || session.data.principal === null || session.data.csrfToken === null) {
      throw new MediaLibraryClientError(
        "signed_out",
        "authentication_required",
        "Your session ended. Sign in again to update Jellyfin.",
      );
    }
    if (!session.data.principal.permissions.includes("playback.history.self.manage")) {
      throw new MediaLibraryClientError(
        "forbidden",
        "permission_denied",
        "Your account cannot update Jellyfin playback state.",
      );
    }
    const response = await fetchLibraryResponse(
      `/api/media/library/${referenceId}/playback-state`,
      {
        body: JSON.stringify(body),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-omnifin-csrf": session.data.csrfToken,
        },
        method: "POST",
      },
      signal,
    );
    return parsedResponse(response, schemas.library.libraryPlaybackStateMutationResponseSchema);
  },
};

export function mediaLibraryOutcomeFromError(
  error: unknown,
): Exclude<MediaLibraryLoadOutcome["status"], "loading" | "ready"> {
  if (error instanceof MediaLibraryClientError) {
    if (error.kind === "forbidden" || error.kind === "signed_out") return error.kind;
  }
  return "unavailable";
}

export function sameOriginMediaPath(path: string | null) {
  if (!path?.startsWith("/v1/media/")) return undefined;
  return path.replace(/^\/v1\//u, "/api/");
}
