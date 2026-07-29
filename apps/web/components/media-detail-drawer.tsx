"use client";

import type {
  DiscoveryMediaDetail,
  DiscoveryMediaRecommendation,
  DiscoveryMovieResult,
  DiscoveryPersonDetail,
  DiscoverySeriesResult,
} from "@omnifin/contracts/discovery";
import {
  ArrowLeft,
  BadgeCheck,
  Clapperboard,
  Clock3,
  ExternalLink,
  Film,
  Layers3,
  Play,
  Radio,
  RotateCcw,
  Sparkles,
  Star,
  UserRound,
  UsersRound,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  MediaDetailClientError,
  discoveryMediaDetailClient,
  discoveryPersonDetailClient,
  type DiscoveryMediaDetailClient,
  type DiscoveryPersonDetailClient,
  type MediaDetailClientErrorKind,
} from "../lib/media-details";

export type DetailMedia = DiscoveryMovieResult | DiscoverySeriesResult;

type DetailState =
  | { kind: "loading"; requestKey: string }
  | { detail: DiscoveryMediaDetail; kind: "ready"; requestKey: string }
  | { errorKind: MediaDetailClientErrorKind; kind: "error"; requestKey: string };

type PersonState =
  | { kind: "loading"; requestKey: string }
  | { detail: DiscoveryPersonDetail; kind: "ready"; requestKey: string }
  | { errorKind: MediaDetailClientErrorKind; kind: "error"; requestKey: string };

interface DetailNavigationState {
  media: DetailMedia;
  personId: number | null;
  rootKey: string;
}

export interface MediaDetailDrawerProperties {
  client?: DiscoveryMediaDetailClient;
  media: DetailMedia | null;
  onOpenChange: (open: boolean) => void;
  onRequest?: (media: DetailMedia) => void;
  open: boolean;
  personClient?: DiscoveryPersonDetailClient;
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

function formatRatingValue(value: number, scale: 10 | 100) {
  return scale === 10 ? value.toFixed(1) : `${Math.round(value)}%`;
}

function trailerUrl(id: string) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id.slice("youtube:".length))}`;
}

function recommendationMedia(item: DiscoveryMediaRecommendation): DetailMedia {
  return item;
}

function creditMedia(credit: DiscoveryPersonDetail["credits"][number]): DetailMedia {
  return {
    availability: credit.availability,
    id: `${credit.kind}:${credit.tmdbId}`,
    kind: credit.kind,
    originalTitle: null,
    overview: null,
    source: "seerr",
    title: credit.title,
    tmdbId: credit.tmdbId,
    voteAverage: credit.voteAverage,
    year: credit.year,
  };
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
      <div className="media-detail__skeleton-metrics">
        {Array.from({ length: 3 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <div className="media-detail__skeleton-people">
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <span className="sr-only">
        Loading normalized metadata, ratings, trailers, recommendations, cast, and crew.
      </span>
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
  onInspectMedia,
  onInspectPerson,
  onRequest,
}: {
  detail: DiscoveryMediaDetail;
  media: DetailMedia;
  onInspectMedia: (media: DetailMedia) => void;
  onInspectPerson: (personId: number) => void;
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

      <section className="media-detail__intelligence">
        <span>
          <Radio aria-hidden="true" /> Audience signal
        </span>
        <div className="media-detail__section-heading">
          <h3>Ratings constellation</h3>
          {detail.intelligence.ratingsState === "unavailable" ? (
            <small>Extended sources are temporarily offline</small>
          ) : null}
        </div>
        {detail.intelligence.ratings.length > 0 ? (
          <ul className="media-detail__ratings">
            {detail.intelligence.ratings.map((rating) => (
              <li key={`${rating.source}-${rating.audience}`}>
                <strong>{formatRatingValue(rating.value, rating.scale)}</strong>
                <span>{rating.label}</span>
                <small>
                  {rating.sentiment ??
                    (rating.voteCount === null
                      ? "Community signal"
                      : formatRatings(rating.voteCount))}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="media-detail__quiet-state">No rating signals are available yet.</p>
        )}
      </section>

      {detail.intelligence.trailers.length > 0 ? (
        <section className="media-detail__trailers">
          <span>
            <Film aria-hidden="true" /> Motion preview
          </span>
          <h3>Trailers &amp; features</h3>
          <ul>
            {detail.intelligence.trailers.map((trailer) => (
              <li key={trailer.id}>
                <a
                  data-directional-item
                  href={trailerUrl(trailer.id)}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <i aria-hidden="true">
                    <Play />
                  </i>
                  <span>
                    <strong>{trailer.title}</strong>
                    <small>
                      {trailer.type.replaceAll("_", " ")}
                      {trailer.resolution ? ` · ${trailer.resolution}p` : ""}
                    </small>
                  </span>
                  <ExternalLink aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                <button
                  data-directional-item
                  onClick={() => onInspectPerson(credit.personId)}
                  type="button"
                >
                  <i aria-hidden="true">{credit.name.slice(0, 1)}</i>
                  <span>
                    <strong>{credit.name}</strong>
                    <small>{credit.character ?? "Cast"}</small>
                  </span>
                  <UserRound aria-hidden="true" />
                </button>
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
                <dd>
                  <button
                    data-directional-item
                    onClick={() => onInspectPerson(credit.personId)}
                    type="button"
                  >
                    {credit.name}
                  </button>
                </dd>
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

      <section className="media-detail__recommendations">
        <span>
          <Sparkles aria-hidden="true" /> Adjacent signal
        </span>
        <div className="media-detail__section-heading">
          <h3>Continue exploring</h3>
          {detail.intelligence.recommendationsState === "unavailable" ? (
            <small>Recommendations are temporarily offline</small>
          ) : null}
        </div>
        {detail.intelligence.recommendations.length > 0 ? (
          <ul>
            {detail.intelligence.recommendations.map((item, index) => (
              <li key={item.id}>
                <button
                  data-directional-item
                  onClick={() => onInspectMedia(recommendationMedia(item))}
                  type="button"
                >
                  <i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.year ?? "Year unavailable"}
                      {item.voteAverage === null ? "" : ` · ${item.voteAverage.toFixed(1)}`}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="media-detail__quiet-state">
            {detail.intelligence.recommendationsState === "unavailable"
              ? "The current title remains available while this source reconnects."
              : "No adjacent titles were supplied for this selection."}
          </p>
        )}
      </section>

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

function PersonContent({
  detail,
  onInspectMedia,
}: {
  detail: DiscoveryPersonDetail;
  onInspectMedia: (media: DetailMedia) => void;
}) {
  const life = [detail.birthday, detail.deathday].filter(Boolean).join(" — ");
  return (
    <div className="media-detail__content media-detail__person-content">
      <section className="media-detail__person-hero">
        <div aria-hidden="true" className="media-detail__person-monogram">
          <span>{detail.name.slice(0, 1)}</span>
        </div>
        <div>
          <span>Person context</span>
          <h2>{detail.name}</h2>
          <p>{detail.department ?? "Creative contributor"}</p>
          {life || detail.birthplace ? (
            <div className="media-detail__person-facts">
              {life ? <span>{life}</span> : null}
              {detail.birthplace ? <span>{detail.birthplace}</span> : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="media-detail__overview">
        <span>Creative context</span>
        <h3>Biography</h3>
        <p>{detail.biography ?? "No biography is available for this contributor yet."}</p>
      </section>

      <section className="media-detail__person-credits">
        <span>
          <Clapperboard aria-hidden="true" /> Selected work
        </span>
        <div className="media-detail__section-heading">
          <h3>Across the library map</h3>
          {detail.creditsState === "unavailable" ? (
            <small>Credits are temporarily offline</small>
          ) : null}
        </div>
        {detail.credits.length > 0 ? (
          <ul>
            {detail.credits.map((credit, index) => (
              <li key={`${credit.kind}:${credit.tmdbId}:${credit.role}`}>
                <button
                  data-directional-item
                  onClick={() => onInspectMedia(creditMedia(credit))}
                  type="button"
                >
                  <i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
                  <span>
                    <strong>{credit.title}</strong>
                    <small>
                      {credit.role}
                      {credit.year ? ` · ${credit.year}` : ""}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="media-detail__quiet-state">
            {detail.creditsState === "unavailable"
              ? "The biography remains available while credits reconnect."
              : "No eligible movie or series credits were supplied."}
          </p>
        )}
      </section>

      <div className="media-detail__footer">
        <span>Normalized person context · private by design</span>
        <span className="media-detail__ready-state">
          <BadgeCheck aria-hidden="true" /> Seerr metadata
        </span>
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
  personClient = discoveryPersonDetailClient,
}: MediaDetailDrawerProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const scrollReference = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [navigation, setNavigation] = useState<DetailNavigationState | null>(null);
  const [personAttempt, setPersonAttempt] = useState(0);
  const [personState, setPersonState] = useState<PersonState | null>(null);
  const [state, setState] = useState<DetailState | null>(null);
  const rootKey = media ? `${media.kind}:${media.tmdbId}` : "none";
  const activeNavigation = navigation?.rootKey === rootKey ? navigation : null;
  const activeMedia = activeNavigation?.media ?? media;
  const personId = activeNavigation?.personId ?? null;
  const requestKey = activeMedia ? `${activeMedia.kind}:${activeMedia.tmdbId}:${attempt}` : "none";
  const personRequestKey = personId ? `${personId}:${personAttempt}` : "none";

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
    if (!open || !activeMedia || personId !== null) return;
    const controller = new AbortController();
    let current = true;
    void client
      .load(
        { kind: activeMedia.kind, tmdbId: activeMedia.tmdbId },
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
  }, [activeMedia, client, open, personId, requestKey]);

  useEffect(() => {
    if (!open || personId === null) return;
    const controller = new AbortController();
    let current = true;
    void personClient
      .load({ tmdbId: personId }, { language: detailLanguage() }, controller.signal)
      .then((response) => {
        if (current) {
          setPersonState({ detail: response.item, kind: "ready", requestKey: personRequestKey });
        }
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setPersonState({
          errorKind: error instanceof MediaDetailClientError ? error.kind : "unavailable",
          kind: "error",
          requestKey: personRequestKey,
        });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [open, personClient, personId, personRequestKey]);

  const visibleState = useMemo<DetailState | null>(() => {
    if (!activeMedia || !open || personId !== null) return null;
    if (!state || state.requestKey !== requestKey) return { kind: "loading", requestKey };
    return state;
  }, [activeMedia, open, personId, requestKey, state]);

  const visiblePersonState = useMemo<PersonState | null>(() => {
    if (personId === null || !open) return null;
    if (!personState || personState.requestKey !== personRequestKey) {
      return { kind: "loading", requestKey: personRequestKey };
    }
    return personState;
  }, [open, personId, personRequestKey, personState]);

  function inspectMedia(nextMedia: DetailMedia) {
    setNavigation({ media: nextMedia, personId: null, rootKey });
    setAttempt(0);
    scrollReference.current?.scrollTo?.({ behavior: "auto", top: 0 });
  }

  function inspectPerson(nextPersonId: number) {
    if (!activeMedia) return;
    setNavigation({ media: activeMedia, personId: nextPersonId, rootKey });
    setPersonAttempt(0);
    scrollReference.current?.scrollTo?.({ behavior: "auto", top: 0 });
  }

  if (!media || !activeMedia) return null;

  return (
    <dialog
      aria-label={
        personId === null
          ? `${activeMedia.title} details`
          : visiblePersonState?.kind === "ready"
            ? `${visiblePersonState.detail.name} person context`
            : "Person context"
      }
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
          <div className="media-detail__header-context">
            {personId === null ? null : (
              <button
                aria-label={`Back to ${activeMedia.title}`}
                className="media-detail__back"
                data-directional-item
                onClick={() => {
                  setNavigation({ media: activeMedia, personId: null, rootKey });
                  scrollReference.current?.scrollTo?.({ behavior: "auto", top: 0 });
                }}
                type="button"
              >
                <ArrowLeft aria-hidden="true" />
              </button>
            )}
            <div>
              <span>{personId === null ? "Expanded signal" : "Contributor signal"}</span>
              <small>
                {personId === null
                  ? activeMedia.kind === "movie"
                    ? "Movie intelligence"
                    : "Series intelligence"
                  : `Back to ${activeMedia.title}`}
              </small>
            </div>
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
        <div aria-live="polite" className="media-detail__scroll" ref={scrollReference}>
          {visiblePersonState?.kind === "ready" ? (
            <PersonContent detail={visiblePersonState.detail} onInspectMedia={inspectMedia} />
          ) : visiblePersonState?.kind === "error" ? (
            <DetailError
              errorKind={visiblePersonState.errorKind}
              onRetry={() => setPersonAttempt((current) => current + 1)}
            />
          ) : visiblePersonState?.kind === "loading" ? (
            <DetailSkeleton title="person context" />
          ) : visibleState?.kind === "ready" ? (
            <DetailContent
              detail={visibleState.detail}
              media={activeMedia}
              onInspectMedia={inspectMedia}
              onInspectPerson={inspectPerson}
              {...(onRequest ? { onRequest } : {})}
            />
          ) : visibleState?.kind === "error" ? (
            <DetailError
              errorKind={visibleState.errorKind}
              onRetry={() => setAttempt((current) => current + 1)}
            />
          ) : (
            <DetailSkeleton title={activeMedia.title} />
          )}
        </div>
      </div>
    </dialog>
  );
}
