"use client";

import "./media-detail-drawer.css";
import "./library-title-drawer.css";

import type {
  LibraryBrowseItem,
  LibraryMovieDetail,
  LibraryMovieMediaSource,
  LibraryPlaybackState,
  LibraryPlaybackStateAction,
  LibrarySeasonEpisode,
  LibrarySeasonEpisodesResponse,
  LibraryTitleDetailResponse,
} from "@omnifin/contracts/library";
import {
  AudioLines,
  CalendarDays,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Clock3,
  Film,
  Gauge,
  HardDrive,
  Layers3,
  LoaderCircle,
  Play,
  RotateCcw,
  Star,
  Tv,
  UsersRound,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  MediaLibraryClientError,
  sameOriginMediaPath,
  type MediaLibraryClient,
} from "../lib/media-library";

export interface PlayableLibrarySelection {
  media: LibrarySeasonEpisode["media"] | LibraryBrowseItem["media"];
  playback: LibraryPlaybackState;
  startPositionSeconds?: number;
}

export interface LibraryTitleDrawerProperties {
  client: MediaLibraryClient;
  item: LibraryBrowseItem | null;
  onClose: () => void;
  onPlay: (selection: PlayableLibrarySelection) => void;
  open: boolean;
}

type TitleState =
  | { kind: "error"; message: string; requestKey: string }
  | { detail: LibraryTitleDetailResponse; kind: "ready"; requestKey: string };

type EpisodeState =
  | { kind: "error"; message: string; requestKey: string }
  | {
      items: LibrarySeasonEpisode[];
      kind: "ready";
      loadingMore: boolean;
      nextCursor: string | null;
      requestKey: string;
    };

function detailErrorMessage(error: unknown) {
  if (error instanceof MediaLibraryClientError) {
    if (error.kind === "signed_out")
      return "Your session ended. Sign in again to inspect this title.";
    if (error.kind === "forbidden") return "Your account can no longer inspect this library.";
  }
  return "Jellyfin could not provide this title right now. Your library was not changed.";
}

function formatRuntime(minutes: number | null) {
  if (minutes === null) return null;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function formatAirDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatBytes(value: number | null) {
  if (value === null) return null;
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1_024)), units.length - 1);
  const amount = value / 1_024 ** exponent;
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
}

function formatBitrate(value: number | null) {
  if (value === null) return null;
  return value >= 1_000
    ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} Mbps`
    : `${value} Kbps`;
}

function playbackLabel(playback: LibraryPlaybackState | null) {
  if (!playback) return null;
  if (playback.played) return "Watched";
  if (playback.positionSeconds < 1) return "Unwatched";
  const remainingMinutes = Math.max(
    1,
    Math.ceil((playback.durationSeconds - playback.positionSeconds) / 60),
  );
  return `${remainingMinutes} min left`;
}

function titleFacts(detail: LibraryTitleDetailResponse) {
  return [
    detail.media.year,
    detail.media.contentRating,
    formatRuntime(detail.media.runtimeMinutes),
    playbackLabel(detail.playback),
    detail.media.kind === "series"
      ? `${detail.seasons.length}${detail.seasonsTruncated ? "+" : ""} season${detail.seasons.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);
}

function TitleSkeleton({ title }: { title: string }) {
  return (
    <div
      aria-label={`Loading details for ${title}`}
      className="library-title__skeleton"
      role="status"
    >
      <span />
      <div>
        <i />
        <i />
        <i />
      </div>
      <span className="sr-only">Loading title information and season hierarchy.</span>
    </div>
  );
}

function EpisodeSkeleton() {
  return (
    <div aria-label="Loading episodes" className="library-title__episode-skeleton" role="status">
      {Array.from({ length: 4 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="library-title__error" role="status">
      <span aria-hidden="true">
        <WifiOff />
      </span>
      <p className="eyebrow">Detail signal interrupted</p>
      <h3>This title is still safely in Jellyfin.</h3>
      <p>{message}</p>
      <button className="button button--glass" onClick={onRetry} type="button">
        <RotateCcw aria-hidden="true" size={17} /> Try again
      </button>
    </section>
  );
}

type PlaybackMutationState =
  | { kind: "idle" }
  | { action: LibraryPlaybackStateAction; kind: "pending" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function playbackMutationErrorMessage(error: unknown) {
  if (error instanceof MediaLibraryClientError) {
    if (error.kind === "signed_out") return "Your session ended. Sign in again to make changes.";
    if (error.kind === "forbidden") return "Your account cannot change Jellyfin watch history.";
  }
  return "Jellyfin could not save that change. Nothing else was altered.";
}

function PlaybackActions({
  client,
  label,
  media,
  onChange,
  onPlay,
  playback,
}: {
  client: MediaLibraryClient;
  label: "episode" | "movie";
  media: PlayableLibrarySelection["media"];
  onChange: (playback: LibraryPlaybackState) => void;
  onPlay: (startPositionSeconds?: number) => void;
  playback: LibraryPlaybackState;
}) {
  const [mutation, setMutation] = useState<PlaybackMutationState>({ kind: "idle" });
  const pending = mutation.kind === "pending";
  const watchedAction = playback.played ? "mark_unwatched" : "mark_watched";

  async function updatePlaybackState(action: LibraryPlaybackStateAction) {
    if (!client.updatePlaybackState || pending) return;
    setMutation({ action, kind: "pending" });
    try {
      const response = await client.updatePlaybackState(media.id, { action });
      onChange(response.playback);
      setMutation({
        kind: "success",
        message:
          action === "mark_watched"
            ? "Marked watched in Jellyfin."
            : action === "mark_unwatched"
              ? "Marked unwatched in Jellyfin."
              : "Saved progress reset in Jellyfin.",
      });
    } catch (error) {
      setMutation({ kind: "error", message: playbackMutationErrorMessage(error) });
    }
  }

  return (
    <div className="library-title__playback-actions">
      <div className="library-title__playback-primary">
        <button
          className="button button--primary"
          data-directional-item
          disabled={pending}
          onClick={() => onPlay()}
          type="button"
        >
          <Play aria-hidden="true" fill="currentColor" />
          {playback.positionSeconds > 0 ? `Resume ${label}` : `Play ${label}`}
        </button>
        {playback.positionSeconds > 0 ? (
          <button
            className="button button--glass"
            data-directional-item
            disabled={pending}
            onClick={() => onPlay(0)}
            type="button"
          >
            <RotateCcw aria-hidden="true" /> Play {label} from beginning
          </button>
        ) : null}
      </div>
      {client.updatePlaybackState ? (
        <div
          aria-label={`Playback history for ${media.title}`}
          className="library-title__history-controls"
          role="group"
        >
          <button
            className="button button--glass"
            data-directional-item
            disabled={pending}
            onClick={() => void updatePlaybackState(watchedAction)}
            type="button"
          >
            {pending && mutation.action === watchedAction ? (
              <LoaderCircle aria-hidden="true" className="library-title__spinner" />
            ) : playback.played ? (
              <RotateCcw aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {playback.played ? "Mark unwatched" : "Mark watched"}
          </button>
          {playback.positionSeconds > 0 ? (
            <button
              className="button button--glass"
              data-directional-item
              disabled={pending}
              onClick={() => void updatePlaybackState("reset_progress")}
              type="button"
            >
              {pending && mutation.action === "reset_progress" ? (
                <LoaderCircle aria-hidden="true" className="library-title__spinner" />
              ) : (
                <RotateCcw aria-hidden="true" />
              )}
              Reset saved progress
            </button>
          ) : null}
        </div>
      ) : null}
      <p aria-live="polite" className="library-title__history-status" data-state={mutation.kind}>
        {mutation.kind === "pending"
          ? "Saving to Jellyfin…"
          : mutation.kind === "success" || mutation.kind === "error"
            ? mutation.message
            : ""}
      </p>
    </div>
  );
}

function PersonPortrait({ credit }: { credit: LibraryMovieDetail["cast"][number] }) {
  const source = sameOriginMediaPath(credit.imagePath);
  return (
    <span
      className="library-title__person-portrait"
      data-artwork-source={source ? "remote" : "generated"}
    >
      <UsersRound aria-hidden="true" />
      {source ? (
        // Person artwork remains on Omnifin's authenticated origin.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          decoding="async"
          loading="lazy"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
          src={source}
        />
      ) : null}
    </span>
  );
}

function MediaSourceCard({ source }: { source: LibraryMovieMediaSource }) {
  const size = formatBytes(source.sizeBytes);
  const bitrate = formatBitrate(source.bitrateKbps);
  const video = source.video;
  const resolution =
    video?.width && video.height ? `${video.width} × ${video.height}` : (video?.height ?? null);
  return (
    <article className="library-title__source-card">
      <header>
        <div>
          <span className="library-title__source-icon" aria-hidden="true">
            <HardDrive />
          </span>
          <div>
            <h4>{source.label}</h4>
            <p>{[size, bitrate].filter(Boolean).join(" · ") || "Technical details unavailable"}</p>
          </div>
        </div>
        {source.container ? <span>{source.container}</span> : null}
      </header>

      {video ? (
        <dl className="library-title__technical-grid" aria-label="Video information">
          {resolution ? (
            <div>
              <dt>Picture</dt>
              <dd>{typeof resolution === "number" ? `${resolution}p` : resolution}</dd>
            </div>
          ) : null}
          {video.codec ? (
            <div>
              <dt>Video</dt>
              <dd>{[video.codec, video.profile].filter(Boolean).join(" · ")}</dd>
            </div>
          ) : null}
          {video.bitDepth ? (
            <div>
              <dt>Depth</dt>
              <dd>{video.bitDepth}-bit</dd>
            </div>
          ) : null}
          {video.hdrFormat ? (
            <div>
              <dt>Range</dt>
              <dd>{video.hdrFormat}</dd>
            </div>
          ) : null}
          {video.bitrateKbps ? (
            <div>
              <dt>Video rate</dt>
              <dd>{formatBitrate(video.bitrateKbps)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {source.audio.length > 0 || source.subtitles.length > 0 ? (
        <div className="library-title__track-groups">
          {source.audio.length > 0 ? (
            <section aria-label="Audio tracks">
              <p>
                <AudioLines aria-hidden="true" /> Audio
              </p>
              <ul>
                {source.audio.map((track, index) => (
                  <li key={`${track.language ?? "audio"}:${track.codec ?? "unknown"}:${index}`}>
                    <strong>{track.title ?? track.language ?? `Track ${index + 1}`}</strong>
                    <span>
                      {[
                        track.codec,
                        track.channels ? `${track.channels} ch` : null,
                        formatBitrate(track.bitrateKbps),
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Audio"}
                    </span>
                  </li>
                ))}
              </ul>
              {source.audioTruncated ? <small>Additional audio tracks are available.</small> : null}
            </section>
          ) : null}
          {source.subtitles.length > 0 ? (
            <section aria-label="Subtitle tracks">
              <p>
                <Captions aria-hidden="true" /> Subtitles
              </p>
              <ul>
                {source.subtitles.map((track, index) => (
                  <li key={`${track.language ?? "subtitle"}:${track.codec ?? "unknown"}:${index}`}>
                    <strong>{track.title ?? track.language ?? `Track ${index + 1}`}</strong>
                    <span>
                      {[
                        track.codec,
                        track.default ? "Default" : null,
                        track.forced ? "Forced" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Subtitle"}
                    </span>
                  </li>
                ))}
              </ul>
              {source.subtitlesTruncated ? (
                <small>Additional subtitle tracks are available.</small>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MovieInformation({ movie }: { movie: LibraryMovieDetail }) {
  const premiereDate = formatAirDate(movie.premiereDate);
  const hasEditorialFacts =
    movie.communityRating !== null ||
    movie.criticRating !== null ||
    premiereDate !== null ||
    movie.genres.length > 0 ||
    movie.studios.length > 0;
  return (
    <div className="library-title__movie-information">
      {hasEditorialFacts ? (
        <section className="library-title__editorial-facts" aria-label="Movie information">
          {movie.communityRating !== null ? (
            <span>
              <Star aria-hidden="true" fill="currentColor" /> {movie.communityRating.toFixed(1)}
              <small>/10 community</small>
            </span>
          ) : null}
          {movie.criticRating !== null ? (
            <span>
              <Gauge aria-hidden="true" /> {movie.criticRating}%<small>critics</small>
            </span>
          ) : null}
          {premiereDate ? (
            <span>
              <CalendarDays aria-hidden="true" /> {premiereDate}
              <small>premiered</small>
            </span>
          ) : null}
          {movie.genres.length > 0 ? (
            <span>
              <Film aria-hidden="true" /> {movie.genres.join(" · ")}
              <small>genres</small>
            </span>
          ) : null}
          {movie.studios.length > 0 ? (
            <span>
              <Clapperboard aria-hidden="true" /> {movie.studios.join(" · ")}
              <small>studio</small>
            </span>
          ) : null}
        </section>
      ) : null}

      {movie.cast.length > 0 ? (
        <section className="library-title__people" aria-labelledby="library-title-cast-heading">
          <div className="library-title__section-heading library-title__section-heading--compact">
            <div>
              <p className="eyebrow">Principal cast</p>
              <h3 id="library-title-cast-heading">On screen</h3>
            </div>
            {movie.castTruncated ? <span>Showing the first 24 credits</span> : null}
          </div>
          <ul aria-label="Cast">
            {movie.cast.map((credit, index) => (
              <li key={`${credit.name}:${credit.role ?? "cast"}:${index}`}>
                <PersonPortrait credit={credit} />
                <strong>{credit.name}</strong>
                <span>{credit.role ?? "Cast"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {movie.crew.length > 0 ? (
        <section className="library-title__crew" aria-label="Key crew">
          <p className="eyebrow">Behind the film</p>
          <dl>
            {movie.crew.map((credit, index) => (
              <div key={`${credit.name}:${credit.type}:${index}`}>
                <dt>{credit.type[0]!.toLocaleUpperCase("en-US") + credit.type.slice(1)}</dt>
                <dd>{credit.name}</dd>
              </div>
            ))}
          </dl>
          {movie.crewTruncated ? <small>Showing the first 16 key crew credits.</small> : null}
        </section>
      ) : null}

      <details className="library-title__media-information">
        <summary data-directional-item>
          <span aria-hidden="true">
            <HardDrive />
          </span>
          <span>
            <strong>Media information</strong>
            <small>
              {movie.mediaSources.length > 0
                ? `${movie.mediaSources.length}${movie.mediaSourcesTruncated ? "+" : ""} owned version${movie.mediaSources.length === 1 ? "" : "s"}`
                : "Jellyfin has not reported technical details"}
            </small>
          </span>
          <ChevronDown aria-hidden="true" />
        </summary>
        <div className="library-title__media-information-body">
          {movie.mediaSources.length > 0 ? (
            movie.mediaSources.map((source, index) => (
              <MediaSourceCard key={`${source.label}:${index}`} source={source} />
            ))
          ) : (
            <p>Playback is available, but this Jellyfin item has no reviewed media-source facts.</p>
          )}
        </div>
      </details>
    </div>
  );
}

function EpisodeArtwork({ episode }: { episode: LibrarySeasonEpisode }) {
  const source = sameOriginMediaPath(episode.media.artwork.posterPath);
  return (
    <span className="library-title__episode-artwork">
      <Film aria-hidden="true" />
      {source ? (
        // Artwork stays on Omnifin's authenticated, opaque media route.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          decoding="async"
          loading="lazy"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
          src={source}
        />
      ) : null}
      <span>{episode.media.subtitle ?? "Episode"}</span>
    </span>
  );
}

function EpisodeDetail({
  client,
  episode,
  onPlaybackChange,
  onPlay,
}: {
  client: MediaLibraryClient;
  episode: LibrarySeasonEpisode;
  onPlaybackChange: (playback: LibraryPlaybackState) => void;
  onPlay: (startPositionSeconds?: number) => void;
}) {
  const airDate = formatAirDate(episode.airDate);
  const cast = episode.credits.filter(({ type }) => type === "cast");
  const crew = episode.credits.filter(({ type }) => type !== "cast");
  const hasEnrichment =
    airDate !== null ||
    episode.communityRating !== null ||
    episode.criticRating !== null ||
    episode.genres.length > 0 ||
    episode.studios.length > 0 ||
    episode.credits.length > 0;
  return (
    <section
      aria-label={`${episode.media.title} episode details`}
      className="library-title__episode-detail"
      id={`library-title-episode-${episode.media.id}`}
    >
      <div className="library-title__episode-detail-heading">
        <div>
          <p className="eyebrow">Episode brief</p>
          <h4>{episode.media.title}</h4>
        </div>
        <div aria-label="Episode facts" className="library-title__episode-detail-facts">
          {airDate ? (
            <span>
              <CalendarDays aria-hidden="true" /> {airDate}
            </span>
          ) : null}
          {episode.communityRating !== null ? (
            <span>
              <Star aria-hidden="true" fill="currentColor" /> {episode.communityRating.toFixed(1)}
              /10
            </span>
          ) : null}
          {episode.criticRating !== null ? <span>{episode.criticRating}% critics</span> : null}
        </div>
      </div>

      {episode.media.overview ? (
        <p className="library-title__episode-detail-overview">{episode.media.overview}</p>
      ) : (
        <p className="library-title__episode-detail-quiet">
          Jellyfin has no episode synopsis for this title yet.
        </p>
      )}

      {cast.length > 0 || crew.length > 0 ? (
        <div className="library-title__episode-credits">
          {cast.length > 0 ? (
            <section>
              <p>
                <UsersRound aria-hidden="true" /> On screen
              </p>
              <ul>
                {cast.map((credit) => (
                  <li key={`${credit.name}:${credit.role ?? "cast"}`}>
                    <strong>{credit.name}</strong>
                    <span>{credit.role ?? "Cast"}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {crew.length > 0 ? (
            <section>
              <p>
                <Clapperboard aria-hidden="true" /> Behind the episode
              </p>
              <dl>
                {crew.map((credit) => (
                  <div key={`${credit.name}:${credit.type}:${credit.role ?? ""}`}>
                    <dt>{credit.type === "director" ? "Director" : "Writer"}</dt>
                    <dd>{credit.name}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {episode.creditsTruncated ? (
            <p className="library-title__episode-detail-note">Showing the first 24 credits.</p>
          ) : null}
        </div>
      ) : null}

      {episode.genres.length > 0 || episode.studios.length > 0 ? (
        <dl className="library-title__episode-metadata">
          {episode.genres.length > 0 ? (
            <div>
              <dt>Genres</dt>
              <dd>{episode.genres.join(" · ")}</dd>
            </div>
          ) : null}
          {episode.studios.length > 0 ? (
            <div>
              <dt>Studio</dt>
              <dd>{episode.studios.join(" · ")}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {!hasEnrichment ? (
        <p className="library-title__episode-detail-quiet" role="status">
          No additional episode metadata is available, but playback is ready.
        </p>
      ) : null}

      <PlaybackActions
        client={client}
        label="episode"
        media={episode.media}
        onChange={onPlaybackChange}
        onPlay={onPlay}
        playback={episode.playback}
      />
    </section>
  );
}

function EpisodeList({
  client,
  onLoadMore,
  onPlaybackChange,
  onPlay,
  state,
}: {
  client: MediaLibraryClient;
  onLoadMore: () => void;
  onPlaybackChange: (episode: LibrarySeasonEpisode, playback: LibraryPlaybackState) => void;
  onPlay: (selection: PlayableLibrarySelection) => void;
  state: Extract<EpisodeState, { kind: "ready" }>;
}) {
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<string | null>(null);
  if (state.items.length === 0) {
    return (
      <div className="library-title__episodes-empty" role="status">
        <Layers3 aria-hidden="true" />
        <p>No playable episodes are available in this season for the paired Jellyfin account.</p>
      </div>
    );
  }
  return (
    <div className="library-title__episodes">
      <ol aria-label="Episodes">
        {state.items.map((episode) => {
          const progress = Math.round(
            (episode.playback.positionSeconds / episode.playback.durationSeconds) * 100,
          );
          const expanded = expandedEpisodeId === episode.media.id;
          const detailId = `library-title-episode-${episode.media.id}`;
          return (
            <li data-expanded={expanded || undefined} key={episode.media.id}>
              <button
                aria-controls={detailId}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "View"} details for ${episode.media.title}`}
                className="library-title__episode-summary"
                data-directional-item
                onClick={() => setExpandedEpisodeId(expanded ? null : episode.media.id)}
                type="button"
              >
                <EpisodeArtwork episode={episode} />
                <span className="library-title__episode-copy">
                  <span className="library-title__episode-copy-heading">
                    <strong>{episode.media.title}</strong>
                    <span>
                      {episode.media.runtimeMinutes
                        ? `${episode.media.runtimeMinutes} min`
                        : "Episode"}
                      {episode.communityRating !== null
                        ? ` · ${episode.communityRating.toFixed(1)} ★`
                        : ""}
                    </span>
                  </span>
                  {episode.media.overview ? <span>{episode.media.overview}</span> : null}
                  {progress > 0 && !episode.playback.played ? (
                    <span className="library-title__episode-progress">
                      <i style={{ width: `${progress}%` }} />
                    </span>
                  ) : null}
                </span>
                <ChevronDown aria-hidden="true" className="library-title__episode-expand" />
              </button>
              {episode.playback.played ? (
                <span className="library-title__episode-watched">
                  <Check aria-hidden="true" /> Watched
                </span>
              ) : null}
              <button
                aria-label={`${episode.playback.positionSeconds > 0 ? "Resume" : "Play"} ${episode.media.title}`}
                className="library-title__episode-play"
                data-directional-item
                onClick={() => onPlay(episode)}
                type="button"
              >
                <Play aria-hidden="true" fill="currentColor" />
              </button>
              {expanded ? (
                <EpisodeDetail
                  client={client}
                  episode={episode}
                  onPlaybackChange={(playback) => onPlaybackChange(episode, playback)}
                  onPlay={(startPositionSeconds) =>
                    onPlay({
                      media: episode.media,
                      playback: episode.playback,
                      ...(startPositionSeconds === undefined ? {} : { startPositionSeconds }),
                    })
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {state.nextCursor ? (
        <button
          className="button button--glass library-title__more"
          disabled={state.loadingMore}
          onClick={onLoadMore}
          type="button"
        >
          {state.loadingMore ? (
            <LoaderCircle aria-hidden="true" className="library-title__spinner" />
          ) : (
            <ChevronRight aria-hidden="true" />
          )}
          {state.loadingMore ? "Loading episodes…" : "More episodes"}
        </button>
      ) : null}
    </div>
  );
}

export function LibraryTitleDrawer({
  client,
  item,
  onClose,
  onPlay,
  open,
}: LibraryTitleDrawerProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [episodeAttempt, setEpisodeAttempt] = useState(0);
  const [episodeState, setEpisodeState] = useState<EpisodeState | null>(null);
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const [titleState, setTitleState] = useState<TitleState | null>(null);
  const referenceId = item?.media.id ?? "none";
  const requestKey = `${referenceId}:${attempt}`;

  useEffect(() => {
    const dialog = dialogReference.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !item) return;
    const controller = new AbortController();
    let current = true;
    const request = client.loadTitle
      ? client.loadTitle(item.media.id, controller.signal)
      : Promise.reject(
          new MediaLibraryClientError(
            "unavailable",
            "title_details_unavailable",
            "Title details are unavailable.",
          ),
        );
    void request
      .then((detail) => {
        if (current) setTitleState({ detail, kind: "ready", requestKey });
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setTitleState({ kind: "error", message: detailErrorMessage(error), requestKey });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [client, item, open, requestKey]);

  const visibleTitleState = useMemo(() => {
    if (!open || !item || titleState?.requestKey !== requestKey) return null;
    return titleState;
  }, [item, open, requestKey, titleState]);
  const detail = visibleTitleState?.kind === "ready" ? visibleTitleState.detail : null;
  const recommendedSeason =
    detail?.seasons.find((season) => season.playedEpisodeCount < season.episodeCount) ??
    detail?.seasons[0];
  const activeSeasonNumber =
    detail?.seasons.some((season) => season.seasonNumber === seasonNumber) === true
      ? seasonNumber
      : (recommendedSeason?.seasonNumber ?? null);
  const episodeRequestKey = `${referenceId}:${activeSeasonNumber ?? "none"}:${episodeAttempt}`;

  useEffect(() => {
    if (!open || !item || item.media.kind !== "series" || activeSeasonNumber === null) return;
    const controller = new AbortController();
    let current = true;
    const request = client.loadSeasonEpisodes
      ? client.loadSeasonEpisodes(
          item.media.id,
          activeSeasonNumber,
          { limit: 30 },
          controller.signal,
        )
      : Promise.reject(
          new MediaLibraryClientError(
            "unavailable",
            "season_episodes_unavailable",
            "Season episodes are unavailable.",
          ),
        );
    void request
      .then((response) => {
        if (current) {
          setEpisodeState({
            items: response.items,
            kind: "ready",
            loadingMore: false,
            nextCursor: response.nextCursor,
            requestKey: episodeRequestKey,
          });
        }
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setEpisodeState({
          kind: "error",
          message: detailErrorMessage(error),
          requestKey: episodeRequestKey,
        });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [activeSeasonNumber, client, episodeRequestKey, item, open]);

  async function loadMoreEpisodes() {
    const nextCursor = episodeState?.kind === "ready" ? episodeState.nextCursor : null;
    if (
      !item ||
      activeSeasonNumber === null ||
      !client.loadSeasonEpisodes ||
      episodeState?.kind !== "ready" ||
      !nextCursor ||
      episodeState.loadingMore
    ) {
      return;
    }
    const currentState = episodeState;
    setEpisodeState({ ...currentState, loadingMore: true });
    try {
      const response: LibrarySeasonEpisodesResponse = await client.loadSeasonEpisodes(
        item.media.id,
        activeSeasonNumber,
        { cursor: nextCursor, limit: 30 },
      );
      const known = new Set(currentState.items.map((episode) => episode.media.id));
      setEpisodeState({
        ...currentState,
        items: [
          ...currentState.items,
          ...response.items.filter((episode) => !known.has(episode.media.id)),
        ],
        loadingMore: false,
        nextCursor: response.nextCursor,
      });
    } catch (error) {
      setEpisodeState({
        kind: "error",
        message: detailErrorMessage(error),
        requestKey: episodeRequestKey,
      });
    }
  }

  function updateMoviePlayback(playback: LibraryPlaybackState) {
    setTitleState((state) => {
      if (state?.kind !== "ready" || state.detail.media.id !== referenceId) return state;
      return { ...state, detail: { ...state.detail, playback } };
    });
  }

  function updateEpisodePlayback(episode: LibrarySeasonEpisode, playback: LibraryPlaybackState) {
    setEpisodeState((state) => {
      if (state?.kind !== "ready" || state.requestKey !== episodeRequestKey) return state;
      return {
        ...state,
        items: state.items.map((item) =>
          item.media.id === episode.media.id ? { ...item, playback } : item,
        ),
      };
    });
    if (episode.playback.played === playback.played || activeSeasonNumber === null) return;
    const playedDelta = playback.played ? 1 : -1;
    setTitleState((state) => {
      if (state?.kind !== "ready" || state.detail.media.id !== referenceId) return state;
      return {
        ...state,
        detail: {
          ...state.detail,
          seasons: state.detail.seasons.map((season) =>
            season.seasonNumber === activeSeasonNumber
              ? {
                  ...season,
                  playedEpisodeCount: Math.max(
                    0,
                    Math.min(season.episodeCount, season.playedEpisodeCount + playedDelta),
                  ),
                }
              : season,
          ),
        },
      };
    });
  }

  if (!item) return null;
  const episodePanelId = `library-title-${item.media.id}-episodes`;
  const activeSeasonTabId =
    activeSeasonNumber === null
      ? undefined
      : `library-title-${item.media.id}-season-${activeSeasonNumber}`;
  const artworkPath = sameOriginMediaPath(
    detail?.media.artwork.backdropPath ??
      item.media.artwork.backdropPath ??
      item.media.artwork.posterPath,
  );
  const visibleEpisodeState = episodeState?.requestKey === episodeRequestKey ? episodeState : null;

  return (
    <dialog
      aria-label={`${item.media.title} details`}
      className="media-detail library-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      ref={dialogReference}
    >
      <div className="media-detail__glass" data-liquid-glass>
        <div className="media-detail__header">
          <div className="media-detail__header-context">
            <div>
              <span>Library title</span>
              <small>{item.media.kind === "series" ? "Series and seasons" : "Movie details"}</small>
            </div>
          </div>
          <button
            aria-label="Close title details"
            className="media-detail__close"
            data-directional-item
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="media-detail__scroll">
          {!visibleTitleState ? (
            <TitleSkeleton title={item.media.title} />
          ) : visibleTitleState.kind === "error" ? (
            <ErrorState
              message={visibleTitleState.message}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          ) : (
            <div className="library-title__content">
              <section className="library-title__hero">
                <div
                  className="library-title__artwork"
                  data-artwork-source={artworkPath ? "remote" : "generated"}
                >
                  {artworkPath ? (
                    // Artwork remains on Omnifin's authenticated origin.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" decoding="async" src={artworkPath} />
                  ) : null}
                  <span aria-hidden="true">{detail!.media.title.slice(0, 1)}</span>
                </div>
                <div className="library-title__hero-copy">
                  <p className="eyebrow">
                    {detail!.media.kind === "series" ? (
                      <Tv aria-hidden="true" />
                    ) : (
                      <Film aria-hidden="true" />
                    )}
                    {detail!.media.kind === "series" ? "Series" : "Feature film"}
                  </p>
                  <h2>{detail!.media.title}</h2>
                  <div aria-label="Title facts" className="library-title__facts">
                    {titleFacts(detail!).map((fact) => (
                      <span key={fact}>{fact}</span>
                    ))}
                  </div>
                  {detail!.movie?.tagline ? (
                    <blockquote className="library-title__tagline">
                      {detail!.movie.tagline}
                    </blockquote>
                  ) : null}
                  {detail!.media.overview ? <p>{detail!.media.overview}</p> : null}
                  {detail!.playback ? (
                    <PlaybackActions
                      client={client}
                      label="movie"
                      media={detail!.media}
                      onChange={updateMoviePlayback}
                      onPlay={(startPositionSeconds) =>
                        onPlay({
                          media: detail!.media,
                          playback: detail!.playback!,
                          ...(startPositionSeconds === undefined ? {} : { startPositionSeconds }),
                        })
                      }
                      playback={detail!.playback}
                    />
                  ) : null}
                </div>
              </section>

              {detail!.movie ? <MovieInformation movie={detail!.movie} /> : null}

              {detail!.media.kind === "series" ? (
                <section className="library-title__hierarchy">
                  <div className="library-title__section-heading">
                    <div>
                      <p className="eyebrow">Episode guide</p>
                      <h3>Seasons</h3>
                    </div>
                    {detail!.seasonsTruncated ? <span>Showing the first 100 seasons</span> : null}
                  </div>
                  {detail!.seasons.length === 0 ? (
                    <div className="library-title__episodes-empty" role="status">
                      <Layers3 aria-hidden="true" />
                      <p>No playable seasons are available for this Jellyfin account.</p>
                    </div>
                  ) : (
                    <>
                      <div
                        aria-label="Seasons"
                        aria-orientation="horizontal"
                        className="library-title__seasons"
                        role="tablist"
                      >
                        {detail!.seasons.map((season, index) => (
                          <button
                            aria-controls={episodePanelId}
                            aria-selected={activeSeasonNumber === season.seasonNumber}
                            data-selected={activeSeasonNumber === season.seasonNumber || undefined}
                            id={`library-title-${item.media.id}-season-${season.seasonNumber}`}
                            key={season.seasonNumber}
                            onClick={() => {
                              setSeasonNumber(season.seasonNumber);
                              setEpisodeAttempt(0);
                            }}
                            onKeyDown={(event) => {
                              const direction =
                                event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                              const targetIndex =
                                event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? detail!.seasons.length - 1
                                    : direction === 0
                                      ? null
                                      : (index + direction + detail!.seasons.length) %
                                        detail!.seasons.length;
                              if (targetIndex === null) return;
                              event.preventDefault();
                              const target = event.currentTarget.parentElement?.querySelectorAll(
                                "button[role='tab']",
                              )[targetIndex] as HTMLButtonElement | undefined;
                              target?.focus();
                              target?.click();
                            }}
                            role="tab"
                            tabIndex={activeSeasonNumber === season.seasonNumber ? 0 : -1}
                            type="button"
                          >
                            <strong>{season.title}</strong>
                            <span>
                              {season.playedEpisodeCount}/{season.episodeCount} watched
                            </span>
                          </button>
                        ))}
                      </div>
                      <div
                        aria-labelledby={activeSeasonTabId}
                        className="library-title__episode-panel"
                        id={episodePanelId}
                        role="tabpanel"
                      >
                        {!visibleEpisodeState ? (
                          <EpisodeSkeleton />
                        ) : visibleEpisodeState.kind === "error" ? (
                          <ErrorState
                            message={visibleEpisodeState.message}
                            onRetry={() => setEpisodeAttempt((value) => value + 1)}
                          />
                        ) : (
                          <EpisodeList
                            client={client}
                            onLoadMore={() => void loadMoreEpisodes()}
                            onPlaybackChange={updateEpisodePlayback}
                            onPlay={(episode) => onPlay(episode)}
                            state={visibleEpisodeState}
                          />
                        )}
                      </div>
                    </>
                  )}
                </section>
              ) : (
                <section className="library-title__movie-note">
                  <Clock3 aria-hidden="true" />
                  <div>
                    <strong>Playback starts only when you ask.</strong>
                    <p>Review the title first, then use the explicit play action above.</p>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
