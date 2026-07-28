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
    videoCodec: "h264",
    width: 1920,
  },
  mediaReferenceId: `media_${"b".repeat(22)}`,
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
    expect(container.querySelector('[data-artwork-source="remote"]')).toHaveStyle({
      "--card-artwork": `url("/api/media/media_${"b".repeat(22)}/images/poster")`,
    });
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
        csrfToken: "rail_playback_csrf_0123456789abcdefghijklmnop",
        session: playbackSession,
      })),
      report: vi.fn(async (_sessionId, request) => ({
        acceptedAt: "2026-07-28T12:30:00.000Z",
        positionSeconds: request.positionSeconds,
        sessionId: playbackSessionId,
        state: "stopped" as const,
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
    expect(playbackClient.prepare).toHaveBeenCalledWith(
      `media_${"b".repeat(22)}`,
      900,
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole("button", { name: "Close player" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
