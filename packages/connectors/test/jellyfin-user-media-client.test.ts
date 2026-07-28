import { describe, expect, it } from "vitest";

import { JellyfinUserMediaClient } from "../src/media/jellyfin-user-media-client.js";
import { createMockTransport, jsonResponse, publicResolver } from "./helpers/mock-fetch.js";

function clientWithResponses(responses: Response[]) {
  const mock = createMockTransport(responses);
  return {
    client: new JellyfinUserMediaClient({
      accessToken: "private-access-token",
      deviceId: "installation-1",
      metadata: { appVersion: "1.2.3" },
      target: {
        baseUrl: "https://jellyfin.example.test/base/",
        connectorId: "jellyfin-home",
        displayName: "Home Jellyfin",
        resolveHost: publicResolver,
        transport: mock.transport,
      },
    }),
    requests: mock.requests,
  };
}

const movie = {
  BackdropImageTags: ["backdrop-tag"],
  Id: "movie-upstream-1",
  ImageTags: { Primary: "poster-tag" },
  Name: "The Far Meridian",
  OfficialRating: "PG-13",
  Overview: "A signal\nreaches the edge of known space.",
  ProductionYear: 2026,
  RunTimeTicks: 7_200_000_000,
  Type: "Movie",
  UserData: {
    LastPlayedDate: "2026-07-27T12:00:00.000Z",
    PlaybackPositionTicks: 1_800_000_000,
  },
};

describe("JellyfinUserMediaClient", () => {
  it("reads the inferred user's modern resume feed and normalizes movies", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({ Items: [movie], StartIndex: 0, TotalRecordCount: 1 }),
    ]);

    await expect(client.readContinueWatching()).resolves.toEqual({
      items: [
        {
          artwork: {
            backdrop: { itemId: "movie-upstream-1", type: "Backdrop" },
            poster: { itemId: "movie-upstream-1", type: "Primary" },
          },
          contentRating: "PG-13",
          externalId: "movie-upstream-1",
          kind: "movie",
          lastPlayedAt: "2026-07-27T12:00:00.000Z",
          overview: "A signal reaches the edge of known space.",
          positionSeconds: 180,
          runtimeSeconds: 720,
          subtitle: null,
          title: "The Far Meridian",
          year: 2026,
        },
      ],
      truncated: false,
    });
    expect(requests[0]?.url.pathname).toBe("/base/UserItems/Resume");
    expect(requests[0]?.url.searchParams.get("Limit")).toBe("51");
    expect(requests[0]?.url.searchParams.get("MediaTypes")).toBe("Video");
    expect(requests[0]?.url.searchParams.has("userId")).toBe(false);
    expect(requests[0]?.init.headers.get("authorization")).toBe(
      'MediaBrowser Client="Omnifin", Device="Omnifin Gateway", DeviceId="installation-1", Version="1.2.3", Token="private-access-token"',
    );
  });

  it("uses series context and artwork for resumable episodes", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        Items: [
          {
            Id: "episode-upstream-1",
            IndexNumber: 3,
            Name: "The Long Meridian",
            ParentBackdropImageTags: ["series-backdrop"],
            ParentBackdropItemId: "series-upstream-1",
            ParentIndexNumber: 2,
            RunTimeTicks: 2_700_000_000,
            SeriesId: "series-upstream-1",
            SeriesName: "Northern Lights",
            SeriesPrimaryImageTag: "series-poster",
            Type: "Episode",
            UserData: {
              LastPlayedDate: "2026-07-27T11:00:00.000Z",
              PlaybackPositionTicks: 900_000_000,
            },
          },
        ],
        TotalRecordCount: 1,
      }),
    ]);

    await expect(client.readContinueWatching()).resolves.toEqual({
      items: [
        expect.objectContaining({
          artwork: {
            backdrop: { itemId: "series-upstream-1", type: "Backdrop" },
            poster: { itemId: "series-upstream-1", type: "Primary" },
          },
          externalId: "episode-upstream-1",
          kind: "episode",
          subtitle: "S02E03 · The Long Meridian",
          title: "Northern Lights",
        }),
      ],
      truncated: false,
    });
  });

  it("bounds upstream records and drops completed or zero-position entries", async () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      ...movie,
      Id: `movie-${index}`,
      UserData: {
        ...movie.UserData,
        PlaybackPositionTicks: index === 0 ? 0 : index === 1 ? movie.RunTimeTicks : 1_000_000_000,
      },
    }));
    const { client } = clientWithResponses([jsonResponse({ Items: items, TotalRecordCount: 72 })]);

    const result = await client.readContinueWatching();

    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(48);
    expect(result.items.map((item) => item.externalId)).not.toContain("movie-50");
  });

  it("fails closed on malformed resume data and unsafe tokens", async () => {
    const malformed = clientWithResponses([
      jsonResponse({ Items: [{ ...movie, RunTimeTicks: "7200000000" }] }),
    ]);
    await expect(malformed.client.readContinueWatching()).rejects.toMatchObject({
      code: "response_invalid",
      operation: "media.continue_watching",
    });

    expect(
      () =>
        new JellyfinUserMediaClient({
          accessToken: 'unsafe", DeviceId="injected',
          deviceId: "installation-1",
          target: {
            baseUrl: "https://jellyfin.example.test/",
            connectorId: "jellyfin-home",
            displayName: "Home Jellyfin",
          },
        }),
    ).toThrow(/access token/i);
  });

  it("reads bounded artwork bytes from the authenticated item image endpoint", async () => {
    const image = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
    const { client, requests } = clientWithResponses([
      new Response(image, { headers: { "content-type": "image/jpeg; charset=binary" } }),
    ]);

    await expect(
      client.readImage({ itemId: "series-upstream-1", maxWidth: 1_600, type: "Backdrop" }),
    ).resolves.toEqual({ body: image, contentType: "image/jpeg" });
    expect(requests[0]?.url.pathname).toBe("/base/Items/series-upstream-1/Images/Backdrop");
    expect(requests[0]?.url.searchParams.get("maxWidth")).toBe("1600");
    expect(requests[0]?.url.searchParams.get("quality")).toBe("90");
    expect(requests[0]?.init.headers.get("accept")).toContain("image/avif");
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("rejects unsafe artwork identifiers, dimensions, media types, and empty bodies", async () => {
    const invalidType = clientWithResponses([
      new Response("private-upstream-body", { headers: { "content-type": "text/html" } }),
    ]);
    await expect(
      invalidType.client.readImage({ itemId: "movie-1", maxWidth: 600, type: "Primary" }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.image" });

    const empty = clientWithResponses([
      new Response(new Uint8Array(), { headers: { "content-type": "image/webp" } }),
    ]);
    await expect(
      empty.client.readImage({ itemId: "movie-1", maxWidth: 600, type: "Primary" }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.image" });

    const noRequest = clientWithResponses([]);
    await expect(
      noRequest.client.readImage({
        itemId: "unsafe/item",
        maxWidth: 600,
        type: "Primary",
      }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.image" });
    await expect(
      noRequest.client.readImage({ itemId: "movie-1", maxWidth: 50_000, type: "Primary" }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.image" });
    expect(noRequest.requests).toHaveLength(0);
  });
});
