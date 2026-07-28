import type {
  SubtitleDownloadIdempotencyKey,
  SubtitleDownloadResponse,
  SubtitleSearchResponse,
} from "@omnifin/contracts/subtitles";

const CSRF_HEADER = "x-omnifin-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, dashboard, errors, subtitles] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/dashboard"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/subtitles"),
  ]);
  return { auth, dashboard, errors, subtitles };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type SubtitleClientErrorKind =
  | "configuration"
  | "conflict"
  | "expired"
  | "forbidden"
  | "invalid_response"
  | "media_unavailable"
  | "pending"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class SubtitleClientError extends Error {
  public readonly code: string;
  public readonly kind: SubtitleClientErrorKind;
  public readonly retryAfterSeconds: number | null;

  public constructor(
    kind: SubtitleClientErrorKind,
    code: string,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "SubtitleClientError";
    this.kind = kind;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SubtitleDownloadCreation {
  download: SubtitleDownloadResponse;
  replayed: boolean;
}

export interface SubtitleSearchOptions {
  csrfToken: string;
  signal?: AbortSignal;
}

export interface SubtitleDownloadOptions extends SubtitleSearchOptions {
  idempotencyKey: SubtitleDownloadIdempotencyKey;
}

export interface SubtitleClient {
  download(
    searchId: string,
    resultId: string,
    options: SubtitleDownloadOptions,
  ): Promise<SubtitleDownloadCreation>;
  search(mediaReferenceId: string, options: SubtitleSearchOptions): Promise<SubtitleSearchResponse>;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SubtitleClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable subtitle response.",
    );
  }
}

async function fetchSameOrigin(path: string, init: RequestInit) {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SubtitleClientError(
      "unavailable",
      "service_unavailable",
      "The subtitle workbench could not reach the gateway.",
    );
  }
}

function errorKind(status: number, code: string): SubtitleClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 429 || code === "subtitle_rate_limited") return "rate_limited";
  if (code === "subtitle_search_expired") return "expired";
  if (code === "idempotency_key_conflict") return "conflict";
  if (code === "subtitle_download_outcome_pending") return "pending";
  if (
    code === "media_reference_not_found" ||
    code === "subtitle_media_ambiguous" ||
    code === "subtitle_media_not_indexed" ||
    code === "subtitle_media_unsupported"
  ) {
    return "media_unavailable";
  }
  if (code === "subtitle_configuration_unavailable") return "configuration";
  if (code === "subtitle_response_invalid") return "invalid_response";
  return status >= 500 ? "unavailable" : "invalid_response";
}

function retryAfterSeconds(response: Response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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
  const code = parsed.success ? parsed.data.error.code : "subtitle_operation_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "The subtitle operation could not be completed.";
  return new SubtitleClientError(
    errorKind(response.status, code),
    code,
    message,
    retryAfterSeconds(response),
  );
}

export function createSubtitleDownloadIdempotencyKey(): SubtitleDownloadIdempotencyKey {
  const identifier = globalThis.crypto?.randomUUID?.();
  if (!identifier) {
    throw new SubtitleClientError(
      "unavailable",
      "secure_random_unavailable",
      "This browser cannot create a secure subtitle operation identifier.",
    );
  }
  return `subtitle-download-${identifier}`;
}

export const subtitleClient: SubtitleClient = {
  async download(searchId, resultId, options) {
    const schemas = await contractSchemas();
    const safeSearchId = schemas.subtitles.subtitleSearchIdSchema.parse(searchId);
    const safeResultId = schemas.subtitles.subtitleResultIdSchema.parse(resultId);
    const csrfToken = schemas.auth.csrfTokenSchema.parse(options.csrfToken);
    const idempotencyKey = schemas.subtitles.subtitleDownloadIdempotencyKeySchema.parse(
      options.idempotencyKey,
    );
    const body = schemas.subtitles.subtitleDownloadRequestSchema.parse({});
    const response = await fetchSameOrigin(
      `/api/subtitle-searches/${safeSearchId}/results/${safeResultId}/download`,
      {
        body: JSON.stringify(body),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [CSRF_HEADER]: csrfToken,
          [IDEMPOTENCY_HEADER]: idempotencyKey,
        },
        method: "POST",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.subtitles.subtitleDownloadResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new SubtitleClientError(
        "invalid_response",
        "invalid_subtitle_download_response",
        "The gateway returned subtitle download data outside the public contract.",
      );
    }
    return {
      download: parsed.data,
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  },

  async search(mediaReferenceId, options) {
    const schemas = await contractSchemas();
    const safeReferenceId = schemas.dashboard.mediaReferenceIdSchema.parse(mediaReferenceId);
    const csrfToken = schemas.auth.csrfTokenSchema.parse(options.csrfToken);
    const body = schemas.subtitles.subtitleSearchRequestSchema.parse({});
    const response = await fetchSameOrigin(`/api/media/${safeReferenceId}/subtitles/search`, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.subtitles.subtitleSearchResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new SubtitleClientError(
        "invalid_response",
        "invalid_subtitle_search_response",
        "The gateway returned subtitle search data outside the public contract.",
      );
    }
    return parsed.data;
  },
};
