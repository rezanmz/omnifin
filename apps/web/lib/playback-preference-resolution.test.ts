import {
  DEFAULT_PLAYBACK_PREFERENCES,
  type PlaybackAudioTrack,
  type PlaybackSubtitleTrack,
} from "@omnifin/contracts/playback";
import { describe, expect, it } from "vitest";

import { resolvePlaybackPreferences } from "./playback-preference-resolution";

const audio = (values: Partial<PlaybackAudioTrack> & Pick<PlaybackAudioTrack, "index">) => ({
  channels: 2,
  codec: "aac",
  default: false,
  language: null,
  selected: false,
  title: null,
  ...values,
});
const subtitle = (
  values: Partial<PlaybackSubtitleTrack> & Pick<PlaybackSubtitleTrack, "index">,
) => ({
  codec: "subrip",
  default: false,
  delivery: "video" as const,
  forced: false,
  language: null,
  selected: false,
  title: null,
  ...values,
});

describe("resolvePlaybackPreferences", () => {
  it("matches semantic languages across changing stream indexes and ISO aliases", () => {
    const preferences = {
      ...DEFAULT_PLAYBACK_PREFERENCES,
      audio: { languages: ["fa", "en-CA"], preferOriginalLanguage: false },
      subtitles: {
        ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
        languages: ["en-CA"],
        mode: "always" as const,
      },
    };
    const resolved = resolvePlaybackPreferences(preferences, "remote", {
      audioTracks: [
        audio({ default: true, index: 1, language: "eng", selected: true }),
        audio({ index: 9, language: "fas" }),
      ],
      subtitleTracks: [subtitle({ index: 42, language: "eng" })],
    });

    expect(resolved).toMatchObject({
      audioStreamIndex: 9,
      effectiveAudioStreamIndex: 9,
      subtitleStreamIndex: 42,
    });
    expect(JSON.stringify(resolved)).not.toMatch(/media_|device|ipAddress/iu);
  });

  it("prefers labelled original audio without accidentally selecting commentary", () => {
    const resolved = resolvePlaybackPreferences(DEFAULT_PLAYBACK_PREFERENCES, "home", {
      audioTracks: [
        audio({ default: true, index: 2, selected: true, title: "Director commentary" }),
        audio({ index: 5, language: "jpn", original: true, title: "Japanese" }),
      ],
      subtitleTracks: [],
    });

    expect(resolved.audioStreamIndex).toBe(5);
    expect(resolved.explanations.audio).toMatch(/original-language/iu);
    expect(resolved.maxStreamingBitrate).toBe(200_000_000);
  });

  it("handles forced, SDH, commentary, and missing-language subtitle roles deterministically", () => {
    const tracks = [
      subtitle({ default: true, index: 3, language: "eng", title: "English commentary" }),
      subtitle({ forced: true, index: 4, language: "eng", title: "English forced" }),
      subtitle({ hearingImpaired: true, index: 5, language: "eng", title: "English" }),
      subtitle({ index: 6, title: "Signs and songs" }),
    ];
    const forced = resolvePlaybackPreferences(
      {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        subtitles: {
          ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
          languages: ["en"],
          mode: "forced",
        },
      },
      "remote",
      {
        audioTracks: [audio({ default: true, index: 1, language: "eng", selected: true })],
        subtitleTracks: tracks,
      },
    );
    expect(forced.subtitleStreamIndex).toBe(4);

    const sdh = resolvePlaybackPreferences(
      {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        subtitles: {
          ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
          languages: ["en"],
          mode: "always",
          preferForced: false,
          preferHearingImpaired: true,
        },
      },
      "remote",
      { audioTracks: [], subtitleTracks: tracks },
    );
    expect(sdh.subtitleStreamIndex).toBe(5);
  });

  it("uses trusted network classification only for automatic quality policy", () => {
    const automatic = resolvePlaybackPreferences(DEFAULT_PLAYBACK_PREFERENCES, "remote", {
      audioTracks: [],
      subtitleTracks: [],
    });
    expect(automatic).toMatchObject({
      effectiveNetworkClass: "remote",
      maxStreamingBitrate: 10_000_000,
    });

    const manualHome = resolvePlaybackPreferences(
      {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        quality: {
          defaultNetworkPolicy: "home",
          homeMaxBitrate: 40_000_000,
          remoteMaxBitrate: 2_000_000,
        },
      },
      "remote",
      { audioTracks: [], subtitleTracks: [] },
    );
    expect(manualHome).toMatchObject({
      effectiveNetworkClass: "home",
      maxStreamingBitrate: 40_000_000,
    });
  });
});
