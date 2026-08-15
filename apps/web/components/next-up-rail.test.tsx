import type { PlaybackContextResponse } from "@omnifin/contracts/playback";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { demoContinueWatchingFeed } from "../lib/continue-watching-demo";
import { NextUpRail } from "./next-up-rail";

const sourceReferenceId = demoContinueWatchingFeed.items[0]!.media.id;
const nextReferenceId = `media_${"n".repeat(22)}`;

const response: PlaybackContextResponse = {
  currentDurationSeconds: 2_700,
  generatedAt: "2026-08-14T12:30:00.000Z",
  mediaReferenceId: sourceReferenceId,
  nextEpisode: {
    artworkPath: `/v1/media/${nextReferenceId}/images/backdrop`,
    durationSeconds: 2_400,
    episodeNumber: 4,
    mediaReferenceId: nextReferenceId,
    seasonNumber: 2,
    seriesTitle: "Northern Lights",
    title: "Beyond the signal",
  },
  nextState: "ready",
  segments: [],
  segmentsState: "empty",
};

describe("NextUpRail", () => {
  it("loads a private continuation after watch history and starts it through the supplied selection boundary", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const client = { loadContext: vi.fn(async () => response) };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <NextUpRail client={client} enabled feed={demoContinueWatchingFeed} onSelect={onSelect} />
      </QueryClientProvider>,
    );

    const trigger = await screen.findByRole("button", {
      name: "View details for Northern Lights",
    });
    await user.click(trigger);

    expect(client.loadContext).toHaveBeenCalledWith(sourceReferenceId, expect.any(AbortSignal));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: nextReferenceId, selectable: true }),
    );
  });
});
