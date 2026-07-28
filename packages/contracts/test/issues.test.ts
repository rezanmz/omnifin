import { describe, expect, it } from "vitest";

import {
  mediaIssueStatusUpdateSchema,
  mediaIssueWorkbenchPageSchema,
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

  it("normalizes an operator workbench without upstream identities", () => {
    const page = mediaIssueWorkbenchPageSchema.parse({
      generatedAt: "2026-07-28T12:00:00.000Z",
      items: [
        {
          category: "subtitles",
          createdAt: "2026-07-28T11:00:00.000Z",
          episodeNumber: 3,
          id: `issue_${"s".repeat(22)}`,
          kind: "episode",
          positionSeconds: null,
          reportedBy: "Mara Chen",
          seasonNumber: 2,
          source: "seerr",
          status: "open",
          summary: "Captions drift after the opening scene.",
          title: "Northern Lights",
          updatedAt: "2026-07-28T11:05:00.000Z",
          year: 2026,
        },
      ],
      limit: 20,
      source: "all",
      sourceStates: { omnifin: "available", seerr: "available" },
      status: "open",
      truncated: false,
    });

    expect(page.items[0]?.id).not.toContain("123");
    expect(Object.keys(page.items[0] ?? {})).not.toEqual(
      expect.arrayContaining(["email", "tmdbId", "upstreamId"]),
    );
  });

  it("accepts bounded resolve and reopen decisions", () => {
    expect(mediaIssueStatusUpdateSchema.parse({ status: "resolved" })).toEqual({
      note: null,
      status: "resolved",
    });
    expect(() =>
      mediaIssueStatusUpdateSchema.parse({ note: "visible\u0000hidden", status: "open" }),
    ).toThrow();
  });
});
