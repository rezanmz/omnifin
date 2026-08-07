import {
  DEFAULT_PLAYBACK_PREFERENCES,
  type PlaybackNegotiationResponse,
  type PlaybackPreferences,
  type PlaybackPreferencesResponse,
} from "@omnifin/contracts/playback";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybackClient } from "../lib/playback";
import type { PlaybackPreferenceClient } from "../lib/playback-preferences";
import type { SubtitleClient } from "../lib/subtitles";
import { TheaterPlayer, type TheaterMedia } from "./theater-player";

const hlsHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    attachMedia: ReturnType<typeof vi.fn>;
    currentLevel: number;
    destroy: ReturnType<typeof vi.fn>;
    handlers: Map<string, (event: string, data: unknown) => void>;
    loadSource: ReturnType<typeof vi.fn>;
    recoverMediaError: ReturnType<typeof vi.fn>;
    startLoad: ReturnType<typeof vi.fn>;
  }>,
  levelSelections: [] as number[],
  supported: true,
}));

vi.mock("hls.js", () => {
  class MockHls {
    static readonly ErrorTypes = {
      MEDIA_ERROR: "mediaError",
      NETWORK_ERROR: "networkError",
    };
    static readonly Events = {
      ERROR: "error",
      LEVEL_SWITCHED: "levelSwitched",
      MANIFEST_PARSED: "manifestParsed",
    };
    static isSupported = () => hlsHarness.supported;

    readonly attachMedia = vi.fn();
    readonly destroy = vi.fn();
    readonly handlers = new Map<string, (event: string, data: unknown) => void>();
    readonly loadSource = vi.fn();
    readonly recoverMediaError = vi.fn();
    readonly startLoad = vi.fn();
    #currentLevel = -1;

    constructor() {
      hlsHarness.instances.push(this);
    }

    get currentLevel() {
      return this.#currentLevel;
    }

    set currentLevel(value: number) {
      this.#currentLevel = value;
      hlsHarness.levelSelections.push(value);
    }

    on(event: string, handler: (event: string, data: unknown) => void) {
      this.handlers.set(event, handler);
    }
  }

  return { default: MockHls };
});

const csrfToken = "theater_player_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const sessionId = `playback_${"p".repeat(22)}`;
const media: TheaterMedia = {
  accent: "#79b8aa",
  artworkPath: `/api/media/media_${"m".repeat(22)}/images/poster`,
  eyebrow: "38 min left",
  id: `media_${"m".repeat(22)}`,
  positionSeconds: 1_200,
  title: "Northern Lights",
};
const versionedMedia: TheaterMedia = {
  ...media,
  mediaSources: [
    {
      audio: [],
      audioTruncated: false,
      bitrateKbps: 18_000,
      container: "MKV",
      label: "4K · Director's cut",
      sizeBytes: 16_000_000_000,
      sourceReferenceId: `source_${"a".repeat(22)}`,
      subtitles: [],
      subtitlesTruncated: false,
      video: null,
    },
    {
      audio: [],
      audioTruncated: false,
      bitrateKbps: 8_000,
      container: "MP4",
      label: "1080p · Theatrical cut",
      sizeBytes: 7_000_000_000,
      sourceReferenceId: `source_${"b".repeat(22)}`,
      subtitles: [],
      subtitlesTruncated: false,
      video: null,
    },
  ],
  sourceReferenceId: `source_${"a".repeat(22)}`,
};
const session: PlaybackNegotiationResponse = {
  audioTracks: [],
  delivery: "direct",
  expiresAt: "2026-07-28T20:00:00.000Z",
  media: {
    audioCodec: "aac",
    bitrate: 8_000_000,
    container: "mp4",
    durationSeconds: 7_200,
    height: 1080,
    streamBitrate: null,
    videoCodec: "h264",
    width: 1920,
  },
  mediaReferenceId: media.id,
  playMethod: "direct_stream",
  positionSeconds: media.positionSeconds,
  sessionId,
  streamPath: `/v1/playback/${sessionId}/stream`,
  subtitleTracks: [],
};

function readyClient(
  preparedSession: PlaybackNegotiationResponse = session,
  canManageLibrary = false,
): PlaybackClient & {
  prepare: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  reportIssue: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(async () => ({ canManageLibrary, csrfToken, session: preparedSession }));
  const report = vi.fn<PlaybackClient["report"]>(async (_id, request) => ({
    acceptedAt: "2026-07-28T12:30:00.000Z",
    positionSeconds: request.positionSeconds,
    sessionId,
    state:
      request.event === "paused" ? "paused" : request.event === "stopped" ? "stopped" : "playing",
  }));
  const reportIssue = vi.fn<PlaybackClient["reportIssue"]>(async (_id, request) => ({
    category: request.category,
    createdAt: "2026-07-28T12:30:00.000Z",
    id: `issue_${"i".repeat(22)}`,
    positionSeconds: request.positionSeconds,
    status: "open",
  }));
  return { prepare, report, reportIssue };
}

function readyPreferenceClient(
  response: PlaybackPreferencesResponse = {
    networkClass: "home",
    preferences: DEFAULT_PLAYBACK_PREFERENCES,
    revision: 1,
    updatedAt: null,
  },
): PlaybackPreferenceClient {
  return { load: vi.fn(async () => response), save: vi.fn() };
}

describe("TheaterPlayer", () => {
  beforeEach(() => {
    hlsHarness.instances.length = 0;
    hlsHarness.levelSelections.length = 0;
    hlsHarness.supported = true;
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  it("shows a deliberate preparation state while the private session opens", () => {
    const client: PlaybackClient = {
      prepare: () => new Promise<never>(() => undefined),
      report: vi.fn(),
      reportIssue: vi.fn(),
    };
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preparing your stream");
    expect(screen.getByRole("dialog", { name: media.title })).toHaveAttribute(
      "data-status",
      "preparing",
    );
  });

  it("loads a direct stream, starts reporting on play, and keeps controls accessible", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    const resume = await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText(`${media.title} video`);
    expect(video).toHaveAttribute("src", `/api/playback/${sessionId}/stream`);
    expect(screen.getByRole("slider", { name: "Playback position" })).toHaveValue("1200");

    await user.click(resume);
    fireEvent.play(video);
    await waitFor(() =>
      expect(client.report).toHaveBeenCalledWith(
        sessionId,
        { event: "started", positionSeconds: 1_200 },
        csrfToken,
        { keepalive: false },
      ),
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mute" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Enter full screen" })).toBeVisible();
  });

  it("uses source-quality compatibility negotiation by default", async () => {
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    expect(client.prepare).toHaveBeenCalledWith(media.id, 1_200, expect.any(AbortSignal), {
      audioStreamIndex: null,
      maxStreamingBitrate: 200_000_000,
      mode: "auto",
      subtitleStreamIndex: null,
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toHaveValue("original");
    expect(screen.getByRole("option", { name: "Original quality" })).toBeVisible();
  });

  it("carries a deliberate Play action through preparation with an autoplay fallback", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    const client = readyClient();
    const { unmount } = render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
        startWhenReady
      />,
    );

    const video = await screen.findByLabelText<HTMLVideoElement>(`${media.title} video`);
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.canPlay(video);
    expect(play).toHaveBeenCalledOnce();

    unmount();
    play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    render(
      <TheaterPlayer
        client={readyClient()}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
        startWhenReady
      />,
    );
    const blockedVideo = await screen.findByLabelText<HTMLVideoElement>(`${media.title} video`);
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.canPlay(blockedVideo);
    expect(await screen.findByText(/browser needs one more tap/u)).toBeVisible();
    expect(screen.getByRole("button", { name: `Resume ${media.title}` })).toBeVisible();
    expect(screen.getByRole("dialog", { name: media.title })).toHaveAttribute(
      "data-status",
      "ready",
    );
  });

  it("controls a direct stream and reports durable playback transitions", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(1_200);

    fireEvent.play(video);
    await waitFor(() => expect(client.report).toHaveBeenCalledTimes(1));
    video.currentTime = 1_212;
    fireEvent.timeUpdate(video);
    await waitFor(() =>
      expect(client.report).toHaveBeenCalledWith(
        sessionId,
        { event: "progress", positionSeconds: 1_212 },
        csrfToken,
        { keepalive: false },
      ),
    );

    fireEvent.pause(video);
    await waitFor(() =>
      expect(client.report).toHaveBeenCalledWith(
        sessionId,
        { event: "paused", positionSeconds: 1_212 },
        csrfToken,
        { keepalive: false },
      ),
    );

    fireEvent.change(screen.getByRole("slider", { name: "Playback position" }), {
      target: { value: "1800" },
    });
    fireEvent.pointerUp(screen.getByRole("slider", { name: "Playback position" }), {
      target: { value: "1800" },
    });
    expect(video.currentTime).toBe(1_800);
    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), {
      target: { value: "0.35" },
    });
    expect(video.volume).toBe(0.35);
    expect(video.muted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(video.muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Enter full screen" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("toggles playback on a single click and full screen on a double click", async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");

    fireEvent.click(video);
    fireEvent.canPlay(video);
    await waitFor(() => expect(play).toHaveBeenCalled());

    fireEvent.click(video);
    fireEvent.click(video);
    fireEvent.doubleClick(video);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Enter full screen" })).toBeVisible();
  });

  it("supports player shortcuts without hijacking range inputs", async () => {
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const dialog = screen.getByRole("dialog", { name: media.title });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 1_200;

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(video.currentTime).toBe(1_210);
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(video.currentTime).toBe(1_200);
    fireEvent.keyDown(dialog, { key: "m" });
    expect(video.muted).toBe(true);
    fireEvent.keyDown(dialog, { key: "k" });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    const volume = screen.getByRole("slider", { name: "Volume" });
    fireEvent.keyDown(volume, { key: "m" });
    expect(video.muted).toBe(true);
  });

  it("supports the standard player keys: volume, jump, edges, and percentage seek", async () => {
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const dialog = screen.getByRole("dialog", { name: media.title });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 1_200;
    Object.defineProperty(video, "volume", { configurable: true, value: 0.5, writable: true });

    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(video.volume).toBeCloseTo(0.6);
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(video.volume).toBeCloseTo(0.5);

    fireEvent.keyDown(dialog, { key: "j" });
    expect(video.currentTime).toBe(1_190);
    fireEvent.keyDown(dialog, { key: "l" });
    expect(video.currentTime).toBe(1_200);

    fireEvent.keyDown(dialog, { key: "Home" });
    expect(video.currentTime).toBe(0);
    fireEvent.keyDown(dialog, { key: "End" });
    expect(video.currentTime).toBe(7_200);

    video.currentTime = 1_200;
    fireEvent.keyDown(dialog, { key: "5" });
    expect(video.currentTime).toBe(4_000);
  });

  it("attaches the masked HLS manifest through hls.js and surfaces a safe failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      playMethod: "transcode",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await waitFor(() => expect(hlsHarness.instances).toHaveLength(1));
    const instance = hlsHarness.instances[0];
    expect(instance).toBeDefined();
    expect(instance?.loadSource).toHaveBeenCalledWith(`/api/playback/${sessionId}/master.m3u8`);
    expect(instance?.attachMedia).toHaveBeenCalledWith(
      screen.getByLabelText(`${media.title} video`),
    );
    await screen.findByRole("button", { name: `Resume ${media.title}` });

    const privateFailure = {
      details: "levelLoadError",
      fatal: true,
      reason: "private upstream response",
      response: { code: 2, text: "private response body" },
      type: "networkError",
      url: `/v1/playback/${sessionId}/hls/asset_h1.${"a".repeat(22)}`,
    };
    instance?.handlers.get("error")?.("error", privateFailure);
    instance?.handlers.get("error")?.("error", privateFailure);
    instance?.handlers.get("error")?.("error", privateFailure);
    expect(await screen.findByRole("alert")).toHaveTextContent("saved progress is safe");
    const diagnostics = warning.mock.calls.flat().join("\n");
    expect(diagnostics).not.toMatch(
      new RegExp(`${sessionId}|asset_h1|private upstream|private response|/v1/playback`, "u"),
    );
  });

  it("re-negotiates track and quality changes at the current position", async () => {
    const user = userEvent.setup();
    const selectableSession: PlaybackNegotiationResponse = {
      ...session,
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
        {
          channels: 2,
          codec: "aac",
          default: false,
          index: 3,
          language: "spa",
          selected: false,
          title: "Español",
        },
      ],
      subtitleTracks: [
        {
          codec: "ass",
          default: false,
          delivery: "video",
          forced: false,
          index: 7,
          language: "eng",
          selected: false,
          title: "English SDH",
        },
      ],
    };
    const client = readyClient(selectableSession);
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 1_333;
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("region", { name: "Playback settings" })).toBeVisible();

    await user.selectOptions(screen.getByRole("combobox", { name: "Audio track" }), "3");
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(client.prepare).toHaveBeenLastCalledWith(media.id, 1_333, expect.any(AbortSignal), {
      audioStreamIndex: 3,
      maxStreamingBitrate: 80_000_000,
      mode: "transcode",
      subtitleStreamIndex: null,
    });
    fireEvent.canPlay(video);

    await screen.findByRole("button", { name: "Playback settings" });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Subtitle track" }), "7");
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(3));
    expect(client.prepare).toHaveBeenLastCalledWith(
      media.id,
      1_333,
      expect.any(AbortSignal),
      expect.objectContaining({
        audioStreamIndex: 3,
        mode: "transcode",
        subtitleStreamIndex: 7,
      }),
    );
    fireEvent.canPlay(video);

    await screen.findByRole("button", { name: "Playback settings" });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Playback quality" }),
      "balanced",
    );
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(4));
    expect(client.prepare).toHaveBeenLastCalledWith(
      media.id,
      1_333,
      expect.any(AbortSignal),
      expect.objectContaining({ maxStreamingBitrate: 10_000_000, mode: "transcode" }),
    );
    fireEvent.canPlay(video);
  });

  it("keeps the active stream alive when replacement negotiation fails", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    const resume = await screen.findByRole("button", { name: `Resume ${media.title}` });
    client.prepare.mockRejectedValueOnce(new Error("incompatible replacement"));
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    expect(video).toHaveAttribute("src", `/api/playback/${sessionId}/stream`);
    await user.click(resume);
    fireEvent.play(video);
    video.currentTime = 1_333;

    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Playback quality" }),
      "balanced",
    );

    expect(await screen.findByText(/current stream is unchanged/u)).toBeVisible();
    expect(video).toHaveAttribute("src", `/api/playback/${sessionId}/stream`);
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(client.report).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ event: "stopped" }),
      csrfToken,
      expect.anything(),
    );
  });

  it("switches owned versions transactionally while preserving the playback position", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={versionedMedia}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    expect(client.prepare).toHaveBeenNthCalledWith(
      1,
      media.id,
      media.positionSeconds,
      expect.any(AbortSignal),
      expect.objectContaining({ sourceReferenceId: `source_${"a".repeat(22)}` }),
    );
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 1_333;
    fireEvent.play(video);

    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Movie version" }),
      `source_${"b".repeat(22)}`,
    );

    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(client.prepare).toHaveBeenLastCalledWith(
      media.id,
      1_333,
      expect.any(AbortSignal),
      expect.objectContaining({ sourceReferenceId: `source_${"b".repeat(22)}` }),
    );
    expect(client.report).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ event: "stopped" }),
      csrfToken,
      expect.anything(),
    );
  });

  it("commits a viable replacement before stopping the previous session", async () => {
    const user = userEvent.setup();
    const replacementSessionId = `playback_${"q".repeat(22)}`;
    const replacementSession: PlaybackNegotiationResponse = {
      ...session,
      positionSeconds: 1_333,
      sessionId: replacementSessionId,
      streamPath: `/v1/playback/${replacementSessionId}/stream`,
    };
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    fireEvent.play(video);
    video.currentTime = 1_333;
    client.prepare.mockResolvedValueOnce({
      canManageLibrary: false,
      csrfToken,
      session: replacementSession,
    });

    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Playback quality" }),
      "balanced",
    );
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(video).toHaveAttribute("src", `/api/playback/${replacementSessionId}/stream`);
    expect(client.report).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ event: "stopped" }),
      csrfToken,
      expect.anything(),
    );

    fireEvent.canPlay(video);
    await waitFor(() =>
      expect(client.report).toHaveBeenCalledWith(
        sessionId,
        { event: "stopped", positionSeconds: 1_333 },
        csrfToken,
        { keepalive: false },
      ),
    );
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toHaveValue("balanced");
    client.prepare.mockResolvedValueOnce({
      canManageLibrary: false,
      csrfToken,
      session: {
        ...session,
        positionSeconds: 1_333,
        sessionId: `playback_${"r".repeat(22)}`,
        streamPath: `/v1/playback/playback_${"r".repeat(22)}/stream`,
      },
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Playback quality" }),
      "original",
    );
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(3));
    expect(client.prepare).toHaveBeenLastCalledWith(
      media.id,
      1_333,
      expect.any(AbortSignal),
      expect.objectContaining({ maxStreamingBitrate: 200_000_000, mode: "auto" }),
    );
  });

  it("restores the active stream and position when replacement readiness fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = userEvent.setup();
    const replacementSessionId = `playback_${"s".repeat(22)}`;
    const replacementSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      playMethod: "transcode",
      positionSeconds: 1_333,
      sessionId: replacementSessionId,
      streamPath: `/v1/playback/${replacementSessionId}/master.m3u8`,
    };
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    fireEvent.play(video);
    video.currentTime = 1_333;
    client.prepare.mockResolvedValueOnce({
      canManageLibrary: false,
      csrfToken,
      session: replacementSession,
    });

    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Playback quality" }),
      "balanced",
    );
    await waitFor(() => expect(hlsHarness.instances).toHaveLength(1));
    const onError = hlsHarness.instances[0]?.handlers.get("error");
    const failure = { details: "levelLoadError", fatal: true, type: "networkError" };
    onError?.("error", failure);
    onError?.("error", failure);
    onError?.("error", failure);

    expect(await screen.findByText(/previous stream was restored/u)).toBeVisible();
    await waitFor(() => expect(video).toHaveAttribute("src", `/api/playback/${sessionId}/stream`));
    fireEvent.loadedMetadata(video);
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(1_333);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(client.report).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ event: "stopped" }),
      csrfToken,
      expect.anything(),
    );
  });

  it("exposes Bazarr discovery only to local library operators", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <TheaterPlayer
        client={readyClient(session, false)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.queryByRole("button", { name: /Find subtitles/u })).not.toBeInTheDocument();

    unmount();
    render(
      <TheaterPlayer
        client={readyClient(session, true)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("button", { name: /Find subtitles/u })).toBeVisible();
  });

  it("opens the lazy subtitle workbench and returns focus to its settings trigger", async () => {
    const user = userEvent.setup();
    const subtitles: SubtitleClient = {
      download: vi.fn(),
      search: () => new Promise(() => undefined),
    };
    render(
      <TheaterPlayer
        client={readyClient(session, true)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
        subtitleClient={subtitles}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    const trigger = screen.getByRole("button", { name: /Find subtitles/u });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Close subtitle workbench" }));

    const restoredTrigger = await screen.findByRole("button", { name: /Find subtitles/u });
    expect(restoredTrigger).toHaveFocus();
  });

  it("renders client-side captions and switches text tracks without renegotiating", async () => {
    const user = userEvent.setup();
    const selectableSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "direct",
      subtitleTracks: [
        {
          codec: "webvtt",
          default: false,
          delivery: "external",
          forced: false,
          index: 5,
          language: "eng",
          selected: true,
          title: "English",
          subtitlePath: `/v1/playback/${sessionId}/subtitle/5`,
        },
      ],
    };
    const client = readyClient(selectableSession);
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    const track = video.querySelector("track");
    expect(track).not.toBeNull();
    expect(track?.getAttribute("src")).toBe(`/api/playback/${sessionId}/subtitle/5`);
    expect(track?.getAttribute("kind")).toBe("subtitles");
    expect(track?.getAttribute("default")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Subtitle track" }), "off");
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("labels burn-in subtitle tracks and restarts the stream to select them", async () => {
    const user = userEvent.setup();
    const tieredSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "direct",
      subtitleTracks: [
        {
          codec: "webvtt",
          default: false,
          delivery: "external",
          forced: false,
          index: 5,
          language: "eng",
          selected: true,
          title: "English",
          subtitlePath: `/v1/playback/${sessionId}/subtitle/5`,
        },
        {
          codec: "ass",
          default: false,
          delivery: "external",
          forced: false,
          index: 7,
          language: "eng",
          selected: false,
          title: "English SDH",
          subtitlePath: `/v1/playback/${sessionId}/subtitle/7`,
        },
      ],
    };
    const client = readyClient(tieredSession);
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 1_333;
    await user.click(screen.getByRole("button", { name: "Playback settings" }));

    const subtitles = screen.getByRole("combobox", { name: "Subtitle track" });
    const nativeOption = screen.getByRole("option", { name: /^English · ENG/u });
    expect(nativeOption).toBeVisible();
    expect(nativeOption.textContent).not.toContain("restarts stream");
    expect(screen.getByRole("option", { name: /restarts stream$/u })).toBeVisible();

    await user.selectOptions(subtitles, "7");
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(client.prepare).toHaveBeenLastCalledWith(
      media.id,
      1_333,
      expect.any(AbortSignal),
      expect.objectContaining({ subtitleStreamIndex: 7 }),
    );
  });

  it("toggles captions with C and remembers the chosen track", async () => {
    const user = userEvent.setup();
    const captionedSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "direct",
      subtitleTracks: [
        {
          codec: "webvtt",
          default: false,
          delivery: "external",
          forced: false,
          index: 5,
          language: "eng",
          selected: true,
          title: "English",
          subtitlePath: `/v1/playback/${sessionId}/subtitle/5`,
        },
      ],
    };
    const client = readyClient(captionedSession);
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const dialog = screen.getByRole("dialog", { name: media.title });
    const settingsButton = () => screen.getByRole("button", { name: "Playback settings" });

    // Opening settings mid-renegotiation is a no-op (the button is disabled
    // until the replacement stream is ready), so retry until the panel opens
    // and reflects the expected track after the caption toggle settles.
    const openSettingsAndExpect = async (value: string) => {
      await waitFor(async () => {
        await user.click(settingsButton());
        expect(screen.queryByRole("combobox", { name: "Subtitle track" })).toHaveValue(value);
      });
    };

    fireEvent.keyDown(dialog, { key: "c" });
    await openSettingsAndExpect("5");

    await user.click(settingsButton());
    fireEvent.keyDown(dialog, { key: "c" });
    await openSettingsAndExpect("off");

    await user.click(settingsButton());
    fireEvent.keyDown(dialog, { key: "c" });
    await openSettingsAndExpect("5");
  });

  it("submits a private playback issue with category, note, and current timestamp", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 1_337.8;
    await user.click(screen.getByRole("button", { name: "Report playback issue" }));
    expect(screen.getByRole("region", { name: "Report playback issue" })).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "A/V sync" }));
    await user.type(
      screen.getByRole("textbox", { name: /What happened/u }),
      "Dialogue is late after seeking.",
    );
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(client.reportIssue).toHaveBeenCalledWith(
        sessionId,
        {
          category: "sync",
          description: "Dialogue is late after seeking.",
          positionSeconds: 1_337,
        },
        csrfToken,
      ),
    );
    expect(await screen.findByText("Issue captured")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("captured privately");
  });

  it("keeps an unsuccessful issue report editable for retry", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    client.reportIssue.mockRejectedValueOnce(
      new Error("Issue reporting is temporarily unavailable."),
    );
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Report playback issue" }));
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
  });

  it("rebuilds HLS from an earlier point without exposing an upstream seek URL", async () => {
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      playMethod: "transcode",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    const client = readyClient(hlsSession);
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await waitFor(() => expect(hlsHarness.instances).toHaveLength(1));
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const progress = screen.getByRole("slider", { name: "Playback position" });
    expect(progress).toHaveAttribute("min", "0");
    fireEvent.change(progress, { target: { value: "300" } });
    fireEvent.pointerUp(progress, { target: { value: "300" } });

    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(client.prepare).toHaveBeenLastCalledWith(
      media.id,
      300,
      expect.any(AbortSignal),
      expect.objectContaining({ mode: "auto" }),
    );
    const instance = hlsHarness.instances[0];
    await waitFor(() => expect(instance?.loadSource).toHaveBeenCalledTimes(2));
  });

  it("destroys the hls.js engine on close", async () => {
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      playMethod: "transcode",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    const onClose = vi.fn();
    const { unmount } = render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={onClose}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await waitFor(() => expect(hlsHarness.instances).toHaveLength(1));
    const instance = hlsHarness.instances[0];
    expect(instance).toBeDefined();
    unmount();
    expect(instance?.destroy).toHaveBeenCalledOnce();
  });

  it("recovers bounded HLS failures before presenting a safe retry", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const instance = hlsHarness.instances[0];
    expect(instance).toBeDefined();
    expect(instance?.loadSource).toHaveBeenCalledWith(`/api/playback/${sessionId}/master.m3u8`);
    expect(instance?.attachMedia).toHaveBeenCalledWith(
      screen.getByLabelText(`${media.title} video`),
    );
    const onError = instance?.handlers.get("error");
    expect(onError).toBeDefined();

    onError?.("error", { fatal: false, type: "networkError" });
    expect(instance?.startLoad).not.toHaveBeenCalled();
    const privateFailure = {
      details: "levelLoadError",
      fatal: true,
      reason: "private upstream response",
      response: { code: 404, text: "private response body" },
      type: "networkError",
      url: `/v1/playback/${sessionId}/hls/asset_h1.${"a".repeat(22)}`,
    };
    onError?.("error", privateFailure);
    onError?.("error", privateFailure);
    expect(instance?.startLoad).toHaveBeenCalledTimes(2);
    fireEvent.waiting(screen.getByLabelText(`${media.title} video`));
    expect(await screen.findByLabelText("Buffering")).toBeVisible();

    onError?.("error", privateFailure);
    expect(await screen.findByRole("alert")).toHaveTextContent("saved progress is safe");
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        details: "levelLoadError",
        event: "hls_playback_failure",
        fatal: true,
        httpStatus: 404,
        recovery: "stopped",
        stage: "playlist",
        type: "networkError",
      }),
    );
    const diagnostics = warning.mock.calls.flat().join("\n");
    expect(diagnostics).not.toMatch(
      new RegExp(`${sessionId}|asset_h1|private response|private upstream|/v1/playback`, "u"),
    );
  });

  it("recovers one fatal HLS media error before giving up", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const instance = hlsHarness.instances[0];
    instance?.handlers.get("error")?.("error", { fatal: true, type: "mediaError" });
    expect(instance?.recoverMediaError).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenLastCalledWith(
      JSON.stringify({
        details: "unknown",
        event: "hls_playback_failure",
        fatal: true,
        httpStatus: null,
        recovery: "media_recovery",
        stage: "engine",
        type: "mediaError",
      }),
    );

    instance?.handlers.get("error")?.("error", { fatal: true, type: "mediaError" });
    expect(await screen.findByRole("alert")).toHaveTextContent("saved progress is safe");
  });

  it("uses native HLS when available and explains unsupported browsers", async () => {
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    hlsHarness.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    const { unmount } = render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );
    expect(await screen.findByRole("button", { name: `Resume ${media.title}` })).toBeVisible();
    expect(screen.getByLabelText(`${media.title} video`)).toHaveAttribute(
      "src",
      `/api/playback/${sessionId}/master.m3u8`,
    );

    unmount();
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot play the negotiated HLS");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("switches renditions client-side when the manifest has multiple levels", async () => {
    const user = userEvent.setup();
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      playMethod: "transcode",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    const client = readyClient(hlsSession);
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await waitFor(() => expect(hlsHarness.instances).toHaveLength(1));
    const instance = hlsHarness.instances[0];
    instance?.handlers.get("manifestParsed")?.("manifestParsed", {
      levels: [
        { bitrate: 8_000_000, height: 1080 },
        { bitrate: 4_000_000, height: 720 },
      ],
    });
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));

    const quality = screen.getByRole("combobox", { name: "Stream quality" });
    expect(quality).toHaveValue("auto");
    expect(within(quality).getByRole("option", { name: "Auto" })).toBeVisible();
    expect(within(quality).getByRole("option", { name: "1080p · 8 Mbps" })).toBeVisible();
    expect(within(quality).getByRole("option", { name: "720p · 4 Mbps" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toBeVisible();

    await user.selectOptions(quality, "1");
    expect(hlsHarness.levelSelections).toEqual([1]);
    expect(screen.getByText("Applying playback quality…")).toBeVisible();
    instance?.handlers.get("levelSwitched")?.("levelSwitched", { level: 1 });
    await waitFor(() => expect(quality).toHaveValue("1"));

    await user.selectOptions(quality, "auto");
    expect(hlsHarness.levelSelections).toEqual([1, -1]);
    instance?.handlers.get("levelSwitched")?.("levelSwitched", { level: -1 });
    await waitFor(() => expect(quality).toHaveValue("auto"));
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("hides stream quality for a single-rendition manifest", async () => {
    const user = userEvent.setup();
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      playMethod: "transcode",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await waitFor(() => expect(hlsHarness.instances).toHaveLength(1));
    hlsHarness.instances[0]?.handlers.get("manifestParsed")?.("manifestParsed", {
      levels: [{ bitrate: 8_000_000, height: 1080 }],
    });
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));

    expect(screen.queryByRole("combobox", { name: "Stream quality" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toBeVisible();
  });

  it("hides stream quality on the native HLS path", async () => {
    const user = userEvent.setup();
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      playMethod: "transcode",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    hlsHarness.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    render(
      <TheaterPlayer
        client={readyClient(hlsSession)}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));

    expect(screen.queryByRole("combobox", { name: "Stream quality" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toBeVisible();
  });

  it("applies account defaults to the initial negotiation before playback starts", async () => {
    const user = userEvent.setup();
    const selectableSession: PlaybackNegotiationResponse = {
      ...session,
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
        {
          channels: 2,
          codec: "aac",
          default: false,
          index: 3,
          language: "spa",
          selected: false,
          title: "Español",
        },
      ],
      subtitleTracks: [
        {
          codec: "webvtt",
          default: false,
          delivery: "external",
          forced: false,
          index: 7,
          language: "spa",
          selected: false,
          title: "Español",
          subtitlePath: `/v1/playback/${sessionId}/subtitle/7`,
        },
      ],
    };
    const preferences: PlaybackPreferences = {
      ...DEFAULT_PLAYBACK_PREFERENCES,
      audio: { languages: ["es"], preferOriginalLanguage: true },
      quality: {
        defaultNetworkPolicy: "auto",
        homeMaxBitrate: null,
        remoteMaxBitrate: 10_000_000,
      },
      subtitles: {
        allowCommentary: false,
        languages: ["es"],
        mode: "always",
        preferForced: false,
        preferHearingImpaired: false,
      },
    };
    const client = readyClient(selectableSession);
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient({
          networkClass: "remote",
          preferences,
          revision: 1,
          updatedAt: null,
        })}
      />,
    );

    // The first negotiation used conservative defaults; the account defaults
    // are applied by re-negotiating once before playback has started.
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(client.prepare).toHaveBeenLastCalledWith(media.id, 1_200, expect.any(AbortSignal), {
      audioStreamIndex: 3,
      maxStreamingBitrate: 10_000_000,
      mode: "transcode",
      subtitleStreamIndex: null,
    });
    fireEvent.canPlay(screen.getByLabelText<HTMLVideoElement>(`${media.title} video`));
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("combobox", { name: "Audio track" })).toHaveValue("3");
  });

  it("falls back to conservative defaults when account preferences are unavailable", async () => {
    const user = userEvent.setup();
    const failingPreferenceClient: PlaybackPreferenceClient = {
      load: vi.fn(async () => {
        throw new Error("offline");
      }),
      save: vi.fn(),
    };
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={failingPreferenceClient}
      />,
    );

    expect(
      await screen.findByText(
        "Account defaults were unavailable; conservative playback defaults are in use.",
      ),
    ).toBeVisible();
    fireEvent.canPlay(screen.getByLabelText<HTMLVideoElement>(`${media.title} video`));
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    // Soft-fail defaults (remote, 10 Mbps ceiling) map to the balanced preset.
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toHaveValue("balanced");
  });

  it("maps a home network bitrate cap to the closest quality preset", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient({
          networkClass: "home",
          preferences: {
            ...DEFAULT_PLAYBACK_PREFERENCES,
            quality: {
              ...DEFAULT_PLAYBACK_PREFERENCES.quality,
              homeMaxBitrate: 10_000_000,
            },
          },
          revision: 1,
          updatedAt: null,
        })}
      />,
    );

    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(client.prepare).toHaveBeenLastCalledWith(media.id, 1_200, expect.any(AbortSignal), {
      audioStreamIndex: null,
      maxStreamingBitrate: 10_000_000,
      mode: "transcode",
      subtitleStreamIndex: null,
    });
    fireEvent.canPlay(screen.getByLabelText<HTMLVideoElement>(`${media.title} video`));
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toHaveValue("balanced");
  });

  it("does not disrupt playback when preferences arrive after playback started", async () => {
    const user = userEvent.setup();
    let resolveLoad: (response: PlaybackPreferencesResponse) => void;
    const deferredPreferenceClient: PlaybackPreferenceClient = {
      load: vi.fn(
        () =>
          new Promise<PlaybackPreferencesResponse>((resolve) => {
            resolveLoad = resolve;
          }),
      ),
      save: vi.fn(),
    };
    const client = readyClient();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={deferredPreferenceClient}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    fireEvent.play(video);

    resolveLoad!({
      networkClass: "remote",
      preferences: DEFAULT_PLAYBACK_PREFERENCES,
      revision: 1,
      updatedAt: null,
    });
    await screen.findByRole("button", { name: "Playback settings" });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    // The account defaults updated the per-item state (balanced from the
    // remote 10 Mbps ceiling) without re-negotiating the active session.
    expect(screen.getByRole("combobox", { name: "Playback quality" })).toHaveValue("balanced");
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("surfaces interrupted progress sync without interrupting playback", async () => {
    const client = readyClient();
    client.report.mockRejectedValue(new Error("offline"));
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.play(screen.getByLabelText(`${media.title} video`));
    expect(await screen.findByText("Progress sync interrupted")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  it("offers a retry after negotiation fails and closes through the visible control", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    client.prepare.mockRejectedValueOnce(new Error("Jellyfin is waking up."));
    const onClose = vi.fn();
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={onClose}
        preferenceClient={readyPreferenceClient()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Jellyfin is waking up");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: `Resume ${media.title}` })).toBeVisible();
    expect(client.prepare).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Close player" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
