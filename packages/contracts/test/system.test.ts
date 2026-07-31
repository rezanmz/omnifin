import { describe, expect, it } from "vitest";

import {
  systemStatusEventCursorSchema,
  systemStatusResponseSchema,
  systemStatusSnapshotEventSchema,
} from "../src/system.js";

const generatedAt = "2026-07-28T23:40:00.000Z";
const sourceId = "source_1234567890123456789012";
const signalId = "signal_1234567890123456789012";
const storageId = "storage_1234567890123456789012";

function response() {
  return {
    generatedAt,
    sources: [
      {
        displayName: "Cinema",
        failure: null,
        id: sourceId,
        service: "radarr",
        signals: [
          {
            id: signalId,
            message: "A new stable release is available.",
            severity: "notice",
            sourceLabel: "Update check",
          },
        ],
        status: "attention",
        storage: [
          {
            freeBytes: 120_000_000_000,
            id: storageId,
            label: "Cinema storage 1",
            state: "warning",
            totalBytes: 1_000_000_000_000,
          },
        ],
      },
    ],
    state: "complete",
    summary: {
      attentionSources: 1,
      criticalStorage: 0,
      errorSignals: 0,
      healthySources: 0,
      noticeSignals: 1,
      sources: 1,
      unavailableSources: 0,
      warningSignals: 0,
      warningStorage: 1,
    },
  };
}

describe("system status contracts", () => {
  it("accepts one strict resumable system-status snapshot event", () => {
    const event = {
      cursor: "system_event_ABCDEFGHIJKLMNOPQRSTUV",
      kind: "snapshot",
      status: response(),
    };

    expect(systemStatusSnapshotEventSchema.parse(event)).toEqual(event);
    expect(systemStatusEventCursorSchema.safeParse("private-upstream-cursor").success).toBe(false);
    expect(
      systemStatusSnapshotEventSchema.safeParse({ ...event, privatePath: "/srv/media" }).success,
    ).toBe(false);
  });

  it("accepts a normalized source with bounded health and storage signals", () => {
    expect(systemStatusResponseSchema.parse(response())).toEqual(response());
  });

  it("accepts an explicit unconfigured state", () => {
    expect(
      systemStatusResponseSchema.parse({
        generatedAt,
        sources: [],
        state: "unconfigured",
        summary: {
          attentionSources: 0,
          criticalStorage: 0,
          errorSignals: 0,
          healthySources: 0,
          noticeSignals: 0,
          sources: 0,
          unavailableSources: 0,
          warningSignals: 0,
          warningStorage: 0,
        },
      }).state,
    ).toBe("unconfigured");
  });

  it("rejects raw upstream paths, links, and identifiers", () => {
    const value = response();
    const source = value.sources[0]!;
    const storage = source.storage[0]!;
    const signal = source.signals[0]!;
    expect(
      systemStatusResponseSchema.safeParse({
        ...value,
        sources: [
          {
            ...source,
            signals: [{ ...signal, wikiUrl: "https://wiki.example.test/system" }],
            storage: [{ ...storage, path: "/srv/media/movies" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects contradictory capacity, source, and summary states", () => {
    const value = response();
    const source = value.sources[0]!;
    expect(
      systemStatusResponseSchema.safeParse({
        ...value,
        sources: [
          {
            ...source,
            status: "healthy",
            storage: [
              {
                ...source.storage[0]!,
                freeBytes: 20,
                state: "healthy",
                totalBytes: 100,
              },
            ],
          },
        ],
        summary: { ...value.summary, attentionSources: 0, healthySources: 1 },
      }).success,
    ).toBe(false);
    expect(
      systemStatusResponseSchema.safeParse({
        ...value,
        summary: { ...value.summary, noticeSignals: 0 },
      }).success,
    ).toBe(false);
  });
});
