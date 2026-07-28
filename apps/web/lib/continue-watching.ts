import type { ContinueWatchingItem, ContinueWatchingResponse } from "@omnifin/contracts/dashboard";

import type { MediaCardModel } from "./dashboard-data";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [dashboard, errors] = await Promise.all([
    import("@omnifin/contracts/dashboard"),
    import("@omnifin/contracts/errors"),
  ]);
  return { dashboard, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type ContinueWatchingClientErrorKind =
  "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class ContinueWatchingClientError extends Error {
  public readonly code: string;
  public readonly kind: ContinueWatchingClientErrorKind;

  public constructor(kind: ContinueWatchingClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "ContinueWatchingClientError";
    this.kind = kind;
    this.code = code;
  }
}

export type ContinueWatchingLoadOutcome =
  | { feed: ContinueWatchingResponse; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ContinueWatchingClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<ContinueWatchingClientError> {
  if (response.status === 401) {
    return new ContinueWatchingClientError(
      "signed_out",
      "authentication_required",
      "Sign in to continue watching your Jellyfin media.",
    );
  }
  if (response.status === 403) {
    return new ContinueWatchingClientError(
      "forbidden",
      "permission_denied",
      "Your account cannot view Jellyfin media.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new ContinueWatchingClientError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new ContinueWatchingClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    "request_failed",
    "Continue Watching could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new ContinueWatchingClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned media data that did not match the public contract.",
    );
  }
  return parsed.data;
}

export interface ContinueWatchingClient {
  load(signal?: AbortSignal): Promise<ContinueWatchingResponse>;
}

export const continueWatchingClient: ContinueWatchingClient = {
  async load(signal) {
    let response: Response;
    try {
      response = await fetch("/api/media/continue-watching", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ContinueWatchingClientError(
        "unavailable",
        "service_unavailable",
        "The gateway could not be reached.",
      );
    }
    const schemas = (await contractSchemas()).dashboard;
    return parsedResponse(response, schemas.continueWatchingResponseSchema);
  },
};

export function continueWatchingOutcomeFromError(
  error: unknown,
): Exclude<ContinueWatchingLoadOutcome["status"], "ready"> {
  if (error instanceof ContinueWatchingClientError) {
    if (error.kind === "forbidden" || error.kind === "signed_out") return error.kind;
  }
  return "unavailable";
}

const fallbackAccents = ["#5d9690", "#9b735f", "#6f789b", "#7f7361", "#75658d"] as const;

function fallbackAccent(item: ContinueWatchingItem) {
  let hash = 0;
  for (const character of `${item.media.kind}:${item.media.title}`) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return fallbackAccents[hash % fallbackAccents.length]!;
}

function sameOriginArtwork(path: string | null) {
  if (path === null) return undefined;
  return path.replace(/^\/v1\//u, "/api/");
}

function minutesLeft(item: ContinueWatchingItem) {
  return `${Math.max(1, Math.ceil((item.durationSeconds - item.positionSeconds) / 60))} min left`;
}

export function continueWatchingCards(feed: ContinueWatchingResponse): MediaCardModel[] {
  return feed.items.map((item) => {
    const artworkPath = sameOriginArtwork(
      item.media.artwork.posterPath ?? item.media.artwork.backdropPath,
    );
    return {
      accent: item.media.artwork.accentColor ?? fallbackAccent(item),
      ...(artworkPath === undefined ? {} : { artworkPath }),
      eyebrow: item.media.subtitle ?? minutesLeft(item),
      id: item.media.id,
      progress: item.progressPercent / 100,
      title: item.media.title,
    };
  });
}
