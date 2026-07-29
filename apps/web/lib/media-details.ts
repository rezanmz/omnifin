import type {
  DiscoveryMediaDetailParams,
  DiscoveryMediaDetailQuery,
  DiscoveryMediaDetailResponse,
  DiscoveryPersonDetailParams,
  DiscoveryPersonDetailQuery,
  DiscoveryPersonDetailResponse,
} from "@omnifin/contracts/discovery";

async function loadContractSchemas() {
  await import("./zod-browser");
  const [discovery, errors] = await Promise.all([
    import("@omnifin/contracts/discovery"),
    import("@omnifin/contracts/errors"),
  ]);
  return { discovery, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type MediaDetailClientErrorKind =
  | "forbidden"
  | "invalid_response"
  | "not_configured"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class MediaDetailClientError extends Error {
  public readonly code: string;
  public readonly kind: MediaDetailClientErrorKind;

  public constructor(kind: MediaDetailClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "MediaDetailClientError";
    this.kind = kind;
    this.code = code;
  }
}

function errorKind(status: number, code: string): MediaDetailClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (code === "discovery_not_configured") return "not_configured";
  if (status === 429 || code === "discovery_rate_limited") return "rate_limited";
  return "unavailable";
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
  const code = parsed.success ? parsed.data.error.code : "request_failed";
  return new MediaDetailClientError(
    errorKind(response.status, code),
    code,
    parsed.success ? parsed.data.error.message : "Media details are temporarily unavailable.",
  );
}

export interface DiscoveryMediaDetailClient {
  load(
    params: DiscoveryMediaDetailParams,
    query: DiscoveryMediaDetailQuery,
    signal?: AbortSignal,
  ): Promise<DiscoveryMediaDetailResponse>;
}

export interface DiscoveryPersonDetailClient {
  load(
    params: DiscoveryPersonDetailParams,
    query: DiscoveryPersonDetailQuery,
    signal?: AbortSignal,
  ): Promise<DiscoveryPersonDetailResponse>;
}

export const discoveryMediaDetailClient: DiscoveryMediaDetailClient = {
  async load(paramsInput, queryInput, signal) {
    const schemas = await contractSchemas();
    const params = schemas.discovery.discoveryMediaDetailParamsSchema.parse(paramsInput);
    const query = schemas.discovery.discoveryMediaDetailQuerySchema.parse(queryInput);
    let response: Response;
    try {
      response = await fetch(
        `/api/discovery/details/${params.kind}/${params.tmdbId}?${new URLSearchParams({
          language: query.language,
        }).toString()}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new MediaDetailClientError(
        "unavailable",
        "service_unavailable",
        "Media details could not reach the gateway.",
      );
    }
    if (!response.ok) throw await responseError(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MediaDetailClientError(
        "invalid_response",
        "invalid_response",
        "Media details returned an unreadable response.",
      );
    }
    const parsed = schemas.discovery.discoveryMediaDetailResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new MediaDetailClientError(
        "invalid_response",
        "invalid_response",
        "Media details did not match the public contract.",
      );
    }
    return parsed.data;
  },
};

export const discoveryPersonDetailClient: DiscoveryPersonDetailClient = {
  async load(paramsInput, queryInput, signal) {
    const schemas = await contractSchemas();
    const params = schemas.discovery.discoveryPersonDetailParamsSchema.parse(paramsInput);
    const query = schemas.discovery.discoveryPersonDetailQuerySchema.parse(queryInput);
    let response: Response;
    try {
      response = await fetch(
        `/api/discovery/people/${params.tmdbId}?${new URLSearchParams({
          language: query.language,
        }).toString()}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new MediaDetailClientError(
        "unavailable",
        "service_unavailable",
        "Person details could not reach the gateway.",
      );
    }
    if (!response.ok) throw await responseError(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MediaDetailClientError(
        "invalid_response",
        "invalid_response",
        "Person details returned an unreadable response.",
      );
    }
    const parsed = schemas.discovery.discoveryPersonDetailResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new MediaDetailClientError(
        "invalid_response",
        "invalid_response",
        "Person details did not match the public contract.",
      );
    }
    return parsed.data;
  },
};
