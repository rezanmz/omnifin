import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAYBACK_PREFERENCES,
  playbackNegotiationRequestSchema,
  playbackNegotiationResponseSchema,
  playbackContextResponseJsonSchema,
  playbackContextResponseSchema,
  playbackProgressRequestSchema,
  playbackProgressResponseSchema,
  playbackPreferencesResponseJsonSchema,
  playbackPreferencesResponseSchema,
  playbackPreferencesUpdateRequestJsonSchema,
  playbackPreferencesUpdateRequestSchema,
} from "../src/playback.js";

const mediaReferenceId = "media_AAAAAAAAAAAAAAAAAAAAAA";
const sessionId = "playback_BBBBBBBBBBBBBBBBBBBBBB";
const sourceReferenceId = "source_VVVVVVVVVVVVVVVVVVVVVV";

function response() {
  return {
    audioTracks: [
      {
        channels: 6,
        codec: "eac3",
        commentary: false,
        default: true,
        index: 1,
        language: "en-CA",
        original: true,
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
    sourceReferenceId,
    streamPath: `/v1/playback/${sessionId}/master.m3u8`,
    subtitleTracks: [
      {
        codec: "webvtt",
        commentary: false,
        default: false,
        delivery: "hls",
        forced: false,
        hearingImpaired: true,
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
        sourceReferenceId,
        subtitleStreamIndex: 4,
      }),
    ).toEqual({
      audioStreamIndex: 1,
      maxStreamingBitrate: 12_000_000,
      mode: "auto",
      positionSeconds: 1_200,
      sourceReferenceId,
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
        sourceReferenceId: "media-source-private-upstream-id",
        subtitleStreamIndex: null,
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

  it("publishes a bounded playback context without upstream media identities", () => {
    const nextMediaReferenceId = "media_CCCCCCCCCCCCCCCCCCCCCC";
    const context = {
      currentDurationSeconds: 270,
      generatedAt: "2026-08-03T20:00:00.000Z",
      mediaReferenceId,
      nextEpisode: {
        artworkPath: `/v1/media/${nextMediaReferenceId}/images/backdrop`,
        durationSeconds: 270,
        episodeNumber: 3,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 1,
        seriesTitle: "Northern Lights",
        title: "The Long Meridian",
      },
      nextState: "ready",
      segments: [
        { endSeconds: 86, kind: "intro", startSeconds: 4 },
        { endSeconds: 269, kind: "credits", startSeconds: 261 },
      ],
      segmentsState: "ready",
    } as const;

    expect(playbackContextResponseSchema.parse(context)).toEqual(context);
    expect(JSON.stringify(context)).not.toContain("upstream");
    expect(playbackContextResponseJsonSchema).toMatchObject({
      additionalProperties: false,
      type: "object",
    });
  });

  it("represents a missing canonical episode without making it playable", () => {
    const nextMediaReferenceId = "media_DDDDDDDDDDDDDDDDDDDDDD";
    const context = {
      currentDurationSeconds: 270,
      generatedAt: "2026-08-03T20:00:00.000Z",
      mediaReferenceId,
      nextEpisode: {
        artworkPath: null,
        durationSeconds: null,
        episodeNumber: 4,
        mediaReferenceId: nextMediaReferenceId,
        seasonNumber: 1,
        seriesTitle: "Northern Lights",
        title: "Event Horizon",
      },
      nextState: "requestable",
      segments: [],
      segmentsState: "empty",
    } as const;

    expect(playbackContextResponseSchema.parse(context)).toEqual(context);
  });

  it("accepts versioned semantic playback preferences without stream identities", () => {
    const preferences = {
      ...DEFAULT_PLAYBACK_PREFERENCES,
      audio: { languages: ["fa", "en-CA"], preferOriginalLanguage: false },
      subtitles: {
        ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
        languages: ["en", "fa"],
        mode: "always" as const,
      },
    };
    expect(
      playbackPreferencesUpdateRequestSchema.parse({ expectedRevision: 3, preferences }),
    ).toEqual({ expectedRevision: 3, preferences });
    expect(
      playbackPreferencesResponseSchema.parse({
        networkClass: "home",
        preferences,
        revision: 4,
        updatedAt: "2026-08-03T20:00:00.000Z",
      }),
    ).toMatchObject({ networkClass: "home", revision: 4 });
  });

  it("rejects duplicate, non-canonical, excessive, and raw track preferences", () => {
    expect(
      playbackPreferencesUpdateRequestSchema.safeParse({
        expectedRevision: 0,
        preferences: {
          ...DEFAULT_PLAYBACK_PREFERENCES,
          audio: { languages: ["en", "en"], preferOriginalLanguage: true },
        },
      }).success,
    ).toBe(false);
    expect(
      playbackPreferencesUpdateRequestSchema.safeParse({
        expectedRevision: 0,
        preferences: {
          ...DEFAULT_PLAYBACK_PREFERENCES,
          subtitles: {
            ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
            languages: ["EN-us"],
            streamIndex: 4,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      playbackPreferencesUpdateRequestSchema.safeParse({
        expectedRevision: 0,
        preferences: {
          ...DEFAULT_PLAYBACK_PREFERENCES,
          quality: {
            ...DEFAULT_PLAYBACK_PREFERENCES.quality,
            remoteMaxBitrate: 1_000_000,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("publishes strict route schemas for preference reads and writes", () => {
    expect(playbackPreferencesResponseJsonSchema).toMatchObject({
      additionalProperties: false,
      type: "object",
    });
    expect(playbackPreferencesUpdateRequestJsonSchema).toMatchObject({
      additionalProperties: false,
      type: "object",
    });
  });
});
