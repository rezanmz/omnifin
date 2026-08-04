import {
  DEFAULT_PLAYBACK_PREFERENCES,
  type PlaybackContextResponse,
  type PlaybackNegotiationResponse,
} from "@omnifin/contracts/playback";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import type { PlaybackClient } from "../lib/playback";
import { TheaterPlayer, type TheaterMedia } from "./theater-player";

const sessionId = `playback_${"s".repeat(22)}`;
const media: TheaterMedia = {
  accent: "#8db9ad",
  eyebrow: "38 min left · Episode 3",
  id: `media_${"m".repeat(22)}`,
  positionSeconds: 1_200,
  title: "Northern Lights",
};
const directSession: PlaybackNegotiationResponse = {
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
      language: "fra",
      selected: false,
      title: "Français",
    },
  ],
  delivery: "direct",
  expiresAt: "2027-07-28T20:00:00.000Z",
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
    {
      codec: "ass",
      default: false,
      delivery: "video",
      forced: false,
      index: 8,
      language: "fra",
      selected: false,
      title: "Français",
    },
  ],
};
const csrfToken = "storybook_playback_csrf_0123456789abcdefghijklmnop";

function clientFor(
  session: PlaybackNegotiationResponse,
  canManageLibrary = true,
  context?: PlaybackContextResponse,
): PlaybackClient {
  return {
    ...(context ? { loadContext: async () => context } : {}),
    prepare: async () => ({ canManageLibrary, csrfToken, session }),
    report: async (_currentSessionId, request) => ({
      acceptedAt: "2026-07-28T12:30:00.000Z",
      positionSeconds: request.positionSeconds,
      sessionId,
      state:
        request.event === "paused" ? "paused" : request.event === "stopped" ? "stopped" : "playing",
    }),
    reportIssue: async (_currentSessionId, request) => ({
      category: request.category,
      createdAt: "2026-07-28T12:30:00.000Z",
      id: `issue_${"i".repeat(22)}`,
      positionSeconds: request.positionSeconds,
      status: "open",
    }),
  };
}

const meta = {
  args: {
    client: clientFor(directSession),
    media,
    onClose: () => undefined,
    preferenceClient: {
      load: async () => ({
        networkClass: "home",
        preferences: DEFAULT_PLAYBACK_PREFERENCES,
        revision: 0,
        updatedAt: null,
      }),
      save: async () => {
        throw new Error("The theater story does not save account preferences.");
      },
    },
  },
  component: TheaterPlayer,
  parameters: { layout: "fullscreen" },
  title: "Components/Theater player",
} satisfies Meta<typeof TheaterPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DirectReady: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Resume Northern Lights" }),
    ).toBeVisible();
    await expect(canvas.getByRole("slider", { name: "Playback position" })).toHaveValue("1200");
  },
};

export const HlsReady: Story = {
  args: {
    client: clientFor({
      ...directSession,
      delivery: "hls",
      streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    }),
  },
};

const nearCreditsMedia = { ...media, positionSeconds: 7_195 };
const nearCreditsSession = { ...directSession, positionSeconds: 7_195 };
const nextMediaReferenceId = `media_${"n".repeat(22)}`;
const nextEpisode = {
  artworkPath: null,
  durationSeconds: 2_700,
  episodeNumber: 4,
  mediaReferenceId: nextMediaReferenceId,
  seasonNumber: 2,
  seriesTitle: "Northern Lights",
  title: "Event Horizon",
};

export const UpNextReady: Story = {
  args: {
    client: clientFor(nearCreditsSession, true, {
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode,
      nextState: "ready",
      segments: [{ endSeconds: 7_200, kind: "credits", startSeconds: 7_160 }],
      segmentsState: "ready",
    }),
    media: nearCreditsMedia,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "Up next" })).toHaveTextContent(
      "S02E04 · Event Horizon",
    );
    await expect(canvas.getByRole("button", { name: "Play next episode" })).toBeVisible();
  },
};

export const NextEpisodeMissing: Story = {
  args: {
    client: clientFor(nearCreditsSession, true, {
      currentDurationSeconds: 7_200,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId: media.id,
      nextEpisode: { ...nextEpisode, durationSeconds: null },
      nextState: "requestable",
      segments: [{ endSeconds: 7_200, kind: "credits", startSeconds: 7_160 }],
      segmentsState: "ready",
    }),
    media: nearCreditsMedia,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("status", { name: "Next episode missing" }),
    ).toHaveTextContent("Request it from the series page when you are ready.");
    await expect(canvas.queryByRole("button", { name: "Play next episode" })).toBeNull();
  },
};

export const SettingsOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Playback settings" }));
    await expect(canvas.getByRole("region", { name: "Playback settings" })).toBeVisible();
  },
};

export const IssueReporter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Report playback issue" }));
    await expect(canvas.getByRole("region", { name: "Report playback issue" })).toBeVisible();
  },
};

export const Preparing: Story = {
  args: {
    client: {
      prepare: () => new Promise<never>(() => undefined),
      report: async () => {
        throw new Error("A preparing player cannot report progress.");
      },
      reportIssue: async () => {
        throw new Error("A preparing player cannot report an issue.");
      },
    },
  },
};

export const NegotiationError: Story = {
  args: {
    client: {
      prepare: async () => {
        throw new Error("Jellyfin is out of reach. Your saved progress is untouched.");
      },
      report: async () => {
        throw new Error("An unavailable player cannot report progress.");
      },
      reportIssue: async () => {
        throw new Error("An unavailable player cannot report an issue.");
      },
    },
  },
};
