import { describe, expect, it } from "vitest";

import {
  playbackIssueCreateRequestSchema,
  playbackIssueIdSchema,
  playbackIssueSchema,
} from "../src/issues.js";

describe("playback issue contracts", () => {
  it("accepts a bounded player report without upstream identifiers", () => {
    const issue = playbackIssueCreateRequestSchema.parse({
      category: "subtitles",
      description: "Captions drift after the second scene.",
      positionSeconds: 1_242,
    });
    expect(issue).toEqual({
      category: "subtitles",
      description: "Captions drift after the second scene.",
      positionSeconds: 1_242,
    });
    expect(Object.keys(issue)).not.toContain("itemId");
  });

  it("allows a report without free-form text and rejects control characters", () => {
    expect(
      playbackIssueCreateRequestSchema.parse({
        category: "buffering",
        description: null,
        positionSeconds: 12,
      }).description,
    ).toBeNull();
    expect(() =>
      playbackIssueCreateRequestSchema.parse({
        category: "other",
        description: "visible\u0000hidden",
        positionSeconds: 0,
      }),
    ).toThrow();
  });

  it("keeps issue identifiers and public records opaque", () => {
    const id = `issue_${"i".repeat(22)}`;
    expect(playbackIssueIdSchema.parse(id)).toBe(id);
    expect(
      playbackIssueSchema.parse({
        category: "audio",
        createdAt: "2026-07-28T12:00:00.000Z",
        id,
        positionSeconds: 42,
        status: "open",
      }),
    ).toEqual({
      category: "audio",
      createdAt: "2026-07-28T12:00:00.000Z",
      id,
      positionSeconds: 42,
      status: "open",
    });
  });
});
