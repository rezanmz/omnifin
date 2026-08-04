import type { LibraryBrowseResponse, LibraryExtrasResponse } from "@omnifin/contracts/library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { libraryDemoPrincipal } from "./library-care-demo";
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

  it("loads local extras lazily through the selected opaque parent reference", async () => {
    const parent = readyMediaLibraryOutcome.feed.items[0]!.media;
    const extraReferenceId = `media_${"x".repeat(22)}`;
    const extras: LibraryExtrasResponse = {
      generatedAt: readyMediaLibraryOutcome.feed.generatedAt,
      items: [
        {
          extraType: "trailer",
          media: {
            artwork: {
              accentColor: "#775544",
              backdropPath: null,
              blurHash: null,
              posterPath: `/v1/media/${extraReferenceId}/images/poster`,
            },
            availability: "available",
            contentRating: null,
            id: extraReferenceId,
            kind: "other",
            overview: "A local trailer.",
            runtimeMinutes: 2,
            subtitle: "Local extra",
            title: "Official trailer",
            year: 2026,
          },
          playback: { durationSeconds: 118, played: false, positionSeconds: 0 },
          source: "local",
        },
      ],
      nextCursor: null,
      onlineItems: [],
      onlineSource: { displayName: "Online trailers", failure: null, status: "unconfigured" },
      onlineState: "unconfigured",
      parentReferenceId: parent.id,
      source: { displayName: "Home Jellyfin", failure: null, status: "healthy" },
      state: "complete",
    };
    const fetchMock = vi.fn(async () => Response.json(extras));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mediaLibraryClient.loadExtras!(parent.id, { limit: 12 })).resolves.toEqual(extras);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/media/library/${parent.id}/extras?limit=12`,
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );

    await expect(mediaLibraryClient.loadExtras!("private-jellyfin-item")).rejects.toMatchObject({
      code: "invalid_reference",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates playback state with the active session CSRF token and an idempotency key", async () => {
    const referenceId = readyMediaLibraryOutcome.feed.items[0]!.media.id;
    const csrfToken = "media_library_csrf_0123456789abcdefghijklmnop";
    const result = {
      action: "reset_progress" as const,
      playback: { durationSeconds: 7_080, played: false, positionSeconds: 0 },
      referenceId,
      updatedAt: "2026-07-30T12:30:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrfToken, principal: libraryDemoPrincipal }))
      .mockResolvedValueOnce(Response.json(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mediaLibraryClient.updatePlaybackState!(
        referenceId,
        { action: "reset_progress" },
        undefined,
        "playback-state-browser-0123456789",
      ),
    ).resolves.toEqual(result);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/media/library/${referenceId}/playback-state`);
    const request = fetchMock.mock.calls[1]?.[1];
    const headers = new Headers(request?.headers);
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({ action: "reset_progress" });
    expect(headers.get("idempotency-key")).toBe("playback-state-browser-0123456789");
    expect(headers.get("x-omnifin-csrf")).toBe(csrfToken);
    expect(String(fetchMock.mock.calls)).not.toContain("jellyfin-user");
  });

  it("fails playback-state writes closed when the session is absent or lacks permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ csrfToken: null, principal: null })),
    );
    await expect(
      mediaLibraryClient.updatePlaybackState!(readyMediaLibraryOutcome.feed.items[0]!.media.id, {
        action: "mark_watched",
      }),
    ).rejects.toMatchObject({ code: "authentication_required", kind: "signed_out" });

    const csrfToken = "media_library_csrf_0123456789abcdefghijklmnop";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          csrfToken,
          principal: { ...libraryDemoPrincipal, permissions: ["media.view"] },
        }),
      ),
    );
    await expect(
      mediaLibraryClient.updatePlaybackState!(readyMediaLibraryOutcome.feed.items[0]!.media.id, {
        action: "mark_watched",
      }),
    ).rejects.toMatchObject({ code: "permission_denied", kind: "forbidden" });
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
