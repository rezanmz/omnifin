"use client";

import type HlsType from "hls.js";
import {
  CircleAlert,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  browserPlaybackPath,
  playbackClient,
  type PlaybackClient,
  type PreparedPlayback,
} from "../lib/playback";
import styles from "./theater-player.module.css";

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
}

type PlayerStatus = "error" | "preparing" | "ready" | "unsupported";
type ReportedState = "negotiated" | "paused" | "playing" | "stopped";

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
}: TheaterPlayerProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const videoReference = useRef<HTMLVideoElement>(null);
  const hlsReference = useRef<HlsType | null>(null);
  const reportQueueReference = useRef(Promise.resolve());
  const reportedStateReference = useRef<ReportedState>("negotiated");
  const lastProgressReference = useRef(0);
  const absolutePositionReference = useRef<() => number>(() => media.positionSeconds);
  const controlsTimeoutReference = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [attempt, setAttempt] = useState(0);
  const [prepared, setPrepared] = useState<PreparedPlayback | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("preparing");
  const [message, setMessage] = useState("Opening a private playback session…");
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
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
    if (playing) {
      controlsTimeoutReference.current = setTimeout(() => setControlsVisible(false), 2_800);
    }
  }, [playing]);

  useEffect(() => {
    const dialog = dialogReference.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reportedStateReference.current = "negotiated";
    void client
      .prepare(media.id, media.positionSeconds, controller.signal)
      .then((result) => {
        setPrepared(result);
        setDuration(result.session.media.durationSeconds);
        setCurrentTime(result.session.positionSeconds);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Playback could not be prepared.");
      });
    return () => controller.abort();
  }, [attempt, client, media.id, media.positionSeconds]);

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
    controlsTimeoutReference.current = playing
      ? setTimeout(() => setControlsVisible(false), 2_800)
      : null;
    return () => {
      if (controlsTimeoutReference.current) clearTimeout(controlsTimeoutReference.current);
    };
  }, [playing]);

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

  function seek(next: number) {
    const video = videoReference.current;
    if (!video || !prepared) return;
    const minimum = prepared.session.delivery === "hls" ? prepared.session.positionSeconds : 0;
    const safe = Math.min(duration, Math.max(minimum, next));
    video.currentTime = prepared.session.delivery === "hls" ? safe - minimum : safe;
    setCurrentTime(safe);
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

  function handleKeyboard(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (isInteractiveTarget(event.target)) return;
    if (event.key === " " || event.key.toLowerCase() === "k") {
      event.preventDefault();
      void togglePlayback();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seek(currentTime - 10);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seek(currentTime + 10);
    } else if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      toggleMuted();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      void toggleFullscreen();
    }
    revealControls();
  }

  const minimumSeek = prepared?.session.delivery === "hls" ? prepared.session.positionSeconds : 0;
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
          <label className={styles.progressControl}>
            <span className="sr-only">Playback position</span>
            <input
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
              disabled={status !== "ready" || duration <= 0}
              max={Math.max(minimumSeek, duration)}
              min={minimumSeek}
              onChange={(event) => seek(Number(event.currentTarget.value))}
              step={1}
              type="range"
              value={Math.min(Math.max(minimumSeek, currentTime), Math.max(minimumSeek, duration))}
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
                {formatTime(currentTime)} <i>/</i> {formatTime(duration)}
              </span>
            </div>
            <button
              aria-label="Enter full screen"
              className={styles.iconButton}
              onClick={() => void toggleFullscreen()}
              type="button"
            >
              <Maximize2 aria-hidden="true" size={19} />
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
