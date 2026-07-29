import type { PlaybackNegotiationResponse } from "@omnifin/contracts/playback";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybackClient } from "../lib/playback";
import type { SubtitleClient } from "../lib/subtitles";
import { TheaterPlayer, type TheaterMedia } from "./theater-player";

const hlsHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    handlers: Map<string, (event: string, data: { fatal: boolean; type: string }) => void>;
    loadSource: ReturnType<typeof vi.fn>;
    recoverMediaError: ReturnType<typeof vi.fn>;
    startLoad: ReturnType<typeof vi.fn>;
  }>,
  supported: true,
}));

vi.mock("hls.js", () => {
  class MockHls {
    static readonly ErrorTypes = {
      MEDIA_ERROR: "mediaError",
      NETWORK_ERROR: "networkError",
    };
    static readonly Events = { ERROR: "error" };
    static isSupported = () => hlsHarness.supported;

    readonly attachMedia = vi.fn();
    readonly destroy = vi.fn();
    readonly handlers = new Map<
      string,
      (event: string, data: { fatal: boolean; type: string }) => void
    >();
    readonly loadSource = vi.fn();
    readonly recoverMediaError = vi.fn();
    readonly startLoad = vi.fn();

    constructor() {
      hlsHarness.instances.push(this);
    }

    on(event: string, handler: (event: string, data: { fatal: boolean; type: string }) => void) {
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
    videoCodec: "h264",
    width: 1920,
  },
  mediaReferenceId: media.id,
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

describe("TheaterPlayer", () => {
  beforeEach(() => {
    hlsHarness.instances.length = 0;
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
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    expect(screen.getByRole("status")).toHaveTextContent("Preparing your stream");
    expect(screen.getByRole("dialog", { name: media.title })).toHaveAttribute(
      "data-status",
      "preparing",
    );
  });

  it("loads a direct stream, starts reporting on play, and keeps controls accessible", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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

  it("controls a direct stream and reports durable playback transitions", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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

  it("supports player shortcuts without hijacking range inputs", async () => {
    const client = readyClient();
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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

  it("recovers bounded HLS failures before presenting a safe retry", async () => {
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    render(
      <TheaterPlayer client={readyClient(hlsSession)} media={media} onClose={() => undefined} />,
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
    onError?.("error", { fatal: true, type: "networkError" });
    onError?.("error", { fatal: true, type: "networkError" });
    expect(instance?.startLoad).toHaveBeenCalledTimes(2);
    expect(await screen.findByLabelText("Buffering")).toBeVisible();

    onError?.("error", { fatal: true, type: "networkError" });
    expect(await screen.findByRole("alert")).toHaveTextContent("saved progress is safe");
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
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
  });

  it("exposes Bazarr discovery only to local library operators", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <TheaterPlayer
        client={readyClient(session, false)}
        media={media}
        onClose={() => undefined}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.queryByRole("button", { name: /Find subtitles/u })).not.toBeInTheDocument();

    unmount();
    render(
      <TheaterPlayer client={readyClient(session, true)} media={media} onClose={() => undefined} />,
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

  it("submits a private playback issue with category, note, and current timestamp", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    const client = readyClient(hlsSession);
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
  });

  it("recovers one fatal HLS media error and destroys the engine on close", async () => {
    const hlsSession: PlaybackNegotiationResponse = {
      ...session,
      delivery: "hls",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    };
    const onClose = vi.fn();
    const { unmount } = render(
      <TheaterPlayer client={readyClient(hlsSession)} media={media} onClose={onClose} />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const instance = hlsHarness.instances[0];
    instance?.handlers.get("error")?.("error", { fatal: true, type: "mediaError" });
    expect(instance?.recoverMediaError).toHaveBeenCalledOnce();
    unmount();
    expect(instance?.destroy).toHaveBeenCalledOnce();
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
      <TheaterPlayer client={readyClient(hlsSession)} media={media} onClose={() => undefined} />,
    );
    expect(await screen.findByRole("button", { name: `Resume ${media.title}` })).toBeVisible();
    expect(screen.getByLabelText(`${media.title} video`)).toHaveAttribute(
      "src",
      `/api/playback/${sessionId}/master.m3u8`,
    );

    unmount();
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    render(
      <TheaterPlayer client={readyClient(hlsSession)} media={media} onClose={() => undefined} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot play the negotiated HLS");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("surfaces interrupted progress sync without interrupting playback", async () => {
    const client = readyClient();
    client.report.mockRejectedValue(new Error("offline"));
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
    render(<TheaterPlayer client={client} media={media} onClose={onClose} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Jellyfin is waking up");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: `Resume ${media.title}` })).toBeVisible();
    expect(client.prepare).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Close player" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
