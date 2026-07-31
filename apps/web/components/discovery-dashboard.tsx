"use client";

import type {
  DiscoveryFeedItem,
  DiscoveryFeedRail,
  DiscoveryFeedRailKind,
  DiscoveryFeedResponse,
} from "@omnifin/contracts/discovery";
import { CloudOff, LockKeyhole, Radar, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DiscoveryFeedClientError,
  discoveryFeedClient,
  type DiscoveryFeedClient,
  type DiscoveryFeedClientErrorKind,
} from "../lib/discovery-feed";
import type { MediaCardModel } from "../lib/dashboard-data";
import type { DiscoveryMediaDetailClient } from "../lib/media-details";
import type { MediaRequestClient } from "../lib/media-requests";
import { HeroSpotlight } from "./hero-spotlight";
import { LazyContinueWatchingRail } from "./lazy-continue-watching-rail";
import { MediaRail } from "./media-rail";
import type { DetailMedia } from "./media-detail-drawer";
import type { RequestableMedia } from "./request-composer";

const MediaDetailDrawer = dynamic(
  () => import("./media-detail-drawer").then((module) => module.MediaDetailDrawer),
  { ssr: false },
);
const RequestComposer = dynamic(
  () => import("./request-composer").then((module) => module.RequestComposer),
  { ssr: false },
);

const RAIL_TITLES: Record<DiscoveryFeedRailKind, string> = {
  popular_movies: "Popular movies",
  popular_series: "Series people are watching",
  trending: "Trending now",
  upcoming: "Coming soon",
};
const RAIL_EMPTY_COPY: Record<DiscoveryFeedRailKind, string> = {
  popular_movies: "Seerr has no popular movie suggestions for this region right now.",
  popular_series: "Seerr has no popular series suggestions for this region right now.",
  trending: "The daily trending signal is quiet right now.",
  upcoming: "No upcoming movies or series were returned for this region.",
};
const ACCENTS = ["#8ce8d3", "#a9d7ff", "#d8ff70", "#f0a77b", "#c9adff", "#f29ab5"];

const FALLBACK_HERO = {
  accent: "#8de9d5",
  actions: "none" as const,
  description:
    "Your private media state stays behind the gateway while Omnifin checks the connected services.",
  eyebrow: "Your library, in focus",
  facts: ["Protected upstreams", "Private by design", "No telemetry"],
  title: "Ready when you are",
};
const SIGNED_OUT_HERO = {
  accent: "#8de9d5",
  actions: "none" as const,
  description:
    "Sign in with OIDC or Jellyfin to restore your private library, watch state, and personalized discovery without exposing upstream credentials.",
  eyebrow: "Your library, private",
  facts: ["OIDC or Jellyfin", "Private by design", "No telemetry"],
  title: "Welcome back",
};
const discoveryRefreshIntervalMs = 5 * 60_000;

export interface DiscoveryDashboardProperties {
  client?: DiscoveryFeedClient;
  detailClient?: DiscoveryMediaDetailClient;
  initialFeed?: DiscoveryFeedResponse;
  live?: boolean;
  requestClient?: MediaRequestClient;
  showContinueWatching?: boolean;
}

function discoveryLanguage() {
  if (typeof navigator === "undefined") return "en";
  if (/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(navigator.language)) return navigator.language;
  const base = navigator.language.slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/u.test(base) ? base : "en";
}

function accentFor(item: DiscoveryFeedItem) {
  return ACCENTS[item.tmdbId % ACCENTS.length]!;
}

function availabilityLabel(item: DiscoveryFeedItem) {
  return {
    available: "Ready to watch",
    partial: "Partially available",
    processing: "Acquiring",
    requested: "Requested",
    unavailable: "Available to request",
    unknown: "Availability unknown",
  }[item.availability];
}

function itemFacts(item: DiscoveryFeedItem) {
  return [
    item.kind === "movie" ? "Movie" : "Series",
    item.year,
    item.voteAverage === null ? null : `${item.voteAverage.toFixed(1)} ★`,
    availabilityLabel(item),
  ]
    .filter((fact): fact is string | number => fact !== null)
    .map(String);
}

function itemMedia(item: DiscoveryFeedItem): DetailMedia {
  return {
    availability: item.availability,
    id: item.id,
    kind: item.kind,
    originalTitle: item.originalTitle,
    overview: item.overview,
    source: item.source,
    title: item.title,
    tmdbId: item.tmdbId,
    voteAverage: item.voteAverage,
    year: item.year,
  };
}

function requestable(item: DiscoveryFeedItem) {
  return item.availability === "unavailable" || item.availability === "partial";
}

function cardFor(item: DiscoveryFeedItem, locallyRequested: boolean): MediaCardModel {
  const metadata = [
    item.year,
    item.voteAverage === null ? null : `${item.voteAverage.toFixed(1)} ★`,
  ]
    .filter((value): value is string | number => value !== null)
    .map(String)
    .join(" · ");
  return {
    accent: accentFor(item),
    ...(item.artwork.posterPath ? { artworkPath: item.artwork.posterPath } : {}),
    eyebrow: locallyRequested ? "Requested" : metadata || availabilityLabel(item),
    id: item.id,
    title: item.title,
  };
}

function DiscoveryRailSkeleton({ title }: { title: string }) {
  return (
    <section aria-busy="true" aria-label={`Loading ${title}`} className="media-rail">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      <div aria-hidden="true" className="media-rail__scroller media-rail__scroller--loading">
        {Array.from({ length: 5 }, (_, index) => (
          <article className="media-card media-card--loading" key={index}>
            <span className="media-card__loading-art" />
            <span className="media-card__loading-line" />
            <span className="media-card__loading-line media-card__loading-line--short" />
          </article>
        ))}
      </div>
      <span className="sr-only" role="status">
        Loading {title}…
      </span>
    </section>
  );
}

function DiscoveryHeroSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading discovery spotlight"
      className="hero-spotlight discovery-hero-skeleton"
    >
      <h1 className="sr-only">Loading connected discovery</h1>
      <div aria-hidden="true" className="discovery-hero-skeleton__lens" />
      <div aria-hidden="true" className="discovery-hero-skeleton__copy">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span className="sr-only" role="status">
        Loading discovery spotlight…
      </span>
    </section>
  );
}

const ERROR_COPY: Record<
  DiscoveryFeedClientErrorKind,
  { action: string | null; detail: string; href: string | null; title: string }
> = {
  forbidden: {
    action: "Review account access",
    detail: "Your current role cannot browse connected discovery metadata.",
    href: "/settings",
    title: "Discovery permission required",
  },
  invalid_response: {
    action: "Try again",
    detail: "The response failed Omnifin’s safety checks, so none of it was displayed.",
    href: null,
    title: "Discovery response rejected",
  },
  not_configured: {
    action: "Open connectors",
    detail: "An administrator needs to validate and enable one Seerr connection.",
    href: "/settings/connectors",
    title: "Discovery is not connected",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended. Sign in again to restore personalized media discovery.",
    href: "/login",
    title: "Your discovery signal is waiting",
  },
  unavailable: {
    action: "Try again",
    detail: "The gateway or Seerr could not be reached. Your Jellyfin watch state is untouched.",
    href: null,
    title: "Discovery is temporarily offline",
  },
};

function DiscoveryBoundary({
  errorKind,
  onRetry,
}: {
  errorKind: DiscoveryFeedClientErrorKind;
  onRetry: () => void;
}) {
  const copy = ERROR_COPY[errorKind];
  const Icon =
    errorKind === "forbidden" ? ShieldAlert : errorKind === "signed_out" ? LockKeyhole : CloudOff;
  return (
    <section aria-labelledby="discovery-boundary-title" className="discovery-boundary">
      <div className="discovery-boundary__lens">
        <span aria-hidden="true" className="discovery-boundary__icon">
          <Icon />
        </span>
        <div>
          <p className="section-kicker">Connected discovery</p>
          <h2 id="discovery-boundary-title">{copy.title}</h2>
          <p>{copy.detail}</p>
        </div>
        {copy.action ? (
          copy.href ? (
            <Link className="button button--glass" href={copy.href}>
              {copy.action}
            </Link>
          ) : (
            <button className="button button--glass" onClick={onRetry} type="button">
              <RefreshCw aria-hidden="true" /> {copy.action}
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}

function DiscoveryEmpty() {
  return (
    <section aria-labelledby="discovery-empty-title" className="discovery-boundary">
      <div className="discovery-boundary__lens">
        <span aria-hidden="true" className="discovery-boundary__icon">
          <Radar />
        </span>
        <div>
          <p className="section-kicker">Connected discovery</p>
          <h2 id="discovery-empty-title">The signal is quiet right now</h2>
          <p>Seerr is connected but returned no eligible movies or series for these rails.</p>
        </div>
      </div>
    </section>
  );
}

function FailedRail({ onRetry, rail }: { onRetry: () => void; rail: DiscoveryFeedRail }) {
  return (
    <section aria-labelledby={`discovery-${rail.kind}-title`} className="media-rail">
      <div className="section-heading">
        <h2 id={`discovery-${rail.kind}-title`}>{RAIL_TITLES[rail.kind]}</h2>
      </div>
      <div
        className="quiet-state quiet-state--rail media-rail__boundary"
        data-severity="warning"
        role="status"
      >
        <span className="quiet-state__icon" aria-hidden="true">
          <CloudOff />
        </span>
        <span className="quiet-state__copy">
          <strong>This rail missed the latest refresh</strong>
          <span>The rest of discovery remains available while Seerr reconnects this source.</span>
        </span>
        <button
          className="button button--glass media-rail__boundary-action"
          onClick={onRetry}
          type="button"
        >
          <RefreshCw aria-hidden="true" /> Retry
        </button>
      </div>
    </section>
  );
}

interface DiscoveryQueryState {
  data: DiscoveryFeedResponse | undefined;
  error: unknown | null;
  isPending: boolean;
}

function useDiscoveryFeed({
  client,
  initialFeed,
  language,
  live,
}: {
  client: DiscoveryFeedClient;
  initialFeed: DiscoveryFeedResponse | undefined;
  language: string;
  live: boolean | undefined;
}) {
  const refreshAvailable = live ?? initialFeed === undefined;
  const [requestRevision, setRequestRevision] = useState(0);
  const [state, setState] = useState<DiscoveryQueryState>({
    data: initialFeed,
    error: null,
    isPending: initialFeed === undefined,
  });
  const refetch = useCallback(() => setRequestRevision((revision) => revision + 1), []);

  useEffect(() => {
    if (!refreshAvailable && requestRevision === 0) return;

    const controller = new AbortController();
    let refreshTimer: number | undefined;

    async function load() {
      try {
        const data = await client.load({ language }, controller.signal);
        if (controller.signal.aborted) return;
        setState({ data, error: null, isPending: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => {
          const authorizationLost =
            error instanceof DiscoveryFeedClientError &&
            (error.kind === "signed_out" || error.kind === "forbidden");
          return {
            data: authorizationLost ? undefined : current.data,
            error,
            isPending: false,
          };
        });
      } finally {
        if (!controller.signal.aborted && refreshAvailable) {
          refreshTimer = window.setTimeout(() => void load(), discoveryRefreshIntervalMs);
        }
      }
    }

    void load();
    return () => {
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [client, language, refreshAvailable, requestRevision]);

  return {
    ...state,
    isError: state.error !== null,
    refetch,
  };
}

function DiscoveryDashboardContent({
  client,
  detailClient,
  initialFeed,
  live,
  requestClient,
  showContinueWatching,
}: Required<Pick<DiscoveryDashboardProperties, "client" | "showContinueWatching">> &
  Omit<DiscoveryDashboardProperties, "client" | "showContinueWatching">) {
  const language = discoveryLanguage();
  const query = useDiscoveryFeed({ client, initialFeed, language, live });
  const [detailMedia, setDetailMedia] = useState<DetailMedia | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [composerMedia, setComposerMedia] = useState<RequestableMedia | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [requestedIds, setRequestedIds] = useState<ReadonlySet<string>>(() => new Set());
  const returnFocusReference = useRef<HTMLElement | null>(null);
  const data = query.data;
  const itemById = useMemo(
    () => new Map(data?.rails.flatMap((rail) => rail.items).map((item) => [item.id, item]) ?? []),
    [data],
  );

  function rememberFocus() {
    returnFocusReference.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function restoreFocus() {
    requestAnimationFrame(() => returnFocusReference.current?.focus());
  }

  function openDetails(item: DiscoveryFeedItem) {
    rememberFocus();
    setDetailMedia(itemMedia(item));
    setDetailOpen(true);
  }

  function openRequest(item: DiscoveryFeedItem) {
    rememberFocus();
    setComposerMedia(itemMedia(item));
    setComposerOpen(true);
  }

  const authorizationErrorKind =
    query.isError &&
    query.error instanceof DiscoveryFeedClientError &&
    (query.error.kind === "signed_out" || query.error.kind === "forbidden")
      ? query.error.kind
      : null;

  if (query.isPending) {
    return (
      <>
        <DiscoveryHeroSkeleton />
        {showContinueWatching ? <LazyContinueWatchingRail /> : null}
        {(Object.keys(RAIL_TITLES) as DiscoveryFeedRailKind[]).map((kind) => (
          <DiscoveryRailSkeleton key={kind} title={RAIL_TITLES[kind]} />
        ))}
      </>
    );
  }

  if (authorizationErrorKind) {
    return (
      <>
        <HeroSpotlight
          hero={authorizationErrorKind === "signed_out" ? SIGNED_OUT_HERO : FALLBACK_HERO}
        />
        {showContinueWatching ? <LazyContinueWatchingRail /> : null}
        <DiscoveryBoundary
          errorKind={authorizationErrorKind}
          onRetry={() => void query.refetch()}
        />
      </>
    );
  }

  if (!data) {
    const errorKind =
      query.error instanceof DiscoveryFeedClientError ? query.error.kind : "unavailable";
    return (
      <>
        <HeroSpotlight hero={FALLBACK_HERO} />
        {showContinueWatching ? <LazyContinueWatchingRail /> : null}
        <DiscoveryBoundary errorKind={errorKind} onRetry={() => void query.refetch()} />
      </>
    );
  }

  const spotlightItem =
    data.rails.find(({ kind }) => kind === "trending")?.items[0] ??
    data.rails.flatMap((rail) => rail.items)[0] ??
    null;
  const spotlightArtworkPath =
    spotlightItem?.artwork.backdropPath ?? spotlightItem?.artwork.posterPath ?? null;

  return (
    <>
      {spotlightArtworkPath ? (
        <link as="image" fetchPriority="high" href={spotlightArtworkPath} rel="preload" />
      ) : null}
      {spotlightItem ? (
        <HeroSpotlight
          artworkPath={spotlightArtworkPath}
          hero={{
            accent: accentFor(spotlightItem),
            actions: "none",
            description:
              spotlightItem.overview ??
              "Open the full detail view for normalized metadata and availability.",
            eyebrow: "Trending through Seerr",
            facts: itemFacts(spotlightItem),
            title: spotlightItem.title,
          }}
          onDetails={() => openDetails(spotlightItem)}
          {...(requestable(spotlightItem) && !requestedIds.has(spotlightItem.id)
            ? { onRequest: () => openRequest(spotlightItem) }
            : {})}
        />
      ) : (
        <HeroSpotlight hero={FALLBACK_HERO} />
      )}
      {showContinueWatching ? <LazyContinueWatchingRail /> : null}
      {data.state === "unavailable" ? (
        <DiscoveryBoundary errorKind="unavailable" onRetry={() => void query.refetch()} />
      ) : data.state === "empty" ? (
        <DiscoveryEmpty />
      ) : (
        data.rails.map((rail) =>
          rail.failure ? (
            <FailedRail key={rail.kind} onRetry={() => void query.refetch()} rail={rail} />
          ) : (
            <MediaRail
              emptyCopy={RAIL_EMPTY_COPY[rail.kind]}
              emptyTitle="No titles in this rail"
              items={rail.items.map((item) => cardFor(item, requestedIds.has(item.id)))}
              key={rail.kind}
              onSelect={(card) => {
                const item = itemById.get(card.id);
                if (item) openDetails(item);
              }}
              {...(query.isError ? { statusMessage: "Saved results · refresh interrupted" } : {})}
              title={RAIL_TITLES[rail.kind]}
            />
          ),
        )
      )}
      {data.state === "degraded" ? (
        <p className="discovery-degraded-status" role="status">
          <Sparkles aria-hidden="true" /> Available rails are current; interrupted sources are shown
          in place.
        </p>
      ) : null}
      {detailMedia ? (
        <MediaDetailDrawer
          {...(detailClient ? { client: detailClient } : {})}
          key={detailMedia.id}
          media={detailMedia}
          onOpenChange={(nextOpen) => {
            setDetailOpen(nextOpen);
            if (!nextOpen) {
              setDetailMedia(null);
              restoreFocus();
            }
          }}
          onRequest={(media) => {
            setDetailOpen(false);
            setDetailMedia(null);
            setComposerMedia(media);
            setComposerOpen(true);
          }}
          open={detailOpen}
        />
      ) : null}
      {composerMedia ? (
        <RequestComposer
          {...(requestClient ? { client: requestClient } : {})}
          key={composerMedia.id}
          media={composerMedia}
          onCreated={() => {
            setRequestedIds((current) => new Set([...current, composerMedia.id]));
          }}
          onOpenChange={(nextOpen) => {
            setComposerOpen(nextOpen);
            if (!nextOpen) {
              setComposerMedia(null);
              restoreFocus();
            }
          }}
          open={composerOpen}
        />
      ) : null}
    </>
  );
}

export function DiscoveryDashboard({
  client = discoveryFeedClient,
  detailClient,
  initialFeed,
  live,
  requestClient,
  showContinueWatching = true,
}: DiscoveryDashboardProperties) {
  return (
    <DiscoveryDashboardContent
      client={client}
      {...(detailClient === undefined ? {} : { detailClient })}
      {...(initialFeed === undefined ? {} : { initialFeed })}
      {...(live === undefined ? {} : { live })}
      {...(requestClient === undefined ? {} : { requestClient })}
      showContinueWatching={showContinueWatching}
    />
  );
}
