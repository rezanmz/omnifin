export const MAX_PLAYBACK_ASSET_TOKEN_LENGTH = 8_192;
export const MAX_PLAYBACK_MANIFEST_BYTES = 2 * 1_024 * 1_024;
export const MAX_PLAYBACK_MANIFEST_REFERENCES = 20_000;
export const MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION = 20_000;
export const MAX_PLAYBACK_ASSET_HANDLES_GLOBAL = 250_000;
export const PLAYBACK_ASSET_HANDLE_BATCH_SIZE = 100;

export const MAX_ACTIVE_PLAYBACK_TRANSFERS_GLOBAL = 32;
export const MAX_ACTIVE_PLAYBACK_TRANSFERS_PER_USER = 8;

export interface PlaybackTransferLimitOverrides {
  global?: number;
  perUser?: number;
}

function configuredLimit(value: number | undefined, fallback: number) {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class PlaybackTransferLeaseManager {
  readonly #activeByUser = new Map<string, number>();
  readonly #globalLimit: number;
  readonly #perUserLimit: number;
  #activeGlobal = 0;

  public constructor(overrides: PlaybackTransferLimitOverrides = {}) {
    this.#globalLimit = configuredLimit(overrides.global, MAX_ACTIVE_PLAYBACK_TRANSFERS_GLOBAL);
    this.#perUserLimit = configuredLimit(overrides.perUser, MAX_ACTIVE_PLAYBACK_TRANSFERS_PER_USER);
  }

  public acquire(userId: string): (() => void) | null {
    const activeForUser = this.#activeByUser.get(userId) ?? 0;
    if (this.#activeGlobal >= this.#globalLimit || activeForUser >= this.#perUserLimit) {
      return null;
    }

    this.#activeGlobal += 1;
    this.#activeByUser.set(userId, activeForUser + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeGlobal -= 1;
      const remaining = (this.#activeByUser.get(userId) ?? 1) - 1;
      if (remaining <= 0) this.#activeByUser.delete(userId);
      else this.#activeByUser.set(userId, remaining);
    };
  }
}
