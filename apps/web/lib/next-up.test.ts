import type { PlaybackContextResponse } from "@omnifin/contracts/playback";
import { describe, expect, it, vi } from "vitest";

import { demoContinueWatchingFeed } from "./continue-watching-demo";
import { loadNextUp, NEXT_UP_MAX_CONTEXTS } from "./next-up";

const sourceReferenceId = demoContinueWatchingFeed.items[0]!.media.id;
const nextReferenceId = `media_${"n".repeat(22)}`;

function context(overrides: Partial<PlaybackContextResponse> = {}): PlaybackContextResponse {
  return {
    currentDurationSeconds: 2_700,
    generatedAt: "2026-08-14T12:30:00.000Z",
    mediaReferenceId: sourceReferenceId,
    nextEpisode: {
      artworkPath: `/v1/media/${nextReferenceId}/images/poster`,
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
    ...overrides,
  };
}

describe("loadNextUp", () => {
  it("keeps user-bound playable continuations opaque and marks requestable episodes non-selectable", async () => {
    const loadContext = vi.fn(async () =>
      context({
        nextEpisode: { ...context().nextEpisode!, durationSeconds: null },
        nextState: "requestable",
      }),
    );

    await expect(loadNextUp(demoContinueWatchingFeed, { loadContext })).resolves.toEqual([
      {
        accent: "#5d9690",
        artworkPath: `/api/media/${nextReferenceId}/images/poster`,
        eyebrow: "Available to request · Beyond the signal",
        id: nextReferenceId,
        requestable: true,
        selectable: false,
        title: "Northern Lights",
      },
    ]);
    expect(loadContext).toHaveBeenCalledWith(sourceReferenceId, undefined);
  });

  it("rejects foreign context responses, deduplicates next references, and bounds fan-out", async () => {
    const items = Array.from({ length: NEXT_UP_MAX_CONTEXTS + 1 }, (_, index) => ({
      ...demoContinueWatchingFeed.items[0]!,
      media: {
        ...demoContinueWatchingFeed.items[0]!.media,
        id: `media_${String(index).padStart(22, "x")}`,
      },
    }));
    const feed = { ...demoContinueWatchingFeed, items };
    const loadContext = vi.fn(async (referenceId: string) =>
      context({
        mediaReferenceId: referenceId === items[0]!.media.id ? "media_invalid" : referenceId,
      }),
    );

    const cards = await loadNextUp(feed, { loadContext });

    expect(loadContext).toHaveBeenCalledTimes(NEXT_UP_MAX_CONTEXTS);
    expect(cards).toEqual([expect.objectContaining({ id: nextReferenceId, selectable: true })]);
  });
});
