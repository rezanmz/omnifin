import type { PlaybackNegotiationResponse } from "@omnifin/contracts/playback";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { demoViewingHistory } from "../lib/viewing-history-demo";
import { ViewingHistoryClientError, type ViewingHistoryClient } from "../lib/viewing-history";
import StandaloneApplicationShell from "./standalone-application-shell";
import { ViewingHistory } from "./viewing-history";

function historyScreen(content: React.ReactNode) {
  return (
    <StandaloneApplicationShell
      accent="#6f8d84"
      current="library"
      displayProfile="standard"
      status="attention"
      themePreference="system"
    >
      {content}
    </StandaloneApplicationShell>
  );
}

describe("ViewingHistory", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  });

  it("renders private grouped activity and filters the deterministic view accessibly", async () => {
    const user = userEvent.setup();
    const { container } = render(
      historyScreen(
        <ViewingHistory
          initialOutcome={{ history: demoViewingHistory, status: "ready" }}
          live={false}
        />,
      ),
    );

    expect(screen.getByRole("heading", { name: "Your story, in sequence." })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Today" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeVisible();
    expect(screen.getByText("Only you")).toBeVisible();
    const historyLists = container.querySelectorAll(
      'section[aria-labelledby^="history-day-"] > ul',
    );
    expect(historyLists).toHaveLength(3);
    for (const list of historyLists) {
      expect(Array.from(list.children).every((entry) => entry.tagName === "LI")).toBe(true);
    }
    expect(screen.getByRole("link", { name: "Back to library" })).toHaveAttribute(
      "href",
      "/library",
    );
    expect(container.innerHTML).not.toMatch(/externalUserId|private-upstream|api_key/iu);

    await user.click(screen.getByRole("radio", { name: "Movies" }));
    expect(screen.getByRole("heading", { name: "2 titles in view" })).toBeVisible();
    expect(screen.queryByText("Northern Lights · S02E01")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Completed" }));
    expect(screen.getByRole("heading", { name: "1 title in view" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Play again" })).toBeVisible();

    const stateControl = screen.getByRole("radio", { name: "Completed" });
    stateControl.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "In progress" })).toHaveFocus();
  });

  it("keeps one-time play from beginning separate from saved progress", async () => {
    const user = userEvent.setup();
    const entry = demoViewingHistory.items[0]!;
    const playbackSessionId = `playback_${"p".repeat(22)}`;
    const session: PlaybackNegotiationResponse = {
      audioTracks: [],
      delivery: "direct",
      expiresAt: "2026-07-30T20:00:00.000Z",
      media: {
        audioCodec: "aac",
        bitrate: 8_000_000,
        container: "mp4",
        durationSeconds: entry.playback.durationSeconds,
        height: 1080,
        videoCodec: "h264",
        width: 1920,
      },
      mediaReferenceId: entry.media.id,
      positionSeconds: 0,
      sessionId: playbackSessionId,
      streamPath: `/v1/playback/${playbackSessionId}/stream`,
      subtitleTracks: [],
    };
    const playbackClient = {
      prepare: vi.fn(async () => ({
        canManageLibrary: false,
        csrfToken: "history_playback_csrf_0123456789abcdefghijklmnop",
        session,
      })),
      report: vi.fn(async (_sessionId, request) => ({
        acceptedAt: "2026-07-30T12:30:00.000Z",
        positionSeconds: request.positionSeconds,
        sessionId: playbackSessionId,
        state: "stopped" as const,
      })),
      reportIssue: vi.fn(async (_sessionId, request) => ({
        category: request.category,
        createdAt: "2026-07-30T12:30:00.000Z",
        id: `issue_${"i".repeat(22)}`,
        positionSeconds: request.positionSeconds,
        status: "open" as const,
      })),
    };
    render(
      historyScreen(
        <ViewingHistory
          initialOutcome={{ history: demoViewingHistory, status: "ready" }}
          live={false}
          playbackClient={playbackClient}
        />,
      ),
    );

    await user.click(screen.getAllByRole("button", { name: "From beginning" })[0]!);
    expect(await screen.findByRole("dialog", { name: entry.media.title })).toBeVisible();
    await waitFor(() =>
      expect(playbackClient.prepare).toHaveBeenCalledWith(
        entry.media.id,
        0,
        expect.any(AbortSignal),
        expect.objectContaining({ mode: "auto" }),
      ),
    );
  });

  it("renders loading, empty, unavailable, and access boundaries deliberately", () => {
    const { rerender } = render(
      historyScreen(<ViewingHistory initialOutcome={{ status: "loading" }} live={false} />),
    );
    expect(screen.getByRole("heading", { name: "Replaying your recent signals…" })).toBeVisible();

    rerender(
      historyScreen(
        <ViewingHistory
          key="empty"
          initialOutcome={{
            history: { ...demoViewingHistory, items: [], state: "empty" },
            status: "ready",
          }}
          live={false}
        />,
      ),
    );
    expect(screen.getByRole("heading", { name: "No activity matches this view." })).toBeVisible();

    rerender(
      historyScreen(
        <ViewingHistory key="signed-out" initialOutcome={{ status: "signed_out" }} live={false} />,
      ),
    );
    expect(
      screen.getByRole("heading", { name: "Sign in to open your viewing history." }),
    ).toBeVisible();
  });

  it("loads live activity, follows the opaque boundary, and removes duplicate entries", async () => {
    const user = userEvent.setup();
    const cursor = "aGlzdG9yeQ.c2lnbmF0dXJl";
    const first = {
      ...demoViewingHistory,
      items: [demoViewingHistory.items[0]!],
      nextCursor: cursor,
    };
    const second = {
      ...demoViewingHistory,
      items: [demoViewingHistory.items[0]!, demoViewingHistory.items[1]!],
      nextCursor: null,
    };
    const client: ViewingHistoryClient = {
      load: vi.fn(async (input) => (input.cursor ? second : first)),
    };
    render(historyScreen(<ViewingHistory client={client} />));

    expect(await screen.findByRole("heading", { name: "1 title in view" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load earlier activity" }));
    expect(await screen.findByRole("heading", { name: "2 titles in view" })).toBeVisible();
    expect(client.load).toHaveBeenCalledWith(
      expect.objectContaining({ cursor, kind: "all", range: "30_days", state: "all" }),
      expect.any(AbortSignal),
    );

    const movies = screen.getByRole("radio", { name: "Movies" });
    movies.focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Episodes" })).toHaveFocus();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Viewing history date range" }),
      "all",
    );
    await waitFor(() =>
      expect(client.load).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "episodes", range: "all" }),
        expect.any(AbortSignal),
      ),
    );
  });

  it("classifies live access failures and recovers from an unavailable gateway", async () => {
    const user = userEvent.setup();
    const unavailableClient: ViewingHistoryClient = {
      load: vi
        .fn()
        .mockRejectedValueOnce(
          new ViewingHistoryClientError("unavailable", "service_unavailable", "Offline"),
        )
        .mockResolvedValueOnce(demoViewingHistory),
    };
    const { rerender } = render(historyScreen(<ViewingHistory client={unavailableClient} />));
    expect(
      await screen.findByRole("heading", { name: "Your activity remains safely in Jellyfin." }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Your story, in sequence." })).toBeVisible();

    const signedOutClient: ViewingHistoryClient = {
      load: vi.fn(async () => {
        throw new ViewingHistoryClientError("signed_out", "authentication_required", "Sign in");
      }),
    };
    rerender(historyScreen(<ViewingHistory client={signedOutClient} key="signed-out-live" />));
    expect(
      await screen.findByRole("heading", { name: "Sign in to open your viewing history." }),
    ).toBeVisible();
  });
});
