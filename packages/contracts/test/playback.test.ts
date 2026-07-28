import { describe, expect, it } from "vitest";

import {
  playbackNegotiationRequestSchema,
  playbackNegotiationResponseSchema,
  playbackProgressRequestSchema,
  playbackProgressResponseSchema,
} from "../src/playback.js";

const mediaReferenceId = "media_AAAAAAAAAAAAAAAAAAAAAA";
const sessionId = "playback_BBBBBBBBBBBBBBBBBBBBBB";

function response() {
  return {
    audioTracks: [
      {
        channels: 6,
        codec: "eac3",
        default: true,
        index: 1,
        language: "en-CA",
        selected: true,
        title: "English · 5.1",
      },
    ],
    delivery: "hls",
    expiresAt: "2026-07-27T18:00:00.000Z",
    media: {
      audioCodec: "aac",
      bitrate: 8_000_000,
      container: "m3u8",
      durationSeconds: 7_200,
      height: 1_080,
      videoCodec: "h264",
      width: 1_920,
    },
    mediaReferenceId,
    positionSeconds: 1_200,
    sessionId,
    streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    subtitleTracks: [
      {
        codec: "webvtt",
        default: false,
        delivery: "hls",
        forced: false,
        index: 4,
        language: "fr",
        selected: false,
        title: "Français",
      },
    ],
  } as const;
}

describe("playback contracts", () => {
  it("accepts a bounded browser negotiation without upstream identifiers", () => {
    expect(
      playbackNegotiationRequestSchema.parse({
        audioStreamIndex: 1,
        maxStreamingBitrate: 12_000_000,
        mode: "auto",
        positionSeconds: 1_200,
        subtitleStreamIndex: 4,
      }),
    ).toEqual({
      audioStreamIndex: 1,
      maxStreamingBitrate: 12_000_000,
      mode: "auto",
      positionSeconds: 1_200,
      subtitleStreamIndex: 4,
    });
  });

  it("rejects unbounded, ambiguous, and extra negotiation input", () => {
    expect(
      playbackNegotiationRequestSchema.safeParse({
        audioStreamIndex: 1,
        maxStreamingBitrate: 1,
        mode: "auto",
        positionSeconds: 0,
        subtitleStreamIndex: 1,
      }).success,
    ).toBe(false);
    expect(
      playbackNegotiationRequestSchema.safeParse({
        audioStreamIndex: null,
        maxStreamingBitrate: 8_000_000,
        mode: "auto",
        positionSeconds: 0,
        rawItemId: "upstream-item",
        subtitleStreamIndex: null,
      }).success,
    ).toBe(false);
  });

  it("binds the stream path to the opaque session and selected delivery", () => {
    expect(playbackNegotiationResponseSchema.parse(response())).toEqual(response());
    expect(
      playbackNegotiationResponseSchema.safeParse({
        ...response(),
        streamPath: "/v1/playback/playback_CCCCCCCCCCCCCCCCCCCCCC/stream",
      }).success,
    ).toBe(false);
    expect(
      playbackNegotiationResponseSchema.safeParse({
        ...response(),
        delivery: "direct",
      }).success,
    ).toBe(false);
  });

  it("requires coherent playback position and unique track selections", () => {
    expect(
      playbackNegotiationResponseSchema.safeParse({
        ...response(),
        positionSeconds: 7_201,
      }).success,
    ).toBe(false);
    expect(
      playbackNegotiationResponseSchema.safeParse({
        ...response(),
        audioTracks: [response().audioTracks[0], response().audioTracks[0]],
      }).success,
    ).toBe(false);
  });

  it("normalizes bounded progress events and acknowledgements", () => {
    expect(
      playbackProgressRequestSchema.parse({ event: "paused", positionSeconds: 2_400 }),
    ).toEqual({ event: "paused", positionSeconds: 2_400 });
    expect(
      playbackProgressResponseSchema.parse({
        acceptedAt: "2026-07-27T17:00:00.000Z",
        positionSeconds: 2_400,
        sessionId,
        state: "paused",
      }),
    ).toMatchObject({ sessionId, state: "paused" });
  });
});
