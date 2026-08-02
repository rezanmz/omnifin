"use client";

import "./media-detail-drawer.css";
import "./library-title-drawer.css";

import type {
  LibraryBrowseItem,
  LibraryPlaybackState,
  LibrarySeasonEpisode,
  LibrarySeasonEpisodesResponse,
  LibraryTitleDetailResponse,
} from "@omnifin/contracts/library";
import {
  Check,
  ChevronRight,
  Clock3,
  Film,
  Layers3,
  LoaderCircle,
  Play,
  RotateCcw,
  Tv,
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

function titleFacts(detail: LibraryTitleDetailResponse) {
  return [
    detail.media.year,
    detail.media.contentRating,
    formatRuntime(detail.media.runtimeMinutes),
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

function EpisodeList({
  onLoadMore,
  onPlay,
  state,
}: {
  onLoadMore: () => void;
  onPlay: (episode: LibrarySeasonEpisode) => void;
  state: Extract<EpisodeState, { kind: "ready" }>;
}) {
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
          return (
            <li key={episode.media.id}>
              <div className="library-title__episode-index" aria-hidden="true">
                {episode.media.subtitle?.match(/E(\d+)/u)?.[1] ?? "•"}
              </div>
              <div className="library-title__episode-copy">
                <div>
                  <h4>{episode.media.title}</h4>
                  <span>
                    {episode.media.runtimeMinutes
                      ? `${episode.media.runtimeMinutes} min`
                      : "Episode"}
                  </span>
                </div>
                {episode.media.overview ? <p>{episode.media.overview}</p> : null}
                {progress > 0 && !episode.playback.played ? (
                  <span className="library-title__episode-progress">
                    <i style={{ width: `${progress}%` }} />
                  </span>
                ) : null}
              </div>
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
                  {detail!.media.overview ? <p>{detail!.media.overview}</p> : null}
                  {detail!.playback ? (
                    <button
                      className="button button--primary library-title__primary-play"
                      data-directional-item
                      onClick={() => onPlay({ media: detail!.media, playback: detail!.playback! })}
                      type="button"
                    >
                      <Play aria-hidden="true" fill="currentColor" />
                      {detail!.playback.positionSeconds > 0 ? "Resume movie" : "Play movie"}
                    </button>
                  ) : null}
                </div>
              </section>

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
                            onLoadMore={() => void loadMoreEpisodes()}
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
