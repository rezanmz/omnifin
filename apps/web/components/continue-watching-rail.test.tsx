import type { ContinueWatchingResponse } from "@omnifin/contracts/dashboard";
import type { PlaybackNegotiationResponse } from "@omnifin/contracts/playback";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  demoContinueWatchingFeed,
  emptyContinueWatchingFeed,
  unavailableContinueWatchingFeed,
} from "../lib/continue-watching-demo";
import { ContinueWatchingRail } from "./continue-watching-rail";

const playbackSessionId = `playback_${"p".repeat(22)}`;
const playbackSession: PlaybackNegotiationResponse = {
  audioTracks: [],
  delivery: "direct",
  expiresAt: "2026-07-28T20:00:00.000Z",
  media: {
    audioCodec: "aac",
    bitrate: 8_000_000,
    container: "mp4",
    durationSeconds: 3_600,
    height: 1080,
    streamBitrate: null,
    videoCodec: "h264",
    width: 1920,
  },
  mediaReferenceId: `media_${"b".repeat(22)}`,
  playMethod: "direct_stream",
  positionSeconds: 1_200,
  sessionId: playbackSessionId,
  streamPath: `/v1/playback/${playbackSessionId}/stream`,
  subtitleTracks: [],
};

describe("ContinueWatchingRail", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  });

  it("renders normalized progress and a private same-origin artwork path", () => {
    const { container } = render(
      <ContinueWatchingRail
        initialOutcome={{ feed: demoContinueWatchingFeed, status: "ready" }}
        live={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Resume Northern Lights" }),
    ).toHaveAccessibleDescription("33% watched");
    expect(container.querySelector('[data-artwork-source="remote"] img')).toHaveAttribute(
      "src",
      `/api/media/media_${"b".repeat(22)}/images/poster`,
    );
    expect(container.innerHTML).not.toContain("jellyfin-main");
  });

  it("uses final card geometry while the feed is loading", () => {
    render(<ContinueWatchingRail client={{ load: () => new Promise<never>(() => undefined) }} />);

    expect(screen.getByRole("region", { name: "Continue watching" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(document.querySelectorAll(".media-card--loading")).toHaveLength(4);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Continue Watching");
  });

  it("guides signed-out viewers without contacting the client", () => {
    const load = vi.fn();
    render(
      <ContinueWatchingRail
        client={{ load }}
        initialOutcome={{ status: "signed_out" }}
        live={false}
      />,
    );

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("status")).toHaveTextContent("Your progress is waiting");
    expect(screen.getByText("Your progress is waiting").parentElement).toHaveClass(
      "quiet-state__copy",
    );
    expect(screen.getByText(/Sign in with OIDC or Jellyfin/u)).toBeVisible();
    expect(load).not.toHaveBeenCalled();
  });

  it("renders deliberate empty and unavailable states", () => {
    const { rerender } = render(
      <ContinueWatchingRail
        initialOutcome={{ feed: emptyContinueWatchingFeed, status: "ready" }}
        live={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Start watching something in Jellyfin");

    rerender(
      <ContinueWatchingRail
        key="unavailable"
        initialOutcome={{ feed: unavailableContinueWatchingFeed, status: "ready" }}
        live={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Jellyfin is out of reach");
  });

  it("retries an interrupted live feed on explicit request", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<ContinueWatchingRail client={{ load }} />);

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(load).toHaveBeenCalledOnce();
    await user.click(retry);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("opens the private theater and returns focus to the selected card", async () => {
    const user = userEvent.setup();
    const playbackClient = {
      prepare: vi.fn(async () => ({
        canManageLibrary: false,
        csrfToken: "rail_playback_csrf_0123456789abcdefghijklmnop",
        session: playbackSession,
      })),
      report: vi.fn(async (_sessionId, request) => ({
        acceptedAt: "2026-07-28T12:30:00.000Z",
        positionSeconds: request.positionSeconds,
        sessionId: playbackSessionId,
        state: "stopped" as const,
      })),
      reportIssue: vi.fn(async (_sessionId, request) => ({
        category: request.category,
        createdAt: "2026-07-28T12:30:00.000Z",
        id: `issue_${"i".repeat(22)}`,
        positionSeconds: request.positionSeconds,
        status: "open" as const,
      })),
    };
    render(
      <ContinueWatchingRail
        initialOutcome={{ feed: demoContinueWatchingFeed, status: "ready" }}
        live={false}
        playbackClient={playbackClient}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Resume Northern Lights" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Northern Lights" })).toBeVisible();
    await waitFor(() =>
      expect(playbackClient.prepare).toHaveBeenCalledWith(
        `media_${"b".repeat(22)}`,
        900,
        expect.any(AbortSignal),
        expect.objectContaining({ mode: "auto" }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Close player" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("suggests one ready next episode from each bounded in-progress episode", async () => {
    const loadContext = vi.fn(async (referenceId: string) => {
      expect(referenceId).toBe(`media_${"b".repeat(22)}`);
      return {
        currentDurationSeconds: 2_700,
        generatedAt: "2026-07-28T12:30:00.000Z",
        mediaReferenceId: referenceId,
        nextEpisode: {
          artworkPath: `/v1/media/media_${"n".repeat(22)}/images/poster`,
          durationSeconds: 2_700,
          episodeNumber: 4,
          mediaReferenceId: `media_${"n".repeat(22)}`,
          seasonNumber: 2,
          seriesTitle: "Northern Lights",
          title: "The Long Meridian",
        },
        nextState: "ready" as const,
        segments: [],
        segmentsState: "empty" as const,
      };
    });
    const playbackClient = {
      loadContext,
      prepare: vi.fn(async () => ({
        canManageLibrary: false,
        csrfToken: "rail_playback_csrf_0123456789abcdefghijklmnop",
        session: playbackSession,
      })),
      report: vi.fn(async (_sessionId, request) => ({
        acceptedAt: "2026-07-28T12:30:00.000Z",
        positionSeconds: request.positionSeconds,
        sessionId: playbackSessionId,
        state: "stopped" as const,
      })),
      reportIssue: vi.fn(async (_sessionId, request) => ({
        category: request.category,
        createdAt: "2026-07-28T12:30:00.000Z",
        id: `issue_${"i".repeat(22)}`,
        positionSeconds: request.positionSeconds,
        status: "open" as const,
      })),
    };
    render(
      <ContinueWatchingRail
        initialOutcome={{ feed: demoContinueWatchingFeed, status: "ready" }}
        live={false}
        playbackClient={playbackClient}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Next up" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "View details for The Long Meridian" }),
    ).toBeVisible();
    expect(screen.getByText("Northern Lights · S2E4")).toBeVisible();
    expect(loadContext).toHaveBeenCalledTimes(1);
  });

  it("bounds next-up context checks to eight in-progress episodes", async () => {
    const loadContext = vi.fn(async (mediaReferenceId: string) => ({
      currentDurationSeconds: 2_700,
      generatedAt: "2026-07-28T12:30:00.000Z",
      mediaReferenceId,
      nextEpisode: null,
      nextState: "end" as const,
      segments: [],
      segmentsState: "empty" as const,
    }));
    const sourceItem = demoContinueWatchingFeed.items[0]!;
    const feed: ContinueWatchingResponse = {
      ...demoContinueWatchingFeed,
      items: Array.from({ length: 9 }, (_, index) => {
        const referenceId = `media_${String.fromCharCode(97 + index).repeat(22)}`;
        return {
          ...sourceItem,
          media: { ...sourceItem.media, id: referenceId },
        };
      }),
    };
    const playbackClient = {
      loadContext,
      prepare: vi.fn(async () => ({
        canManageLibrary: false,
        csrfToken: "rail_playback_csrf_0123456789abcdefghijklmnop",
        session: playbackSession,
      })),
      report: vi.fn(async (_sessionId, request) => ({
        acceptedAt: "2026-07-28T12:30:00.000Z",
        positionSeconds: request.positionSeconds,
        sessionId: playbackSessionId,
        state: "stopped" as const,
      })),
      reportIssue: vi.fn(async (_sessionId, request) => ({
        category: request.category,
        createdAt: "2026-07-28T12:30:00.000Z",
        id: `issue_${"i".repeat(22)}`,
        positionSeconds: request.positionSeconds,
        status: "open" as const,
      })),
    };

    render(
      <ContinueWatchingRail
        initialOutcome={{ feed, status: "ready" }}
        live={false}
        playbackClient={playbackClient}
      />,
    );

    await waitFor(() => expect(loadContext).toHaveBeenCalledTimes(8));
    expect(loadContext).toHaveBeenLastCalledWith(
      `media_${"h".repeat(22)}`,
      expect.any(AbortSignal),
    );
  });
});
