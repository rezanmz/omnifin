import { describe, expect, it } from "vitest";

import { matchEngineAudioTrack, type HlsAudioTrackSummary } from "./player-engine";

const tracks: HlsAudioTrackSummary[] = [
  { channels: "6", id: 1, lang: "eng", name: "English 5.1" },
  { channels: "2", id: 3, lang: "spa", name: "Español" },
  { id: 5, lang: "eng", name: "English Commentary" },
];

describe("matchEngineAudioTrack", () => {
  it("prefers an exact language and name match", () => {
    expect(matchEngineAudioTrack({ language: "eng", title: "English 5.1" }, tracks)).toMatchObject({
      id: 1,
    });
  });

  it("falls back to a language match when names differ", () => {
    expect(matchEngineAudioTrack({ language: "spa", title: "Spanish" }, tracks)).toMatchObject({
      id: 3,
    });
  });

  it("matches language and name case-insensitively", () => {
    expect(matchEngineAudioTrack({ language: "ENG", title: "ENGLISH 5.1" }, tracks)).toMatchObject({
      id: 1,
    });
    expect(matchEngineAudioTrack({ language: "Esp", title: "ESPAÑOL" }, tracks)).toMatchObject({
      id: 3,
    });
  });

  it("matches by name only when the target has no language", () => {
    expect(matchEngineAudioTrack({ language: null, title: "Español" }, tracks)).toMatchObject({
      id: 3,
    });
  });

  it("returns null when nothing matches", () => {
    expect(matchEngineAudioTrack({ language: "deu", title: "Deutsch" }, tracks)).toBeNull();
    expect(matchEngineAudioTrack({ language: null, title: "Unknown" }, tracks)).toBeNull();
    expect(matchEngineAudioTrack({ language: "eng", title: null }, tracks)).toMatchObject({
      id: 1,
    });
  });
});
