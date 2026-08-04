"use client";

import type HlsType from "hls.js";
import type { LibraryMovieMediaSource } from "@omnifin/contracts/library";
import type { PlaybackContextResponse } from "@omnifin/contracts/playback";
import {
  Bug,
  Captions,
  CheckCircle2,
  CircleAlert,
  Headphones,
  HardDrive,
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
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { resolvePlaybackPreferences } from "../lib/playback-preference-resolution";
import {
  playbackPreferenceClient,
  type PlaybackPreferenceClient,
} from "../lib/playback-preferences";
import {
  browserPlaybackPath,
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
  mediaSources?: LibraryMovieMediaSource[];
  positionSeconds: number;
  sourceReferenceId?: string;
  title: string;
}

export interface TheaterPlayerProperties {
  client?: PlaybackClient;
  media: TheaterMedia;
  onClose: () => void;
  preferenceClient?: PlaybackPreferenceClient;
  startWhenReady?: boolean;
  subtitleClient?: SubtitleClient;
}

interface TheaterPlayerSessionProperties extends TheaterPlayerProperties {
  autoplayEpisodeCount: number;
  initialHandoff?: EpisodePlaybackHandoff;
  onAdvance: (
    episode: NonNullable<PlaybackContextResponse["nextEpisode"]>,
    reason: "autoplay" | "manual",
    handoff: EpisodePlaybackHandoff,
  ) => void;
  onViewerIntent: () => void;
}

type PlayerStatus = "error" | "preparing" | "ready" | "unsupported";
type ReportedState = "negotiated" | "paused" | "playing" | "stopped";
type QualityPreset =
  "auto" | "balanced" | "cinema" | "constrained" | "data-saver" | "high" | "original";
type IssueCategory = "audio" | "buffering" | "other" | "subtitles" | "sync" | "video_quality";
type IssueStatus = "error" | "idle" | "submitting" | "success";
type HlsFailureRecovery = "media_recovery" | "network_retry" | "stopped";
type HlsFailureStage = "engine" | "fragment" | "manifest" | "media" | "playlist";

interface HlsFailureData {
  details?: unknown;
  fatal?: unknown;
  response?: { code?: unknown } | null;
  type?: unknown;
}

interface PlaybackPreferences {
  audioStreamIndex: number | null;
  quality: QualityPreset;
  subtitleStreamIndex: number | null;
}

interface EpisodePlaybackHandoff {
  preferences: PlaybackPreferences;
  prepared: PreparedPlayback;
}

interface EpisodePlaybackPreferences {
  autoplay: boolean;
  countdownSeconds: number;
  skipCredits: boolean;
  skipIntro: boolean;
  stillWatchingAfter: number | null;
}

const QUALITY_PRESETS = {
  auto: { bitrate: 80_000_000, label: "Auto", mode: "auto" },
  original: { bitrate: 200_000_000, label: "Original quality", mode: "auto" },
  cinema: { bitrate: 40_000_000, label: "Cinema · 40 Mbps", mode: "transcode" },
  high: { bitrate: 20_000_000, label: "High · 20 Mbps", mode: "transcode" },
  balanced: { bitrate: 10_000_000, label: "Balanced · 10 Mbps", mode: "transcode" },
  "data-saver": { bitrate: 4_000_000, label: "Data saver · 4 Mbps", mode: "transcode" },
  constrained: { bitrate: 2_000_000, label: "Constrained · 2 Mbps", mode: "transcode" },
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

function preparationOptions(
  preferences: PlaybackPreferences,
  {
    accountCeiling = false,
    sourceReferenceId,
  }: { accountCeiling?: boolean; sourceReferenceId?: string | null } = {},
): PlaybackPreparationOptions {
  const quality = QUALITY_PRESETS[preferences.quality];
  const customTracks =
    preferences.audioStreamIndex !== null || preferences.subtitleStreamIndex !== null;
  return {
    audioStreamIndex: preferences.audioStreamIndex,
    maxStreamingBitrate: quality.bitrate,
    mode: customTracks ? "transcode" : accountCeiling ? "auto" : quality.mode,
    ...(sourceReferenceId === undefined ? {} : { sourceReferenceId }),
    subtitleStreamIndex: preferences.subtitleStreamIndex,
  };
}

function qualityPresetForBitrate(bitrate: number): QualityPreset {
  const exact = (
    Object.entries(QUALITY_PRESETS) as Array<
      [QualityPreset, (typeof QUALITY_PRESETS)[QualityPreset]]
    >
  ).find(([, preset]) => preset.bitrate === bitrate)?.[0];
  if (exact) return exact;
  if (bitrate >= QUALITY_PRESETS.original.bitrate) return "original";
  if (bitrate >= QUALITY_PRESETS.auto.bitrate) return "auto";
  if (bitrate >= QUALITY_PRESETS.cinema.bitrate) return "cinema";
  if (bitrate >= QUALITY_PRESETS.high.bitrate) return "high";
  if (bitrate >= QUALITY_PRESETS.balanced.bitrate) return "balanced";
  return bitrate >= QUALITY_PRESETS["data-saver"].bitrate ? "data-saver" : "constrained";
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

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement && Boolean(target.closest("button, input, select, textarea"))
  );
}

function TheaterPlayerSession({
  autoplayEpisodeCount,
  client = playbackClient,
  initialHandoff,
  media,
  onAdvance,
  onClose,
  onViewerIntent,
  preferenceClient = playbackPreferenceClient,
  startWhenReady = false,
  subtitleClient,
}: TheaterPlayerSessionProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const videoReference = useRef<HTMLVideoElement>(null);
  const hlsReference = useRef<HlsType | null>(null);
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
    episodeAdvance?: {
      episode: NonNullable<PlaybackContextResponse["nextEpisode"]>;
      reason: "autoplay" | "manual";
    };
    generation: number;
    previous: PreparedPlayback;
    previousOnePlayOverride: boolean;
    previousPosition: number;
    previousPreferences: PlaybackPreferences;
    previousSourceReferenceId: string | null;
    resume: boolean;
  } | null>(null);
  const restorePositionReference = useRef<number | null>(null);
  const startWhenReadyReference = useRef(startWhenReady);
  const lastProgressReference = useRef(0);
  const absolutePositionReference = useRef<() => number>(() => media.positionSeconds);
  const controlsTimeoutReference = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedPositionReference = useRef(media.positionSeconds);
  const restoreSubtitleFocusReference = useRef(false);
  const subtitleTriggerReference = useRef<HTMLButtonElement>(null);
  const autoSkippedIntroReference = useRef<string | null>(null);
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
  const [effectiveDefaults, setEffectiveDefaults] = useState<{
    audio: string;
    quality: string;
    subtitles: string;
  } | null>(null);
  const [onePlayOverride, setOnePlayOverride] = useState(false);
  const [sourceReferenceId, setSourceReferenceId] = useState(media.sourceReferenceId ?? null);
  const [playbackContextResult, setPlaybackContextResult] = useState<{
    context: PlaybackContextResponse;
    mediaId: string;
  } | null>(null);
  const [episodePreferences, setEpisodePreferences] = useState<EpisodePlaybackPreferences>({
    autoplay: false,
    countdownSeconds: 10,
    skipCredits: true,
    skipIntro: true,
    stillWatchingAfter: 3,
  });
  const [autoplayCancelled, setAutoplayCancelled] = useState(false);
  const [stillWatching, setStillWatching] = useState(false);

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

  useEffect(() => {
    const controller = new AbortController();
    if (!client.loadContext) return () => controller.abort();
    void client
      .loadContext(media.id, controller.signal)
      .then((context) => {
        if (!controller.signal.aborted) setPlaybackContextResult({ context, mediaId: media.id });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) setPlaybackContextResult(null);
      });
    return () => controller.abort();
  }, [client, media.id]);

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
      setSourceReferenceId(replacement.previousSourceReferenceId);
      setOnePlayOverride(replacement.previousOnePlayOverride);
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
    const prepare = async () => {
      let profile;
      try {
        profile = await preferenceClient.load(controller.signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const contracts = await import("@omnifin/contracts/playback");
        profile = {
          networkClass: "remote" as const,
          preferences: contracts.DEFAULT_PLAYBACK_PREFERENCES,
          revision: 0,
          updatedAt: null,
        };
        setTransitionMessage(
          "Account defaults were unavailable; conservative playback defaults are in use.",
        );
      }
      if (controller.signal.aborted) return;
      setEpisodePreferences(profile.preferences.episodes);
      if (initialHandoff) {
        preferencesReference.current = initialHandoff.preferences;
        setPreferences(initialHandoff.preferences);
        setOnePlayOverride(true);
        return initialHandoff.prepared;
      }
      const networkClass =
        profile.preferences.quality.defaultNetworkPolicy === "auto"
          ? profile.networkClass
          : profile.preferences.quality.defaultNetworkPolicy;
      const initialBitrate =
        networkClass === "home"
          ? (profile.preferences.quality.homeMaxBitrate ?? 200_000_000)
          : profile.preferences.quality.remoteMaxBitrate;
      const initialPreferences = {
        audioStreamIndex: null,
        quality: qualityPresetForBitrate(initialBitrate),
        subtitleStreamIndex: null,
      } satisfies PlaybackPreferences;
      preferencesReference.current = initialPreferences;
      setPreferences(initialPreferences);
      const first = await client.prepare(
        media.id,
        requestedPositionReference.current,
        controller.signal,
        preparationOptions(initialPreferences, {
          accountCeiling: true,
          ...(media.sourceReferenceId === undefined
            ? {}
            : { sourceReferenceId: media.sourceReferenceId }),
        }),
      );
      if (controller.signal.aborted) {
        stopSession(first, first.session.positionSeconds, true);
        return;
      }
      let firstStopped = false;
      try {
        const resolved = resolvePlaybackPreferences(
          profile.preferences,
          profile.networkClass,
          first.session,
        );
        const resolvedPreferences = {
          audioStreamIndex: resolved.audioStreamIndex,
          quality: qualityPresetForBitrate(resolved.maxStreamingBitrate),
          subtitleStreamIndex: resolved.subtitleStreamIndex,
        } satisfies PlaybackPreferences;
        const currentAudioIndex =
          first.session.audioTracks.find((track) => track.selected)?.index ??
          first.session.audioTracks.find((track) => track.default)?.index ??
          first.session.audioTracks[0]?.index ??
          null;
        const currentSubtitleIndex =
          first.session.subtitleTracks.find((track) => track.selected)?.index ?? null;
        const needsTrackResolution =
          (resolved.effectiveAudioStreamIndex !== null &&
            resolved.effectiveAudioStreamIndex !== currentAudioIndex) ||
          resolved.subtitleStreamIndex !== currentSubtitleIndex;
        let result = first;
        if (needsTrackResolution) {
          result = await client.prepare(
            media.id,
            requestedPositionReference.current,
            controller.signal,
            preparationOptions(resolvedPreferences, {
              accountCeiling: true,
              ...(media.sourceReferenceId === undefined
                ? {}
                : { sourceReferenceId: media.sourceReferenceId }),
            }),
          );
          if (controller.signal.aborted) {
            stopSession(first, first.session.positionSeconds, true);
            stopSession(result, result.session.positionSeconds, true);
            return;
          }
          stopSession(first, first.session.positionSeconds);
          firstStopped = true;
        }
        preferencesReference.current = resolvedPreferences;
        setPreferences(resolvedPreferences);
        setEffectiveDefaults(resolved.explanations);
        setOnePlayOverride(false);
        return result;
      } catch (error) {
        if (!firstStopped) {
          stopSession(first, first.session.positionSeconds, controller.signal.aborted);
        }
        throw error;
      }
    };
    void prepare()
      .then((result) => {
        if (!result) return;
        if (controller.signal.aborted) {
          stopSession(result, result.session.positionSeconds, true);
          return;
        }
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
  }, [
    attempt,
    client,
    initialHandoff,
    media.id,
    media.sourceReferenceId,
    preferenceClient,
    stopSession,
  ]);

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
    const attach = async () => {
      if (prepared.session.delivery === "direct") {
        video.src = source;
        setStatus("ready");
        setMessage("Ready to resume");
        return;
      }
      const hlsModule = await import("hls.js");
      if (cancelled) return;
      const Hls = hlsModule.default;
      if (Hls.isSupported()) {
        const hls = new Hls({
          backBufferLength: 90,
          capLevelToPlayerSize: true,
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 30,
        });
        hlsReference.current = hls;
        let networkRecoveries = 0;
        let mediaRecoveries = 0;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
            networkRecoveries += 1;
            recordHlsFailure(data, "network_retry");
            setBuffering(true);
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
          if (
            !rollbackReplacement(
              "That playback change could not be applied. The previous stream was restored.",
            )
          ) {
            setStatus("error");
            setMessage("The stream stopped responding. Your saved progress is safe.");
          }
        });
        hls.loadSource(source);
        hls.attachMedia(video);
        setStatus("ready");
        setMessage("Ready to resume");
        return;
      }
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = source;
        setStatus("ready");
        setMessage("Ready to resume");
        return;
      }
      if (
        !rollbackReplacement(
          "That playback change is not supported here. The previous stream was restored.",
        )
      ) {
        setStatus("unsupported");
        setMessage("This browser cannot play the negotiated HLS stream.");
      }
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
      hlsReference.current?.destroy();
      hlsReference.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [prepared, rollbackReplacement]);

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
    onViewerIntent();
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
    nextSourceReferenceId = sourceReferenceId,
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
        preparationOptions(nextPreferences, {
          ...(nextSourceReferenceId === null ? {} : { sourceReferenceId: nextSourceReferenceId }),
        }),
      );
      if (controller.signal.aborted || generation !== replacementGenerationReference.current) {
        stopSession(result, safePosition);
        return;
      }
      replacementReference.current = {
        generation,
        previous: active,
        previousOnePlayOverride: onePlayOverride,
        previousPosition,
        previousPreferences: preferencesReference.current,
        previousSourceReferenceId: sourceReferenceId,
        resume: playing,
      };
      preferencesReference.current = nextPreferences;
      preparedReference.current = result;
      reportedStateReference.current = "negotiated";
      startWhenReadyReference.current = playing;
      setPreferences(nextPreferences);
      setSourceReferenceId(nextSourceReferenceId);
      setOnePlayOverride(true);
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

  function seekWithinSession(next: number, viewerInitiated = false) {
    const video = videoReference.current;
    if (!video || !prepared) return;
    if (viewerInitiated) onViewerIntent();
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
    seekWithinSession(next, true);
    setSeekPreview(null);
  }

  function changeVolume(next: number) {
    const video = videoReference.current;
    if (!video) return;
    onViewerIntent();
    video.volume = next;
    video.muted = next === 0;
    setVolume(next);
    setMuted(next === 0);
  }

  function toggleMuted() {
    const video = videoReference.current;
    if (!video) return;
    onViewerIntent();
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  async function toggleFullscreen() {
    const dialog = dialogReference.current;
    if (!dialog) return;
    onViewerIntent();
    if (document.fullscreenElement) await document.exitFullscreen();
    else await dialog.requestFullscreen?.();
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
    if (event.key === " " || event.key.toLowerCase() === "k") {
      event.preventDefault();
      void togglePlayback();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekWithinSession(currentTime - 10, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekWithinSession(currentTime + 10, true);
    } else if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      toggleMuted();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      void toggleFullscreen();
    }
    revealControls();
  }

  const displayedPosition = seekPreview ?? currentTime;
  const playbackContext =
    playbackContextResult?.mediaId === media.id ? playbackContextResult.context : null;
  const activeIntro = playbackContext?.segments.find(
    (segment) =>
      segment.kind === "intro" &&
      currentTime >= segment.startSeconds &&
      currentTime < segment.endSeconds,
  );
  const credits = playbackContext?.segments.find((segment) => segment.kind === "credits");
  const activeCredits =
    credits && currentTime >= credits.startSeconds && currentTime < credits.endSeconds
      ? credits
      : null;
  const nextEpisode = playbackContext?.nextState === "ready" ? playbackContext.nextEpisode : null;
  const requestableNextEpisode =
    playbackContext?.nextState === "requestable" ? playbackContext.nextEpisode : null;
  const upNextVisible = Boolean(
    nextEpisode &&
    (currentTime >= (credits?.startSeconds ?? Number.POSITIVE_INFINITY) ||
      duration - currentTime <= Math.max(30, episodePreferences.countdownSeconds)),
  );
  const requestableNextVisible = Boolean(
    requestableNextEpisode &&
    (currentTime >= (credits?.startSeconds ?? Number.POSITIVE_INFINITY) ||
      duration - currentTime <= 30),
  );
  const stillWatchingDue = Boolean(
    episodePreferences.stillWatchingAfter !== null &&
    (autoplayEpisodeCount + 1) % episodePreferences.stillWatchingAfter === 0,
  );
  const autoplayCountdownSeconds = Math.max(0, Math.ceil(duration - currentTime));
  const autoplayCountdownVisible = Boolean(
    episodePreferences.autoplay &&
    !autoplayCancelled &&
    nextEpisode &&
    autoplayCountdownSeconds <= episodePreferences.countdownSeconds,
  );
  useEffect(() => {
    autoSkippedIntroReference.current = null;
  }, [media.id]);
  const selectedAudioIndex =
    preferences.audioStreamIndex ??
    prepared?.session.audioTracks.find((track) => track.selected)?.index ??
    prepared?.session.audioTracks.find((track) => track.default)?.index ??
    prepared?.session.audioTracks[0]?.index ??
    null;
  const poster = media.artworkPath;

  async function advanceToNext(reason: "autoplay" | "manual" = "manual") {
    if (!nextEpisode || switching) return;
    const active = preparedReference.current;
    if (!active) return;
    const previousPosition = absolutePosition();
    const generation = replacementGenerationReference.current + 1;
    replacementGenerationReference.current = generation;
    replacementControllerReference.current?.abort();
    const controller = new AbortController();
    replacementControllerReference.current = controller;
    setSwitching(true);
    setTransitionMessage(`Preparing ${nextEpisode.title} while this stream stays available…`);
    setSettingsOpen(false);
    try {
      const result = await client.prepare(
        nextEpisode.mediaReferenceId,
        0,
        controller.signal,
        preparationOptions(preferencesReference.current),
      );
      if (controller.signal.aborted || generation !== replacementGenerationReference.current) {
        stopSession(result, 0);
        return;
      }
      replacementReference.current = {
        episodeAdvance: { episode: nextEpisode, reason },
        generation,
        previous: active,
        previousOnePlayOverride: onePlayOverride,
        previousPosition,
        previousPreferences: preferencesReference.current,
        previousSourceReferenceId: sourceReferenceId,
        resume: playing,
      };
      preparedReference.current = result;
      reportedStateReference.current = "negotiated";
      startWhenReadyReference.current = false;
      setOnePlayOverride(true);
      setPrepared(result);
      setPlaying(false);
      setBuffering(false);
      setDuration(result.session.media.durationSeconds);
      setCurrentTime(0);
      setSeekPreview(null);
      setStatus("preparing");
      setMessage(`Preparing ${nextEpisode.title}…`);
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== replacementGenerationReference.current ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      replacementControllerReference.current = null;
      setSwitching(false);
      setTransitionMessage(
        "The next episode could not be prepared. This stream is unchanged; try Play next again.",
      );
    }
  }

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
        style={{ "--player-accent": media.accent } as React.CSSProperties}
      >
        <video
          aria-label={`${media.title} video`}
          className={styles.video}
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
              const episodeAdvance = replacement.episodeAdvance;
              if (episodeAdvance && prepared) {
                stopSession(replacement.previous, replacement.previousPosition);
                preparedReference.current = null;
                replacementControllerReference.current = null;
                setSwitching(false);
                onAdvance(episodeAdvance.episode, episodeAdvance.reason, {
                  preferences: preferencesReference.current,
                  prepared,
                });
                return;
              }
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
          onEnded={() => {
            setPlaying(false);
            setBuffering(false);
            setCurrentTime(duration);
            if (episodePreferences.autoplay && !autoplayCancelled && nextEpisode) {
              const autoplayNeedsConfirmation =
                document.visibilityState !== "visible" || !navigator.onLine;
              if (stillWatchingDue || autoplayNeedsConfirmation) {
                setStillWatching(true);
                setControlsVisible(true);
              } else void advanceToNext("autoplay");
            } else setControlsVisible(true);
          }}
          onLoadedMetadata={(event) => {
            if (prepared?.session.delivery === "direct" && prepared.session.positionSeconds > 0) {
              event.currentTarget.currentTime =
                restorePositionReference.current ?? prepared.session.positionSeconds;
            }
          }}
          onPause={(event) => {
            setPlaying(false);
            if (autoplayCountdownVisible && !switching && !event.currentTarget.ended) {
              setAutoplayCancelled(true);
              setControlsVisible(true);
              setTransitionMessage("Autoplay cancelled because playback was paused.");
            }
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
            const intro = playbackContext?.segments.find(
              (segment) =>
                segment.kind === "intro" &&
                position >= segment.startSeconds &&
                position < segment.endSeconds,
            );
            const marker = intro ? `${intro.startSeconds}:${intro.endSeconds}` : null;
            if (
              intro &&
              marker &&
              episodePreferences.skipIntro &&
              autoSkippedIntroReference.current !== marker
            ) {
              autoSkippedIntroReference.current = marker;
              seekWithinSession(intro.endSeconds);
              setTransitionMessage("Intro skipped using your account preference.");
              return;
            }
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
          Use Space or K to play and pause, arrow keys to seek, M to mute, and F for full screen.
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

        {status === "ready" && activeIntro && (
          <button
            className={styles.skipButton}
            onClick={() => seekWithinSession(activeIntro.endSeconds, true)}
            type="button"
          >
            Skip intro
          </button>
        )}

        {status === "ready" && activeCredits && episodePreferences.skipCredits && (
          <button
            className={`${styles.skipButton} ${styles.skipButtonCredits}`}
            onClick={() => {
              if (nextEpisode) void advanceToNext();
              else seekWithinSession(activeCredits.endSeconds, true);
            }}
            type="button"
          >
            Skip credits
          </button>
        )}

        {status === "ready" && stillWatching && nextEpisode && (
          <section aria-label="Still watching?" className={styles.upNext} role="alert">
            <span className={styles.upNextEyebrow}>Playback paused</span>
            <strong>Still watching?</strong>
            <span>
              Up next ·{" "}
              {nextEpisode.seasonNumber === null || nextEpisode.episodeNumber === null
                ? nextEpisode.title
                : `S${String(nextEpisode.seasonNumber).padStart(2, "0")}E${String(
                    nextEpisode.episodeNumber,
                  ).padStart(2, "0")} · ${nextEpisode.title}`}
            </span>
            <button
              aria-label="Continue watching"
              onClick={() => {
                setStillWatching(false);
                void advanceToNext();
              }}
              type="button"
            >
              <Play aria-hidden="true" fill="currentColor" size={16} /> Continue watching
            </button>
          </section>
        )}

        {status === "ready" && requestableNextVisible && requestableNextEpisode && (
          <section aria-label="Next episode missing" className={styles.upNext} role="status">
            <span className={styles.upNextEyebrow}>Next episode missing</span>
            <strong>{requestableNextEpisode.seriesTitle}</strong>
            <span>
              {requestableNextEpisode.seasonNumber === null ||
              requestableNextEpisode.episodeNumber === null
                ? requestableNextEpisode.title
                : `S${String(requestableNextEpisode.seasonNumber).padStart(2, "0")}E${String(
                    requestableNextEpisode.episodeNumber,
                  ).padStart(2, "0")} · ${requestableNextEpisode.title}`}
            </span>
            <span>
              This episode is not in your library. Request it from the series page when you are
              ready.
            </span>
          </section>
        )}

        {status === "ready" && upNextVisible && !stillWatching && nextEpisode && (
          <section aria-label="Up next" className={styles.upNext}>
            <span className={styles.upNextEyebrow}>Up next</span>
            <strong>{nextEpisode.seriesTitle}</strong>
            <span>
              {nextEpisode.seasonNumber === null || nextEpisode.episodeNumber === null
                ? nextEpisode.title
                : `S${String(nextEpisode.seasonNumber).padStart(2, "0")}E${String(
                    nextEpisode.episodeNumber,
                  ).padStart(2, "0")} · ${nextEpisode.title}`}
            </span>
            {autoplayCountdownVisible && (
              <span aria-label="Episode autoplay countdown" role="status">
                Autoplay in {autoplayCountdownSeconds}{" "}
                {autoplayCountdownSeconds === 1 ? "second" : "seconds"}
              </span>
            )}
            <div className={styles.upNextActions}>
              <button
                aria-label="Play next episode"
                onClick={() => void advanceToNext()}
                type="button"
              >
                <Play aria-hidden="true" fill="currentColor" size={16} /> Play next
              </button>
              {episodePreferences.autoplay && !autoplayCancelled && (
                <button
                  aria-label="Cancel autoplay"
                  className={styles.upNextSecondary}
                  onClick={() => setAutoplayCancelled(true)}
                  type="button"
                >
                  Cancel autoplay
                </button>
              )}
            </div>
          </section>
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
                <small>{onePlayOverride ? "One-play override" : "Account defaults applied"}</small>
              </div>
              <div className={styles.preferenceContext} role="status">
                <div>
                  <strong>
                    {onePlayOverride ? "This play only" : "Effective account profile"}
                  </strong>
                  <span>
                    {onePlayOverride
                      ? "Track and quality changes here preserve your place without changing other sessions."
                      : [
                          effectiveDefaults?.audio,
                          effectiveDefaults?.subtitles,
                          effectiveDefaults?.quality,
                        ]
                          .filter(Boolean)
                          .join(" ") || "Resolving account defaults against this source…"}
                  </span>
                </div>
                <Link href="/settings/playback">Edit account defaults</Link>
              </div>
              {media.mediaSources && media.mediaSources.length > 1 ? (
                <label className={styles.settingField}>
                  <span>
                    <HardDrive aria-hidden="true" size={16} /> Movie version
                  </span>
                  <select
                    aria-label="Movie version"
                    disabled={switching}
                    onChange={(event) => {
                      onViewerIntent();
                      const nextSourceReferenceId = event.currentTarget.value;
                      if (nextSourceReferenceId === sourceReferenceId) return;
                      void replacePlayback(
                        preferences,
                        absolutePosition(),
                        "Switching movie version without losing your place…",
                        nextSourceReferenceId,
                      );
                    }}
                    value={sourceReferenceId ?? media.mediaSources[0]!.sourceReferenceId}
                  >
                    {media.mediaSources.map((source) => (
                      <option key={source.sourceReferenceId} value={source.sourceReferenceId}>
                        {source.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className={styles.settingField}>
                <span>
                  <Headphones aria-hidden="true" size={16} /> Audio
                </span>
                <select
                  aria-label="Audio track"
                  disabled={switching || prepared.session.audioTracks.length === 0}
                  onChange={(event) => {
                    onViewerIntent();
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
                    onViewerIntent();
                    const nextIndex =
                      event.currentTarget.value === "off"
                        ? null
                        : Number(event.currentTarget.value);
                    const nextPreferences = {
                      ...preferences,
                      quality:
                        nextIndex !== null && preferences.quality === "original"
                          ? "auto"
                          : preferences.quality,
                      subtitleStreamIndex: nextIndex,
                    } satisfies PlaybackPreferences;
                    void replacePlayback(
                      nextPreferences,
                      absolutePosition(),
                      nextIndex === null ? "Turning subtitles off…" : "Loading subtitles…",
                    );
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
                    onViewerIntent();
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
                      disabled={
                        value === "original" &&
                        (preferences.audioStreamIndex !== null ||
                          preferences.subtitleStreamIndex !== null)
                      }
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

function nextTheaterMedia(
  current: TheaterMedia,
  episode: NonNullable<PlaybackContextResponse["nextEpisode"]>,
): TheaterMedia {
  const episodeLabel =
    episode.seasonNumber === null || episode.episodeNumber === null
      ? episode.title
      : `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(
          2,
          "0",
        )} · ${episode.title}`;
  return {
    accent: current.accent,
    ...(episode.artworkPath === null
      ? {}
      : { artworkPath: episode.artworkPath.replace(/^\/v1\//u, "/api/") }),
    eyebrow: episodeLabel,
    id: episode.mediaReferenceId,
    positionSeconds: 0,
    title: episode.seriesTitle,
  };
}

export function TheaterPlayer(properties: TheaterPlayerProperties) {
  const [activePlayback, setActivePlayback] = useState<{
    handoff?: EpisodePlaybackHandoff;
    media: TheaterMedia;
  }>({ media: properties.media });
  const [autoplayEpisodeCount, setAutoplayEpisodeCount] = useState(0);

  return (
    <TheaterPlayerSession
      {...properties}
      {...(activePlayback.handoff ? { initialHandoff: activePlayback.handoff } : {})}
      autoplayEpisodeCount={autoplayEpisodeCount}
      key={activePlayback.media.id}
      media={activePlayback.media}
      onAdvance={(episode, reason, handoff) => {
        setAutoplayEpisodeCount((count) => (reason === "autoplay" ? count + 1 : 0));
        setActivePlayback((current) => ({
          handoff,
          media: nextTheaterMedia(current.media, episode),
        }));
      }}
      onViewerIntent={() => setAutoplayEpisodeCount(0)}
      startWhenReady={Boolean(activePlayback.handoff) || properties.startWhenReady === true}
    />
  );
}
