import type { DiscoveryFeedQuery, DiscoveryFeedResponse } from "@omnifin/contracts/discovery";

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

export type DiscoveryFeedClientErrorKind =
  "forbidden" | "invalid_response" | "not_configured" | "signed_out" | "unavailable";

export class DiscoveryFeedClientError extends Error {
  public readonly code: string;
  public readonly kind: DiscoveryFeedClientErrorKind;

  public constructor(kind: DiscoveryFeedClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "DiscoveryFeedClientError";
    this.kind = kind;
    this.code = code;
  }
}

function errorKind(status: number, code: string): DiscoveryFeedClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (code === "discovery_not_configured") return "not_configured";
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
  return new DiscoveryFeedClientError(
    errorKind(response.status, code),
    code,
    parsed.success ? parsed.data.error.message : "Discovery is temporarily unavailable.",
  );
}

function browserArtworkPath(path: string | null) {
  if (path === null) return null;
  const reference = path.match(
    /^\/v1\/discovery\/artwork\/(discovery_art_[A-Za-z0-9_-]{22})$/u,
  )?.[1];
  if (!reference) {
    throw new DiscoveryFeedClientError(
      "invalid_response",
      "invalid_response",
      "Discovery returned an unsafe artwork reference.",
    );
  }
  return `/api/discovery/artwork/${reference}`;
}

function browserFeed(feed: DiscoveryFeedResponse): DiscoveryFeedResponse {
  return {
    ...feed,
    rails: feed.rails.map((rail) => ({
      ...rail,
      items: rail.items.map((item) => ({
        ...item,
        artwork: {
          backdropPath: browserArtworkPath(item.artwork.backdropPath),
          posterPath: browserArtworkPath(item.artwork.posterPath),
        },
      })),
    })),
  };
}

export interface DiscoveryFeedClient {
  load(input: DiscoveryFeedQuery, signal?: AbortSignal): Promise<DiscoveryFeedResponse>;
}

export const discoveryFeedClient: DiscoveryFeedClient = {
  async load(input, signal) {
    const schemas = await contractSchemas();
    const query = schemas.discovery.discoveryFeedQuerySchema.parse(input);
    let response: Response;
    try {
      response = await fetch(
        `/api/discovery/feed?${new URLSearchParams({ language: query.language }).toString()}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new DiscoveryFeedClientError(
        "unavailable",
        "service_unavailable",
        "Discovery could not reach the gateway.",
      );
    }
    if (!response.ok) throw await responseError(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DiscoveryFeedClientError(
        "invalid_response",
        "invalid_response",
        "Discovery returned an unreadable response.",
      );
    }
    const parsed = schemas.discovery.discoveryFeedResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new DiscoveryFeedClientError(
        "invalid_response",
        "invalid_response",
        "Discovery returned a response that did not match the public contract.",
      );
    }
    return browserFeed(parsed.data);
  },
};
