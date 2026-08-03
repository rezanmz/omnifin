import type { LibraryBrowseResponse } from "@omnifin/contracts/library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readyMediaLibraryOutcome } from "./media-library-demo";
import {
  MediaLibraryClientError,
  mediaLibraryClient,
  mediaLibraryOutcomeFromError,
  sameOriginMediaPath,
} from "./media-library";

const feed: LibraryBrowseResponse = readyMediaLibraryOutcome.feed;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Media library client", () => {
  it("encodes only bounded catalogue controls and validates the normalized response", async () => {
    const fetchMock = vi.fn(async () => Response.json(feed));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mediaLibraryClient.load({
        cursor: "cursor_abcdefghijklmnop",
        kind: "series",
        limit: 24,
        query: "  Northern Lights  ",
        sort: "year",
      }),
    ).resolves.toEqual(feed);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/library?kind=series&limit=24&sort=year&query=Northern+Lights&cursor=cursor_abcdefghijklmnop",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("Living Room Jellyfin");
  });

  it("loads title details and season pages only through opaque same-origin routes", async () => {
    const series = readyMediaLibraryOutcome.feed.items.find(
      (item) => item.media.kind === "series",
    )!;
    const detail = {
      generatedAt: readyMediaLibraryOutcome.feed.generatedAt,
      media: series.media,
      movie: null,
      playback: null,
      seasons: [{ episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 2, title: "Season 2" }],
      seasonsTruncated: false,
    };
    const episodes = {
      generatedAt: readyMediaLibraryOutcome.feed.generatedAt,
      items: [],
      nextCursor: null,
      seasonNumber: 2,
      titleReferenceId: series.media.id,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(detail))
      .mockResolvedValueOnce(Response.json(episodes));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mediaLibraryClient.loadTitle!(series.media.id)).resolves.toEqual(detail);
    await expect(
      mediaLibraryClient.loadSeasonEpisodes!(series.media.id, 2, {
        cursor: "cursor_abcdefghijklmnop",
        limit: 20,
      }),
    ).resolves.toEqual(episodes);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/media/library/${series.media.id}`,
      `/api/media/library/${series.media.id}/seasons/2/episodes?limit=20&cursor=cursor_abcdefghijklmnop`,
    ]);
  });

  it("fails closed when the gateway response violates the browser contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...feed, items: [{ rawJellyfinId: "private" }] })),
    );

    await expect(mediaLibraryClient.load({ kind: "all", sort: "recent" })).rejects.toMatchObject({
      code: "invalid_response",
      kind: "invalid_response",
    });
  });

  it("classifies authentication, permission, and connectivity boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(mediaLibraryClient.load({ kind: "all", sort: "recent" })).rejects.toMatchObject({
      kind: "signed_out",
    });
    expect(
      mediaLibraryOutcomeFromError(
        new MediaLibraryClientError("forbidden", "permission_denied", "Restricted"),
      ),
    ).toBe("forbidden");
    expect(mediaLibraryOutcomeFromError(new Error("offline"))).toBe("unavailable");
  });

  it("maps only normalized media proxy paths onto the current origin", () => {
    const path = `/v1/media/media_${"m".repeat(22)}/images/poster`;
    expect(sameOriginMediaPath(path)).toBe(`/api/media/media_${"m".repeat(22)}/images/poster`);
    const personPath = `/v1/media/media_${"m".repeat(22)}/images/people/v2.opaque.image.grant`;
    expect(sameOriginMediaPath(personPath)).toBe(
      `/api/media/media_${"m".repeat(22)}/images/people/v2.opaque.image.grant`,
    );
    expect(sameOriginMediaPath(null)).toBeUndefined();
    expect(sameOriginMediaPath("https://media.example/poster.jpg")).toBeUndefined();
    expect(sameOriginMediaPath("/untrusted/poster.jpg")).toBeUndefined();
  });
});
