"use client";

import type HlsType from "hls.js";
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
  subtitleClient?: SubtitleClient;
}

type PlayerStatus = "error" | "preparing" | "ready" | "unsupported";
type ReportedState = "negotiated" | "paused" | "playing" | "stopped";
type QualityPreset = "auto" | "balanced" | "data-saver" | "high" | "original";
type IssueCategory = "audio" | "buffering" | "other" | "subtitles" | "sync" | "video_quality";
type IssueStatus = "error" | "idle" | "submitting" | "success";

interface PlaybackPreferences {
  audioStreamIndex: number | null;
  quality: QualityPreset;
  subtitleStreamIndex: number | null;
}

const QUALITY_PRESETS = {
  auto: { bitrate: 80_000_000, label: "Auto", mode: "auto" },
  original: { bitrate: 200_000_000, label: "Original", mode: "direct" },
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

function preparationOptions(preferences: PlaybackPreferences): PlaybackPreparationOptions {
  const quality = QUALITY_PRESETS[preferences.quality];
  const customTracks =
    preferences.audioStreamIndex !== null || preferences.subtitleStreamIndex !== null;
  return {
    audioStreamIndex: preferences.audioStreamIndex,
    maxStreamingBitrate: quality.bitrate,
    mode: customTracks ? "transcode" : quality.mode,
    subtitleStreamIndex: preferences.subtitleStreamIndex,
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

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement && Boolean(target.closest("button, input, select, textarea"))
  );
}

export function TheaterPlayer({
  client = playbackClient,
  media,
  onClose,
  subtitleClient,
}: TheaterPlayerProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const videoReference = useRef<HTMLVideoElement>(null);
  const hlsReference = useRef<HlsType | null>(null);
  const reportQueueReference = useRef(Promise.resolve());
  const reportedStateReference = useRef<ReportedState>("negotiated");
  const lastProgressReference = useRef(0);
  const absolutePositionReference = useRef<() => number>(() => media.positionSeconds);
  const controlsTimeoutReference = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeAfterPreparationReference = useRef(false);
  const restoreSubtitleFocusReference = useRef(false);
  const subtitleTriggerReference = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [attempt, setAttempt] = useState(0);
  const [requestedPosition, setRequestedPosition] = useState(media.positionSeconds);
  const [preferences, setPreferences] = useState<PlaybackPreferences>({
    audioStreamIndex: null,
    quality: "auto",
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

  const close = useCallback(() => {
    const dialog = dialogReference.current;
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    else onClose();
  }, [onClose]);

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
    void client
      .prepare(media.id, requestedPosition, controller.signal, preparationOptions(preferences))
      .then((result) => {
        if (controller.signal.aborted) return;
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
  }, [attempt, client, media.id, preferences, requestedPosition]);

  useEffect(() => {
    if (!prepared) return;
    const video = videoReference.current;
    if (!video) return;
    let cancelled = false;
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
            setBuffering(true);
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
            mediaRecoveries += 1;
            hls.recoverMediaError();
            return;
          }
          setStatus("error");
          setMessage("The stream stopped responding. Your saved progress is safe.");
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
      setStatus("unsupported");
      setMessage("This browser cannot play the negotiated HLS stream.");
    };
    void attach().catch(() => {
      if (!cancelled) {
        setStatus("error");
        setMessage("The playback engine could not be loaded.");
      }
    });
    return () => {
      cancelled = true;
      hlsReference.current?.destroy();
      hlsReference.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [prepared]);

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
      queueReport("stopped", absolutePositionReference.current(), true);
    },
    [queueReport],
  );

  async function togglePlayback() {
    const video = videoReference.current;
    if (!video || status !== "ready") return;
    if (video.paused) {
      await video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }

  function replacePlayback(
    nextPreferences: PlaybackPreferences,
    nextPosition: number,
    nextMessage: string,
  ) {
    const safePosition = Math.min(duration, Math.max(0, Math.floor(nextPosition)));
    resumeAfterPreparationReference.current = playing;
    queueReport("stopped", absolutePosition(), false);
    setPlaying(false);
    setBuffering(false);
    setPrepared(null);
    setPreferences(nextPreferences);
    setRequestedPosition(safePosition);
    setCurrentTime(safePosition);
    setSeekPreview(null);
    setSettingsOpen(false);
    setStatus("preparing");
    setMessage(nextMessage);
  }

  function seekWithinSession(next: number) {
    const video = videoReference.current;
    if (!video || !prepared) return;
    const minimum = prepared.session.delivery === "hls" ? prepared.session.positionSeconds : 0;
    const safe = Math.min(duration, Math.max(0, next));
    if (prepared.session.delivery === "hls" && safe < minimum) {
      replacePlayback(preferences, safe, "Rebuilding the stream from that moment…");
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
    const dialog = dialogReference.current;
    if (!dialog) return;
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
      seekWithinSession(currentTime - 10);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekWithinSession(currentTime + 10);
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
        style={{ "--player-accent": media.accent } as React.CSSProperties}
      >
        <video
          aria-label={`${media.title} video`}
          className={styles.video}
          onCanPlay={(event) => {
            if (!resumeAfterPreparationReference.current) return;
            resumeAfterPreparationReference.current = false;
            void event.currentTarget.play().catch(() => undefined);
          }}
          onDurationChange={(event) => {
            if (Number.isFinite(event.currentTarget.duration)) {
              setDuration(prepared?.session.media.durationSeconds ?? event.currentTarget.duration);
            }
          }}
          onLoadedMetadata={(event) => {
            if (prepared?.session.delivery === "direct" && prepared.session.positionSeconds > 0) {
              event.currentTarget.currentTime = prepared.session.positionSeconds;
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
            <span className={styles.syncState} data-warning={syncInterrupted || undefined}>
              {syncInterrupted ? "Progress sync interrupted" : "Private Jellyfin session"}
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
                  setPrepared(null);
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

        {status === "ready" && !playing && !buffering && (
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
                  disabled={prepared.session.audioTracks.length === 0}
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
                    replacePlayback(nextPreferences, absolutePosition(), "Switching audio track…");
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
                  onChange={(event) => {
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
                    replacePlayback(
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
                  onChange={(event) => {
                    const quality = event.currentTarget.value as QualityPreset;
                    replacePlayback(
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
