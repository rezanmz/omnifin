import type {
  LibraryBrowseKind,
  LibraryBrowseResponse,
  LibraryBrowseSort,
} from "@omnifin/contracts/library";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [library, errors] = await Promise.all([
    import("@omnifin/contracts/library"),
    import("@omnifin/contracts/errors"),
  ]);
  return { errors, library };
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
}

export const mediaLibraryClient: MediaLibraryClient = {
  async load(input, signal) {
    let response: Response;
    try {
      response = await fetch(`/api/media/library?${requestParameters(input).toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
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
    const schemas = (await contractSchemas()).library;
    return parsedResponse(response, schemas.libraryBrowseResponseSchema);
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
