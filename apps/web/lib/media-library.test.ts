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
        kind: "episodes",
        limit: 24,
        query: "  Northern Lights  ",
        sort: "year",
      }),
    ).resolves.toEqual(feed);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/library?kind=episodes&limit=24&sort=year&query=Northern+Lights&cursor=cursor_abcdefghijklmnop",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("Living Room Jellyfin");
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
    expect(sameOriginMediaPath(null)).toBeUndefined();
    expect(sameOriginMediaPath("https://media.example/poster.jpg")).toBeUndefined();
    expect(sameOriginMediaPath("/untrusted/poster.jpg")).toBeUndefined();
  });
});
