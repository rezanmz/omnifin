import type {
  PlaybackContextResponse,
  PlaybackNegotiationResponse,
  PlaybackProgressRequest,
  PlaybackProgressResponse,
} from "@omnifin/contracts/playback";
import type { PlaybackIssue, PlaybackIssueCreateRequest } from "@omnifin/contracts/issues";

const CSRF_HEADER = "x-omnifin-csrf";
const DEFAULT_MAX_STREAMING_BITRATE = 80_000_000;

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors, issues, playback] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/issues"),
    import("@omnifin/contracts/playback"),
  ]);
  return { auth, errors, issues, playback };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type PlaybackClientErrorKind =
  "forbidden" | "invalid_response" | "session_expired" | "unavailable";

export class PlaybackClientError extends Error {
  public readonly code: string;
  public readonly kind: PlaybackClientErrorKind;

  public constructor(kind: PlaybackClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "PlaybackClientError";
    this.kind = kind;
    this.code = code;
  }
}

export interface PreparedPlayback {
  canManageLibrary: boolean;
  csrfToken: string;
  session: PlaybackNegotiationResponse;
}

export interface PlaybackPreparationOptions {
  audioStreamIndex?: number | null;
  maxStreamingBitrate?: number;
  mode?: "auto" | "direct" | "transcode";
  subtitleStreamIndex?: number | null;
}

export interface PlaybackClient {
  loadContext?(mediaReferenceId: string, signal?: AbortSignal): Promise<PlaybackContextResponse>;
  prepare(
    mediaReferenceId: string,
    positionSeconds: number,
    signal?: AbortSignal,
    options?: PlaybackPreparationOptions,
  ): Promise<PreparedPlayback>;
  report(
    sessionId: string,
    request: PlaybackProgressRequest,
    csrfToken: string,
    options?: { keepalive?: boolean; signal?: AbortSignal },
  ): Promise<PlaybackProgressResponse>;
  reportIssue(
    sessionId: string,
    request: PlaybackIssueCreateRequest,
    csrfToken: string,
    signal?: AbortSignal,
  ): Promise<PlaybackIssue>;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PlaybackClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable playback response.",
    );
  }
}

async function fetchSameOrigin(path: string, init?: RequestInit) {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PlaybackClientError(
      "unavailable",
      "service_unavailable",
      "The player could not reach the gateway.",
    );
  }
}

async function responseError(response: Response) {
  if (response.status === 401) {
    return new PlaybackClientError(
      "session_expired",
      "authentication_required",
      "Your session ended. Sign in again to resume playback.",
    );
  }
  if (response.status === 403) {
    return new PlaybackClientError(
      "forbidden",
      "permission_denied",
      "Your account cannot play this Jellyfin item.",
    );
  }
  const schemas = await contractSchemas();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = schemas.errors.apiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : "playback_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "Playback is temporarily unavailable.";
  return new PlaybackClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    code,
    message,
  );
}

export function browserPlaybackPath(path: string) {
  if (!/^\/v1\/playback\/playback_[A-Za-z0-9_-]{22}\/(?:master\.m3u8|stream)$/u.test(path)) {
    throw new PlaybackClientError(
      "invalid_response",
      "invalid_stream_path",
      "The gateway returned an unsafe playback path.",
    );
  }
  return path.replace(/^\/v1\//u, "/api/");
}

export const playbackClient: PlaybackClient & {
  loadContext(mediaReferenceId: string, signal?: AbortSignal): Promise<PlaybackContextResponse>;
} = {
  async loadContext(mediaReferenceId, signal) {
    if (!/^media_[A-Za-z0-9_-]{22}$/u.test(mediaReferenceId)) {
      throw new PlaybackClientError(
        "invalid_response",
        "invalid_media_reference",
        "The player received an invalid media reference.",
      );
    }
    const schemas = await contractSchemas();
    const response = await fetchSameOrigin(`/api/media/${mediaReferenceId}/playback-context`, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.playback.playbackContextResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success || parsed.data.mediaReferenceId !== mediaReferenceId) {
      throw new PlaybackClientError(
        "invalid_response",
        "invalid_playback_context_response",
        "The gateway returned playback context outside the public contract.",
      );
    }
    return parsed.data;
  },

  async prepare(mediaReferenceId, positionSeconds, signal, options = {}) {
    const schemas = await contractSchemas();
    const sessionResponse = await fetchSameOrigin("/api/auth/session", {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!sessionResponse.ok) throw await responseError(sessionResponse);
    const session = schemas.auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success) {
      throw new PlaybackClientError(
        "invalid_response",
        "invalid_session_response",
        "The gateway returned an invalid session response.",
      );
    }
    if (session.data.principal === null || session.data.csrfToken === null) {
      throw new PlaybackClientError(
        "session_expired",
        "authentication_required",
        "Your session ended. Sign in again to resume playback.",
      );
    }
    if (!session.data.principal.permissions.includes("media.view")) {
      throw new PlaybackClientError(
        "forbidden",
        "permission_denied",
        "Your account cannot play Jellyfin media.",
      );
    }

    const body = schemas.playback.playbackNegotiationRequestSchema.parse({
      audioStreamIndex: options.audioStreamIndex ?? null,
      maxStreamingBitrate: options.maxStreamingBitrate ?? DEFAULT_MAX_STREAMING_BITRATE,
      mode: options.mode ?? "auto",
      positionSeconds,
      subtitleStreamIndex: options.subtitleStreamIndex ?? null,
    });
    const response = await fetchSameOrigin(`/api/media/${mediaReferenceId}/playback`, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [CSRF_HEADER]: session.data.csrfToken,
      },
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.playback.playbackNegotiationResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new PlaybackClientError(
        "invalid_response",
        "invalid_playback_response",
        "The gateway returned playback data outside the public contract.",
      );
    }
    browserPlaybackPath(parsed.data.streamPath);
    return {
      canManageLibrary: session.data.principal.permissions.includes("library.manage"),
      csrfToken: session.data.csrfToken,
      session: parsed.data,
    };
  },

  async report(sessionId, request, csrfToken, options = {}) {
    const schemas = await contractSchemas();
    const safeSessionId = schemas.playback.playbackSessionIdSchema.parse(sessionId);
    const body = schemas.playback.playbackProgressRequestSchema.parse(request);
    const response = await fetchSameOrigin(`/api/playback/${safeSessionId}/progress`, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [CSRF_HEADER]: schemas.auth.csrfTokenSchema.parse(csrfToken),
      },
      keepalive: options.keepalive ?? false,
      method: "POST",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.playback.playbackProgressResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new PlaybackClientError(
        "invalid_response",
        "invalid_progress_response",
        "The gateway returned an invalid progress response.",
      );
    }
    return parsed.data;
  },

  async reportIssue(sessionId, request, csrfToken, signal) {
    const schemas = await contractSchemas();
    const safeSessionId = schemas.playback.playbackSessionIdSchema.parse(sessionId);
    const body = schemas.issues.playbackIssueCreateRequestSchema.parse(request);
    const response = await fetchSameOrigin(`/api/playback/${safeSessionId}/issues`, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [CSRF_HEADER]: schemas.auth.csrfTokenSchema.parse(csrfToken),
      },
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.issues.playbackIssueSchema.safeParse(await safeJson(response));
    if (!parsed.success) {
      throw new PlaybackClientError(
        "invalid_response",
        "invalid_issue_response",
        "The gateway returned an invalid issue report response.",
      );
    }
    return parsed.data;
  },
};
