import {
  DEFAULT_PLAYBACK_PREFERENCES,
  type PlaybackContextResponse,
  type PlaybackNegotiationResponse,
} from "@omnifin/contracts/playback";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybackClient } from "../lib/playback";
import type { PlaybackPreferenceClient } from "../lib/playback-preferences";
import type { SubtitleClient } from "../lib/subtitles";
import { TheaterPlayer, type TheaterMedia } from "./theater-player";

const playbackPreferenceHarness = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../lib/playback-preferences", () => ({
  playbackPreferenceClient: { load: playbackPreferenceHarness.load },
}));

interface HlsErrorFixture {
  details?: string;
  fatal: boolean;
  reason?: string;
  response?: { code?: number; text?: string };
  type: string;
  url?: string;
}

const hlsHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    handlers: Map<string, (event: string, data: HlsErrorFixture) => void>;
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
    readonly handlers = new Map<string, (event: string, data: HlsErrorFixture) => void>();
    readonly loadSource = vi.fn();
    readonly recoverMediaError = vi.fn();
    readonly startLoad = vi.fn();

    constructor() {
      hlsHarness.instances.push(this);
    }

    on(event: string, handler: (event: string, data: HlsErrorFixture) => void) {
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
  loadContext: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  reportIssue: ReturnType<typeof vi.fn>;
} {
  const loadContext = vi.fn<NonNullable<PlaybackClient["loadContext"]>>(async () => ({
    currentDurationSeconds: preparedSession.media.durationSeconds,
    generatedAt: "2026-07-28T12:30:00.000Z",
    mediaReferenceId: preparedSession.mediaReferenceId,
    nextEpisode: null,
    nextState: "end",
    segments: [],
    segmentsState: "empty",
  }));
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
  return { loadContext, prepare, report, reportIssue };
}

describe("TheaterPlayer", () => {
  beforeEach(() => {
    hlsHarness.instances.length = 0;
    hlsHarness.supported = true;
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    playbackPreferenceHarness.load.mockResolvedValue({
      networkClass: "home",
      preferences: DEFAULT_PLAYBACK_PREFERENCES,
      revision: 0,
      updatedAt: null,
    });
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

  it("offers a manual intro skip from trusted Jellyfin markers", async () => {
    const user = userEvent.setup();
    const openingSession = {
      ...session,
      positionSeconds: 0,
    } satisfies PlaybackNegotiationResponse;
    const client = readyClient(openingSession);
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: null,
      nextState: "end",
      segments: [{ endSeconds: 86, kind: "intro", startSeconds: 4 }],
      segmentsState: "ready",
    } satisfies PlaybackContextResponse);
    playbackPreferenceHarness.load.mockResolvedValueOnce({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: { ...DEFAULT_PLAYBACK_PREFERENCES.episodes, skipIntro: false },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(
      <TheaterPlayer
        client={client}
        media={{ ...media, positionSeconds: 0 }}
        onClose={() => undefined}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 10;
    fireEvent.timeUpdate(video);
    await user.click(await screen.findByRole("button", { name: "Skip intro" }));

    expect(video.currentTime).toBe(86);
  });

  it("offers a credit skip that hands episodic playback to the canonical next item", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const nextMediaReferenceId = `media_${"e".repeat(22)}`;
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber: 4,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Event Horizon",
      },
      nextState: "ready",
      segments: [{ endSeconds: 7_200, kind: "credits", startSeconds: 7_160 }],
      segmentsState: "ready",
    } satisfies PlaybackContextResponse);
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 7_165;
    fireEvent.timeUpdate(video);
    await user.click(await screen.findByRole("button", { name: "Skip credits" }));

    await waitFor(() =>
      expect(client.prepare).toHaveBeenLastCalledWith(
        nextMediaReferenceId,
        0,
        expect.any(AbortSignal),
        expect.anything(),
      ),
    );
    fireEvent.canPlay(video);
    await waitFor(() =>
      expect(
        client.report.mock.calls.filter(([, request]) => request.event === "stopped"),
      ).toHaveLength(1),
    );
  });

  it("hands off to the canonical next episode only after the viewer chooses it", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const nextMediaReferenceId = `media_${"n".repeat(22)}`;
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: `/v1/media/${nextMediaReferenceId}/images/backdrop`,
        durationSeconds: 2_700,
        episodeNumber: 4,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Event Horizon",
      },
      nextState: "ready",
      segments: [{ endSeconds: 7_200, kind: "credits", startSeconds: 7_160 }],
      segmentsState: "ready",
    } satisfies PlaybackContextResponse);
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 7_165;
    fireEvent.timeUpdate(video);
    const upNext = await screen.findByRole("region", { name: "Up next" });
    expect(upNext).toHaveTextContent("S02E04");
    expect(client.prepare).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Play next episode" }));
    await waitFor(() =>
      expect(client.prepare).toHaveBeenLastCalledWith(
        nextMediaReferenceId,
        0,
        expect.any(AbortSignal),
        expect.anything(),
      ),
    );
  });

  it("shows a missing canonical episode as requestable without negotiating playback", async () => {
    const client = readyClient();
    const nextMediaReferenceId = `media_${"r".repeat(22)}`;
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: null,
        episodeNumber: 4,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Event Horizon",
      },
      nextState: "requestable",
      segments: [{ endSeconds: 7_200, kind: "credits", startSeconds: 7_160 }],
      segmentsState: "ready",
    } satisfies PlaybackContextResponse);
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 7_165;
    fireEvent.timeUpdate(video);

    const missing = await screen.findByRole("status", { name: "Next episode missing" });
    expect(missing).toHaveTextContent("S02E04 · Event Horizon");
    expect(missing).toHaveTextContent("Request it from the series page when you are ready.");
    expect(screen.queryByRole("button", { name: "Play next episode" })).not.toBeInTheDocument();
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps the current episode session alive until the selected next stream can play", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const nextMediaReferenceId = `media_${"t".repeat(22)}`;
    const nextSession = {
      ...session,
      mediaReferenceId: nextMediaReferenceId,
      positionSeconds: 0,
      sessionId: `playback_${"t".repeat(22)}`,
      streamPath: `/v1/playback/playback_${"t".repeat(22)}/stream`,
    } satisfies PlaybackNegotiationResponse;
    client.prepare
      .mockResolvedValueOnce({ canManageLibrary: false, csrfToken, session })
      .mockResolvedValueOnce({ canManageLibrary: false, csrfToken, session: nextSession });
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber: 4,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Event Horizon",
      },
      nextState: "ready",
      segments: [{ endSeconds: 7_200, kind: "credits", startSeconds: 7_160 }],
      segmentsState: "ready",
    } satisfies PlaybackContextResponse);
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 7_165;
    fireEvent.timeUpdate(video);
    await user.click(await screen.findByRole("button", { name: "Play next episode" }));

    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    expect(
      client.report.mock.calls.filter(([, request]) => request.event === "stopped"),
    ).toHaveLength(0);

    fireEvent.canPlay(video);
    await waitFor(() =>
      expect(
        client.report.mock.calls.filter(([, request]) => request.event === "stopped"),
      ).toHaveLength(1),
    );
    expect(client.prepare).toHaveBeenCalledTimes(2);
  });

  it("autoplays the canonical next episode only after the current episode ends", async () => {
    const client = readyClient();
    const nextMediaReferenceId = `media_${"a".repeat(22)}`;
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber: 5,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    } satisfies PlaybackContextResponse);
    playbackPreferenceHarness.load.mockResolvedValueOnce({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          stillWatchingAfter: null,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    expect(client.prepare).toHaveBeenCalledTimes(1);
    fireEvent.ended(screen.getByLabelText(`${media.title} video`));

    await waitFor(() =>
      expect(client.prepare).toHaveBeenLastCalledWith(
        nextMediaReferenceId,
        0,
        expect.any(AbortSignal),
        expect.anything(),
      ),
    );
  });

  it.each([
    { condition: "the app is backgrounded", online: true, visibility: "hidden" as const },
    { condition: "the network is offline", online: false, visibility: "visible" as const },
  ])("requires confirmation instead of opening the next stream when $condition", async (state) => {
    const client = readyClient();
    const nextMediaReferenceId = `media_${"v".repeat(22)}`;
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber: 5,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    } satisfies PlaybackContextResponse);
    playbackPreferenceHarness.load.mockResolvedValueOnce({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          stillWatchingAfter: null,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue(state.visibility);
    const connection = vi.spyOn(navigator, "onLine", "get").mockReturnValue(state.online);
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.ended(screen.getByLabelText(`${media.title} video`));

    expect(await screen.findByRole("alert", { name: "Still watching?" })).toHaveTextContent(
      "Afterimage",
    );
    expect(client.prepare).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
    connection.mockRestore();
  });

  it("keeps a failed next-episode preparation recoverable without retrying in a loop", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const nextMediaReferenceId = `media_${"w".repeat(22)}`;
    client.prepare
      .mockResolvedValueOnce({ canManageLibrary: false, csrfToken, session })
      .mockRejectedValueOnce(new Error("The next episode could not be prepared."));
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber: 5,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    } satisfies PlaybackContextResponse);
    playbackPreferenceHarness.load.mockResolvedValue({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          stillWatchingAfter: null,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.ended(screen.getByLabelText(`${media.title} video`));

    expect(
      await screen.findByText(
        "The next episode could not be prepared. This stream is unchanged; try Play next again.",
      ),
    ).toBeVisible();
    expect(
      client.report.mock.calls.filter(([, request]) => request.event === "stopped"),
    ).toHaveLength(0);
    expect(client.prepare).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Play next episode" }));
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(3));
    expect(
      client.report.mock.calls.filter(([, request]) => request.event === "stopped"),
    ).toHaveLength(0);
  });

  it("counts down visibly and lets the viewer cancel episode autoplay", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const nextMediaReferenceId = `media_${"d".repeat(22)}`;
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber: 5,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    } satisfies PlaybackContextResponse);
    playbackPreferenceHarness.load.mockResolvedValueOnce({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          countdownSeconds: 10,
          stillWatchingAfter: null,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 7_195;
    fireEvent.timeUpdate(video);

    expect(
      await screen.findByRole("status", { name: "Episode autoplay countdown" }),
    ).toHaveTextContent("Autoplay in 5 seconds");
    await user.click(screen.getByRole("button", { name: "Cancel autoplay" }));
    fireEvent.ended(video);
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("treats a deliberate pause during the countdown as an autoplay cancellation", async () => {
    const client = readyClient();
    const nextMediaReferenceId = `media_${"p".repeat(22)}`;
    client.loadContext.mockResolvedValueOnce({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber: 5,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    } satisfies PlaybackContextResponse);
    playbackPreferenceHarness.load.mockResolvedValueOnce({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          countdownSeconds: 10,
          stillWatchingAfter: null,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const video = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    video.currentTime = 7_195;
    fireEvent.timeUpdate(video);
    await screen.findByRole("status", { name: "Episode autoplay countdown" });

    fireEvent.play(video);
    fireEvent.pause(video);

    expect(
      screen.queryByRole("status", { name: "Episode autoplay countdown" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play next episode" })).toBeVisible();
    fireEvent.ended(video);
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("pauses binge autoplay at the configured still-watching boundary", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const secondReferenceId = `media_${"b".repeat(22)}`;
    const thirdReferenceId = `media_${"c".repeat(22)}`;
    const contextWithNext = (
      mediaReferenceId: string,
      nextMediaReferenceId: string,
      episodeNumber: number,
    ): PlaybackContextResponse => ({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: episodeNumber === 6 ? "Signal Return" : "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    });
    client.loadContext
      .mockResolvedValueOnce(contextWithNext(media.id, secondReferenceId, 5))
      .mockResolvedValueOnce(contextWithNext(secondReferenceId, thirdReferenceId, 6));
    playbackPreferenceHarness.load.mockResolvedValue({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          stillWatchingAfter: 2,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.ended(screen.getByLabelText(`${media.title} video`));
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    fireEvent.canPlay(screen.getByLabelText(`${media.title} video`));
    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.ended(screen.getByLabelText(`${media.title} video`));

    const confirmation = await screen.findByRole("alert", { name: "Still watching?" });
    expect(confirmation).toHaveTextContent("Signal Return");
    expect(client.prepare).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Continue watching" }));
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(3));
  });

  it("starts a fresh binge window after a manual next-episode choice", async () => {
    const user = userEvent.setup();
    const client = readyClient();
    const secondReferenceId = `media_${"f".repeat(22)}`;
    const thirdReferenceId = `media_${"g".repeat(22)}`;
    const contextWithNext = (
      mediaReferenceId: string,
      nextMediaReferenceId: string,
      episodeNumber: number,
    ): PlaybackContextResponse => ({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: episodeNumber === 6 ? "Signal Return" : "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    });
    client.loadContext
      .mockResolvedValueOnce(contextWithNext(media.id, secondReferenceId, 5))
      .mockResolvedValueOnce(contextWithNext(secondReferenceId, thirdReferenceId, 6));
    playbackPreferenceHarness.load.mockResolvedValue({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          stillWatchingAfter: 2,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    const firstVideo = screen.getByLabelText<HTMLVideoElement>(`${media.title} video`);
    firstVideo.currentTime = 7_195;
    fireEvent.timeUpdate(firstVideo);
    await user.click(await screen.findByRole("button", { name: "Play next episode" }));
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    fireEvent.canPlay(screen.getByLabelText(`${media.title} video`));
    await screen.findByRole("button", { name: `Resume ${media.title}` });

    fireEvent.ended(screen.getByLabelText(`${media.title} video`));

    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert", { name: "Still watching?" })).not.toBeInTheDocument();
  });

  it("resets the binge window after explicit playback interaction", async () => {
    const client = readyClient();
    const secondReferenceId = `media_${"h".repeat(22)}`;
    const thirdReferenceId = `media_${"j".repeat(22)}`;
    const contextWithNext = (
      mediaReferenceId: string,
      nextMediaReferenceId: string,
      episodeNumber: number,
    ): PlaybackContextResponse => ({
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: 2_700,
        episodeNumber,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 2,
        seriesTitle: "Northern Lights",
        title: episodeNumber === 6 ? "Signal Return" : "Afterimage",
      },
      nextState: "ready",
      segments: [],
      segmentsState: "empty",
    });
    client.loadContext
      .mockResolvedValueOnce(contextWithNext(media.id, secondReferenceId, 5))
      .mockResolvedValueOnce(contextWithNext(secondReferenceId, thirdReferenceId, 6));
    playbackPreferenceHarness.load.mockResolvedValue({
      networkClass: "home",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        episodes: {
          ...DEFAULT_PLAYBACK_PREFERENCES.episodes,
          autoplay: true,
          stillWatchingAfter: 2,
        },
      },
      revision: 1,
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    fireEvent.ended(screen.getByLabelText(`${media.title} video`));
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    fireEvent.canPlay(screen.getByLabelText(`${media.title} video`));
    await screen.findByRole("button", { name: `Resume ${media.title}` });

    fireEvent.keyDown(screen.getByRole("dialog", { name: media.title }), { key: "ArrowRight" });
    fireEvent.ended(screen.getByLabelText(`${media.title} video`));

    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert", { name: "Still watching?" })).not.toBeInTheDocument();
  });

  it("uses source-quality compatibility negotiation by default", async () => {
    const client = readyClient();
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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

  it("resolves account languages and remote quality against each title before playback", async () => {
    const firstSession: PlaybackNegotiationResponse = {
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
          index: 8,
          language: "fas",
          selected: false,
          title: "Persian",
        },
      ],
      subtitleTracks: [
        {
          codec: "subrip",
          default: false,
          delivery: "video",
          forced: false,
          index: 14,
          language: "eng",
          selected: false,
          title: "English SDH",
        },
      ],
    };
    const replacementSessionId = `playback_${"q".repeat(22)}`;
    const resolvedSession: PlaybackNegotiationResponse = {
      ...firstSession,
      audioTracks: firstSession.audioTracks.map((track) => ({
        ...track,
        selected: track.index === 8,
      })),
      delivery: "hls",
      sessionId: replacementSessionId,
      streamPath: `/v1/playback/${replacementSessionId}/master.m3u8`,
      subtitleTracks: firstSession.subtitleTracks.map((track) => ({ ...track, selected: true })),
    };
    const client = readyClient(firstSession);
    client.prepare
      .mockResolvedValueOnce({ canManageLibrary: false, csrfToken, session: firstSession })
      .mockResolvedValueOnce({ canManageLibrary: false, csrfToken, session: resolvedSession });
    const preferenceClient: PlaybackPreferenceClient = {
      load: vi.fn(async () => ({
        networkClass: "remote" as const,
        preferences: {
          ...DEFAULT_PLAYBACK_PREFERENCES,
          audio: { languages: ["fa"], preferOriginalLanguage: false },
          quality: {
            ...DEFAULT_PLAYBACK_PREFERENCES.quality,
            remoteMaxBitrate: 4_000_000 as const,
          },
          subtitles: {
            ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
            languages: ["en"],
            mode: "always" as const,
            preferHearingImpaired: true,
          },
        },
        revision: 5,
        updatedAt: "2026-08-03T20:00:00.000Z",
      })),
      save: vi.fn(),
    };
    render(
      <TheaterPlayer
        client={client}
        media={media}
        onClose={() => undefined}
        preferenceClient={preferenceClient}
      />,
    );

    await screen.findByRole("button", { name: `Resume ${media.title}` });
    expect(client.prepare).toHaveBeenNthCalledWith(1, media.id, 1_200, expect.any(AbortSignal), {
      audioStreamIndex: null,
      maxStreamingBitrate: 4_000_000,
      mode: "auto",
      subtitleStreamIndex: null,
    });
    expect(client.prepare).toHaveBeenNthCalledWith(2, media.id, 1_200, expect.any(AbortSignal), {
      audioStreamIndex: 8,
      maxStreamingBitrate: 4_000_000,
      mode: "transcode",
      subtitleStreamIndex: 14,
    });
    await waitFor(() =>
      expect(client.report).toHaveBeenCalledWith(
        sessionId,
        { event: "stopped", positionSeconds: 1_200 },
        csrfToken,
        { keepalive: false },
      ),
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByText("Effective account profile")).toBeVisible();
    expect(screen.getByText(/4 Mbps remote ceiling applied/iu)).toBeVisible();
    expect(screen.getByRole("link", { name: "Edit account defaults" })).toHaveAttribute(
      "href",
      "/settings/playback",
    );
  });

  it("carries a deliberate Play action through preparation with an autoplay fallback", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    const client = readyClient();
    const { unmount } = render(
      <TheaterPlayer client={client} media={media} onClose={() => undefined} startWhenReady />,
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
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(await screen.findByLabelText("Buffering")).toBeVisible();

    onError?.("error", privateFailure);
    expect(await screen.findByRole("alert")).toHaveTextContent("saved progress is safe");
    expect(warning).toHaveBeenLastCalledWith(
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
    fireEvent.canPlay(video);

    await screen.findByRole("button", { name: "Playback settings" });
    await user.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByText("This play only")).toBeVisible();
    expect(screen.getByText(/without changing other sessions/iu)).toBeVisible();
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
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
    render(<TheaterPlayer client={client} media={versionedMedia} onClose={() => undefined} />);

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
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
      positionSeconds: 1_333,
      sessionId: replacementSessionId,
      streamPath: `/v1/playback/${replacementSessionId}/master.m3u8`,
    };
    const client = readyClient();
    render(<TheaterPlayer client={client} media={media} onClose={() => undefined} />);

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
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
