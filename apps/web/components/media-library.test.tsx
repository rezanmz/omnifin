import type { LibraryBrowseResponse } from "@omnifin/contracts/library";
import type { PlaybackNegotiationResponse } from "@omnifin/contracts/playback";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  emptyMediaLibraryOutcome,
  mediaLibraryDemoClient,
  mediaLibraryDemoItems,
  readyMediaLibraryOutcome,
  unavailableMediaLibraryOutcome,
} from "../lib/media-library-demo";
import { MediaLibrary } from "./media-library";
import StandaloneApplicationShell from "./standalone-application-shell";

const playbackSessionId = `playback_${"p".repeat(22)}`;
const playbackSession: PlaybackNegotiationResponse = {
  audioTracks: [],
  delivery: "direct",
  expiresAt: "2026-07-30T20:00:00.000Z",
  media: {
    audioCodec: "aac",
    bitrate: 8_000_000,
    container: "mp4",
    durationSeconds: 7_080,
    height: 1080,
    videoCodec: "h264",
    width: 1920,
  },
  mediaReferenceId: `media_${"a".repeat(22)}`,
  positionSeconds: 2_940,
  sessionId: playbackSessionId,
  streamPath: `/v1/playback/${playbackSessionId}/stream`,
  subtitleTracks: [],
};

function libraryScreen(content: ReactElement) {
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

describe("MediaLibrary", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  });

  it("renders a user-scoped collection without upstream identity details", () => {
    const { container } = render(
      libraryScreen(<MediaLibrary initialOutcome={readyMediaLibraryOutcome} live={false} />),
    );

    expect(screen.getByRole("heading", { name: "Every story, in its place." })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Library" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Library" })[0]).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("list", { name: "Library titles" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(mediaLibraryDemoItems.length);
    expect(screen.getByRole("button", { name: /View details for Ember Coast/u })).toBeVisible();
    expect(container.innerHTML).not.toContain("externalUserId");
    expect(container.innerHTML).not.toContain("jellyfin-user");
  });

  it("filters and sorts the deterministic catalogue without contacting the gateway", async () => {
    const user = userEvent.setup();
    const load = vi.fn();
    render(
      libraryScreen(
        <MediaLibrary client={{ load }} initialOutcome={readyMediaLibraryOutcome} live={false} />,
      ),
    );

    await user.click(screen.getByRole("radio", { name: "Series" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.queryByRole("button", { name: /View details for Ember Coast/u }),
    ).not.toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search your library" });
    await user.type(search, "atlas");
    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /View details for Atlas Station/u })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Clear library search" }));
    await user.click(screen.getByRole("radio", { name: "All" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort library" }), "title");
    const list = screen.getByRole("list", { name: "Library titles" });
    expect(within(list).getAllByRole("button")[0]).toHaveAccessibleName(
      /View details for Atlas Station/u,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("uses final poster geometry while the catalogue is loading", () => {
    render(libraryScreen(<MediaLibrary initialOutcome={{ status: "loading" }} live={false} />));

    expect(screen.getByRole("heading", { name: "Gathering your library…" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Gathering your library…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading movies and series");
  });

  it("renders deliberate empty, unavailable, signed-out, and permission boundaries", () => {
    const { rerender } = render(
      libraryScreen(<MediaLibrary initialOutcome={emptyMediaLibraryOutcome} live={false} />),
    );
    expect(screen.getByRole("heading", { name: "Your paired library is empty." })).toBeVisible();

    rerender(
      libraryScreen(
        <MediaLibrary
          key="unavailable"
          initialOutcome={unavailableMediaLibraryOutcome}
          live={false}
        />,
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Your library is still safely at home");

    rerender(
      libraryScreen(
        <MediaLibrary key="signed-out" initialOutcome={{ status: "signed_out" }} live={false} />,
      ),
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");

    rerender(
      libraryScreen(
        <MediaLibrary key="forbidden" initialOutcome={{ status: "forbidden" }} live={false} />,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("not available to your account");
  });

  it("loads opaque continuation pages without duplicating titles", async () => {
    const user = userEvent.setup();
    const cursor = "cursor_abcdefghijklmnop";
    const first: LibraryBrowseResponse = {
      ...readyMediaLibraryOutcome.feed,
      items: [mediaLibraryDemoItems[0]!],
      nextCursor: cursor,
    };
    const second: LibraryBrowseResponse = {
      ...readyMediaLibraryOutcome.feed,
      items: [mediaLibraryDemoItems[0]!, mediaLibraryDemoItems[1]!],
      nextCursor: null,
    };
    const load = vi.fn(async ({ cursor: requestedCursor }: { cursor?: string }) =>
      requestedCursor ? second : first,
    );
    render(libraryScreen(<MediaLibrary client={{ load }} />));

    expect(
      await screen.findByRole("button", { name: /View details for Ember Coast/u }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reveal more" }));
    expect(
      await screen.findByRole("button", { name: /View details for Northern Lights/u }),
    ).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(load).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor }),
      expect.any(AbortSignal),
    );
  });

  it("opens title details first, then starts private playback only from an explicit action", async () => {
    const user = userEvent.setup();
    const playbackClient = {
      prepare: vi.fn(async () => ({
        canManageLibrary: false,
        csrfToken: "library_playback_csrf_0123456789abcdefghijkl",
        session: playbackSession,
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
      libraryScreen(
        <MediaLibrary
          initialOutcome={readyMediaLibraryOutcome}
          live={false}
          playbackClient={playbackClient}
        />,
      ),
    );

    const trigger = screen.getByRole("button", { name: /View details for Ember Coast/u });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Ember Coast details" })).toBeVisible();
    expect(screen.getByText("The horizon remembers.")).toBeVisible();
    expect(screen.getByText("Mara Voss")).toBeVisible();
    await user.click(screen.getByText("Media information"));
    expect(screen.getByRole("heading", { name: "4K · HEVC · MKV" })).toBeVisible();
    expect(playbackClient.prepare).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Play movie from beginning" }));
    expect(await screen.findByRole("dialog", { name: "Ember Coast" })).toBeVisible();
    expect(playbackClient.prepare).toHaveBeenCalledWith(
      `media_${"a".repeat(22)}`,
      0,
      expect.any(AbortSignal),
      expect.objectContaining({ mode: "auto" }),
    );
    await user.click(screen.getByRole("button", { name: "Close player" }));

    await user.click(screen.getByRole("button", { name: "Resume movie" }));
    expect(await screen.findByRole("dialog", { name: "Ember Coast" })).toBeVisible();
    expect(playbackClient.prepare).toHaveBeenCalledWith(
      `media_${"a".repeat(22)}`,
      2_940,
      expect.any(AbortSignal),
      expect.objectContaining({ mode: "auto" }),
    );

    await user.click(screen.getByRole("button", { name: "Close player" }));
    expect(screen.getByRole("dialog", { name: "Ember Coast details" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close title details" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("updates saved Jellyfin progress separately from one-time playback position", async () => {
    const user = userEvent.setup();
    const referenceId = `media_${"a".repeat(22)}`;
    const updatePlaybackState = vi.fn(async () => ({
      action: "reset_progress" as const,
      playback: { durationSeconds: 7_080, played: false, positionSeconds: 0 },
      referenceId,
      updatedAt: "2026-07-30T12:30:00.000Z",
    }));
    render(
      libraryScreen(
        <MediaLibrary
          client={{ ...mediaLibraryDemoClient, updatePlaybackState }}
          initialOutcome={readyMediaLibraryOutcome}
          live={false}
        />,
      ),
    );

    await user.click(screen.getByRole("button", { name: /View details for Ember Coast/u }));
    const detail = await screen.findByRole("dialog", { name: "Ember Coast details" });
    expect(within(detail).getByRole("button", { name: "Play movie from beginning" })).toBeVisible();
    await user.click(within(detail).getByRole("button", { name: "Reset saved progress" }));

    await waitFor(() =>
      expect(updatePlaybackState).toHaveBeenCalledWith(referenceId, {
        action: "reset_progress",
      }),
    );
    expect(within(detail).getByText("Saved progress reset in Jellyfin.")).toBeVisible();
    expect(within(detail).getByRole("button", { name: "Play movie" })).toBeVisible();
    expect(
      within(detail).queryByRole("button", { name: "Play movie from beginning" }),
    ).not.toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Mark watched" })).toBeVisible();
  });

  it("prepares an admin-only original download from the title detail without exposing Jellyfin", async () => {
    const user = userEvent.setup();
    const referenceId = `media_${"a".repeat(22)}`;
    const grantId = `media_download_${"d".repeat(22)}`;
    const prepareDownload = vi.fn(async () => ({
      archiveRetrieval: "unknown" as const,
      contentType: "video/x-matroska",
      expiresAt: "2026-07-30T12:05:00.000Z",
      filename: "Ember Coast (2026).mkv",
      generatedAt: "2026-07-30T12:00:00.000Z",
      grantId,
      path: `/v1/media/library/downloads/${grantId}`,
      referenceId,
      sizeBytes: 6_979_321_856,
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      libraryScreen(
        <MediaLibrary
          client={{
            ...mediaLibraryDemoClient,
            loadDownloadEligibility: async () => ({
              snapshot: { csrfToken: "original-download-csrf" },
              status: "ready",
            }),
            prepareDownload,
          }}
          initialOutcome={readyMediaLibraryOutcome}
          live={false}
        />,
      ),
    );

    await user.click(screen.getByRole("button", { name: /View details for Ember Coast/u }));
    const detail = await screen.findByRole("dialog", { name: "Ember Coast details" });
    await user.click(await within(detail).findByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(prepareDownload).toHaveBeenCalledWith(referenceId, {
        csrfToken: "original-download-csrf",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(within(detail).getByText("Download started in your browser.")).toBeVisible();
    expect(within(detail).getByText(/Ember Coast \(2026\)\.mkv/u)).toBeVisible();
    const link = click.mock.instances[0] as HTMLAnchorElement;
    expect(new URL(link.href).pathname).toBe(`/api/media/library/downloads/${grantId}`);
    expect(detail.innerHTML).not.toContain("jellyfin-user");
  });

  it("keeps a series as one title and exposes its episodes inside a season hierarchy", async () => {
    const user = userEvent.setup();
    const playbackClient = {
      prepare: vi.fn(async () => ({
        canManageLibrary: false,
        csrfToken: "library_playback_csrf_0123456789abcdefghijkl",
        session: { ...playbackSession, mediaReferenceId: `media_${"i".repeat(22)}` },
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
      libraryScreen(
        <MediaLibrary
          initialOutcome={readyMediaLibraryOutcome}
          live={false}
          playbackClient={playbackClient}
        />,
      ),
    );

    await user.click(screen.getByRole("button", { name: /View details for Northern Lights/u }));
    const detail = await screen.findByRole("dialog", { name: "Northern Lights details" });
    expect(within(detail).getByRole("heading", { name: "Northern Lights" })).toBeVisible();
    const seasonOne = within(detail).getByRole("tab", { name: /Season 1/u });
    expect(seasonOne).toHaveAttribute("aria-selected", "true");
    expect(seasonOne).toHaveAttribute("tabindex", "0");
    expect(await within(detail).findByRole("list", { name: "Episodes" })).toBeVisible();
    expect(playbackClient.prepare).not.toHaveBeenCalled();

    seasonOne.focus();
    await user.keyboard("{ArrowRight}");
    const seasonTwo = within(detail).getByRole("tab", { name: /Season 2/u });
    expect(seasonTwo).toHaveFocus();
    expect(seasonTwo).toHaveAttribute("aria-selected", "true");
    expect(
      await within(detail).findByRole("button", { name: "Resume The Long Meridian" }),
    ).toBeVisible();
    await user.click(
      within(detail).getByRole("button", { name: "View details for The Long Meridian" }),
    );
    const episodeDetail = within(detail).getByRole("region", {
      name: "The Long Meridian episode details",
    });
    expect(episodeDetail).toHaveTextContent("Apr 3, 2026");
    expect(episodeDetail).toHaveTextContent("7.5/10");
    expect(episodeDetail).toHaveTextContent("Mara Voss");
    expect(episodeDetail).toHaveTextContent("Ari Chen");
    expect(within(episodeDetail).getByRole("button", { name: "Resume episode" })).toBeVisible();
    seasonTwo.focus();
    await user.keyboard("{ArrowLeft}");
    expect(seasonOne).toHaveFocus();
    expect(seasonOne).toHaveAttribute("aria-selected", "true");

    await user.click(within(detail).getByRole("button", { name: "Play The Long Meridian" }));
    expect(await screen.findByRole("dialog", { name: "The Long Meridian" })).toBeVisible();
    expect(playbackClient.prepare).toHaveBeenCalledWith(
      `media_${"i".repeat(22)}`,
      0,
      expect.any(AbortSignal),
      expect.objectContaining({ mode: "auto" }),
    );
  });
});
