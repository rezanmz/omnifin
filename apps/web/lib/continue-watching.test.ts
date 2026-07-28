import type { ContinueWatchingResponse } from "@omnifin/contracts/dashboard";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContinueWatchingClientError,
  continueWatchingCards,
  continueWatchingClient,
  continueWatchingOutcomeFromError,
} from "./continue-watching";

const feed: ContinueWatchingResponse = {
  failures: [],
  generatedAt: "2026-07-28T05:00:00.000Z",
  items: [
    {
      durationSeconds: 3_600,
      lastPlayedAt: "2026-07-28T04:30:00.000Z",
      media: {
        artwork: {
          accentColor: "#4c7672",
          backdropPath: null,
          blurHash: null,
          posterPath: `/v1/media/media_${"m".repeat(22)}/images/poster`,
        },
        availability: "available",
        contentRating: "TV-14",
        id: `media_${"m".repeat(22)}`,
        kind: "episode",
        overview: null,
        runtimeMinutes: 60,
        subtitle: "S02E03 · The Long Meridian",
        title: "Northern Lights",
        year: 2026,
      },
      positionSeconds: 1_200,
      progressPercent: 33.3,
    },
  ],
  source: {
    connectorId: "jellyfin-main",
    displayName: "Home Jellyfin",
    failure: null,
    status: "healthy",
  },
  state: "complete",
  truncated: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Continue Watching client", () => {
  it("loads and validates the normalized same-origin feed", async () => {
    const fetchMock = vi.fn(async () => Response.json(feed));
    vi.stubGlobal("fetch", fetchMock);

    await expect(continueWatchingClient.load()).resolves.toEqual(feed);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/continue-watching",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    );
  });

  it("fails closed when the gateway response violates the public contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...feed, items: [{ raw: true }] })),
    );

    await expect(continueWatchingClient.load()).rejects.toMatchObject({
      code: "invalid_response",
      kind: "invalid_response",
    });
  });

  it("classifies authentication and service boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(continueWatchingClient.load()).rejects.toMatchObject({ kind: "signed_out" });
    expect(
      continueWatchingOutcomeFromError(
        new ContinueWatchingClientError("forbidden", "permission_denied", "Restricted"),
      ),
    ).toBe("forbidden");
    expect(continueWatchingOutcomeFromError(new Error("offline"))).toBe("unavailable");
  });

  it("maps only opaque, same-origin artwork paths into presentation cards", () => {
    expect(continueWatchingCards(feed)).toEqual([
      {
        accent: "#4c7672",
        artworkPath: `/api/media/media_${"m".repeat(22)}/images/poster`,
        eyebrow: "S02E03 · The Long Meridian",
        id: `media_${"m".repeat(22)}`,
        progress: 0.33299999999999996,
        title: "Northern Lights",
      },
    ]);
    expect(JSON.stringify(continueWatchingCards(feed))).not.toContain("jellyfin-main");
  });
});
