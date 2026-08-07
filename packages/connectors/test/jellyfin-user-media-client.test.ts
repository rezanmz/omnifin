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
  it("deletes one exact item through the paired user's authenticated endpoint", async () => {
    const { client, requests } = clientWithResponses([new Response(null, { status: 204 })]);

    await client.deleteLibraryItem("movie-upstream-1");

    expect(requests[0]?.url.pathname).toBe("/base/Items/movie-upstream-1");
    expect(requests[0]?.url.search).toBe("");
    expect(requests[0]?.init.method).toBe("DELETE");
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("rejects a non-canonical deletion target before issuing a request", async () => {
    const { client, requests } = clientWithResponses([]);

    await expect(client.deleteLibraryItem("../another-title")).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("rejects an unexpected successful status for item deletion", async () => {
    const { client } = clientWithResponses([new Response("accepted", { status: 200 })]);

    await expect(client.deleteLibraryItem("movie-upstream-1")).rejects.toMatchObject({
      code: "response_invalid",
      operation: "library.removal.file_delete",
    });
  });

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

  it("reads bounded private viewing history with current Jellyfin state", async () => {
    const completedMovie = {
      ...movie,
      UserData: {
        LastPlayedDate: "2026-07-27T12:00:00.000Z",
        Played: true,
        PlaybackPositionTicks: 0,
      },
    };
    const episode = {
      Id: "episode-upstream-1",
      ImageTags: { Primary: "episode-still" },
      IndexNumber: 3,
      Name: "The Long Meridian",
      ParentIndexNumber: 2,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      SeriesPrimaryImageTag: "series-poster",
      Type: "Episode",
      UserData: {
        LastPlayedDate: "2026-07-26T11:00:00.000Z",
        Played: false,
        PlaybackPositionTicks: 900_000_000,
      },
    };
    const { client, requests } = clientWithResponses([
      jsonResponse({
        Items: [completedMovie, episode, { ...completedMovie, Id: "movie-upstream-2" }],
      }),
    ]);

    await expect(
      client.readViewingHistory({
        kind: "all",
        limit: 2,
        state: "all",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({
      boundaryFound: true,
      items: [
        expect.objectContaining({
          externalId: "movie-upstream-1",
          kind: "movie",
          lastPlayedAt: "2026-07-27T12:00:00.000Z",
          played: true,
          positionSeconds: 0,
        }),
        expect.objectContaining({
          externalId: "episode-upstream-1",
          kind: "episode",
          played: false,
          positionSeconds: 90,
          subtitle: "S02E03 · The Long Meridian",
          title: "Northern Lights",
        }),
      ],
      nextAfterItemId: "episode-upstream-1",
    });
    expect(requests[0]?.url.pathname).toBe("/base/Users/paired-user-id/Items");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({
      EnableUserData: "true",
      IncludeItemTypes: "Movie,Episode",
      Limit: "100",
      Recursive: "true",
      SortBy: "DatePlayed",
      SortOrder: "Descending",
      StartIndex: "0",
    });
    expect(requests[0]?.url.searchParams.has("Filters")).toBe(false);
    expect(requests[0]?.url.searchParams.has("api_key")).toBe(false);
  });

  it("continues after an opaque cursor boundary even when newer activity arrives", async () => {
    const historyMovie = (id: string, playedAt: string) => ({
      ...movie,
      Id: id,
      UserData: { LastPlayedDate: playedAt, Played: true, PlaybackPositionTicks: 0 },
    });
    const { client } = clientWithResponses([
      jsonResponse({
        Items: [
          historyMovie("newer-upstream", "2026-07-28T12:00:00.000Z"),
          historyMovie("cursor-upstream", "2026-07-27T12:00:00.000Z"),
          historyMovie("older-upstream", "2026-07-26T12:00:00.000Z"),
        ],
      }),
    ]);

    await expect(
      client.readViewingHistory({
        afterItemId: "cursor-upstream",
        kind: "movies",
        limit: 20,
        state: "completed",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      boundaryFound: true,
      items: [{ externalId: "older-upstream" }],
      nextAfterItemId: null,
    });
  });

  it("applies history state, type, and date filters without trusting upstream filtering", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({
        Items: [
          {
            ...movie,
            Id: "unexpected-resume",
            UserData: {
              LastPlayedDate: "2026-07-27T13:00:00.000Z",
              Played: false,
              PlaybackPositionTicks: 900_000_000,
            },
          },
          {
            ...movie,
            Id: "completed-upstream",
            UserData: {
              LastPlayedDate: "2026-07-27T12:00:00.000Z",
              Played: true,
              PlaybackPositionTicks: 0,
            },
          },
          {
            ...movie,
            Id: "too-old-upstream",
            UserData: {
              LastPlayedDate: "2026-06-01T12:00:00.000Z",
              Played: true,
              PlaybackPositionTicks: 0,
            },
          },
        ],
      }),
    ]);

    await expect(
      client.readViewingHistory({
        kind: "movies",
        limit: 20,
        since: "2026-07-01T00:00:00.000Z",
        state: "completed",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({ items: [{ externalId: "completed-upstream" }] });
    expect(requests[0]?.url.searchParams.get("Filters")).toBe("IsPlayed");
    expect(requests[0]?.url.searchParams.get("IncludeItemTypes")).toBe("Movie");

    const missingBoundary = clientWithResponses([jsonResponse({ Items: [] })]);
    await expect(
      missingBoundary.client.readViewingHistory({
        afterItemId: "gone-upstream",
        kind: "episodes",
        limit: 20,
        state: "in_progress",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({ boundaryFound: false, items: [], nextAfterItemId: null });
    expect(missingBoundary.requests[0]?.url.searchParams.get("Filters")).toBe("IsResumable");
    expect(missingBoundary.requests[0]?.url.searchParams.get("IncludeItemTypes")).toBe("Episode");
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
        TotalRecordCount: 46,
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
      totalResults: 46,
      truncated: true,
    });
    expect(requests[0]?.url.pathname).toBe("/base/Users/paired-user-id/Items");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({
      EnableTotalRecordCount: "true",
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
    const { client, requests } = clientWithResponses([
      jsonResponse({ Items: [series], TotalRecordCount: 1 }),
    ]);

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
      totalResults: 1,
      truncated: false,
    });
    expect(requests[0]?.url.searchParams.get("IncludeItemTypes")).toBe("Series");
    expect(requests[0]?.url.searchParams.has("MediaTypes")).toBe(false);
  });

  it("keeps older Jellyfin catalogues usable when an exact total is omitted", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        Items: [movie, series, { ...movie, Id: "overflow-item" }],
      }),
    ]);

    await expect(
      client.readLibrary({
        kind: "all",
        limit: 2,
        sort: "title",
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ externalId: "movie-upstream-1" }),
        expect.objectContaining({ externalId: "series-upstream-1" }),
      ],
      nextStartIndex: 2,
      totalResults: null,
      truncated: true,
    });
  });

  it("keeps a valid catalogue page when an older Jellyfin reports an incoherent total", async () => {
    const { client } = clientWithResponses([jsonResponse({ Items: [movie], TotalRecordCount: 0 })]);

    await expect(
      client.readLibrary({
        kind: "movies",
        limit: 30,
        sort: "title",
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ externalId: "movie-upstream-1" })],
      nextStartIndex: null,
      totalResults: null,
      truncated: false,
    });
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
        TotalRecordCount: 2,
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
      totalResults: 2,
      truncated: false,
    });
    expect(movieClient.requests[0]?.url.searchParams.get("IncludeItemTypes")).toBe("Movie");
    expect(movieClient.requests[0]?.url.searchParams.has("MediaTypes")).toBe(false);
    expect(movieClient.requests[0]?.url.searchParams.get("SortBy")).toBe("SortName");
    expect(movieClient.requests[0]?.url.searchParams.get("SortOrder")).toBe("Ascending");

    const malformed = clientWithResponses([
      jsonResponse({ Items: [{ ...movie, Type: "Episode" }], TotalRecordCount: 1 }),
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

  it.each([
    { response: { Items: [], TotalRecordCount: -1 }, title: "a negative total" },
    { response: { Items: [], TotalRecordCount: 1.5 }, title: "a fractional total" },
    {
      response: { Items: [], TotalRecordCount: 10_000_001 },
      title: "an implausibly large total",
    },
  ])("rejects $title", async ({ response }) => {
    const { client } = clientWithResponses([jsonResponse(response)]);

    await expect(
      client.readLibrary({
        kind: "all",
        limit: 30,
        sort: "recent",
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.library" });
  });

  it("normalizes bounded movie metadata and owned media without exposing filenames or paths", async () => {
    const people = [
      {
        Id: "person-upstream-1",
        Name: "Mara Voss",
        PrimaryImageTag: "person-image-tag",
        Role: "Elian Vale",
        Type: "Actor",
      },
      {
        Id: "person-upstream-2",
        Name: "Mara Voss",
        Role: "Alternate Elian Vale",
        Type: "Actor",
      },
      { Name: "Jon Bell", Type: "Director" },
      { Name: "Ari Chen", Type: "Writer" },
      { Name: "Nia Rao", Type: "Producer" },
      ...Array.from({ length: 24 }, (_, index) => ({
        Name: `Guest ${index + 1}`,
        Role: `Guest role ${index + 1}`,
        Type: "Actor",
      })),
    ];
    const { client, requests } = clientWithResponses([
      jsonResponse({
        ...movie,
        CanDelete: true,
        CommunityRating: 8.4,
        CriticRating: 91,
        Genres: ["Drama", "Science fiction", "Drama"],
        MediaSources: [
          {
            Bitrate: 9_250_000,
            Container: "mkv",
            MediaStreams: [
              {
                BitDepth: 10,
                BitRate: 8_700_000,
                Codec: "hevc",
                Height: 1_606,
                Profile: "Main 10",
                Type: "Video",
                VideoRangeType: "HDR10",
                Width: 3_840,
              },
              {
                BitRate: 640_000,
                Channels: 6,
                Codec: "eac3",
                Language: "eng",
                Title: "English 5.1",
                Type: "Audio",
              },
              {
                Codec: "subrip",
                IsDefault: true,
                IsForced: false,
                Language: "eng",
                Type: "Subtitle",
              },
              { Codec: "mjpeg", Type: "EmbeddedImage" },
            ],
            Name: "/private/library/The Far Meridian.mkv",
            Path: "/private/library/The Far Meridian.mkv",
            Size: 6_979_321_856,
          },
        ],
        People: people,
        PremiereDate: "2026-04-18T00:00:00.0000000Z",
        ProviderIds: {
          Imdb: "tt1234567",
          RottenTomatoes: "https://www.rottentomatoes.com/m/the_far_meridian",
          Tmdb: "98765",
        },
        Studios: [{ Name: "Northlight Pictures" }, { Name: "Northlight Pictures" }],
        Taglines: ["The horizon remembers."],
      }),
      jsonResponse({
        Items: [
          {
            Id: "person-upstream-1",
            Name: "Mara Voss",
            ProviderIds: { Tmdb: "12345" },
            Type: "Person",
          },
          {
            Id: "person-upstream-2",
            Name: "Mara Voss",
            ProviderIds: { tmdb: "54321" },
            Type: "Person",
          },
        ],
      }),
    ]);

    const detail = await client.readLibraryTitle({
      itemId: "movie-upstream-1",
      userId: "paired-user-id",
    });

    expect(detail.item).toMatchObject({ externalId: "movie-upstream-1", kind: "movie" });
    expect(detail.removal).toEqual({
      canDelete: true,
      providerIds: { imdb: "tt1234567", tmdb: 98_765 },
      sizeBytes: 6_979_321_856,
    });
    expect(detail.movie).toMatchObject({
      castTruncated: true,
      communityRating: 8.4,
      crew: [
        expect.objectContaining({ name: "Jon Bell", type: "director" }),
        expect.objectContaining({ name: "Ari Chen", type: "writer" }),
        expect.objectContaining({ name: "Nia Rao", type: "producer" }),
      ],
      criticRating: 91,
      genres: ["Drama", "Science fiction"],
      mediaSources: [
        {
          audio: [
            {
              bitrateKbps: 640,
              channels: 6,
              codec: "E-AC-3",
              language: "eng",
              title: "English 5.1",
            },
          ],
          audioTruncated: false,
          bitrateKbps: 9_250,
          container: "MKV",
          label: "4K · HEVC · MKV",
          sizeBytes: 6_979_321_856,
          subtitles: [
            { codec: "SUBRIP", default: true, forced: false, language: "eng", title: null },
          ],
          subtitlesTruncated: false,
          video: {
            bitrateKbps: 8_700,
            bitDepth: 10,
            codec: "HEVC",
            hdrFormat: "HDR10",
            height: 1_606,
            profile: "Main 10",
            width: 3_840,
          },
        },
      ],
      premiereDate: "2026-04-18",
      studios: ["Northlight Pictures"],
      tagline: "The horizon remembers.",
    });
    expect(detail.movie?.cast).toHaveLength(24);
    expect(detail.providerReferences).toEqual([
      { identifier: "tt1234567", mediaKind: "movie", provider: "imdb" },
      { identifier: 98_765, mediaKind: "movie", provider: "tmdb" },
      {
        identifier: "the_far_meridian",
        mediaKind: "movie",
        provider: "rotten_tomatoes",
      },
    ]);
    expect(detail.movie?.cast[0]).toMatchObject({
      image: { itemId: "person-upstream-1", type: "Primary" },
      imagePath: null,
      name: "Mara Voss",
      person: { itemId: "person-upstream-1", tmdbId: 12_345 },
      personItemId: "person-upstream-1",
      personReferenceId: null,
      role: "Elian Vale",
      type: "cast",
    });
    expect(detail.movie?.cast[1]).toMatchObject({
      name: "Mara Voss",
      person: { itemId: "person-upstream-2", tmdbId: 54_321 },
      role: "Alternate Elian Vale",
    });
    expect(JSON.stringify(detail)).not.toMatch(/private\/library|The Far Meridian\.mkv/u);
    expect(requests[0]?.url.searchParams.get("Fields")).toContain("MediaSources");
    expect(requests[0]?.url.searchParams.get("UserId")).toBe("paired-user-id");
    expect(requests[1]?.url.pathname).toBe("/base/Items");
    expect(requests[1]?.url.searchParams.get("Ids")).toBe("person-upstream-1,person-upstream-2");
    expect(requests[1]?.url.searchParams.get("Fields")).toBe("ProviderIds");
  });

  it("keeps movie playback available when optional rich metadata is malformed", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        ...movie,
        CommunityRating: "unknown",
        Genres: [{ unsafe: true }],
        MediaSources: [{ MediaStreams: "invalid" }],
        People: 42,
        PremiereDate: { invalid: true },
        ProviderIds: {
          Imdb: "https://private.invalid/title/tt1234567",
          RottenTomatoes: "https://www.rottentomatoes.com.evil.invalid/m/private",
          Tmdb: "../../private",
        },
        Studios: ["invalid"],
        Taglines: "invalid",
      }),
    ]);

    await expect(
      client.readLibraryTitle({ itemId: "movie-upstream-1", userId: "paired-user-id" }),
    ).resolves.toMatchObject({
      item: { externalId: "movie-upstream-1", kind: "movie", runtimeSeconds: 720 },
      movie: {
        cast: [],
        communityRating: null,
        genres: [],
        mediaSources: [],
        premiereDate: null,
        studios: [],
        tagline: null,
      },
      providerReferences: [],
      removal: {
        canDelete: false,
        providerIds: { imdb: null, tmdb: null },
        sizeBytes: null,
      },
    });
  });

  it("resolves a library person only through an exact Jellyfin ID and reviewed TMDB identity", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({
        Id: "person-upstream-1",
        Name: "Mara Voss",
        ProviderIds: { TmDb: "12345" },
        Type: "Person",
      }),
    ]);

    await expect(
      client.readLibraryPerson({ itemId: "person-upstream-1", userId: "paired-user-id" }),
    ).resolves.toEqual({ itemId: "person-upstream-1", name: "Mara Voss", tmdbId: 12_345 });
    expect(requests[0]?.url.pathname).toBe("/base/Items/person-upstream-1");
    expect(requests[0]?.url.searchParams.get("Fields")).toBe("ProviderIds");
    expect(requests[0]?.url.searchParams.get("UserId")).toBe("paired-user-id");
  });

  it("rejects a person response without a trustworthy TMDB bridge", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        Id: "person-upstream-1",
        Name: "Mara Voss",
        ProviderIds: { Imdb: "nm0000001" },
        Type: "Person",
      }),
    ]);

    await expect(
      client.readLibraryPerson({ itemId: "person-upstream-1", userId: "paired-user-id" }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.library.people" });
  });

  it("revalidates and range-streams downloadable originals without exposing source paths", async () => {
    const original = new Uint8Array([2, 3, 4, 5]);
    const { client, requests } = clientWithResponses([
      jsonResponse({
        ...movie,
        CanDownload: true,
        Etag: "private-source-version",
        MediaSources: [
          { Container: "mp4", Id: "alternate-source", Size: 1_000 },
          {
            Container: "mkv",
            Id: "movie-upstream-1",
            MediaStreams: [{ Height: 0, Type: "Subtitle", Width: 0 }],
            Size: 50_000_000_000,
          },
        ],
        Path: "/private/library/The Far Meridian.mkv",
      }),
      new Response(original, {
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(original.byteLength),
          "content-range": "bytes 2-5/50000000000",
          "content-type": "video/x-matroska",
        },
        status: 206,
      }),
    ]);

    const metadata = await client.readOriginalDownloadMetadata({
      itemId: "movie-upstream-1",
      userId: "paired-user-id",
    });
    expect(metadata).toEqual({
      canDownload: true,
      container: "mkv",
      etag: "private-source-version",
      externalId: "movie-upstream-1",
      sizeBytes: 50_000_000_000,
      title: "The Far Meridian",
      year: 2026,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/private\/library|\.mkv/iu);

    const transfer = await client.streamOriginalDownload({
      itemId: "movie-upstream-1",
      maxResponseBytes: 50_000_000_000,
      range: "bytes=2-5",
    });
    await expect(new Response(transfer.body).arrayBuffer()).resolves.toEqual(original.buffer);
    expect(transfer).toMatchObject({
      acceptRanges: true,
      contentLength: 4,
      contentRange: "bytes 2-5/50000000000",
      contentType: "video/x-matroska",
      status: 206,
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/base/Items/movie-upstream-1",
      "/base/Items/movie-upstream-1/Download",
    ]);
    expect(requests[0]?.url.searchParams.get("UserId")).toBe("paired-user-id");
    expect(requests[1]?.init.headers.get("range")).toBe("bytes=2-5");
    expect(requests[1]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("keeps download denial and unsatisfied ranges explicit", async () => {
    const denied = clientWithResponses([
      jsonResponse({
        ...movie,
        CanDownload: false,
        Container: "mp4",
        Etag: "private-denied-version",
        MediaSources: [{ Container: "mp4", Id: "movie-upstream-1", Size: 9_000 }],
      }),
    ]);
    await expect(
      denied.client.readOriginalDownloadMetadata({
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({ canDownload: false });

    const unsatisfied = clientWithResponses([
      new Response(null, {
        headers: { "content-range": "bytes */9000" },
        status: 416,
      }),
    ]);
    await expect(
      unsatisfied.client.streamOriginalDownload({
        itemId: "movie-upstream-1",
        maxResponseBytes: 9_000,
        range: "bytes=9000-",
      }),
    ).resolves.toMatchObject({
      contentLength: null,
      contentRange: "bytes */9000",
      status: 416,
    });
    await expect(
      unsatisfied.client.streamOriginalDownload({
        itemId: "movie-upstream-1",
        maxResponseBytes: 9_000,
        range: "bytes=4-2",
      }),
    ).rejects.toBeDefined();
    expect(unsatisfied.requests).toHaveLength(1);
  });

  it("permits original episode files while preserving useful series coordinates", async () => {
    const episodeDownload = clientWithResponses([
      jsonResponse({
        CanDownload: true,
        Container: "mkv",
        Etag: "private-episode-version",
        Id: "episode-upstream-1",
        IndexNumber: 3,
        MediaSources: [
          {
            Container: "mkv",
            Id: "episode-upstream-1",
            MediaStreams: [{ Height: 0, Type: "Subtitle", Width: 0 }],
            Size: 1_250_000_000,
          },
        ],
        Name: "The Long Meridian",
        ParentIndexNumber: 2,
        ProductionYear: 2026,
        SeriesName: "Northern Lights",
        Type: "Episode",
      }),
    ]);

    await expect(
      episodeDownload.client.readOriginalDownloadMetadata({
        itemId: "episode-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({
      canDownload: true,
      container: "mkv",
      etag: "private-episode-version",
      externalId: "episode-upstream-1",
      sizeBytes: 1_250_000_000,
      title: "Northern Lights - S02E03 · The Long Meridian",
      year: 2026,
    });
    expect(JSON.stringify(episodeDownload.requests)).not.toContain("private-episode-version");
  });

  it("rejects malformed required original download source metadata", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        ...movie,
        CanDownload: true,
        MediaSources: [{ Container: "mkv", Id: "movie-upstream-1", Size: "50000000000" }],
      }),
    ]);

    await expect(
      client.readOriginalDownloadMetadata({
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).rejects.toMatchObject({
      code: "response_invalid",
      operation: "media.original_download.metadata",
    });
  });

  it("reads parent-scoped local extras and normalizes every reviewed Jellyfin type", async () => {
    const extra = (id: string, ExtraType: string) => ({
      BackdropImageTags: [`${id}-backdrop`],
      ExtraType,
      Id: id,
      ImageTags: { Primary: `${id}-poster` },
      Name: `Extra ${id}`,
      Overview: `A local ${ExtraType} bonus video.`,
      ProductionYear: 2026,
      RunTimeTicks: 600_000_000,
      Type: "Video",
      UserData: { Played: false, PlaybackPositionTicks: 120_000_000 },
    });
    const { client, requests } = clientWithResponses([
      jsonResponse([extra("trailer-1", "Unknown")]),
      jsonResponse([
        extra("clip-1", "Clip"),
        extra("behind-1", "BehindTheScenes"),
        extra("deleted-1", "DeletedScene"),
        extra("interview-1", "Interview"),
        extra("scene-1", "Scene"),
        extra("sample-1", "Sample"),
        extra("featurette-1", "Featurette"),
        extra("short-1", "Short"),
        extra("other-1", "Unknown"),
        { ...extra("audio-1", "ThemeSong"), Type: "Audio" },
      ]),
      jsonResponse({ ProviderIds: { Tmdb: "1042" } }),
    ]);

    const result = await client.readLibraryExtras({
      itemId: "movie-upstream-1",
      limit: 24,
      startIndex: 0,
      userId: "paired-user-id",
    });

    expect(result.items.map(({ extraType }) => extraType)).toEqual([
      "trailer",
      "clip",
      "featurette",
      "behind_the_scenes",
      "deleted_scene",
      "interview",
      "scene",
      "sample",
      "short",
      "other",
    ]);
    expect(result.items[0]).toMatchObject({
      artwork: {
        backdrop: { itemId: "trailer-1", type: "Backdrop" },
        poster: { itemId: "trailer-1", type: "Primary" },
      },
      externalId: "trailer-1",
      positionSeconds: 12,
      runtimeSeconds: 60,
      year: 2026,
    });
    expect(result.catalogTmdbId).toBe(1_042);
    expect(result.nextStartIndex).toBeNull();
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/base/Items/movie-upstream-1/LocalTrailers",
      "/base/Items/movie-upstream-1/SpecialFeatures",
      "/base/Items/movie-upstream-1",
    ]);
    expect(requests.every(({ url }) => url.searchParams.get("UserId") === "paired-user-id")).toBe(
      true,
    );
  });

  it("keeps available special features when the optional local-trailer endpoint is absent", async () => {
    const { client } = clientWithResponses([
      jsonResponse({ error: "not found" }, { status: 404 }),
      jsonResponse([
        {
          ExtraType: "Featurette",
          Id: "featurette-1",
          Name: "Making the Meridian",
          RunTimeTicks: 600_000_000,
          Type: "Video",
        },
      ]),
    ]);

    await expect(
      client.readLibraryExtras({
        itemId: "movie-upstream-1",
        limit: 12,
        startIndex: 0,
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      items: [{ externalId: "featurette-1", extraType: "featurette" }],
      nextStartIndex: null,
    });
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
      jsonResponse({
        ...series,
        People: [
          {
            Id: "series-person-upstream-1",
            Name: "Mara Voss",
            Role: "Dr. Elian Vale",
            Type: "Actor",
          },
        ],
        ProviderIds: {
          Imdb: "tt0903747",
          RottenTomatoes: "breaking_bad",
          Tmdb: "1396",
        },
      }),
      jsonResponse({
        Items: [
          {
            Id: "series-person-upstream-1",
            Name: "Mara Voss",
            ProviderIds: { Tmdb: "12345" },
            Type: "Person",
          },
        ],
      }),
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
      providerReferences: [
        { identifier: "tt0903747", mediaKind: "series", provider: "imdb" },
        { identifier: 1396, mediaKind: "series", provider: "tmdb" },
        {
          identifier: "breaking_bad",
          mediaKind: "series",
          provider: "rotten_tomatoes",
        },
      ],
      seasons: [{ episodeCount: 8, playedEpisodeCount: 3, seasonNumber: 2, title: "Season 2" }],
      seasonsTruncated: false,
      seriesCredits: {
        cast: [
          expect.objectContaining({
            name: "Mara Voss",
            person: { itemId: "series-person-upstream-1", tmdbId: 12_345 },
          }),
        ],
      },
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
      {
        name: "Mara Voss",
        person: null,
        personItemId: null,
        personReferenceId: null,
        role: "Dr. Elian Vale",
        type: "cast",
      },
      {
        name: "Ari Chen",
        person: null,
        personItemId: null,
        personReferenceId: null,
        role: null,
        type: "writer",
      },
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
      "/base/Items",
      "/base/Shows/series-upstream-1/Seasons",
      "/base/Shows/series-upstream-1/Episodes",
    ]);
    expect(Object.fromEntries(requests[2]!.url.searchParams)).toMatchObject({
      Limit: "101",
      SortBy: "IndexNumber",
      SortOrder: "Ascending",
      UserId: "paired-user-id",
    });
    expect(Object.fromEntries(requests[3]!.url.searchParams)).toMatchObject({
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

  it("reads trusted playback markers and the canonical next episode", async () => {
    const currentEpisode = {
      Id: "episode-upstream-1",
      IndexNumber: 2,
      Name: "Aperture",
      ParentIndexNumber: 1,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const nextEpisode = {
      ...currentEpisode,
      Id: "episode-upstream-2",
      ImageTags: { Primary: "next-still" },
      IndexNumber: 3,
      Name: "The Long Meridian",
      UserData: { Played: false, PlaybackPositionTicks: 0 },
    };
    const { client, requests } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({
        Items: [
          {
            EndTicks: 860_000_000,
            Id: "segment-intro-1",
            ItemId: "episode-upstream-1",
            StartTicks: 40_000_000,
            Type: "Intro",
          },
          {
            EndTicks: 2_690_000_000,
            Id: "segment-outro-1",
            ItemId: "episode-upstream-1",
            StartTicks: 2_610_000_000,
            Type: "Outro",
          },
        ],
        StartIndex: 0,
        TotalRecordCount: 2,
      }),
      jsonResponse({ Items: [nextEpisode], StartIndex: 1, TotalRecordCount: 2 }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({
      current: {
        durationSeconds: 270,
        episodeNumber: 2,
        seasonNumber: 1,
        seriesId: "series-upstream-1",
      },
      nextEpisode: {
        artwork: {
          accentColor: null,
          backdrop: null,
          blurHash: null,
          poster: { itemId: "episode-upstream-2", type: "Primary" },
        },
        durationSeconds: 270,
        externalId: "episode-upstream-2",
        episodeNumber: 3,
        seasonNumber: 1,
        seriesTitle: "Northern Lights",
        title: "The Long Meridian",
        year: null,
      },
      nextState: "ready",
      segments: [
        { endSeconds: 86, kind: "intro", startSeconds: 4 },
        { endSeconds: 269, kind: "credits", startSeconds: 261 },
      ],
      segmentsState: "ready",
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/base/Items/episode-upstream-1",
      "/base/MediaSegments/episode-upstream-1",
      "/base/Shows/series-upstream-1/Episodes",
    ]);
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toEqual({
      includeSegmentTypes: "Intro,Outro",
    });
    expect(Object.fromEntries(requests[2]!.url.searchParams)).toMatchObject({
      EnableUserData: "true",
      IsUnaired: "false",
      Limit: "8",
      SortBy: "IndexNumber",
      StartIndex: "1",
      StartItemId: "episode-upstream-1",
      UserId: "paired-user-id",
    });
    expect(requests[2]!.url.searchParams.has("IsMissing")).toBe(false);
    expect(requests.every(({ url }) => !url.searchParams.has("api_key"))).toBe(true);
  });

  it("keeps next-episode context when Jellyfin markers are unavailable", async () => {
    const currentEpisode = {
      Id: "episode-upstream-1",
      IndexNumber: 2,
      Name: "Aperture",
      ParentIndexNumber: 1,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const { client } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({ message: "private marker failure" }, { status: 503 }),
      jsonResponse({
        Items: [
          {
            ...currentEpisode,
            Id: "episode-upstream-2",
            IndexNumber: 3,
            Name: "The Long Meridian",
          },
        ],
      }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      nextEpisode: { externalId: "episode-upstream-2" },
      nextState: "ready",
      segments: [],
      segmentsState: "unavailable",
    });
  });

  it("treats an incoherent cross-series next item as unavailable instead of ending the series", async () => {
    const currentEpisode = {
      Id: "episode-upstream-10",
      IndexNumber: 10,
      Name: "The Crossing",
      ParentIndexNumber: 1,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const { client } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({ Items: [], StartIndex: 0, TotalRecordCount: 0 }),
      jsonResponse({
        Items: [
          {
            ...currentEpisode,
            Id: "foreign-episode-upstream-1",
            IndexNumber: 1,
            ParentIndexNumber: 2,
            SeriesId: "different-series-upstream-1",
          },
        ],
      }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-10",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({ nextEpisode: null, nextState: "unavailable" });
  });

  it("accepts Jellyfin's canonical season-boundary result without inferring filenames", async () => {
    const currentEpisode = {
      Id: "episode-upstream-10",
      IndexNumber: 10,
      IndexNumberEnd: 11,
      Name: "The Crossing",
      ParentIndexNumber: 1,
      RunTimeTicks: 5_400_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const { client } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({ Items: [], StartIndex: 0, TotalRecordCount: 0 }),
      jsonResponse({
        Items: [
          {
            ...currentEpisode,
            Id: "episode-upstream-12",
            IndexNumber: 1,
            Name: "After the Solstice",
            ParentIndexNumber: 2,
            RunTimeTicks: 2_700_000_000,
          },
        ],
      }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-10",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      nextEpisode: {
        episodeNumber: 1,
        externalId: "episode-upstream-12",
        seasonNumber: 2,
        title: "After the Solstice",
      },
      nextState: "ready",
    });
  });

  it("skips an unexpected special when a regular canonical successor is available", async () => {
    const currentEpisode = {
      Id: "episode-upstream-10",
      IndexNumber: 10,
      Name: "The Crossing",
      ParentIndexNumber: 1,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const { client, requests } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({ Items: [], StartIndex: 0, TotalRecordCount: 0 }),
      jsonResponse({
        Items: [
          {
            ...currentEpisode,
            Id: "special-upstream-1",
            IndexNumber: 1,
            Name: "A Winter Signal",
            ParentIndexNumber: 0,
          },
          {
            ...currentEpisode,
            Id: "episode-upstream-11",
            IndexNumber: 1,
            Name: "After the Solstice",
            ParentIndexNumber: 2,
          },
        ],
        StartIndex: 1,
        TotalRecordCount: 3,
      }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-10",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      nextEpisode: {
        externalId: "episode-upstream-11",
        seasonNumber: 2,
        title: "After the Solstice",
      },
      nextState: "ready",
    });
    expect(requests[2]!.url.searchParams.get("Limit")).toBe("8");
  });

  it("fails closed when the bounded look-ahead cannot get past specials", async () => {
    const currentEpisode = {
      Id: "episode-upstream-10",
      IndexNumber: 10,
      Name: "The Crossing",
      ParentIndexNumber: 1,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const { client } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({ Items: [], StartIndex: 0, TotalRecordCount: 0 }),
      jsonResponse({
        Items: Array.from({ length: 8 }, (_, index) => ({
          ...currentEpisode,
          Id: `special-upstream-${index + 1}`,
          IndexNumber: index + 1,
          Name: `Special ${index + 1}`,
          ParentIndexNumber: 0,
        })),
        StartIndex: 1,
        TotalRecordCount: 20,
      }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-10",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({ nextEpisode: null, nextState: "unavailable" });
  });

  it("returns a definitive end state when Jellyfin has no later available episode", async () => {
    const currentEpisode = {
      Id: "episode-upstream-10",
      IndexNumber: 10,
      Name: "The Crossing",
      ParentIndexNumber: 1,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const { client } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({ Items: [], StartIndex: 0, TotalRecordCount: 0 }),
      jsonResponse({ Items: [], StartIndex: 1, TotalRecordCount: 1 }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-10",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({ nextEpisode: null, nextState: "end" });
  });

  it("reports a missing aired canonical episode as requestable without making it playable", async () => {
    const currentEpisode = {
      Id: "episode-upstream-10",
      IndexNumber: 10,
      Name: "The Crossing",
      ParentIndexNumber: 1,
      RunTimeTicks: 2_700_000_000,
      SeriesId: "series-upstream-1",
      SeriesName: "Northern Lights",
      Type: "Episode",
    };
    const { client, requests } = clientWithResponses([
      jsonResponse(currentEpisode),
      jsonResponse({ Items: [], StartIndex: 0, TotalRecordCount: 0 }),
      jsonResponse({
        Items: [
          {
            Id: "episode-upstream-11",
            IndexNumber: 11,
            LocationType: "Virtual",
            Name: "Event Horizon",
            ParentIndexNumber: 1,
            PremiereDate: "2026-07-01T00:00:00.000Z",
            SeriesId: "series-upstream-1",
            SeriesName: "Northern Lights",
            Type: "Episode",
          },
        ],
        StartIndex: 1,
        TotalRecordCount: 2,
      }),
    ]);

    await expect(
      client.readPlaybackContext({
        itemId: "episode-upstream-10",
        userId: "paired-user-id",
      }),
    ).resolves.toMatchObject({
      nextEpisode: {
        durationSeconds: null,
        episodeNumber: 11,
        externalId: "episode-upstream-11",
        seasonNumber: 1,
        seriesTitle: "Northern Lights",
        title: "Event Horizon",
      },
      nextState: "requestable",
    });
    expect(Object.fromEntries(requests[2]!.url.searchParams)).toMatchObject({
      IsUnaired: "false",
      Limit: "8",
      StartIndex: "1",
      StartItemId: "episode-upstream-10",
    });
    expect(requests[2]!.url.searchParams.has("IsMissing")).toBe(false);
  });

  it("marks paired-user media watched and reconciles the authoritative Jellyfin state", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({ Played: true, PlaybackPositionTicks: 0 }),
      jsonResponse({
        Id: "movie-upstream-1",
        RunTimeTicks: 7_200_000_000,
        Type: "Movie",
        UserData: { Played: true, PlaybackPositionTicks: 0 },
      }),
    ]);

    await expect(
      client.updatePlaybackState({
        action: "mark_watched",
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({ durationSeconds: 720, played: true, positionSeconds: 0 });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/base/UserPlayedItems/movie-upstream-1",
      "/base/Items/movie-upstream-1",
    ]);
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.url.searchParams.get("userId")).toBe("paired-user-id");
    expect(requests[1]?.url.searchParams.get("EnableUserData")).toBe("true");
    expect(requests[1]?.url.searchParams.get("UserId")).toBe("paired-user-id");
    expect(requests.every(({ url }) => !url.searchParams.has("api_key"))).toBe(true);
  });

  it("keeps mark-unwatched distinct from resetting only the resume position", async () => {
    const unplayed = clientWithResponses([
      jsonResponse({ Played: false, PlaybackPositionTicks: 0 }),
      jsonResponse({
        Id: "episode-upstream-1",
        RunTimeTicks: 2_700_000_000,
        Type: "Episode",
        UserData: { Played: false, PlaybackPositionTicks: 0 },
      }),
    ]);
    await expect(
      unplayed.client.updatePlaybackState({
        action: "mark_unwatched",
        itemId: "episode-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({ durationSeconds: 270, played: false, positionSeconds: 0 });
    expect(unplayed.requests[0]?.url.pathname).toBe("/base/UserPlayedItems/episode-upstream-1");
    expect(unplayed.requests[0]?.init.method).toBe("DELETE");

    const reset = clientWithResponses([
      jsonResponse({ Played: true, PlaybackPositionTicks: 0 }),
      jsonResponse({
        Id: "movie-upstream-1",
        RunTimeTicks: 7_200_000_000,
        Type: "Movie",
        UserData: { Played: true, PlaybackPositionTicks: 0 },
      }),
    ]);
    await expect(
      reset.client.updatePlaybackState({
        action: "reset_progress",
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({ durationSeconds: 720, played: true, positionSeconds: 0 });
    expect(reset.requests[0]?.url.pathname).toBe("/base/UserItems/movie-upstream-1/UserData");
    expect(reset.requests[0]?.init.method).toBe("POST");
    expect(reset.requests[0]?.init.headers.get("content-type")).toBe("application/json");
    expect(Buffer.from(reset.requests[0]?.init.body ?? []).toString("utf8")).toBe(
      '{"PlaybackPositionTicks":0}',
    );
  });

  it("reconciles a retryable unknown mutation outcome before reporting failure", async () => {
    let attempt = 0;
    const client = new JellyfinUserMediaClient({
      accessToken: "private-access-token",
      deviceId: "installation-1",
      target: {
        baseUrl: "https://jellyfin.example.test/base/",
        connectorId: "jellyfin-home",
        displayName: "Home Jellyfin",
        resolveHost: publicResolver,
        transport: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("connection ended after write");
          return jsonResponse({
            Id: "movie-upstream-1",
            RunTimeTicks: 7_200_000_000,
            Type: "Movie",
            UserData: { Played: true, PlaybackPositionTicks: 0 },
          });
        },
      },
    });

    await expect(
      client.updatePlaybackState({
        action: "mark_watched",
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toEqual({ durationSeconds: 720, played: true, positionSeconds: 0 });
    expect(attempt).toBe(2);
  });

  it("fails closed when Jellyfin does not converge to the requested playback state", async () => {
    const { client } = clientWithResponses([
      jsonResponse({ Played: false, PlaybackPositionTicks: 0 }),
      jsonResponse({
        Id: "movie-upstream-1",
        RunTimeTicks: 7_200_000_000,
        Type: "Movie",
        UserData: { Played: false, PlaybackPositionTicks: 1_800_000_000 },
      }),
    ]);

    await expect(
      client.updatePlaybackState({
        action: "mark_watched",
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.playback_state" });
  });

  it("reads and changes the paired user's authoritative favorite state", async () => {
    const current = clientWithResponses([
      jsonResponse({ Id: "movie-upstream-1", UserData: { IsFavorite: false } }),
    ]);
    await expect(
      current.client.readFavoriteState({
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toBe(false);
    expect(current.requests[0]?.url.pathname).toBe("/base/Items/movie-upstream-1");
    expect(Object.fromEntries(current.requests[0]!.url.searchParams)).toEqual({
      EnableUserData: "true",
      UserId: "paired-user-id",
    });

    const marked = clientWithResponses([
      jsonResponse({ IsFavorite: true }),
      jsonResponse({ Id: "movie-upstream-1", UserData: { IsFavorite: true } }),
    ]);
    await expect(
      marked.client.updateFavoriteState({
        favorite: true,
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toBe(true);
    expect(marked.requests.map(({ url }) => url.pathname)).toEqual([
      "/base/UserFavoriteItems/movie-upstream-1",
      "/base/Items/movie-upstream-1",
    ]);
    expect(marked.requests[0]?.init.method).toBe("POST");
    expect(marked.requests[0]?.url.searchParams.get("userId")).toBe("paired-user-id");
    expect(marked.requests.every(({ url }) => !url.searchParams.has("api_key"))).toBe(true);

    const unmarked = clientWithResponses([
      jsonResponse({ IsFavorite: false }),
      jsonResponse({ Id: "movie-upstream-1", UserData: { IsFavorite: false } }),
    ]);
    await expect(
      unmarked.client.updateFavoriteState({
        favorite: false,
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toBe(false);
    expect(unmarked.requests[0]?.init.method).toBe("DELETE");
  });

  it("reconciles an unknown favorite mutation outcome before reporting success", async () => {
    let attempt = 0;
    const client = new JellyfinUserMediaClient({
      accessToken: "private-access-token",
      deviceId: "installation-1",
      target: {
        baseUrl: "https://jellyfin.example.test/base/",
        connectorId: "jellyfin-home",
        displayName: "Home Jellyfin",
        resolveHost: publicResolver,
        transport: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("connection ended after favorite write");
          return jsonResponse({ Id: "movie-upstream-1", UserData: { IsFavorite: true } });
        },
      },
    });

    await expect(
      client.updateFavoriteState({
        favorite: true,
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).resolves.toBe(true);
    expect(attempt).toBe(2);
  });

  it("fails closed when favorite state is malformed or does not converge", async () => {
    const malformed = clientWithResponses([
      jsonResponse({ Id: "movie-upstream-1", UserData: { IsFavorite: "yes" } }),
    ]);
    await expect(
      malformed.client.readFavoriteState({
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.favorite" });

    const divergent = clientWithResponses([
      jsonResponse({ IsFavorite: true }),
      jsonResponse({ Id: "movie-upstream-1", UserData: { IsFavorite: false } }),
    ]);
    await expect(
      divergent.client.updateFavoriteState({
        favorite: true,
        itemId: "movie-upstream-1",
        userId: "paired-user-id",
      }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.favorite" });
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
