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
  ImageBlurHashes: { Primary: { "poster-tag": "005?}k" } },
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

const series = {
  BackdropImageTags: ["series-backdrop"],
  Id: "series-upstream-1",
  ImageBlurHashes: { Primary: { "series-poster": "005?}k" } },
  ImageTags: { Primary: "series-poster" },
  MediaType: "Unknown",
  Name: "Northern Lights",
  OfficialRating: "TV-14",
  Overview: "An observatory decodes a signal hidden in the aurora.",
  ProductionYear: 2025,
  RunTimeTicks: null,
  Type: "Series",
  UserData: { Played: false, PlaybackPositionTicks: 0 },
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
            accentColor: "#336699",
            backdrop: { itemId: "movie-upstream-1", type: "Backdrop" },
            blurHash: "005?}k",
            poster: { itemId: "movie-upstream-1", type: "Primary" },
          },
          contentRating: "PG-13",
          episodeNumber: null,
          externalId: "movie-upstream-1",
          kind: "movie",
          lastPlayedAt: "2026-07-27T12:00:00.000Z",
          overview: "A signal reaches the edge of known space.",
          positionSeconds: 180,
          runtimeSeconds: 720,
          seasonNumber: null,
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
    expect(requests[0]?.url.searchParams.get("Fields")?.split(",")).toContain("ImageBlurHashes");
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
            ImageBlurHashes: {
              Backdrop: { "series-backdrop": "00H,-T" },
              Primary: { "series-poster": "005?}k", "unrelated-poster": "001.H." },
            },
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
            accentColor: "#336699",
            backdrop: { itemId: "series-upstream-1", type: "Backdrop" },
            blurHash: "005?}k",
            poster: { itemId: "series-upstream-1", type: "Primary" },
          },
          externalId: "episode-upstream-1",
          episodeNumber: 3,
          kind: "episode",
          seasonNumber: 2,
          subtitle: "S02E03 · The Long Meridian",
          title: "Northern Lights",
        }),
      ],
      truncated: false,
    });
  });

  it("keeps resumable media available when Jellyfin returns a malformed blur hash", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        Items: [
          {
            ...movie,
            ImageBlurHashes: { Primary: { "poster-tag": 42 } },
          },
          {
            ...movie,
            Id: "movie-upstream-2",
            ImageBlurHashes: { Primary: { "poster-tag": "0!5?}k" } },
          },
          {
            ...movie,
            Id: "movie-upstream-3",
            ImageBlurHashes: {
              Primary: { "poster-tag": "}05?}k000000000000000000" },
            },
          },
        ],
        TotalRecordCount: 3,
      }),
    ]);

    await expect(client.readContinueWatching()).resolves.toMatchObject({
      items: [
        { artwork: { accentColor: null, blurHash: null } },
        { artwork: { accentColor: null, blurHash: null } },
        { artwork: { accentColor: null, blurHash: null } },
      ],
    });
  });

  it("tone-maps a dark chromatic average into a usable artwork accent", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        Items: [
          {
            ...movie,
            ImageBlurHashes: { Primary: { "poster-tag": "001.H." } },
          },
        ],
        TotalRecordCount: 1,
      }),
    ]);

    await expect(client.readContinueWatching()).resolves.toMatchObject({
      items: [{ artwork: { accentColor: "#661daf", blurHash: "001.H." } }],
    });
  });

  it("retains a valid neutral blur hash without inventing an artwork accent", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        Items: [
          {
            ...movie,
            ImageBlurHashes: { Primary: { "poster-tag": "00TI,a" } },
          },
        ],
        TotalRecordCount: 1,
      }),
    ]);

    await expect(client.readContinueWatching()).resolves.toMatchObject({
      items: [{ artwork: { accentColor: null, blurHash: "00TI,a" } }],
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

  it("reads a bounded paired-user library without widening the user's Jellyfin scope", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({
        Items: [
          {
            ...movie,
            ImageTags: { Primary: "poster-tag", Thumb: null },
            IndexNumber: null,
            ParentBackdropImageTags: null,
            ParentBackdropItemId: null,
            ParentIndexNumber: null,
            SeriesId: null,
            SeriesName: null,
            SeriesPrimaryImageTag: null,
            UserData: { Played: false, PlaybackPositionTicks: 1_800_000_000 },
          },
          series,
          { ...movie, Id: "hidden-overflow-item" },
        ],
      }),
    ]);

    await expect(
      client.readLibrary({
        kind: "all",
        limit: 2,
        query: "  Meridian  ",
        sort: "recent",
        startIndex: 30,
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          externalId: "movie-upstream-1",
          kind: "movie",
          played: false,
          positionSeconds: 180,
          title: "The Far Meridian",
        }),
        expect.objectContaining({
          externalId: "series-upstream-1",
          kind: "series",
          played: false,
          positionSeconds: 0,
          runtimeSeconds: null,
          title: "Northern Lights",
        }),
      ],
      nextStartIndex: 32,
      truncated: true,
    });
    expect(requests[0]?.url.pathname).toBe("/base/Users/paired-user-id/Items");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({
      EnableTotalRecordCount: "false",
      EnableUserData: "true",
      IncludeItemTypes: "Movie,Series",
      IsMissing: "false",
      IsVirtualItem: "false",
      Limit: "3",
      Recursive: "true",
      SearchTerm: "Meridian",
      SortBy: "DateCreated",
      SortOrder: "Descending",
      StartIndex: "30",
    });
    expect(requests[0]?.url.searchParams.has("api_key")).toBe(false);
    expect(requests[0]?.url.searchParams.has("MediaTypes")).toBe(false);
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("keeps Jellyfin series catalogue items whose media type is Unknown", async () => {
    const { client, requests } = clientWithResponses([jsonResponse({ Items: [series] })]);

    await expect(
      client.readLibrary({
        kind: "series",
        limit: 30,
        sort: "title",
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      items: [{ externalId: "series-upstream-1", kind: "series", title: "Northern Lights" }],
      nextStartIndex: null,
      truncated: false,
    });
    expect(requests[0]?.url.searchParams.get("IncludeItemTypes")).toBe("Series");
    expect(requests[0]?.url.searchParams.has("MediaTypes")).toBe(false);
  });

  it("uses exact library type and sorting allowlists and fails closed on version drift", async () => {
    const movieClient = clientWithResponses([
      jsonResponse({
        Items: [
          {
            ...movie,
            ProductionYear: 0,
            UserData: { Played: null, PlaybackPositionTicks: null },
          },
          { ...movie, Id: "runtime-missing", RunTimeTicks: null },
        ],
      }),
    ]);
    await expect(
      movieClient.client.readLibrary({
        kind: "movies",
        limit: 30,
        sort: "title",
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          played: false,
          positionSeconds: 0,
          year: null,
        }),
      ],
      nextStartIndex: null,
      truncated: false,
    });
    expect(movieClient.requests[0]?.url.searchParams.get("IncludeItemTypes")).toBe("Movie");
    expect(movieClient.requests[0]?.url.searchParams.has("MediaTypes")).toBe(false);
    expect(movieClient.requests[0]?.url.searchParams.get("SortBy")).toBe("SortName");
    expect(movieClient.requests[0]?.url.searchParams.get("SortOrder")).toBe("Ascending");

    const malformed = clientWithResponses([
      jsonResponse({ Items: [{ ...movie, Type: "Episode" }] }),
    ]);
    await expect(
      malformed.client.readLibrary({
        kind: "all",
        limit: 30,
        sort: "year",
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.library" });
    await expect(
      movieClient.client.readLibrary({
        kind: "all",
        limit: 51,
        sort: "recent",
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).rejects.toBeDefined();
  });

  it("reads normalized series seasons and paged episodes without leaking scope", async () => {
    const episode = {
      CommunityRating: 8.4,
      CriticRating: 91,
      Genres: ["Drama", "Science fiction", "Drama"],
      Id: "episode-upstream-1",
      ImageBlurHashes: { Primary: { "episode-still": "005?}k" } },
      ImageTags: { Primary: "episode-still" },
      IndexNumber: 3,
      Name: "The Long Meridian",
      ParentBackdropImageTags: ["series-backdrop"],
      ParentBackdropItemId: "series-upstream-1",
      ParentIndexNumber: 2,
      People: [
        { Name: "Mara Voss", Role: "Dr. Elian Vale", Type: "Actor" },
        { Name: "Ari Chen", Type: "Writer" },
        ...Array.from({ length: 24 }, (_, index) => ({
          Name: `Guest ${index + 1}`,
          Role: `Guest role ${index + 1}`,
          Type: "GuestStar",
        })),
      ],
      PremiereDate: "2025-02-14T00:00:00.0000000Z",
      ProductionYear: 2025,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      SeriesPrimaryImageTag: "series-poster",
      Studios: [{ Name: "Northlight Pictures" }, { Name: "Northlight Pictures" }],
      Type: "Episode",
      UserData: { Played: false, PlaybackPositionTicks: 900_000_000 },
    };
    const { client, requests } = clientWithResponses([
      jsonResponse(series),
      jsonResponse({
        Items: [
          {
            ChildCount: 8,
            Id: "season-upstream-2",
            IndexNumber: 2,
            Name: "Season 2",
            RecursiveItemCount: 8,
            Type: "Season",
            UserData: { Played: false, UnplayedItemCount: 5 },
          },
        ],
      }),
      jsonResponse({
        Items: [
          episode,
          {
            ...episode,
            CommunityRating: 11,
            CriticRating: -1,
            Genres: ["", "Drama"],
            Id: "episode-upstream-2",
            IndexNumber: 4,
            People: [{ Name: "", Role: "", Type: "Actor" }],
            Studios: [{ Name: "" }],
          },
          { ...episode, Id: "episode-upstream-3", IndexNumber: 5 },
        ],
      }),
    ]);

    await expect(
      client.readLibraryTitle({ itemId: "series-upstream-1", userId: "paired-user-id" }),
    ).resolves.toMatchObject({
      item: { externalId: "series-upstream-1", kind: "series", runtimeSeconds: null },
      seasons: [{ episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 2, title: "Season 2" }],
      seasonsTruncated: false,
    });
    const episodes = await client.readLibrarySeasonEpisodes({
      limit: 2,
      seasonNumber: 2,
      seriesId: "series-upstream-1",
      startIndex: 0,
      userId: "paired-user-id",
    });
    expect(episodes.items[0]).toMatchObject({
      airDate: "2025-02-14",
      artwork: { poster: { itemId: "episode-upstream-1", type: "Primary" } },
      communityRating: 8.4,
      creditsTruncated: true,
      criticRating: 91,
      externalId: "episode-upstream-1",
      genres: ["Drama", "Science fiction"],
      kind: "episode",
      positionSeconds: 90,
      seasonNumber: 2,
      studios: ["Northlight Pictures"],
      title: "The Long Meridian",
    });
    expect(episodes.items[0]?.credits).toHaveLength(24);
    expect(episodes.items[0]?.credits.slice(0, 2)).toEqual([
      { name: "Mara Voss", role: "Dr. Elian Vale", type: "cast" },
      { name: "Ari Chen", role: null, type: "writer" },
    ]);
    expect(episodes.items[1]).toMatchObject({
      communityRating: null,
      credits: [],
      criticRating: null,
      genres: ["Drama"],
      studios: [],
    });
    expect(episodes).toMatchObject({ nextStartIndex: 2, truncated: true });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/base/Items/series-upstream-1",
      "/base/Shows/series-upstream-1/Seasons",
      "/base/Shows/series-upstream-1/Episodes",
    ]);
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toMatchObject({
      Limit: "101",
      SortBy: "IndexNumber",
      SortOrder: "Ascending",
      UserId: "paired-user-id",
    });
    expect(Object.fromEntries(requests[2]!.url.searchParams)).toMatchObject({
      Fields: expect.stringContaining("People"),
      IsMissing: "false",
      Limit: "3",
      Season: "2",
      StartIndex: "0",
      UserId: "paired-user-id",
    });
    expect(requests.every(({ url }) => !url.searchParams.has("api_key"))).toBe(true);
  });

  it("derives season progress when Jellyfin omits aggregate episode counts", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse(series),
      jsonResponse({
        Items: [
          {
            Id: "season-upstream-1",
            IndexNumber: 1,
            Name: "Season 1",
            Type: "Season",
            UserData: { Played: true, UnplayedItemCount: 0 },
          },
          {
            Id: "season-upstream-2",
            IndexNumber: 2,
            Name: "Season 2",
            Type: "Season",
            UserData: { Played: false, UnplayedItemCount: 2 },
          },
        ],
      }),
      jsonResponse({
        Items: [{ Id: "episode-upstream-1", Type: "Episode", UserData: { Played: true } }],
        TotalRecordCount: 10,
      }),
      jsonResponse({
        Items: [{ Id: "episode-upstream-11", Type: "Episode", UserData: { Played: true } }],
        TotalRecordCount: 10,
      }),
    ]);

    await expect(
      client.readLibraryTitle({ itemId: "series-upstream-1", userId: "paired-user-id" }),
    ).resolves.toMatchObject({
      seasons: [
        { episodeCount: 10, playedEpisodeCount: 10, seasonNumber: 1 },
        { episodeCount: 10, playedEpisodeCount: 8, seasonNumber: 2 },
      ],
    });
    expect(requests).toHaveLength(4);
    for (const [index, season] of ["1", "2"].entries()) {
      expect(requests[index + 2]?.url.pathname).toBe("/base/Shows/series-upstream-1/Episodes");
      expect(Object.fromEntries(requests[index + 2]!.url.searchParams)).toMatchObject({
        EnableImages: "false",
        EnableUserData: "true",
        IsMissing: "false",
        Limit: "51",
        Season: season,
        StartIndex: "0",
        UserId: "paired-user-id",
      });
    }
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
