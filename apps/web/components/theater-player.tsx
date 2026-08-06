"use client";

import "video.js/dist/video-js.css";
import type { PlaybackNegotiationResponse } from "@omnifin/contracts/playback";
import {
  Bug,
  Captions,
  CheckCircle2,
  CircleAlert,
  Headphones,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Send,
  Settings2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  browserPlaybackPath,
  browserPlaybackSubtitlePath,
  playbackClient,
  type PlaybackClient,
  type PlaybackPreparationOptions,
  type PreparedPlayback,
} from "../lib/playback";
import type { SubtitleClient } from "../lib/subtitles";
import styles from "./theater-player.module.css";

const SubtitleWorkbench = dynamic(
  () => import("./subtitle-workbench").then((module) => module.SubtitleWorkbench),
  {
    loading: () => (
      <section aria-label="Opening subtitle workbench" className={styles.subtitleChunkLoader}>
        <LoaderCircle aria-hidden="true" className={styles.spinner} size={18} />
        <span>Opening subtitle workbench…</span>
      </section>
    ),
    ssr: false,
  },
);

export interface TheaterMedia {
  accent: string;
  artworkPath?: string;
  eyebrow: string;
  id: string;
  positionSeconds: number;
  title: string;
}

export interface TheaterPlayerProperties {
  client?: PlaybackClient;
  media: TheaterMedia;
  onClose: () => void;
  startWhenReady?: boolean;
  subtitleClient?: SubtitleClient;
}

type PlayerStatus = "error" | "preparing" | "ready" | "unsupported";

interface PlayerHandle {
  dispose(): void;
  error(): { code?: number; message?: string } | null;
  on(event: string, listener: (...args: unknown[]) => void): void;
  one(event: string, listener: () => void): void;
  play(): Promise<void>;
  src(source: { src: string; type: string }): void;
}

type ReportedState = "negotiated" | "paused" | "playing" | "stopped";
type QualityPreset = "auto" | "balanced" | "data-saver" | "high" | "original";
type IssueCategory = "audio" | "buffering" | "other" | "subtitles" | "sync" | "video_quality";
type IssueStatus = "error" | "idle" | "submitting" | "success";
type MediaFailureRecovery = "media_recovery" | "network_retry" | "stopped";

interface MediaFailureData {
  code?: unknown;
  details?: unknown;
  source?: unknown;
}

interface PlaybackPreferences {
  audioStreamIndex: number | null;
  quality: QualityPreset;
  subtitleStreamIndex: number | null;
}

const QUALITY_PRESETS = {
  auto: { bitrate: 80_000_000, label: "Auto", mode: "auto" },
  original: { bitrate: 200_000_000, label: "Original quality", mode: "auto" },
  high: { bitrate: 20_000_000, label: "High · 20 Mbps", mode: "transcode" },
  balanced: { bitrate: 10_000_000, label: "Balanced · 10 Mbps", mode: "transcode" },
  "data-saver": { bitrate: 4_000_000, label: "Data saver · 4 Mbps", mode: "transcode" },
} as const satisfies Record<
  QualityPreset,
  { bitrate: number; label: string; mode: "auto" | "direct" | "transcode" }
>;

const ISSUE_CATEGORIES = [
  { label: "Buffering", value: "buffering" },
  { label: "Audio", value: "audio" },
  { label: "Subtitles", value: "subtitles" },
  { label: "A/V sync", value: "sync" },
  { label: "Video quality", value: "video_quality" },
  { label: "Other", value: "other" },
] as const satisfies readonly { label: string; value: IssueCategory }[];

const SAFE_MEDIA_DIAGNOSTIC_VALUE = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

function safeMediaDiagnosticValue(value: unknown) {
  return typeof value === "string" && SAFE_MEDIA_DIAGNOSTIC_VALUE.test(value) ? value : "unknown";
}

function recordMediaFailure(data: MediaFailureData, recovery: MediaFailureRecovery) {
  const details = safeMediaDiagnosticValue(data.details);
  const code = safeMediaDiagnosticValue(data.code);
  console.warn(
    JSON.stringify({
      code,
      details,
      event: "media_playback_failure",
      recovery,
      source: safeMediaDiagnosticValue(data.source),
    }),
  );
}

function preparationOptions(
  preferences: PlaybackPreferences,
  session?: PlaybackNegotiationResponse | null,
): PlaybackPreparationOptions {
  const quality = QUALITY_PRESETS[preferences.quality];
  const customTracks = preferences.audioStreamIndex !== null;
  const selectedSubtitle = session?.subtitleTracks.find(
    (track) => track.index === preferences.subtitleStreamIndex,
  );
  const clientRenderedSubtitle =
    selectedSubtitle !== undefined &&
    selectedSubtitle.subtitlePath !== undefined &&
    subtitleKind(selectedSubtitle) !== undefined;
  return {
    audioStreamIndex: preferences.audioStreamIndex,
    maxStreamingBitrate: quality.bitrate,
    mode: customTracks ? "transcode" : quality.mode,
    subtitleStreamIndex: clientRenderedSubtitle ? null : preferences.subtitleStreamIndex,
  };
}

function trackLabel(track: {
  channels?: number | null;
  codec: string | null;
  index: number;
  language: string | null;
  title: string | null;
}) {
  const primary = track.title ?? track.language?.toUpperCase() ?? track.codec?.toUpperCase();
  const detail = [track.language?.toUpperCase(), track.codec?.toUpperCase()]
    .filter((value, index, values) => value && value !== primary && values.indexOf(value) === index)
    .join(" · ");
  const channels = track.channels && track.channels > 2 ? `${track.channels} channels` : null;
  return [primary ?? `Track ${track.index}`, detail, channels].filter(Boolean).join(" · ");
}

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainder = safeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function subtitleKind(track: { codec: string | null; delivery: "external" | "hls" | "video" }) {
  if (track.delivery === "hls") return undefined;
  const codec = track.codec?.toLowerCase();
  if (
    codec &&
    ["ass", "mov_text", "sami", "smi", "srt", "ssa", "subrip", "vtt", "webvtt"].includes(codec)
  ) {
    return "subtitles" as const;
  }
  return undefined;
}

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement && Boolean(target.closest("button, input, select, textarea"))
  );
}

export function TheaterPlayer({
  client = playbackClient,
  media,
  onClose,
  startWhenReady = false,
  subtitleClient,
}: TheaterPlayerProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const stageReference = useRef<HTMLDivElement>(null);
  const videoReference = useRef<HTMLVideoElement>(null);
  const playerReference = useRef<PlayerHandle | null>(null);
  const reportQueueReference = useRef(Promise.resolve());
  const reportedStateReference = useRef<ReportedState>("negotiated");
  const preparedReference = useRef<PreparedPlayback | null>(null);
  const preferencesReference = useRef<PlaybackPreferences>({
    audioStreamIndex: null,
    quality: "original",
    subtitleStreamIndex: null,
  });
  const replacementControllerReference = useRef<AbortController | null>(null);
  const replacementGenerationReference = useRef(0);
  const replacementReference = useRef<{
    generation: number;
    previous: PreparedPlayback;
    previousPosition: number;
    previousPreferences: PlaybackPreferences;
    resume: boolean;
  } | null>(null);
  const restorePositionReference = useRef<number | null>(null);
  const startWhenReadyReference = useRef(startWhenReady);
  const lastProgressReference = useRef(0);
  const absolutePositionReference = useRef<() => number>(() => media.positionSeconds);
  const controlsTimeoutReference = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimerReference = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedPositionReference = useRef(media.positionSeconds);
  const restoreSubtitleFocusReference = useRef(false);
  const subtitleTriggerReference = useRef<HTMLButtonElement>(null);
  const subtitleTracksByIndexReference = useRef(new Map<number, TextTrack | null>());
  const subtitleSuppressedReference = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const [attempt, setAttempt] = useState(0);
  const [preferences, setPreferences] = useState<PlaybackPreferences>({
    audioStreamIndex: null,
    quality: "original",
    subtitleStreamIndex: null,
  });
  const [prepared, setPrepared] = useState<PreparedPlayback | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("preparing");
  const [message, setMessage] = useState("Opening a private playback session…");
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [issuePanelOpen, setIssuePanelOpen] = useState(false);
  const [subtitleWorkbenchOpen, setSubtitleWorkbenchOpen] = useState(false);
  const [issueCategory, setIssueCategory] = useState<IssueCategory>("buffering");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueStatus, setIssueStatus] = useState<IssueStatus>("idle");
  const [issueMessage, setIssueMessage] = useState("");
  const [currentTime, setCurrentTime] = useState(media.positionSeconds);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [syncInterrupted, setSyncInterrupted] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [transitionMessage, setTransitionMessage] = useState("");

  const close = useCallback(() => {
    const dialog = dialogReference.current;
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    else onClose();
  }, [onClose]);

  useEffect(() => {
    preparedReference.current = prepared;
  }, [prepared]);

  useEffect(() => {
    preferencesReference.current = preferences;
  }, [preferences]);

  const stopSession = useCallback(
    (target: PreparedPlayback, positionSeconds: number, keepalive = false) => {
      void client
        .report(
          target.session.sessionId,
          { event: "stopped", positionSeconds: Math.max(0, Math.floor(positionSeconds)) },
          target.csrfToken,
          { keepalive },
        )
        .catch(() => setSyncInterrupted(true));
    },
    [client],
  );

  const rollbackReplacement = useCallback(
    (reason: string) => {
      const replacement = replacementReference.current;
      if (!replacement) return false;
      const failed = preparedReference.current;
      replacementReference.current = null;
      if (failed && failed.session.sessionId !== replacement.previous.session.sessionId) {
        stopSession(failed, failed.session.positionSeconds);
      }
      preferencesReference.current = replacement.previousPreferences;
      preparedReference.current = replacement.previous;
      restorePositionReference.current = replacement.previousPosition;
      setPreferences(replacement.previousPreferences);
      setPrepared(replacement.previous);
      reportedStateReference.current = replacement.resume ? "paused" : "negotiated";
      startWhenReadyReference.current = replacement.resume;
      setSwitching(false);
      setBuffering(false);
      setStatus("preparing");
      setMessage("Restoring the previous stream…");
      setTransitionMessage(reason);
      return true;
    },
    [stopSession],
  );

  const queueReport = useCallback(
    (
      event: "paused" | "progress" | "started" | "stopped",
      positionSeconds: number,
      keepalive = false,
    ) => {
      if (!prepared) return;
      reportQueueReference.current = reportQueueReference.current
        .catch(() => undefined)
        .then(async () => {
          const state = reportedStateReference.current;
          if (state === "stopped") return;
          if (event === "progress" && state !== "playing") return;
          if (event === "paused" && state !== "playing") return;
          if (event === "started" && !["negotiated", "paused", "playing"].includes(state)) return;
          await client.report(
            prepared.session.sessionId,
            { event, positionSeconds: Math.max(0, Math.floor(positionSeconds)) },
            prepared.csrfToken,
            { keepalive },
          );
          reportedStateReference.current =
            event === "stopped" ? "stopped" : event === "paused" ? "paused" : "playing";
          setSyncInterrupted(false);
        })
        .catch(() => setSyncInterrupted(true));
    },
    [client, prepared],
  );

  const absolutePosition = useCallback(() => {
    const video = videoReference.current;
    if (!video || !prepared) return currentTime;
    return prepared.session.delivery === "hls"
      ? prepared.session.positionSeconds + Math.max(0, video.currentTime)
      : video.currentTime === 0 && currentTime > 0
        ? currentTime
        : Math.max(0, video.currentTime);
  }, [currentTime, prepared]);

  useEffect(() => {
    absolutePositionReference.current = absolutePosition;
  }, [absolutePosition]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimeoutReference.current) clearTimeout(controlsTimeoutReference.current);
    controlsTimeoutReference.current = null;
    if (playing && !settingsOpen && !issuePanelOpen && !subtitleWorkbenchOpen) {
      controlsTimeoutReference.current = setTimeout(() => setControlsVisible(false), 2_800);
    }
  }, [issuePanelOpen, playing, settingsOpen, subtitleWorkbenchOpen]);

  useEffect(() => {
    const dialog = dialogReference.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  }, []);

  const selectSubtitleTrack = useCallback((subtitleStreamIndex: number | null) => {
    const tracks = subtitleTracksByIndexReference.current;
    if (tracks.size === 0) return subtitleStreamIndex === null;
    let resolved = subtitleStreamIndex === null;
    for (const [index, track] of tracks.entries()) {
      if (track === null) continue;
      try {
        if (subtitleStreamIndex !== null && index === subtitleStreamIndex) {
          track.mode = "showing";
          resolved = true;
        } else if (track.mode === "showing" || track.mode === "hidden") {
          track.mode = "disabled";
        }
      } catch {
        // Mode assignment is a browser-owned property; ignore unsupported setters.
      }
    }
    return resolved;
  }, []);

  const setSubtitleTrack = useCallback(
    (subtitleStreamIndex: number | null) => {
      const active = prepared;
      if (!active) return;
      const track =
        subtitleStreamIndex === null
          ? null
          : (active.session.subtitleTracks.find(
              (candidate) => candidate.index === subtitleStreamIndex,
            ) ?? null);
      const clientToggleableTrack =
        subtitleStreamIndex !== null
          ? track !== null && track.subtitlePath !== undefined && subtitleKind(track)
          : active.session.subtitleTracks.some(
              (candidate) => candidate.subtitlePath !== undefined && subtitleKind(candidate),
            );
      const toggleable = clientToggleableTrack && selectSubtitleTrack(subtitleStreamIndex);
      if (toggleable) {
        const nextPreferences = { ...preferences, subtitleStreamIndex };
        preferencesReference.current = nextPreferences;
        subtitleSuppressedReference.current = subtitleStreamIndex === null;
        setPreferences(nextPreferences);
        setTransitionMessage(
          subtitleStreamIndex === null ? "Turning subtitles off…" : "Loading subtitles…",
        );
        return;
      }
      const nextPreferences = {
        ...preferences,
        quality:
          subtitleStreamIndex !== null && preferences.quality === "original"
            ? "auto"
            : preferences.quality,
        subtitleStreamIndex,
      } satisfies PlaybackPreferences;
      void replacePlayback(
        nextPreferences,
        absolutePosition(),
        subtitleStreamIndex === null ? "Turning subtitles off…" : "Loading subtitles…",
      );
    },
    [absolutePosition, preferences, prepared, replacePlayback, selectSubtitleTrack],
  );

  useEffect(() => {
    if (!restoreSubtitleFocusReference.current || subtitleWorkbenchOpen || !settingsOpen) return;
    subtitleTriggerReference.current?.focus();
    restoreSubtitleFocusReference.current = false;
  }, [settingsOpen, subtitleWorkbenchOpen]);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reportedStateReference.current = "negotiated";
    void client
      .prepare(
        media.id,
        requestedPositionReference.current,
        controller.signal,
        preparationOptions(preferencesReference.current, preparedReference.current?.session),
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        preparedReference.current = result;
        setPrepared(result);
        setDuration(result.session.media.durationSeconds);
        setCurrentTime(result.session.positionSeconds);
        setSeekPreview(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Playback could not be prepared.");
      });
    return () => controller.abort();
  }, [attempt, client, media.id]);

  useEffect(() => {
    if (!prepared) return;
    const video = videoReference.current;
    if (!video) return;
    let cancelled = false;
    const replacementGeneration = replacementReference.current?.generation;
    const readinessTimeout =
      replacementGeneration === undefined
        ? null
        : setTimeout(() => {
            if (replacementReference.current?.generation !== replacementGeneration) return;
            rollbackReplacement(
              "The new stream took too long to become ready. The previous stream was restored.",
            );
          }, 15_000);
    const source = browserPlaybackPath(prepared.session.streamPath);
    const clearTracks = () => {
      for (const child of Array.from(video.children)) {
        if (child instanceof HTMLTrackElement) child.remove();
      }
      subtitleTracksByIndexReference.current = new Map();
    };
    const attachSubtitles = () => {
      subtitleTracksByIndexReference.current = new Map();
      for (const track of prepared.session.subtitleTracks) {
        if (track.subtitlePath === undefined) continue;
        const kind = subtitleKind(track);
        if (kind === undefined) continue;
        const trackElement = document.createElement("track");
        trackElement.kind = kind;
        trackElement.label = track.title ?? `Track ${track.index}`;
        if (track.language !== null && track.language !== undefined) {
          trackElement.srclang = track.language;
        }
        if (track.selected) trackElement.default = true;
        trackElement.src = browserPlaybackSubtitlePath(track.subtitlePath);
        video.appendChild(trackElement);
        let textTrack: TextTrack | null = null;
        try {
          textTrack = trackElement.track ?? null;
          if (textTrack) textTrack.mode = "disabled";
        } catch {
          textTrack = null;
        }
        subtitleTracksByIndexReference.current.set(track.index, textTrack);
      }
      const preferredIndex = subtitleSuppressedReference.current
        ? null
        : (preferencesReference.current.subtitleStreamIndex ??
          prepared.session.subtitleTracks.find((track) => track.selected)?.index ??
          null);
      selectSubtitleTrack(preferredIndex);
    };
    const attach = async () => {
      if (prepared.session.delivery === "direct") {
        const activePlayer = playerReference.current;
        if (activePlayer) {
          playerReference.current = null;
          activePlayer.dispose();
        }
        if (stageReference.current && !video.parentNode) {
          stageReference.current.insertBefore(video, stageReference.current.firstChild);
        }
        if (typeof styles.video === "string") video.className = styles.video;
        clearTracks();
        attachSubtitles();
        video.src = source;
        setStatus("ready");
        setMessage("Ready to resume");
        return;
      }
      let player = playerReference.current;
      if (!player) {
        const videojsModule = await import("video.js");
        if (cancelled) return;
        const videojs = videojsModule.default;
        player = videojs(video, {
          autoplay: false,
          controls: false,
          fill: true,
          fluid: false,
          html5: {
            vhs: {
              limitRenditionByPlayerDimensions: true,
              overrideNative: false,
            },
          },
          liveui: false,
          preload: "metadata",
        }) as unknown as PlayerHandle;
        playerReference.current = player;
        player.on("error", () => {
          const currentError = player!.error();
          recordMediaFailure(
            {
              code: currentError?.code,
              details: currentError?.message,
              source: "video.js",
            },
            "stopped",
          );
          if (
            !rollbackReplacement(
              "That playback change could not be applied. The previous stream was restored.",
            )
          ) {
            setStatus("error");
            setMessage("The stream stopped responding. Your saved progress is safe.");
          }
        });
        player.on("ready", () => {
          if (cancelled) return;
          clearTracks();
          attachSubtitles();
          setStatus("ready");
          setMessage("Ready to resume");
          if (!startWhenReadyReference.current) return;
          startWhenReadyReference.current = false;
          void player!.play().catch(() => {
            setTransitionMessage("Ready to play — your browser needs one more tap to start.");
          });
        });
      }
      clearTracks();
      attachSubtitles();
      player.src({
        src: source,
        type: "application/x-mpegURL",
      });
    };
    void attach().catch(() => {
      if (
        !cancelled &&
        !rollbackReplacement(
          "The new stream could not be attached. The previous stream was restored.",
        )
      ) {
        setStatus("error");
        setMessage("The playback engine could not be loaded.");
      }
    });
    return () => {
      cancelled = true;
      if (readinessTimeout) clearTimeout(readinessTimeout);
      clearTracks();
      video.removeAttribute("src");
      video.load();
    };
  }, [prepared, rollbackReplacement, selectSubtitleTrack]);

  useEffect(() => {
    if (controlsTimeoutReference.current) clearTimeout(controlsTimeoutReference.current);
    controlsTimeoutReference.current =
      playing && !settingsOpen && !issuePanelOpen
        ? setTimeout(() => setControlsVisible(false), 2_800)
        : null;
    return () => {
      if (controlsTimeoutReference.current) clearTimeout(controlsTimeoutReference.current);
    };
  }, [issuePanelOpen, playing, settingsOpen]);

  useEffect(
    () => () => {
      replacementControllerReference.current?.abort();
      if (clickTimerReference.current) clearTimeout(clickTimerReference.current);
      const player = playerReference.current;
      playerReference.current = null;
      if (player && typeof player.dispose === "function") player.dispose();
      const active = preparedReference.current;
      if (active) stopSession(active, absolutePositionReference.current(), true);
      const replacement = replacementReference.current;
      if (replacement && replacement.previous.session.sessionId !== active?.session.sessionId) {
        stopSession(replacement.previous, absolutePositionReference.current(), true);
      }
    },
    [stopSession],
  );

  async function togglePlayback() {
    const video = videoReference.current;
    if (!video || status !== "ready") return;
    if (video.paused) {
      startWhenReadyReference.current = false;
      await video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }

  async function replacePlayback(
    nextPreferences: PlaybackPreferences,
    nextPosition: number,
    nextMessage: string,
  ) {
    const active = preparedReference.current;
    if (!active) return;
    const previousPosition = absolutePosition();
    const safePosition = Math.min(duration, Math.max(0, Math.floor(nextPosition)));
    const generation = replacementGenerationReference.current + 1;
    replacementGenerationReference.current = generation;
    replacementControllerReference.current?.abort();
    const controller = new AbortController();
    replacementControllerReference.current = controller;
    setSwitching(true);
    setTransitionMessage(nextMessage);
    setSettingsOpen(false);
    try {
      const result = await client.prepare(
        media.id,
        safePosition,
        controller.signal,
        preparationOptions(nextPreferences, active.session),
      );
      if (controller.signal.aborted || generation !== replacementGenerationReference.current) {
        stopSession(result, safePosition);
        return;
      }
      replacementReference.current = {
        generation,
        previous: active,
        previousPosition,
        previousPreferences: preferencesReference.current,
        resume: playing,
      };
      preferencesReference.current = nextPreferences;
      preparedReference.current = result;
      reportedStateReference.current = "negotiated";
      startWhenReadyReference.current = playing;
      setPreferences(nextPreferences);
      setPrepared(result);
      setPlaying(false);
      setBuffering(false);
      setCurrentTime(safePosition);
      setSeekPreview(null);
      setStatus("preparing");
      setMessage(nextMessage);
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== replacementGenerationReference.current ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      setSwitching(false);
      setTransitionMessage("That change could not be applied. Your current stream is unchanged.");
    }
  }

  function seekWithinSession(next: number) {
    const video = videoReference.current;
    if (!video || !prepared) return;
    const minimum = prepared.session.delivery === "hls" ? prepared.session.positionSeconds : 0;
    const safe = Math.min(duration, Math.max(0, next));
    if (prepared.session.delivery === "hls" && safe < minimum) {
      void replacePlayback(preferences, safe, "Rebuilding the stream from that moment…");
      return;
    }
    video.currentTime = prepared.session.delivery === "hls" ? safe - minimum : safe;
    setCurrentTime(safe);
  }

  function commitSeek(rawValue: string) {
    const next = Number(rawValue);
    if (!Number.isFinite(next)) return;
    if (seekPreview === null && Math.abs(next - currentTime) < 1) return;
    seekWithinSession(next);
    setSeekPreview(null);
  }

  function changeVolume(next: number) {
    const video = videoReference.current;
    if (!video) return;
    video.volume = next;
    video.muted = next === 0;
    setVolume(next);
    setMuted(next === 0);
  }

  function toggleMuted() {
    const video = videoReference.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  async function toggleFullscreen() {
    const stage = stageReference.current;
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (typeof stage.requestFullscreen === "function") await stage.requestFullscreen();
    } catch {
      // Fullscreen can be rejected while a modal dialog is open; keep playback usable.
    }
  }

  async function submitIssue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prepared || issueStatus === "submitting") return;
    const description = issueDescription.trim();
    setIssueStatus("submitting");
    setIssueMessage("Sending the timestamp and playback context…");
    try {
      await client.reportIssue(
        prepared.session.sessionId,
        {
          category: issueCategory,
          description: description ? description : null,
          positionSeconds: Math.max(0, Math.floor(absolutePosition())),
        },
        prepared.csrfToken,
      );
      setIssueStatus("success");
      setIssueMessage("Thanks — the issue and playback context were captured privately.");
    } catch (error) {
      setIssueStatus("error");
      setIssueMessage(
        error instanceof Error ? error.message : "The issue could not be sent. Try again.",
      );
    }
  }

  function handleKeyboard(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (isInteractiveTarget(event.target)) return;
    if (event.key === "Escape" && (settingsOpen || issuePanelOpen || subtitleWorkbenchOpen)) {
      event.preventDefault();
      setSettingsOpen(false);
      setIssuePanelOpen(false);
      setSubtitleWorkbenchOpen(false);
      return;
    }
    const key = event.key.toLowerCase();
    if (event.key === " " || key === "k") {
      event.preventDefault();
      void togglePlayback();
    } else if (event.key === "ArrowLeft" || key === "j") {
      event.preventDefault();
      seekWithinSession(currentTime - 10);
    } else if (event.key === "ArrowRight" || key === "l") {
      event.preventDefault();
      seekWithinSession(currentTime + 10);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      changeVolume(Math.min(1, Math.max(0, (videoReference.current?.volume ?? volume) + 0.1)));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      changeVolume(Math.min(1, Math.max(0, (videoReference.current?.volume ?? volume) - 0.1)));
    } else if (event.key === "Home") {
      event.preventDefault();
      seekWithinSession(0);
    } else if (event.key === "End") {
      event.preventDefault();
      seekWithinSession(duration);
    } else if (/^[0-9]$/u.test(event.key)) {
      event.preventDefault();
      const fraction = event.key === "0" ? 1 : Number(event.key) / 9;
      seekWithinSession(Math.round(duration * fraction));
    } else if (key === "m") {
      event.preventDefault();
      toggleMuted();
    } else if (key === "f") {
      event.preventDefault();
      void toggleFullscreen();
    } else if (key === "c") {
      event.preventDefault();
      const active = prepared;
      if (active && active.session.subtitleTracks.length > 0) {
        let subtitlesActive = !subtitleSuppressedReference.current;
        if (subtitlesActive && preferences.subtitleStreamIndex === null) {
          subtitlesActive = Array.from(subtitleTracksByIndexReference.current.values()).some(
            (track) => track !== null && track.mode === "showing",
          );
        }
        if (subtitlesActive) {
          setSubtitleTrack(null);
        } else {
          const preferredIndex =
            preferences.subtitleStreamIndex ??
            active.session.subtitleTracks.find((track) => track.selected)?.index ??
            active.session.subtitleTracks.find(
              (track) => track.subtitlePath !== undefined && subtitleKind(track),
            )?.index ??
            active.session.subtitleTracks[0]?.index ??
            null;
          if (preferredIndex !== null) setSubtitleTrack(preferredIndex);
        }
      }
    }
    revealControls();
  }

  const displayedPosition = seekPreview ?? currentTime;
  const selectedAudioIndex =
    preferences.audioStreamIndex ??
    prepared?.session.audioTracks.find((track) => track.selected)?.index ??
    prepared?.session.audioTracks.find((track) => track.default)?.index ??
    prepared?.session.audioTracks[0]?.index ??
    null;
  const poster = media.artworkPath;

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className={styles.dialog}
      data-controls={controlsVisible ? "visible" : "hidden"}
      data-status={status}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onClose={onClose}
      onKeyDown={handleKeyboard}
      onPointerMove={revealControls}
      ref={dialogReference}
    >
      <div
        className={styles.stage}
        ref={stageReference}
        style={{ "--player-accent": media.accent } as React.CSSProperties}
      >
        <video
          aria-label={`${media.title} video`}
          className={styles.video}
          onClick={() => {
            if (status !== "ready") return;
            if (clickTimerReference.current) clearTimeout(clickTimerReference.current);
            clickTimerReference.current = setTimeout(() => {
              clickTimerReference.current = null;
              void togglePlayback();
            }, 260);
            revealControls();
          }}
          onDoubleClick={() => {
            if (status !== "ready") return;
            if (clickTimerReference.current) {
              clearTimeout(clickTimerReference.current);
              clickTimerReference.current = null;
            }
            void toggleFullscreen();
            revealControls();
          }}
          onCanPlay={(event) => {
            const restorePosition = restorePositionReference.current;
            if (restorePosition !== null && prepared) {
              event.currentTarget.currentTime =
                prepared.session.delivery === "hls"
                  ? Math.max(0, restorePosition - prepared.session.positionSeconds)
                  : restorePosition;
              setCurrentTime(restorePosition);
              restorePositionReference.current = null;
            }
            const replacement = replacementReference.current;
            if (replacement) {
              replacementReference.current = null;
              stopSession(replacement.previous, absolutePositionReference.current());
              setSwitching(false);
              setTransitionMessage("Playback changed without losing your place.");
            }
            setStatus("ready");
            if (!startWhenReadyReference.current) return;
            startWhenReadyReference.current = false;
            void event.currentTarget.play().catch(() => {
              setTransitionMessage("Ready to play — your browser needs one more tap to start.");
            });
          }}
          onDurationChange={(event) => {
            if (Number.isFinite(event.currentTarget.duration)) {
              setDuration(prepared?.session.media.durationSeconds ?? event.currentTarget.duration);
            }
          }}
          onLoadedMetadata={(event) => {
            if (prepared?.session.delivery === "direct" && prepared.session.positionSeconds > 0) {
              event.currentTarget.currentTime =
                restorePositionReference.current ?? prepared.session.positionSeconds;
            }
          }}
          onPause={() => {
            setPlaying(false);
            if (reportedStateReference.current === "playing") {
              queueReport("paused", absolutePosition());
            }
          }}
          onPlay={() => {
            setPlaying(true);
            setBuffering(false);
            setTransitionMessage("");
            queueReport("started", absolutePosition());
          }}
          onPlaying={() => setBuffering(false)}
          onTimeUpdate={() => {
            const position = absolutePosition();
            setCurrentTime(position);
            if (Math.abs(position - lastProgressReference.current) >= 10) {
              lastProgressReference.current = position;
              queueReport("progress", position);
            }
          }}
          onWaiting={() => setBuffering(true)}
          poster={poster}
          preload="metadata"
          ref={videoReference}
        />

        <div className={styles.vignette} aria-hidden="true" />

        <header className={styles.topBar}>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>{media.eyebrow}</span>
            <h2 id={titleId}>{media.title}</h2>
          </div>
          <div className={styles.topActions}>
            <span
              className={styles.syncState}
              data-warning={syncInterrupted || transitionMessage || undefined}
              role={transitionMessage ? "status" : undefined}
            >
              {transitionMessage ||
                (syncInterrupted ? "Progress sync interrupted" : "Private Jellyfin session")}
            </span>
            <button
              aria-label="Close player"
              className={styles.iconButton}
              onClick={close}
              type="button"
            >
              <X aria-hidden="true" size={20} />
            </button>
          </div>
        </header>

        <p className="sr-only" id={descriptionId}>
          Use Space or K to play and pause, J and L to jump back and forward, arrow keys to seek or
          change volume, Home and End to jump to the start and end, number keys to seek by
          percentage, M to mute, C to show or hide captions, and F for full screen.
        </p>

        {status === "preparing" && (
          <div className={styles.centerState} role="status">
            <span className={styles.stateOrb}>
              <LoaderCircle aria-hidden="true" className={styles.spinner} size={28} />
            </span>
            <strong>Preparing your stream</strong>
            <span>{message}</span>
          </div>
        )}

        {(status === "error" || status === "unsupported") && (
          <div className={styles.centerState} role="alert">
            <span className={styles.stateOrb} data-error="true">
              <CircleAlert aria-hidden="true" size={28} />
            </span>
            <strong>
              {status === "unsupported" ? "Playback is not supported here" : "Playback paused"}
            </strong>
            <span>{message}</span>
            {status === "error" && (
              <button
                className={styles.retryButton}
                onClick={() => {
                  const active = preparedReference.current;
                  const position = absolutePositionReference.current();
                  replacementControllerReference.current?.abort();
                  replacementReference.current = null;
                  if (active) stopSession(active, position);
                  requestedPositionReference.current = position;
                  preparedReference.current = null;
                  reportedStateReference.current = "negotiated";
                  startWhenReadyReference.current = playing;
                  setPrepared(null);
                  setPlaying(false);
                  setSwitching(false);
                  setTransitionMessage("");
                  setStatus("preparing");
                  setMessage("Opening a private playback session…");
                  setAttempt((value) => value + 1);
                }}
                type="button"
              >
                <RotateCcw aria-hidden="true" size={17} /> Try again
              </button>
            )}
          </div>
        )}

        {status === "ready" && !playing && !buffering && !switching && (
          <button
            aria-label={`Resume ${media.title}`}
            className={styles.primaryPlay}
            onClick={() => void togglePlayback()}
            type="button"
          >
            <Play aria-hidden="true" fill="currentColor" size={28} />
          </button>
        )}

        {buffering && status === "ready" && (
          <span aria-label="Buffering" className={styles.buffering} role="status">
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={25} />
          </span>
        )}

        <footer className={styles.controls}>
          {subtitleWorkbenchOpen && prepared?.canManageLibrary && (
            <SubtitleWorkbench
              csrfToken={prepared.csrfToken}
              mediaReferenceId={media.id}
              mediaTitle={media.title}
              onClose={() => {
                setSubtitleWorkbenchOpen(false);
                setSettingsOpen(true);
                restoreSubtitleFocusReference.current = true;
              }}
              {...(subtitleClient === undefined ? {} : { client: subtitleClient })}
            />
          )}
          {issuePanelOpen && prepared && (
            <section
              aria-label="Report playback issue"
              className={`${styles.settingsPanel} ${styles.issuePanel}`}
              id={`${titleId}-issue`}
            >
              {issueStatus === "success" ? (
                <div className={styles.issueSuccess} role="status">
                  <span className={styles.issueSuccessIcon}>
                    <CheckCircle2 aria-hidden="true" size={22} />
                  </span>
                  <div>
                    <strong>Issue captured</strong>
                    <p>{issueMessage}</p>
                  </div>
                  <button
                    className={styles.issueDone}
                    onClick={() => setIssuePanelOpen(false)}
                    type="button"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <form className={styles.issueForm} onSubmit={(event) => void submitIssue(event)}>
                  <div className={styles.settingsHeading}>
                    <span>Report an issue</span>
                    <small>Current timestamp included</small>
                  </div>
                  <fieldset className={styles.issueCategories}>
                    <legend className="sr-only">Issue category</legend>
                    {ISSUE_CATEGORIES.map((category) => (
                      <label key={category.value}>
                        <input
                          checked={issueCategory === category.value}
                          name="issue-category"
                          onChange={() => setIssueCategory(category.value)}
                          type="radio"
                          value={category.value}
                        />
                        <span>{category.label}</span>
                      </label>
                    ))}
                  </fieldset>
                  <label className={styles.issueDescription}>
                    <span>
                      What happened? <small>Optional</small>
                    </span>
                    <textarea
                      aria-describedby={`${titleId}-issue-privacy`}
                      maxLength={1_000}
                      onChange={(event) => setIssueDescription(event.currentTarget.value)}
                      placeholder="A short note helps pinpoint the problem."
                      rows={3}
                      value={issueDescription}
                    />
                  </label>
                  <div className={styles.issueFooter}>
                    <p
                      data-error={issueStatus === "error" || undefined}
                      id={`${titleId}-issue-privacy`}
                      role={issueStatus === "error" ? "alert" : "status"}
                    >
                      {issueMessage || "No media paths, credentials, or account details are sent."}
                    </p>
                    <button
                      className={styles.issueSubmit}
                      disabled={issueStatus === "submitting"}
                      type="submit"
                    >
                      {issueStatus === "submitting" ? (
                        <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
                      ) : (
                        <Send aria-hidden="true" size={16} />
                      )}
                      {issueStatus === "submitting" ? "Sending…" : "Send report"}
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
          {settingsOpen && prepared && (
            <section
              aria-label="Playback settings"
              className={styles.settingsPanel}
              id={`${titleId}-settings`}
            >
              <div className={styles.settingsHeading}>
                <span>Playback</span>
                <small>Changes preserve your place</small>
              </div>
              <label className={styles.settingField}>
                <span>
                  <Headphones aria-hidden="true" size={16} /> Audio
                </span>
                <select
                  aria-label="Audio track"
                  disabled={switching || prepared.session.audioTracks.length === 0}
                  onChange={(event) => {
                    const nextIndex = Number(event.currentTarget.value);
                    const defaultIndex =
                      prepared.session.audioTracks.find((track) => track.default)?.index ??
                      prepared.session.audioTracks[0]?.index ??
                      null;
                    const nextPreferences = {
                      ...preferences,
                      audioStreamIndex: nextIndex === defaultIndex ? null : nextIndex,
                      quality: preferences.quality === "original" ? "auto" : preferences.quality,
                    } satisfies PlaybackPreferences;
                    void replacePlayback(
                      nextPreferences,
                      absolutePosition(),
                      "Switching audio track…",
                    );
                  }}
                  value={selectedAudioIndex ?? ""}
                >
                  {prepared.session.audioTracks.length === 0 && <option value="">Auto</option>}
                  {prepared.session.audioTracks.map((track) => (
                    <option key={track.index} value={track.index}>
                      {trackLabel(track)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.settingField}>
                <span>
                  <Captions aria-hidden="true" size={17} /> Subtitles
                </span>
                <select
                  aria-label="Subtitle track"
                  disabled={switching}
                  onChange={(event) => {
                    const nextIndex =
                      event.currentTarget.value === "off"
                        ? null
                        : Number(event.currentTarget.value);
                    setSubtitleTrack(nextIndex);
                  }}
                  value={preferences.subtitleStreamIndex ?? "off"}
                >
                  <option value="off">Off</option>
                  {prepared.session.subtitleTracks.map((track) => (
                    <option key={track.index} value={track.index}>
                      {trackLabel(track)}
                      {track.forced ? " · Forced" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {prepared.canManageLibrary && (
                <button
                  className={styles.subtitleWorkbenchButton}
                  onClick={() => {
                    setSettingsOpen(false);
                    setSubtitleWorkbenchOpen(true);
                  }}
                  ref={subtitleTriggerReference}
                  type="button"
                >
                  <span className={styles.subtitleWorkbenchButtonIcon} aria-hidden="true">
                    <Captions size={17} />
                  </span>
                  <span>
                    <strong>Find subtitles</strong>
                    <small>Search connected Bazarr providers</small>
                  </span>
                  <span aria-hidden="true">Open</span>
                </button>
              )}
              <label className={styles.settingField}>
                <span>
                  <Settings2 aria-hidden="true" size={16} /> Quality
                </span>
                <select
                  aria-label="Playback quality"
                  disabled={switching}
                  onChange={(event) => {
                    const quality = event.currentTarget.value as QualityPreset;
                    void replacePlayback(
                      { ...preferences, quality },
                      absolutePosition(),
                      "Applying playback quality…",
                    );
                  }}
                  value={preferences.quality}
                >
                  {(
                    Object.entries(QUALITY_PRESETS) as Array<
                      [QualityPreset, (typeof QUALITY_PRESETS)[QualityPreset]]
                    >
                  ).map(([value, option]) => (
                    <option
                      disabled={value === "original" && preferences.audioStreamIndex !== null}
                      key={value}
                      value={value}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}
          <label className={styles.progressControl}>
            <span className="sr-only">Playback position</span>
            <input
              aria-valuetext={`${formatTime(displayedPosition)} of ${formatTime(duration)}`}
              disabled={status !== "ready" || duration <= 0}
              max={Math.max(0, duration)}
              min={0}
              onBlur={(event) => commitSeek(event.currentTarget.value)}
              onChange={(event) => setSeekPreview(Number(event.currentTarget.value))}
              onKeyUp={(event) => {
                if (
                  ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(
                    event.key,
                  )
                ) {
                  commitSeek(event.currentTarget.value);
                }
              }}
              onPointerCancel={() => setSeekPreview(null)}
              onPointerUp={(event) => commitSeek(event.currentTarget.value)}
              step={1}
              type="range"
              value={Math.min(Math.max(0, displayedPosition), Math.max(0, duration))}
            />
          </label>
          <div className={styles.controlRow}>
            <div className={styles.controlCluster}>
              <button
                aria-label={playing ? "Pause" : "Play"}
                className={styles.iconButton}
                disabled={status !== "ready"}
                onClick={() => void togglePlayback()}
                type="button"
              >
                {playing ? (
                  <Pause aria-hidden="true" size={20} />
                ) : (
                  <Play aria-hidden="true" size={20} />
                )}
              </button>
              <button
                aria-label={muted ? "Unmute" : "Mute"}
                className={styles.iconButton}
                onClick={toggleMuted}
                type="button"
              >
                {muted ? (
                  <VolumeX aria-hidden="true" size={20} />
                ) : (
                  <Volume2 aria-hidden="true" size={20} />
                )}
              </button>
              <label className={styles.volumeControl}>
                <span className="sr-only">Volume</span>
                <input
                  max={1}
                  min={0}
                  onChange={(event) => changeVolume(Number(event.currentTarget.value))}
                  step={0.05}
                  type="range"
                  value={muted ? 0 : volume}
                />
              </label>
              <span className={styles.timecode}>
                {formatTime(displayedPosition)} <i>/</i> {formatTime(duration)}
              </span>
            </div>
            <div className={styles.controlCluster}>
              <button
                aria-controls={`${titleId}-issue`}
                aria-expanded={issuePanelOpen}
                aria-label="Report playback issue"
                className={styles.iconButton}
                disabled={!prepared}
                onClick={() => {
                  setSettingsOpen(false);
                  setSubtitleWorkbenchOpen(false);
                  setIssuePanelOpen((value) => {
                    if (!value) {
                      setIssueStatus("idle");
                      setIssueMessage("");
                    }
                    return !value;
                  });
                }}
                type="button"
              >
                <Bug aria-hidden="true" size={18} />
              </button>
              <button
                aria-controls={`${titleId}-settings`}
                aria-expanded={settingsOpen}
                aria-label="Playback settings"
                className={styles.iconButton}
                disabled={status !== "ready"}
                onClick={() => {
                  setIssuePanelOpen(false);
                  setSubtitleWorkbenchOpen(false);
                  setSettingsOpen((value) => !value);
                }}
                type="button"
              >
                <Settings2 aria-hidden="true" size={19} />
              </button>
              <button
                aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
                className={styles.iconButton}
                onClick={() => void toggleFullscreen()}
                type="button"
              >
                {fullscreen ? (
                  <Minimize2 aria-hidden="true" size={19} />
                ) : (
                  <Maximize2 aria-hidden="true" size={19} />
                )}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
