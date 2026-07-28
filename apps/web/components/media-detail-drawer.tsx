"use client";

import type {
  DiscoveryMediaDetail,
  DiscoveryMovieResult,
  DiscoverySeriesResult,
} from "@omnifin/contracts/discovery";
import {
  BadgeCheck,
  Clapperboard,
  Clock3,
  Layers3,
  RotateCcw,
  Sparkles,
  Star,
  UsersRound,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  MediaDetailClientError,
  discoveryMediaDetailClient,
  type DiscoveryMediaDetailClient,
  type MediaDetailClientErrorKind,
} from "../lib/media-details";

export type DetailMedia = DiscoveryMovieResult | DiscoverySeriesResult;

type DetailState =
  | { kind: "loading"; requestKey: string }
  | { detail: DiscoveryMediaDetail; kind: "ready"; requestKey: string }
  | { errorKind: MediaDetailClientErrorKind; kind: "error"; requestKey: string };

export interface MediaDetailDrawerProperties {
  client?: DiscoveryMediaDetailClient;
  media: DetailMedia | null;
  onOpenChange: (open: boolean) => void;
  onRequest?: (media: DetailMedia) => void;
  open: boolean;
}

const ERROR_COPY: Record<MediaDetailClientErrorKind, { detail: string; title: string }> = {
  forbidden: {
    detail: "Your current role cannot inspect media. An administrator can review your access.",
    title: "Media permission required",
  },
  invalid_response: {
    detail: "The upstream response failed Omnifin’s safety checks. No raw data was displayed.",
    title: "Details were safely rejected",
  },
  not_configured: {
    detail: "An administrator needs to validate and enable one Seerr connection.",
    title: "Discovery is not connected",
  },
  rate_limited: {
    detail: "Seerr asked for a short pause. The current search context remains in place.",
    title: "Details are cooling down",
  },
  signed_out: {
    detail: "Your session ended. Sign in again to inspect this title.",
    title: "Sign in to continue",
  },
  unavailable: {
    detail: "The gateway or Seerr could not be reached. Nothing in your library was changed.",
    title: "Details are temporarily offline",
  },
};

function detailLanguage() {
  if (typeof navigator === "undefined") return "en";
  if (/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(navigator.language)) return navigator.language;
  const base = navigator.language.slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/u.test(base) ? base : "en";
}

function availabilityLabel(availability: DiscoveryMediaDetail["availability"]) {
  return {
    available: "Ready to watch",
    partial: "Partially available",
    processing: "Acquisition in progress",
    requested: "Request submitted",
    unavailable: "Available to request",
    unknown: "Availability unknown",
  }[availability];
}

function formatRuntime(minutes: number | null) {
  if (minutes === null) return null;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function formatRatings(count: number | null) {
  if (count === null) return null;
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" }).format(
    count,
  )} ratings`;
}

function DetailSkeleton({ title }: { title: string }) {
  return (
    <div
      aria-label={`Loading details for ${title}`}
      className="media-detail__skeleton"
      role="status"
    >
      <div className="media-detail__skeleton-hero">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="media-detail__skeleton-copy">
        <span />
        <span />
        <span />
      </div>
      <div className="media-detail__skeleton-people">
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <span className="sr-only">Loading normalized cast, crew, and availability.</span>
    </div>
  );
}

function DetailError({
  errorKind,
  onRetry,
}: {
  errorKind: MediaDetailClientErrorKind;
  onRetry: () => void;
}) {
  const copy = ERROR_COPY[errorKind];
  return (
    <section className="media-detail__error" role="status">
      <span className="media-detail__error-mark">
        <WifiOff aria-hidden="true" />
      </span>
      <span>Detail signal interrupted</span>
      <h2>{copy.title}</h2>
      <p>{copy.detail}</p>
      {errorKind === "signed_out" ? (
        <a className="media-detail__primary" data-directional-item href="/login">
          Sign in
        </a>
      ) : errorKind === "forbidden" || errorKind === "not_configured" ? null : (
        <button
          className="media-detail__primary"
          data-directional-item
          onClick={onRetry}
          type="button"
        >
          <RotateCcw aria-hidden="true" /> Try again
        </button>
      )}
    </section>
  );
}

function DetailContent({
  detail,
  media,
  onRequest,
}: {
  detail: DiscoveryMediaDetail;
  media: DetailMedia;
  onRequest?: (media: DetailMedia) => void;
}) {
  const runtime = formatRuntime(detail.runtimeMinutes);
  const ratings = formatRatings(detail.voteCount);
  const requestable = detail.availability === "unavailable" || detail.availability === "partial";
  return (
    <div className="media-detail__content">
      <section className="media-detail__hero">
        <div aria-hidden="true" className="media-detail__monogram">
          <span />
          <i>{detail.title.slice(0, 1)}</i>
        </div>
        <div className="media-detail__hero-copy">
          <div className="media-detail__signal">
            <span>{detail.kind === "movie" ? "Feature film" : "Series"}</span>
            <span>{availabilityLabel(detail.availability)}</span>
          </div>
          <h2>{detail.title}</h2>
          {detail.tagline ? <p className="media-detail__tagline">{detail.tagline}</p> : null}
          <div aria-label="Title facts" className="media-detail__facts">
            {detail.year ? <span>{detail.year}</span> : null}
            {runtime ? (
              <span>
                <Clock3 aria-hidden="true" /> {runtime}
              </span>
            ) : null}
            {detail.voteAverage === null ? null : (
              <span>
                <Star aria-hidden="true" /> {detail.voteAverage.toFixed(1)}
              </span>
            )}
            {ratings ? <span>{ratings}</span> : null}
          </div>
          {detail.genres.length > 0 ? (
            <ul aria-label="Genres" className="media-detail__genres">
              {detail.genres.map((genre) => (
                <li key={genre}>{genre}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="media-detail__overview">
        <span>Story signal</span>
        <h3>Overview</h3>
        <p>{detail.overview ?? "No synopsis is available for this title."}</p>
      </section>

      <dl className="media-detail__availability">
        <div>
          <dt>
            <BadgeCheck aria-hidden="true" /> Availability
          </dt>
          <dd>{availabilityLabel(detail.availability)}</dd>
        </div>
        <div>
          <dt>
            <Clapperboard aria-hidden="true" /> Production
          </dt>
          <dd>{detail.productionStatus ?? "Status unavailable"}</dd>
        </div>
        {detail.kind === "series" ? (
          <div>
            <dt>
              <Layers3 aria-hidden="true" /> Collection
            </dt>
            <dd>
              {detail.seasonCount} season{detail.seasonCount === 1 ? "" : "s"} ·{" "}
              {detail.episodeCount} episode{detail.episodeCount === 1 ? "" : "s"}
            </dd>
          </div>
        ) : null}
      </dl>

      {detail.cast.length > 0 ? (
        <section className="media-detail__people">
          <span>
            <UsersRound aria-hidden="true" /> Principal cast
          </span>
          <h3>On screen</h3>
          <ul>
            {detail.cast.map((credit) => (
              <li key={`${credit.name}-${credit.character ?? "cast"}`}>
                <i aria-hidden="true">{credit.name.slice(0, 1)}</i>
                <span>
                  <strong>{credit.name}</strong>
                  <small>{credit.character ?? "Cast"}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.crew.length > 0 ? (
        <section className="media-detail__crew">
          <span>Behind the signal</span>
          <h3>Key crew</h3>
          <dl>
            {detail.crew.map((credit) => (
              <div key={`${credit.name}-${credit.role}`}>
                <dt>{credit.role}</dt>
                <dd>{credit.name}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {detail.kind === "series" && detail.seasons.length > 0 ? (
        <section className="media-detail__seasons">
          <span>Episode map</span>
          <h3>Season guide</h3>
          <ul>
            {detail.seasons.map((season) => (
              <li key={season.number}>
                <i>{String(season.number).padStart(2, "0")}</i>
                <span>
                  <strong>{season.title}</strong>
                  <small>
                    {season.episodeCount} episode{season.episodeCount === 1 ? "" : "s"}
                    {season.year ? ` · ${season.year}` : ""}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="media-detail__footer">
        <span>Normalized Seerr metadata · private by design</span>
        {requestable && onRequest ? (
          <button
            aria-label={`Request ${detail.title}`}
            className="media-detail__primary"
            data-directional-item
            onClick={() => onRequest(media)}
            type="button"
          >
            Request title <Sparkles aria-hidden="true" />
          </button>
        ) : (
          <span className="media-detail__ready-state">
            <BadgeCheck aria-hidden="true" /> {availabilityLabel(detail.availability)}
          </span>
        )}
      </div>
    </div>
  );
}

export function MediaDetailDrawer({
  client = discoveryMediaDetailClient,
  media,
  onOpenChange,
  onRequest,
  open,
}: MediaDetailDrawerProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DetailState | null>(null);
  const requestKey = media ? `${media.kind}:${media.tmdbId}:${attempt}` : "none";

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
    if (!open || !media) return;
    const controller = new AbortController();
    let current = true;
    void client
      .load(
        { kind: media.kind, tmdbId: media.tmdbId },
        { language: detailLanguage() },
        controller.signal,
      )
      .then((response) => {
        if (current) setState({ detail: response.item, kind: "ready", requestKey });
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setState({
          errorKind: error instanceof MediaDetailClientError ? error.kind : "unavailable",
          kind: "error",
          requestKey,
        });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [client, media, open, requestKey]);

  const visibleState = useMemo<DetailState | null>(() => {
    if (!media || !open) return null;
    if (!state || state.requestKey !== requestKey) return { kind: "loading", requestKey };
    return state;
  }, [media, open, requestKey, state]);

  if (!media) return null;

  return (
    <dialog
      aria-label={`${media.title} details`}
      className="media-detail"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        if (open) onOpenChange(false);
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onOpenChange(false);
      }}
      ref={dialogReference}
    >
      <div className="media-detail__glass" data-liquid-glass>
        <div className="media-detail__header">
          <div>
            <span>Expanded signal</span>
            <small>{media.kind === "movie" ? "Movie intelligence" : "Series intelligence"}</small>
          </div>
          <button
            aria-label="Close media details"
            className="media-detail__close"
            data-directional-item
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div aria-live="polite" className="media-detail__scroll">
          {visibleState?.kind === "ready" ? (
            <DetailContent
              detail={visibleState.detail}
              media={media}
              {...(onRequest ? { onRequest } : {})}
            />
          ) : visibleState?.kind === "error" ? (
            <DetailError
              errorKind={visibleState.errorKind}
              onRetry={() => setAttempt((current) => current + 1)}
            />
          ) : (
            <DetailSkeleton title={media.title} />
          )}
        </div>
      </div>
    </dialog>
  );
}
