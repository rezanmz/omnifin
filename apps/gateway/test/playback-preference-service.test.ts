import { DEFAULT_PLAYBACK_PREFERENCES } from "@omnifin/contracts/playback";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/client.js";
import {
  PlaybackPreferenceError,
  PlaybackPreferenceService,
} from "../src/media/playback-preference-service.js";

const now = new Date("2026-08-03T20:00:00.000Z");

function harness() {
  const database = openDatabase(":memory:");
  database.migrate();
  database.sqlite.exec(`
    insert into users (id, display_name, role, role_source, status)
    values
      ('viewer-1', 'Viewer one', 'viewer', 'manual', 'active'),
      ('viewer-2', 'Viewer two', 'viewer', 'manual', 'active');
  `);
  return {
    database,
    service: new PlaybackPreferenceService(database, { clock: () => now }),
  };
}

describe("PlaybackPreferenceService", () => {
  it("returns conservative versioned defaults before the first save", () => {
    const { database, service } = harness();
    try {
      expect(service.read("viewer-1")).toEqual({
        networkClass: "remote",
        preferences: DEFAULT_PLAYBACK_PREFERENCES,
        revision: 0,
        updatedAt: null,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from playback_preferences").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("persists semantic preferences with optimistic concurrency", () => {
    const { database, service } = harness();
    const preferences = {
      ...DEFAULT_PLAYBACK_PREFERENCES,
      audio: { languages: ["fa", "en-CA"], preferOriginalLanguage: false },
      subtitles: {
        ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
        languages: ["en"],
        mode: "always" as const,
      },
    };
    try {
      expect(service.update("viewer-1", { expectedRevision: 0, preferences })).toMatchObject({
        preferences,
        revision: 1,
        updatedAt: now.toISOString(),
      });
      expect(service.read("viewer-1")).toMatchObject({ preferences, revision: 1 });

      expect(() =>
        service.update("viewer-1", {
          expectedRevision: 0,
          preferences: DEFAULT_PLAYBACK_PREFERENCES,
        }),
      ).toThrow(PlaybackPreferenceError);
      expect(service.read("viewer-1")).toMatchObject({ preferences, revision: 1 });
    } finally {
      database.close();
    }
  });

  it("isolates users and fails closed for corrupt stored data", () => {
    const { database, service } = harness();
    try {
      service.update("viewer-1", {
        expectedRevision: 0,
        preferences: {
          ...DEFAULT_PLAYBACK_PREFERENCES,
          quality: {
            ...DEFAULT_PLAYBACK_PREFERENCES.quality,
            remoteMaxBitrate: 4_000_000,
          },
        },
      });
      expect(service.read("viewer-2")).toMatchObject({ revision: 0, updatedAt: null });

      database.sqlite
        .prepare(
          "update playback_preferences set preferences_json = '{}' where user_id = 'viewer-1'",
        )
        .run();
      expect(() => service.read("viewer-1")).toThrow(PlaybackPreferenceError);
      expect(service.read("viewer-2")).toMatchObject({ revision: 0 });
    } finally {
      database.close();
    }
  });
});
