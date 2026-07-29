import { describe, expect, it } from "vitest";

import { JellyfinLibraryClient } from "../src/media/jellyfin-library-client.js";
import { createMockTransport, jsonResponse, publicResolver } from "./helpers/mock-fetch.js";

function clientWithResponses(responses: Response[]) {
  const mock = createMockTransport(responses);
  return {
    client: new JellyfinLibraryClient({
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

const unmatchedMovie = {
  Id: "movie-upstream-1",
  ImageTags: {},
  Name: "The Far Meridian",
  Overview: null,
  ProductionYear: 2026,
  ProviderIds: {},
  Type: "Movie",
};

describe("JellyfinLibraryClient", () => {
  it("normalizes incomplete items without returning paths or provider identifiers", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({
        Items: [
          unmatchedMovie,
          {
            ...unmatchedMovie,
            Id: "series-upstream-1",
            ImageTags: { Primary: "poster-tag" },
            Name: "Northern Lights",
            Overview: "A crew follows a signal through the polar dark.",
            ProductionYear: null,
            ProviderIds: { Tvdb: "private-provider-id" },
            Type: "Series",
          },
        ],
        StartIndex: 0,
        TotalRecordCount: 4,
      }),
    ]);

    await expect(client.listAttentionItems({ limit: 2, startIndex: 0 })).resolves.toEqual({
      items: [
        {
          artwork: { poster: null },
          externalId: "movie-upstream-1",
          identityState: "unmatched",
          issues: ["missing_identity", "missing_overview", "missing_poster"],
          kind: "movie",
          overview: null,
          title: "The Far Meridian",
          year: 2026,
        },
        {
          artwork: { poster: { itemId: "series-upstream-1", type: "Primary" } },
          externalId: "series-upstream-1",
          identityState: "identified",
          issues: ["missing_year"],
          kind: "series",
          overview: "A crew follows a signal through the polar dark.",
          title: "Northern Lights",
          year: null,
        },
      ],
      nextStartIndex: 2,
      scanned: 2,
      truncated: true,
    });
    expect(requests[0]?.url.pathname).toBe("/base/Items");
    expect(requests[0]?.url.searchParams.get("includeItemTypes")).toBe("Movie,Series");
    expect(requests[0]?.url.searchParams.get("limit")).toBe("3");
    expect(requests[0]?.url.searchParams.get("fields")).not.toContain("Path");
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("accepts asynchronous scans and explicit safe or replacing item refreshes", async () => {
    const { client, requests } = clientWithResponses([
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]);

    await client.scanLibrary();
    await client.refreshItem({
      imageMode: "replace",
      itemId: "movie-upstream-1",
      metadataMode: "missing",
    });

    expect(requests[0]?.url.pathname).toBe("/base/Library/Refresh");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[1]?.url.pathname).toBe("/base/Items/movie-upstream-1/Refresh");
    expect(requests[1]?.url.searchParams.get("replaceAllImages")).toBe("true");
    expect(requests[1]?.url.searchParams.get("replaceAllMetadata")).toBe("false");
    expect(requests[1]?.url.searchParams.get("regenerateTrickplay")).toBe("false");
  });

  it("read-modify-writes only the allowed metadata fields", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({
        Id: "movie-upstream-1",
        Name: "Old title",
        Overview: "Old overview",
        Path: "/private/media/movie.mkv",
        ProductionYear: 2024,
        ProviderIds: { Tmdb: "private-provider-id" },
        Type: "Movie",
      }),
      new Response(null, { status: 204 }),
    ]);

    await client.updateMetadata("movie-upstream-1", {
      overview: null,
      title: "The Far Meridian",
      year: 2026,
    });

    const body = JSON.parse(Buffer.from(requests[1]?.init.body ?? new Uint8Array()).toString());
    expect(body).toMatchObject({
      Id: "movie-upstream-1",
      Name: "The Far Meridian",
      Overview: null,
      Path: "/private/media/movie.mkv",
      ProductionYear: 2026,
      ProviderIds: { Tmdb: "private-provider-id" },
    });
    expect(requests[1]?.url.pathname).toBe("/base/Items/movie-upstream-1");
    expect(requests[1]?.init.headers.get("content-type")).toBe("application/json");
  });

  it("normalizes remote artwork and applies only exact HTTPS provider results", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({
        Images: [
          {
            CommunityRating: 8.6,
            Height: 3_000,
            Language: "en",
            ProviderName: "TMDb",
            ThumbnailUrl: "https://image.example.test/thumb/poster.jpg?size=small",
            Type: "Primary",
            Url: "https://image.example.test/full/poster.jpg",
            VoteCount: 512,
            Width: 2_000,
          },
          {
            ProviderName: "Unsafe",
            Type: "Primary",
            Url: "http://169.254.169.254/latest/meta-data",
          },
        ],
        TotalRecordCount: 2,
      }),
      new Response(null, { status: 204 }),
    ]);

    await expect(
      client.searchRemoteArtwork("movie-upstream-1", {
        includeAllLanguages: false,
        kind: "poster",
      }),
    ).resolves.toEqual([
      {
        communityRating: 8.6,
        height: 3_000,
        imageUrl: "https://image.example.test/full/poster.jpg",
        language: "en",
        previewUrl: "https://image.example.test/thumb/poster.jpg?size=small",
        providerName: "TMDb",
        voteCount: 512,
        width: 2_000,
      },
    ]);
    await client.applyRemoteArtwork(
      "movie-upstream-1",
      "poster",
      "https://image.example.test/full/poster.jpg",
    );
    expect(requests[0]?.url.pathname).toBe("/base/Items/movie-upstream-1/RemoteImages");
    expect(requests[1]?.url.pathname).toBe("/base/Items/movie-upstream-1/RemoteImages/Download");
    expect(requests[1]?.url.searchParams.get("type")).toBe("Primary");
    expect(requests[1]?.url.searchParams.get("imageUrl")).toBe(
      "https://image.example.test/full/poster.jpg",
    );
  });

  it("proxies bounded remote artwork without forwarding Jellyfin credentials", async () => {
    const image = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
    const { client, requests } = clientWithResponses([
      new Response(image, { headers: { "content-type": "image/jpeg" } }),
    ]);

    await expect(
      client.readRemoteArtwork("https://image.example.test/thumb/poster.jpg?size=small"),
    ).resolves.toEqual({ body: image, contentType: "image/jpeg" });
    expect(requests[0]?.url.origin).toBe("https://image.example.test");
    expect(requests[0]?.url.searchParams.get("size")).toBe("small");
    expect(requests[0]?.init.headers.has("authorization")).toBe(false);
  });

  it("fails closed on mismatched item reads and unsafe artwork URLs", async () => {
    const mismatched = clientWithResponses([
      jsonResponse({
        Id: "different-item",
        Name: "Unexpected",
        Overview: null,
        ProductionYear: null,
        Type: "Movie",
      }),
    ]);
    await expect(
      mismatched.client.updateMetadata("movie-upstream-1", { title: "Safe title" }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "library.item.read" });
    const noRequest = clientWithResponses([]);
    await expect(
      noRequest.client.applyRemoteArtwork(
        "movie-upstream-1",
        "poster",
        "http://169.254.169.254/latest/meta-data",
      ),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "library.artwork.apply" });
    expect(noRequest.requests).toHaveLength(0);
  });
});
