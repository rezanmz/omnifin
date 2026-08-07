import { describe, expect, it } from "vitest";

import {
  JellyfinPlaybackClient,
  JellyfinPlaybackUnavailableError,
} from "../src/media/jellyfin-playback-client.js";
import { createMockTransport, jsonResponse, publicResolver } from "./helpers/mock-fetch.js";

function clientWithResponses(responses: Response[]) {
  const mock = createMockTransport(responses);
  return {
    client: new JellyfinPlaybackClient({
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

const mediaStreams = [
  {
    BitRate: 8_000_000,
    Codec: "h264",
    Height: 1080,
    Index: 0,
    Type: "Video",
    Width: 1920,
  },
  {
    Channels: 6,
    Codec: "aac",
    DisplayTitle: "English · 5.1",
    Index: 1,
    IsDefault: true,
    Language: "eng",
    Type: "Audio",
  },
  {
    Channels: 2,
    Codec: "aac",
    DisplayTitle: "French · Stereo",
    Index: 2,
    Language: "fra",
    Type: "Audio",
  },
  {
    Codec: "vtt",
    DeliveryMethod: "External",
    DisplayTitle: "English",
    Height: 0,
    Index: 3,
    IsDefault: true,
    Language: "eng",
    Type: "Subtitle",
    Width: 0,
  },
  {
    Codec: "pgssub",
    DeliveryMethod: "Encode",
    DisplayTitle: "English forced",
    Height: 0,
    Index: 4,
    IsForced: true,
    Language: "eng",
    Type: "Subtitle",
    Width: 0,
  },
];

const directSource = {
  Bitrate: 8_640_000,
  Container: "mp4",
  DefaultAudioStreamIndex: 1,
  DefaultSubtitleStreamIndex: 3,
  Id: "media-source-1",
  MediaStreams: mediaStreams,
  RunTimeTicks: 7_200_000_000,
  SupportsDirectPlay: true,
  SupportsTranscoding: true,
  TranscodingContainer: "mp4",
  TranscodingSubProtocol: "hls",
  TranscodingUrl:
    "/base/Videos/movie-upstream-1/master.m3u8?MediaSourceId=media-source-1&PlaySessionId=play-session-upstream-1",
};

describe("JellyfinPlaybackClient", () => {
  it("negotiates an authenticated direct-play source with bounded browser capabilities", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({ MediaSources: [directSource], PlaySessionId: "play-session-upstream-1" }),
    ]);

    await expect(
      client.negotiate({
        audioStreamIndex: 2,
        itemId: "movie-upstream-1",
        maxStreamingBitrate: 20_000_000,
        mode: "auto",
        positionSeconds: 180,
        subtitleStreamIndex: 3,
      }),
    ).resolves.toEqual({
      audioTracks: [
        {
          channels: 6,
          codec: "aac",
          default: true,
          index: 1,
          language: "eng",
          selected: false,
          title: "English · 5.1",
        },
        {
          channels: 2,
          codec: "aac",
          default: false,
          index: 2,
          language: "fra",
          selected: true,
          title: "French · Stereo",
        },
      ],
      delivery: "direct",
      itemId: "movie-upstream-1",
      liveStreamId: null,
      media: {
        audioCodec: "aac",
        bitrate: 8_640_000,
        container: "mp4",
        durationSeconds: 720,
        height: 1080,
        videoCodec: "h264",
        width: 1920,
      },
      mediaSourceId: "media-source-1",
      playMethod: "DirectPlay",
      playSessionId: "play-session-upstream-1",
      positionSeconds: 180,
      subtitleTracks: [
        {
          codec: "vtt",
          default: true,
          delivery: "external",
          forced: false,
          index: 3,
          language: "eng",
          selected: true,
          title: "English",
        },
        {
          codec: "pgssub",
          default: false,
          delivery: "video",
          forced: true,
          index: 4,
          language: "eng",
          selected: false,
          title: "English forced",
        },
      ],
      upstreamTarget: {
        path: "Videos/movie-upstream-1/stream",
        query:
          "static=true&mediaSourceId=media-source-1&playSessionId=play-session-upstream-1&deviceId=installation-1",
      },
    });

    expect(requests[0]?.url.pathname).toBe("/base/Items/movie-upstream-1/PlaybackInfo");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
    expect(requests[0]?.init.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(Buffer.from(requests[0]?.init.body ?? []).toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      AllowAudioStreamCopy: true,
      AllowVideoStreamCopy: true,
      AudioStreamIndex: 2,
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      MaxAudioChannels: 2,
      MaxStreamingBitrate: 20_000_000,
      StartTimeTicks: 1_800_000_000,
      SubtitleStreamIndex: 3,
    });
    expect(body).not.toHaveProperty("UserId");
    expect(body.DeviceProfile).toMatchObject({
      DirectPlayProfiles: expect.arrayContaining([
        expect.objectContaining({ Container: "mp4,m4v", Type: "Video" }),
        expect.objectContaining({ Container: "webm", Type: "Video" }),
      ]),
      SubtitleProfiles: expect.arrayContaining([
        { Format: "vtt", Method: "External" },
        { Format: "pgssub,dvdsub", Method: "Encode" },
      ]),
      TranscodingProfiles: [
        expect.objectContaining({
          AudioCodec: "aac",
          Container: "mp4",
          Protocol: "hls",
          Type: "Video",
          VideoCodec: "h264",
        }),
      ],
    });
  });

  it("ignores embedded artwork streams without weakening playback-stream validation", async () => {
    const sourceWithEmbeddedArtwork = {
      ...directSource,
      MediaStreams: [
        ...mediaStreams,
        {
          Codec: "mjpeg",
          Height: 1_080,
          Index: 5,
          Type: "EmbeddedImage",
          Width: 1_920,
        },
      ],
    };
    const { client } = clientWithResponses([
      jsonResponse({
        MediaSources: [sourceWithEmbeddedArtwork],
        PlaySessionId: "play-session-upstream-1",
      }),
    ]);

    const result = await client.negotiate({
      audioStreamIndex: 1,
      itemId: "movie-upstream-1",
      maxStreamingBitrate: 20_000_000,
      mode: "auto",
      positionSeconds: 0,
      subtitleStreamIndex: null,
    });

    expect(result).toMatchObject({
      audioTracks: [{ index: 1 }, { index: 2 }],
      delivery: "direct",
      media: { audioCodec: "aac", videoCodec: "h264" },
      subtitleTracks: [{ index: 3 }, { index: 4 }],
    });
    expect(JSON.stringify(result)).not.toMatch(/EmbeddedImage|mjpeg/iu);
  });

  it("still rejects oversized stream collections and malformed known playback streams", async () => {
    const oversized = clientWithResponses([
      jsonResponse({
        MediaSources: [
          {
            ...directSource,
            MediaStreams: Array.from({ length: 513 }, (_, index) => ({
              Codec: "mjpeg",
              Index: index,
              Type: "EmbeddedImage",
            })),
          },
        ],
        PlaySessionId: "play-session-upstream-1",
      }),
    ]).client;
    const malformedKnown = clientWithResponses([
      jsonResponse({
        MediaSources: [
          {
            ...directSource,
            MediaStreams: [...mediaStreams, { Index: 5, Type: "Video", Width: 100_000 }],
          },
        ],
        PlaySessionId: "play-session-upstream-1",
      }),
    ]).client;
    const malformedEntry = clientWithResponses([
      jsonResponse({
        MediaSources: [{ ...directSource, MediaStreams: [...mediaStreams, null] }],
        PlaySessionId: "play-session-upstream-1",
      }),
    ]).client;
    const input = {
      audioStreamIndex: 1,
      itemId: "movie-upstream-1",
      maxStreamingBitrate: 20_000_000,
      mode: "auto" as const,
      positionSeconds: 0,
      subtitleStreamIndex: null,
    };

    await expect(oversized.negotiate(input)).rejects.toMatchObject({ code: "response_invalid" });
    await expect(malformedKnown.negotiate(input)).rejects.toMatchObject({
      code: "response_invalid",
    });
    await expect(malformedEntry.negotiate(input)).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("falls back to the same-origin HLS target and removes returned credential parameters", async () => {
    const hlsSource = {
      ...directSource,
      SupportsDirectPlay: false,
      TranscodingUrl:
        "/base/videos/movie-upstream-1/master.m3u8?MediaSourceId=media-source-1&api_key=leaked&PlaySessionId=play-session-upstream-1",
    };
    const { client } = clientWithResponses([
      jsonResponse({ MediaSources: [hlsSource], PlaySessionId: "play-session-upstream-1" }),
    ]);

    await expect(
      client.negotiate({
        audioStreamIndex: null,
        itemId: "movie-upstream-1",
        maxStreamingBitrate: 8_000_000,
        mode: "auto",
        positionSeconds: 0,
        subtitleStreamIndex: null,
      }),
    ).resolves.toMatchObject({
      delivery: "hls",
      playMethod: "Transcode",
      subtitleTracks: expect.arrayContaining([
        expect.objectContaining({ index: 3, selected: false }),
      ]),
      upstreamTarget: {
        path: "videos/movie-upstream-1/master.m3u8",
        query: "MediaSourceId=media-source-1&PlaySessionId=play-session-upstream-1",
      },
    });
  });

  it("normalizes a Jellyfin direct-stream remux as a same-origin byte stream", async () => {
    const remuxSource = {
      ...directSource,
      Container: "mp4",
      SupportsDirectPlay: false,
      SupportsDirectStream: true,
    };
    const { client, requests } = clientWithResponses([
      jsonResponse({ MediaSources: [remuxSource], PlaySessionId: "play-session-upstream-1" }),
    ]);

    await expect(
      client.negotiate({
        audioStreamIndex: null,
        itemId: "movie-upstream-1",
        maxStreamingBitrate: 200_000_000,
        mode: "auto",
        positionSeconds: 42,
        subtitleStreamIndex: null,
      }),
    ).resolves.toMatchObject({
      delivery: "direct",
      playMethod: "DirectStream",
      positionSeconds: 42,
      upstreamTarget: {
        path: "Videos/movie-upstream-1/stream",
        query:
          "static=true&mediaSourceId=media-source-1&playSessionId=play-session-upstream-1&deviceId=installation-1",
      },
    });
    const body = JSON.parse(Buffer.from(requests[0]?.init.body ?? []).toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      MaxStreamingBitrate: 200_000_000,
    });
  });

  it("fails closed when an explicit delivery mode is unavailable or a selection is invalid", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        MediaSources: [{ ...directSource, SupportsDirectPlay: false }],
        PlaySessionId: "play-session-upstream-1",
      }),
      jsonResponse({ MediaSources: [directSource], PlaySessionId: "play-session-upstream-1" }),
    ]);

    await expect(
      client.negotiate({
        audioStreamIndex: null,
        itemId: "movie-upstream-1",
        maxStreamingBitrate: 8_000_000,
        mode: "direct",
        positionSeconds: 0,
        subtitleStreamIndex: null,
      }),
    ).rejects.toBeInstanceOf(JellyfinPlaybackUnavailableError);
    await expect(
      client.negotiate({
        audioStreamIndex: 99,
        itemId: "movie-upstream-1",
        maxStreamingBitrate: 8_000_000,
        mode: "auto",
        positionSeconds: 0,
        subtitleStreamIndex: null,
      }),
    ).rejects.toBeInstanceOf(JellyfinPlaybackUnavailableError);
  });

  it("does not proxy media sources that require arbitrary upstream headers", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        MediaSources: [
          {
            ...directSource,
            RequiredHttpHeaders: { "X-Private-Upstream-Context": "private" },
          },
        ],
        PlaySessionId: "play-session-upstream-1",
      }),
    ]);

    await expect(
      client.negotiate({
        audioStreamIndex: null,
        itemId: "movie-upstream-1",
        maxStreamingBitrate: 8_000_000,
        mode: "auto",
        positionSeconds: 0,
        subtitleStreamIndex: null,
      }),
    ).rejects.toBeInstanceOf(JellyfinPlaybackUnavailableError);
  });

  it("rejects cross-origin and malformed transcoding targets", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        MediaSources: [
          {
            ...directSource,
            SupportsDirectPlay: false,
            TranscodingUrl: "https://attacker.example.test/private/master.m3u8",
          },
        ],
        PlaySessionId: "play-session-upstream-1",
      }),
    ]);

    await expect(
      client.negotiate({
        audioStreamIndex: null,
        itemId: "movie-upstream-1",
        maxStreamingBitrate: 8_000_000,
        mode: "auto",
        positionSeconds: 0,
        subtitleStreamIndex: null,
      }),
    ).rejects.toMatchObject({ code: "response_invalid", operation: "media.playback.negotiate" });
  });

  it("reports start, pause/progress, and stop events without putting tokens in URLs", async () => {
    const { client, requests } = clientWithResponses([
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]);
    const session = {
      audioStreamIndex: 2,
      itemId: "movie-upstream-1",
      mediaSourceId: "media-source-1",
      playMethod: "DirectStream" as const,
      playSessionId: "play-session-upstream-1",
      subtitleStreamIndex: 3,
    };

    await client.reportPlaybackEvent({ event: "started", positionSeconds: 180, session });
    await client.reportPlaybackEvent({ event: "paused", positionSeconds: 240, session });
    await client.reportPlaybackEvent({ event: "stopped", positionSeconds: 250, session });

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/base/Sessions/Playing",
      "/base/Sessions/Playing/Progress",
      "/base/Sessions/Playing/Stopped",
    ]);
    for (const request of requests) {
      expect(request.url.search).toBe("");
      expect(request.init.headers.get("authorization")).toContain('Token="private-access-token"');
    }
    expect(JSON.parse(Buffer.from(requests[1]?.init.body ?? []).toString("utf8"))).toMatchObject({
      AudioStreamIndex: 2,
      CanSeek: true,
      IsPaused: true,
      ItemId: "movie-upstream-1",
      MediaSourceId: "media-source-1",
      PlayMethod: "DirectStream",
      PlaySessionId: "play-session-upstream-1",
      PositionTicks: 2_400_000_000,
      SubtitleStreamIndex: 3,
    });
  });

  it("reads a negotiated playback target with authentication and a bounded byte range", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const { client, requests } = clientWithResponses([
      new Response(bytes, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-range": "bytes 0-3/120",
          "content-type": "video/mp4",
        },
      }),
    ]);

    const response = await client.readPlaybackTarget({
      accept: "video/*",
      range: "bytes=0-3",
      target: {
        path: "Videos/movie-upstream-1/stream",
        query: "static=true&mediaSourceId=media-source-1",
      },
    });

    expect(response).toMatchObject({ body: bytes, status: 206 });
    expect(response.headers.get("content-range")).toBe("bytes 0-3/120");
    expect(requests[0]?.url.pathname).toBe("/base/Videos/movie-upstream-1/stream");
    expect(requests[0]?.url.search).toBe("?static=true&mediaSourceId=media-source-1");
    expect(requests[0]?.init.headers.get("range")).toBe("bytes=0-3");
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("returns an unsatisfied range response for the gateway to sanitize", async () => {
    const { client } = clientWithResponses([
      new Response("upstream detail", {
        status: 416,
        headers: { "content-range": "bytes */120" },
      }),
    ]);

    const response = await client.readPlaybackTarget({
      range: "bytes=500-503",
      target: {
        path: "Videos/movie-upstream-1/stream",
        query: "static=true&mediaSourceId=media-source-1",
      },
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */120");
  });

  it("streams a normalized HLS asset with token-only authentication", async () => {
    const bytes = new Uint8Array([0, 0, 1, 186, 68, 0, 4, 0]);
    const { client, requests } = clientWithResponses([
      new Response(bytes, { headers: { "content-type": "video/mp2t" } }),
    ]);

    const response = await client.streamPlaybackTarget({
      accept: "video/*,audio/*,application/octet-stream",
      maxResponseBytes: 64 * 1_024 * 1_024,
      target: {
        path: "Videos/movie-upstream-1/hls1/main/0.ts",
        query: "segment=0",
      },
    });
    const body = new Uint8Array(await new Response(response.body).arrayBuffer());

    expect(body).toEqual(bytes);
    expect(requests[0]?.url.pathname).toBe("/base/Videos/movie-upstream-1/hls1/main/0.ts");
    expect(requests[0]?.url.search).toBe("?segment=0");
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("reads a masked WebVTT subtitle stream bound to its session source", async () => {
    const vtt = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello");
    const { client, requests } = clientWithResponses([
      new Response(vtt, { headers: { "content-type": "text/vtt" } }),
    ]);

    const response = await client.readSubtitleStream({
      itemId: "movie-upstream-1",
      mediaSourceId: "media-source-1",
      subtitleIndex: 3,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(vtt);
    expect(response.headers.get("content-type")).toBe("text/vtt");
    expect(requests[0]?.url.pathname).toBe(
      "/base/Videos/movie-upstream-1/media-source-1/Subtitles/3/Stream.vtt",
    );
    expect(requests[0]?.init.headers.get("accept")).toBe(
      "text/vtt,text/plain,application/octet-stream",
    );
    expect(requests[0]?.init.headers.get("authorization")).toContain(
      'Token="private-access-token"',
    );
  });

  it("normalizes same-server HLS assets while rejecting traversal and external URLs", () => {
    const { client } = clientWithResponses([]);
    const parent = {
      path: "Videos/movie-upstream-1/master.m3u8",
      query: "MediaSourceId=media-source-1",
    };

    expect(client.resolvePlaybackTarget(parent, "hls1/main/0.ts?api_key=leaked&segment=0")).toEqual(
      {
        path: "Videos/movie-upstream-1/hls1/main/0.ts",
        query: "segment=0",
      },
    );
    expect(() =>
      client.resolvePlaybackTarget(parent, "https://attacker.example.test/segment.ts"),
    ).toThrow(/safely interpret/i);
    expect(() => client.resolvePlaybackTarget(parent, "../../../private/segment.ts")).toThrow(
      /safely interpret/i,
    );
  });
});
