import type HlsType from "hls.js";

/** A single manifest rendition as surfaced by the engine. */
export interface HlsLevelSummary {
  bitrate: number;
  height: number | undefined;
  index: number;
}

/**
 * Minimal engine seam the theater player drives. The component only relies on
 * these methods, so the engine behind the seam can be swapped without touching
 * the player's state machine or controls.
 */
export interface PlayerHandle {
  currentLevel(): number;
  dispose(): void;
  error(): { code?: number; message?: string } | null;
  levels(): HlsLevelSummary[];
  on(event: string, listener: (...args: unknown[]) => void): void;
  one(event: string, listener: () => void): void;
  play(): Promise<void>;
  setAutoLevel(): void;
  setLevel(index: number): void;
  src(source: { src: string; type: string }): void;
}

type HlsFailureRecovery = "media_recovery" | "network_retry" | "stopped";
type HlsFailureStage = "engine" | "fragment" | "manifest" | "media" | "playlist";

interface HlsFailureData {
  details?: unknown;
  fatal?: unknown;
  response?: { code?: unknown } | null;
  type?: unknown;
}

const SAFE_HLS_DIAGNOSTIC_VALUE = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

function safeHlsDiagnosticValue(value: unknown) {
  return typeof value === "string" && SAFE_HLS_DIAGNOSTIC_VALUE.test(value) ? value : "unknown";
}

function hlsFailureStage(details: string): HlsFailureStage {
  const normalized = details.toLowerCase();
  if (normalized.includes("manifest")) return "manifest";
  if (normalized.includes("level") || normalized.includes("track")) return "playlist";
  if (normalized.includes("frag") || normalized.includes("key")) return "fragment";
  if (normalized.includes("buffer") || normalized.includes("media") || normalized.includes("mux")) {
    return "media";
  }
  return "engine";
}

function recordHlsFailure(data: HlsFailureData, recovery: HlsFailureRecovery) {
  const details = safeHlsDiagnosticValue(data.details);
  const responseCode = data.response?.code;
  const httpStatus =
    typeof responseCode === "number" &&
    Number.isInteger(responseCode) &&
    responseCode >= 100 &&
    responseCode <= 599
      ? responseCode
      : null;
  console.warn(
    JSON.stringify({
      details,
      event: "hls_playback_failure",
      fatal: data.fatal === true,
      httpStatus,
      recovery,
      stage: hlsFailureStage(details),
      type: safeHlsDiagnosticValue(data.type),
    }),
  );
}

type EventListener = (...args: unknown[]) => void;

function createEmitter() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    emit(event: string, ...args: unknown[]) {
      for (const listener of Array.from(listeners.get(event) ?? [])) listener(...args);
    },
    off(event: string, listener: EventListener) {
      listeners.get(event)?.delete(listener);
    },
    on(event: string, listener: EventListener) {
      const group = listeners.get(event) ?? new Set<EventListener>();
      group.add(listener);
      listeners.set(event, group);
    },
    one(event: string, listener: EventListener) {
      const once: EventListener = (...args) => {
        listeners.get(event)?.delete(once);
        listener(...args);
      };
      const group = listeners.get(event) ?? new Set<EventListener>();
      group.add(once);
      listeners.set(event, group);
    },
  };
}

/**
 * Creates a player handle backed by an hls.js instance attached to the given
 * media element. The Hls constructor is injected so the lazy module import
 * stays in the component while this stays trivially testable.
 */
export function createHlsPlayerHandle(video: HTMLVideoElement, Hls: typeof HlsType): PlayerHandle {
  const emitter = createEmitter();
  const hls = new Hls({
    backBufferLength: 90,
    capLevelToPlayerSize: true,
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 30,
  });
  let lastError: { code?: number; message?: string } | null = null;
  let networkRecoveries = 0;
  let mediaRecoveries = 0;
  let capturedLevels: HlsLevelSummary[] = [];
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
      networkRecoveries += 1;
      recordHlsFailure(data, "network_retry");
      // Deviation from the reference player (which set buffering state here):
      // the component drives buffering from the video element's native
      // `waiting` event, so retries during playback show the same spinner;
      // retries before playback starts (initial manifest load) do not.
      hls.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
      mediaRecoveries += 1;
      recordHlsFailure(data, "media_recovery");
      hls.recoverMediaError();
      return;
    }
    recordHlsFailure(data, "stopped");
    lastError = {
      ...(typeof data.response?.code === "number" ? { code: data.response.code } : {}),
      ...(typeof data.details === "string" ? { message: data.details } : {}),
    };
    emitter.emit("error");
  });
  hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
    capturedLevels = (data.levels ?? []).map((level, index) => ({
      bitrate: level.bitrate,
      height: level.height,
      index,
    }));
    emitter.emit("levelchanged");
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, () => {
    // The current level is read live from the hls instance; this notification
    // keeps the component's level state in sync with hls.js's own tracking.
    emitter.emit("levelchanged");
  });
  return {
    currentLevel() {
      return hls.currentLevel;
    },
    dispose() {
      hls.destroy();
    },
    error() {
      return lastError;
    },
    levels() {
      return capturedLevels;
    },
    on: emitter.on,
    one: emitter.one,
    play() {
      return video.play();
    },
    setAutoLevel() {
      hls.currentLevel = -1;
    },
    setLevel(index) {
      hls.currentLevel = index;
    },
    src(source) {
      // Each new source gets a fresh recovery budget (the reference player
      // destroyed its Hls instance per stream; this engine reuses one).
      networkRecoveries = 0;
      mediaRecoveries = 0;
      capturedLevels = [];
      emitter.emit("levelchanged");
      hls.loadSource(source.src);
      if (!hls.media) hls.attachMedia(video);
      emitter.emit("ready");
    },
  };
}

/**
 * Creates a player handle for browsers that can play HLS natively
 * (Safari) when hls.js reports itself unsupported.
 */
export function createNativeHlsPlayerHandle(video: HTMLVideoElement): PlayerHandle {
  const emitter = createEmitter();
  let lastError: { code?: number; message?: string } | null = null;
  const onVideoError = () => {
    const mediaError = video.error;
    lastError = mediaError
      ? { code: mediaError.code, message: mediaError.message }
      : { code: 4, message: "The native HLS stream could not be played." };
    emitter.emit("error");
  };
  video.addEventListener("error", onVideoError);
  return {
    currentLevel() {
      // Native HLS exposes no level introspection; the UI must treat the
      // stream as a single auto rendition.
      return -1;
    },
    dispose() {
      video.removeEventListener("error", onVideoError);
      video.removeAttribute("src");
      video.load();
    },
    error() {
      return lastError;
    },
    levels() {
      return [];
    },
    on: emitter.on,
    one: emitter.one,
    play() {
      return video.play();
    },
    setAutoLevel() {
      // No-op: native HLS has no client-side rendition selection.
    },
    setLevel(_index: number) {
      // No-op: native HLS has no client-side rendition selection.
    },
    src(source) {
      video.src = source.src;
      emitter.emit("ready");
    },
  };
}
