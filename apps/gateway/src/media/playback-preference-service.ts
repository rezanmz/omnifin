import {
  DEFAULT_PLAYBACK_PREFERENCES,
  playbackPreferencesResponseSchema,
  playbackPreferencesSchema,
  playbackPreferencesUpdateRequestSchema,
  type PlaybackPreferencesResponse,
  type PlaybackPreferencesUpdateRequest,
} from "@omnifin/contracts/playback";

import type { DatabaseHandle } from "../db/client.js";

interface PlaybackPreferenceRow {
  preferencesJson: string;
  revision: number;
  updatedAt: number;
}

export interface PlaybackPreferenceDependencies {
  clock?: () => Date;
}

export class PlaybackPreferenceError extends Error {
  public readonly reason: "conflict" | "storage_failure";

  public constructor(reason: PlaybackPreferenceError["reason"], options?: ErrorOptions) {
    super("Playback preferences could not be saved.", options);
    this.name = "PlaybackPreferenceError";
    this.reason = reason;
  }
}

function operationTime(clock: () => Date) {
  const value = clock().valueOf();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new PlaybackPreferenceError("storage_failure");
  return value;
}

function response(
  preferencesJson: string,
  revision: number,
  updatedAt: number | null,
  networkClass: "home" | "remote",
): PlaybackPreferencesResponse {
  try {
    return playbackPreferencesResponseSchema.parse({
      networkClass,
      preferences: playbackPreferencesSchema.parse(JSON.parse(preferencesJson)),
      revision,
      updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(),
    });
  } catch (error) {
    throw new PlaybackPreferenceError("storage_failure", { cause: error });
  }
}

const defaultPreferencesJson = JSON.stringify(
  playbackPreferencesSchema.parse(DEFAULT_PLAYBACK_PREFERENCES),
);

export class PlaybackPreferenceService {
  readonly #clock: () => Date;
  readonly #database: DatabaseHandle;

  public constructor(database: DatabaseHandle, dependencies: PlaybackPreferenceDependencies = {}) {
    this.#database = database;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  public read(
    userId: string,
    networkClass: "home" | "remote" = "remote",
  ): PlaybackPreferencesResponse {
    try {
      const row = this.#database.sqlite
        .prepare(
          `select preferences_json as preferencesJson, revision, updated_at as updatedAt
           from playback_preferences
           where user_id = ?
           limit 1`,
        )
        .get(userId) as PlaybackPreferenceRow | undefined;
      return row
        ? response(row.preferencesJson, row.revision, row.updatedAt, networkClass)
        : response(defaultPreferencesJson, 0, null, networkClass);
    } catch (error) {
      if (error instanceof PlaybackPreferenceError) throw error;
      throw new PlaybackPreferenceError("storage_failure", { cause: error });
    }
  }

  public update(
    userId: string,
    rawInput: PlaybackPreferencesUpdateRequest,
    networkClass: "home" | "remote" = "remote",
  ): PlaybackPreferencesResponse {
    const input = playbackPreferencesUpdateRequestSchema.parse(rawInput);
    const preferencesJson = JSON.stringify(input.preferences);
    const now = operationTime(this.#clock);
    try {
      return this.#database.sqlite
        .transaction(() => {
          const existing = this.#database.sqlite
            .prepare(
              `select preferences_json as preferencesJson, revision, updated_at as updatedAt
               from playback_preferences
               where user_id = ?
               limit 1`,
            )
            .get(userId) as PlaybackPreferenceRow | undefined;
          if (!existing) {
            if (input.expectedRevision !== 0) throw new PlaybackPreferenceError("conflict");
            this.#database.sqlite
              .prepare(
                `insert into playback_preferences (
                   user_id, schema_version, preferences_json, revision, created_at, updated_at
                 ) values (?, 1, ?, 1, ?, ?)`,
              )
              .run(userId, preferencesJson, now, now);
            return response(preferencesJson, 1, now, networkClass);
          }
          if (existing.revision !== input.expectedRevision || existing.revision >= 2_147_483_647) {
            throw new PlaybackPreferenceError("conflict");
          }
          const nextRevision = existing.revision + 1;
          const updated = this.#database.sqlite
            .prepare(
              `update playback_preferences
               set preferences_json = ?, schema_version = 1, revision = ?, updated_at = ?
               where user_id = ? and revision = ?`,
            )
            .run(preferencesJson, nextRevision, now, userId, existing.revision);
          if (updated.changes !== 1) throw new PlaybackPreferenceError("conflict");
          return response(preferencesJson, nextRevision, now, networkClass);
        })
        .immediate();
    } catch (error) {
      if (error instanceof PlaybackPreferenceError) throw error;
      throw new PlaybackPreferenceError("storage_failure", { cause: error });
    }
  }
}
