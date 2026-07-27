import type { DiscoverySearchQuery, DiscoverySearchResponse } from "@omnifin/contracts/discovery";

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

export type DiscoverySearchClientErrorKind =
  | "forbidden"
  | "invalid_response"
  | "not_configured"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class DiscoverySearchClientError extends Error {
  public readonly code: string;
  public readonly kind: DiscoverySearchClientErrorKind;

  public constructor(kind: DiscoverySearchClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "DiscoverySearchClientError";
    this.kind = kind;
    this.code = code;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DiscoverySearchClientError(
      "invalid_response",
      "invalid_response",
      "Search returned an unreadable response.",
    );
  }
}

function errorKind(status: number, code: string): DiscoverySearchClientErrorKind {
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
  return new DiscoverySearchClientError(
    errorKind(response.status, code),
    code,
    parsed.success ? parsed.data.error.message : "Search is temporarily unavailable.",
  );
}

export interface DiscoverySearchClient {
  search(input: DiscoverySearchQuery, signal?: AbortSignal): Promise<DiscoverySearchResponse>;
}

export const discoverySearchClient: DiscoverySearchClient = {
  async search(input, signal) {
    const schemas = await contractSchemas();
    const query = schemas.discovery.discoverySearchQuerySchema.parse(input);
    const parameters = new URLSearchParams({
      language: query.language,
      page: String(query.page),
      query: query.query,
    });
    let response: Response;
    try {
      response = await fetch(`/api/discovery/search?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new DiscoverySearchClientError(
        "unavailable",
        "service_unavailable",
        "Search could not reach the gateway.",
      );
    }
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.discovery.discoverySearchResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new DiscoverySearchClientError(
        "invalid_response",
        "invalid_response",
        "Search returned a response that did not match the public contract.",
      );
    }
    return parsed.data;
  },
};
