import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  PlaybackContextResponse,
  PlaybackNegotiationResponse,
} from "@omnifin/contracts/playback";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserPlaybackPath, playbackClient } from "./playback";
import type { PlaybackClientError } from "./playback";

const csrfToken = "playback_csrf_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const mediaReferenceId = `media_${"m".repeat(22)}`;
const sessionId = `playback_${"p".repeat(22)}`;
const sourceReferenceId = `source_${"s".repeat(22)}`;
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-29T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Ari",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-28T14:00:00.000Z",
  issuedAt: "2026-07-28T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Ari Jellyfin",
      externalUserId: "jellyfin-ari",
      health: "linked",
      id: "jellyfin-link-ari",
      lastVerifiedAt: "2026-07-28T12:00:00.000Z",
      linkedAt: "2026-07-27T12:00:00.000Z",
      service: "jellyfin",
      username: "ari",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.viewer],
  role: "viewer",
  sessionId: "session-ari",
  userId: "user-ari",
};
const playback: PlaybackNegotiationResponse = {
  audioTracks: [
    {
      channels: 6,
      codec: "aac",
      default: true,
      index: 1,
      language: "eng",
      selected: true,
      title: "English 5.1",
    },
  ],
  delivery: "hls",
  expiresAt: "2026-07-28T20:00:00.000Z",
  media: {
    audioCodec: "aac",
    bitrate: 8_000_000,
    container: "mp4",
    durationSeconds: 7_200,
    height: 1080,
    videoCodec: "h264",
    width: 1920,
  },
  mediaReferenceId,
  positionSeconds: 1_200,
  sessionId,
  streamPath: `/v1/playback/${sessionId}/master.m3u8`,
  subtitleTracks: [],
};
const playbackContext: PlaybackContextResponse = {
  currentDurationSeconds: 7_200,
  generatedAt: "2026-07-28T12:30:00.000Z",
  mediaReferenceId,
  nextEpisode: null,
  nextState: "end",
  segments: [{ endSeconds: 120, kind: "intro", startSeconds: 4 }],
  segmentsState: "ready",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function authenticatedSession(overrides: Partial<SessionPrincipal> = {}) {
  return { csrfToken, principal: { ...principal, ...overrides } };
}

describe("playback client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prepares playback with session CSRF and a normalized public media reference", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken, principal }))
      .mockResolvedValueOnce(jsonResponse(playback, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(playbackClient.prepare(mediaReferenceId, 1_200)).resolves.toEqual({
      canManageLibrary: false,
      csrfToken,
      session: playback,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const [, request] = fetchMock.mock.calls[1]!;
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/media/${mediaReferenceId}/playback`);
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(JSON.parse(request.body)).toEqual({
      audioStreamIndex: null,
      maxStreamingBitrate: 80_000_000,
      mode: "auto",
      positionSeconds: 1_200,
      subtitleStreamIndex: null,
    });
  });

  it("loads bounded playback context through the same-origin gateway", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(playbackContext));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(playbackClient.loadContext(mediaReferenceId, controller.signal)).resolves.toEqual(
      playbackContext,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/media/${mediaReferenceId}/playback-context`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      }),
    );
  });

  it("carries local library-management permission without exposing the principal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          authenticatedSession({
            permissions: [...ROLE_PERMISSIONS.operator],
            role: "operator",
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(playback, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(playbackClient.prepare(mediaReferenceId, 0)).resolves.toMatchObject({
      canManageLibrary: true,
    });
  });

  it("sends bounded track and quality preferences during re-negotiation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(authenticatedSession()))
      .mockResolvedValueOnce(jsonResponse(playback, 201));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await playbackClient.prepare(mediaReferenceId, 2_400, controller.signal, {
      audioStreamIndex: 3,
      maxStreamingBitrate: 10_000_000,
      mode: "transcode",
      subtitleStreamIndex: 7,
    });

    const [, request] = fetchMock.mock.calls[1]!;
    expect(request.signal).toBe(controller.signal);
    expect(JSON.parse(request.body)).toEqual({
      audioStreamIndex: 3,
      maxStreamingBitrate: 10_000_000,
      mode: "transcode",
      positionSeconds: 2_400,
      subtitleStreamIndex: 7,
    });
  });

  it("rejects a negotiation that does not echo the requested owned source", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(authenticatedSession()))
      .mockResolvedValueOnce(
        jsonResponse({ ...playback, sourceReferenceId: `source_${"x".repeat(22)}` }, 201),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      playbackClient.prepare(mediaReferenceId, 1_200, undefined, { sourceReferenceId }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({
        code: "invalid_playback_source_response",
        kind: "invalid_response",
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ sourceReferenceId });
  });

  it("reports progress through the opaque playback session", async () => {
    const response = {
      acceptedAt: "2026-07-28T12:30:00.000Z",
      positionSeconds: 1_230,
      sessionId,
      state: "playing" as const,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      playbackClient.report(sessionId, { event: "progress", positionSeconds: 1_230 }, csrfToken),
    ).resolves.toEqual(response);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/playback/${sessionId}/progress`);
    expect(new Headers(fetchMock.mock.calls[0]?.[1].headers).get("x-omnifin-csrf")).toBe(csrfToken);
  });

  it("reports a normalized playback issue through the opaque session", async () => {
    const issue = {
      category: "subtitles" as const,
      createdAt: "2026-07-28T12:30:00.000Z",
      id: `issue_${"i".repeat(22)}`,
      positionSeconds: 1_245,
      status: "open" as const,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(issue, 201));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      playbackClient.reportIssue(
        sessionId,
        {
          category: "subtitles",
          description: "Captions lag behind dialogue.",
          positionSeconds: 1_245,
        },
        csrfToken,
        controller.signal,
      ),
    ).resolves.toEqual(issue);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/playback/${sessionId}/issues`);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(request.signal).toBe(controller.signal);
    expect(JSON.parse(request.body)).toEqual({
      category: "subtitles",
      description: "Captions lag behind dialogue.",
      positionSeconds: 1_245,
    });
  });

  it("rejects unsafe stream paths and fails closed for a signed-out browser", async () => {
    expect(() => browserPlaybackPath("https://jellyfin.example.test/private")).toThrowError(
      expect.objectContaining({ code: "invalid_stream_path" }),
    );
    expect(browserPlaybackPath(playback.streamPath)).toBe(`/api/playback/${sessionId}/master.m3u8`);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse({ csrfToken: null, principal: null })),
    );
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({
        code: "authentication_required",
        kind: "session_expired",
      }),
    );
  });

  it.each([
    [401, "session_expired", "authentication_required"],
    [403, "forbidden", "permission_denied"],
  ] as const)(
    "maps an HTTP %s session failure without leaking its body",
    async (status, kind, code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(jsonResponse({ secret: "hidden" }, status)),
      );

      await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
        expect.objectContaining<Partial<PlaybackClientError>>({ code, kind }),
      );
    },
  );

  it("preserves safe public gateway errors and normalizes malformed failures", async () => {
    const safeError = {
      error: {
        code: "jellyfin_unavailable",
        message: "Jellyfin is waking up.",
        requestId: "request-playback-01",
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(safeError, 503)));
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({
        code: "jellyfin_unavailable",
        kind: "unavailable",
        message: "Jellyfin is waking up.",
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("not-json", { status: 400 })),
    );
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({
        code: "playback_failed",
        kind: "invalid_response",
      }),
    );
  });

  it("rejects malformed session, permission, and negotiation responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ hello: "world" })));
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({ code: "invalid_session_response" }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse(authenticatedSession({ permissions: [] }))),
    );
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({ code: "permission_denied" }),
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(authenticatedSession()))
        .mockResolvedValueOnce(jsonResponse({ streamPath: "https://private.invalid" }, 201)),
    );
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({ code: "invalid_playback_response" }),
    );
  });

  it("rejects unreadable success bodies and unreachable gateway requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("not-json", { status: 200 })),
    );
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({ code: "invalid_response" }),
    );

    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("private network detail")));
    await expect(playbackClient.prepare(mediaReferenceId, 0)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({
        code: "service_unavailable",
        kind: "unavailable",
      }),
    );
  });

  it("preserves caller cancellation and sends keepalive progress with an explicit signal", async () => {
    const abortError = new DOMException("cancelled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(abortError));
    await expect(
      playbackClient.prepare(mediaReferenceId, 0, new AbortController().signal),
    ).rejects.toBe(abortError);

    const response = {
      acceptedAt: "2026-07-28T12:30:00.000Z",
      positionSeconds: 1_240,
      sessionId,
      state: "playing" as const,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await playbackClient.report(
      sessionId,
      { event: "progress", positionSeconds: 1_240 },
      csrfToken,
      { keepalive: true, signal: controller.signal },
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ keepalive: true, signal: controller.signal }),
    );
  });

  it("rejects malformed progress responses and progress authorization failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ accepted: true })));
    await expect(
      playbackClient.report(sessionId, { event: "progress", positionSeconds: 1_240 }, csrfToken),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({ code: "invalid_progress_response" }),
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({}, 403)));
    await expect(
      playbackClient.report(sessionId, { event: "paused", positionSeconds: 1_240 }, csrfToken),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({
        code: "permission_denied",
        kind: "forbidden",
      }),
    );
  });

  it("rejects malformed issue responses without trusting gateway payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ accepted: true }, 201)));
    await expect(
      playbackClient.reportIssue(
        sessionId,
        { category: "other", description: null, positionSeconds: 1_240 },
        csrfToken,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackClientError>>({ code: "invalid_issue_response" }),
    );
  });
});
