import type { DiscoveryBrowseQuery, DiscoveryBrowseResponse } from "@omnifin/contracts/discovery";

async function loadContractSchemas() {
  await import("./zod-browser");
  return import("@omnifin/contracts/discovery");
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type DiscoveryBrowseClientErrorKind =
  "forbidden" | "invalid_response" | "not_configured" | "signed_out" | "unavailable";

export class DiscoveryBrowseClientError extends Error {
  public readonly code: string;
  public readonly kind: DiscoveryBrowseClientErrorKind;

  public constructor(kind: DiscoveryBrowseClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "DiscoveryBrowseClientError";
    this.kind = kind;
    this.code = code;
  }
}

function errorKind(status: number, code: string): DiscoveryBrowseClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (code === "discovery_not_configured") return "not_configured";
  return "unavailable";
}

async function responseError(response: Response) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const code =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "code" in body.error &&
    typeof body.error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(body.error.code)
      ? body.error.code
      : "request_failed";
  return new DiscoveryBrowseClientError(
    errorKind(response.status, code),
    code,
    "Browse is temporarily unavailable.",
  );
}

function browserArtworkPath(path: string | null) {
  if (path === null) return null;
  const reference = path.match(
    /^\/v1\/discovery\/artwork\/(discovery_art_[A-Za-z0-9_-]{22})$/u,
  )?.[1];
  if (!reference) {
    throw new DiscoveryBrowseClientError(
      "invalid_response",
      "invalid_response",
      "Browse returned an unsafe artwork reference.",
    );
  }
  return `/api/discovery/artwork/${reference}`;
}

function browserResponse(response: DiscoveryBrowseResponse): DiscoveryBrowseResponse {
  return {
    ...response,
    items: response.items.map((item) => ({
      ...item,
      artwork: {
        backdropPath: browserArtworkPath(item.artwork.backdropPath),
        posterPath: browserArtworkPath(item.artwork.posterPath),
      },
    })),
  };
}

function queryParameters(input: DiscoveryBrowseQuery) {
  const parameters = new URLSearchParams({
    availability: input.availability,
    kind: input.kind,
    locale: input.locale,
    page: String(input.page),
    sort: input.sort,
  });
  for (const [key, value] of Object.entries(input)) {
    if (["availability", "kind", "locale", "page", "sort"].includes(key)) continue;
    if (value !== undefined) parameters.set(key, String(value));
  }
  return parameters;
}

export interface DiscoveryBrowseClient {
  load(input: DiscoveryBrowseQuery, signal?: AbortSignal): Promise<DiscoveryBrowseResponse>;
}

export const discoveryBrowseClient: DiscoveryBrowseClient = {
  async load(input, signal) {
    const schemas = await contractSchemas();
    const criteria = schemas.discoveryBrowseQuerySchema.parse(input);
    let response: Response;
    try {
      response = await fetch(`/api/discovery/browse?${queryParameters(criteria).toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new DiscoveryBrowseClientError(
        "unavailable",
        "service_unavailable",
        "Browse could not reach the gateway.",
      );
    }
    if (!response.ok) throw await responseError(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DiscoveryBrowseClientError(
        "invalid_response",
        "invalid_response",
        "Browse returned an unreadable response.",
      );
    }
    const parsed = schemas.discoveryBrowseResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new DiscoveryBrowseClientError(
        "invalid_response",
        "invalid_response",
        "Browse returned a response that did not match the public contract.",
      );
    }
    return browserResponse(parsed.data);
  },
};
