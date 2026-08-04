import type {
  PlaybackPreferencesResponse,
  PlaybackPreferencesUpdateRequest,
} from "@omnifin/contracts/playback";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function contractSchemas() {
  await import("./zod-browser");
  const [auth, errors, playback] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/playback"),
  ]);
  return { auth, errors, playback };
}

export type PlaybackPreferenceClientErrorKind =
  "conflict" | "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class PlaybackPreferenceClientError extends Error {
  public constructor(
    public readonly kind: PlaybackPreferenceClientErrorKind,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlaybackPreferenceClientError";
  }
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new PlaybackPreferenceClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable preference response.",
    );
  }
}

async function responseError(response: Response) {
  if (response.status === 401) {
    return new PlaybackPreferenceClientError(
      "signed_out",
      "authentication_required",
      "Your session ended. Sign in again to manage playback preferences.",
    );
  }
  if (response.status === 403) {
    return new PlaybackPreferenceClientError(
      "forbidden",
      "permission_denied",
      "Your account cannot manage playback preferences.",
    );
  }
  const schemas = await contractSchemas();
  const parsed = schemas.errors.apiErrorSchema.safeParse(await safeJson(response));
  const code = parsed.success ? parsed.data.error.code : "request_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "Playback preferences are unavailable.";
  return new PlaybackPreferenceClientError(
    response.status === 409
      ? "conflict"
      : response.status >= 500
        ? "unavailable"
        : "invalid_response",
    code,
    message,
  );
}

async function parsed<T>(response: Response, schema: ResponseSchema<T>) {
  if (!response.ok) throw await responseError(response);
  const result = schema.safeParse(await safeJson(response));
  if (!result.success) {
    throw new PlaybackPreferenceClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned playback preferences that did not match the public contract.",
    );
  }
  return result.data;
}

async function sameOrigin(path: string, init: RequestInit = {}, signal?: AbortSignal) {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PlaybackPreferenceClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached.",
    );
  }
}

export interface PlaybackPreferenceClient {
  load(signal?: AbortSignal): Promise<PlaybackPreferencesResponse>;
  save(
    request: PlaybackPreferencesUpdateRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackPreferencesResponse>;
}

export const playbackPreferenceClient: PlaybackPreferenceClient = {
  async load(signal) {
    const schemas = await contractSchemas();
    return parsed(
      await sameOrigin(
        "/api/playback/preferences",
        { headers: { accept: "application/json" } },
        signal,
      ),
      schemas.playback.playbackPreferencesResponseSchema,
    );
  },
  async save(request, signal) {
    const schemas = await contractSchemas();
    const body = schemas.playback.playbackPreferencesUpdateRequestSchema.parse(request);
    const sessionResponse = await sameOrigin(
      "/api/auth/session",
      { headers: { accept: "application/json" } },
      signal,
    );
    if (!sessionResponse.ok) throw await responseError(sessionResponse);
    const session = schemas.auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success || !session.data.principal || !session.data.csrfToken) {
      throw new PlaybackPreferenceClientError(
        "signed_out",
        "authentication_required",
        "Your session ended. Sign in again to save playback preferences.",
      );
    }
    if (!session.data.principal.permissions.includes("playback.use")) {
      throw new PlaybackPreferenceClientError(
        "forbidden",
        "permission_denied",
        "Your account cannot manage playback preferences.",
      );
    }
    return parsed(
      await sameOrigin(
        "/api/playback/preferences",
        {
          body: JSON.stringify(body),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-omnifin-csrf": session.data.csrfToken,
          },
          method: "PUT",
        },
        signal,
      ),
      schemas.playback.playbackPreferencesResponseSchema,
    );
  },
};
