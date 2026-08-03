"use client";

import type {
  DiscoveryBrowseGenre,
  DiscoveryBrowseQuery,
  DiscoveryBrowseResponse,
  DiscoveryFeedItem,
} from "@omnifin/contracts/discovery";
import { DISCOVERY_MOVIE_GENRES, DISCOVERY_SERIES_GENRES } from "@omnifin/contracts/discovery";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Film,
  LoaderCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tv,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from "react";

import {
  DiscoveryBrowseClientError,
  discoveryBrowseClient,
  type DiscoveryBrowseClient,
} from "../lib/discovery-browse";
import type { DiscoveryMediaDetailClient } from "../lib/media-details";
import type { MediaRequestClient } from "../lib/media-requests";
import type { ThemePreference } from "../lib/theme";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import type { DetailMedia } from "./media-detail-drawer";
import { MobileNavigation, NavigationRail } from "./navigation-rail";
import type { RequestableMedia } from "./request-composer";
import { TopCommandBar } from "./top-command-bar";
import styles from "./discovery-browser.module.css";

const MediaDetailDrawer = dynamic(
  () => import("./media-detail-drawer").then((module) => module.MediaDetailDrawer),
  { ssr: false },
);
const RequestComposer = dynamic(
  () => import("./request-composer").then((module) => module.RequestComposer),
  { ssr: false },
);

const sortOptions = [
  { label: "Most popular", value: "popularity" },
  { label: "Highest rated", value: "rating" },
  { label: "Newest first", value: "newest" },
  { label: "Title A–Z", value: "title" },
] as const;
const availabilityOptions = [
  { label: "Any availability", value: "any" },
  { label: "Ready to watch", value: "available" },
  { label: "Partially available", value: "partial" },
  { label: "Requested", value: "requested" },
  { label: "Acquiring", value: "processing" },
  { label: "Ready to request", value: "requestable" },
] as const;
const languageOptions = [
  ["", "Any original language"],
  ["en", "English"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["hi", "Hindi"],
] as const;
const accentColors = ["#83e7d0", "#9acbff", "#d8ff70", "#f0a77b", "#c6a8ff"] as const;

type AmbientStyle = CSSProperties & { "--ambient-accent": string };
type CardStyle = CSSProperties & { "--browse-accent": string };

export interface DiscoveryBrowserProperties {
  client?: DiscoveryBrowseClient;
  detailClient?: DiscoveryMediaDetailClient;
  initialCriteria: DiscoveryBrowseQuery;
  initialResponse?: DiscoveryBrowseResponse;
  invalidCriteria?: boolean;
  live?: boolean;
  requestClient?: MediaRequestClient;
  themePreference?: ThemePreference;
}

function titleCase(value: string) {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function browseUrl(criteria: DiscoveryBrowseQuery) {
  const parameters = new URLSearchParams();
  parameters.set("kind", criteria.kind);
  if (criteria.query !== undefined) parameters.set("query", criteria.query);
  if (criteria.genre !== undefined) parameters.set("genre", criteria.genre);
  if (criteria.yearFrom !== undefined) parameters.set("yearFrom", String(criteria.yearFrom));
  if (criteria.yearTo !== undefined) parameters.set("yearTo", String(criteria.yearTo));
  if (criteria.minimumRating !== undefined) {
    parameters.set("minimumRating", String(criteria.minimumRating));
  }
  if (criteria.minimumVotes !== undefined) {
    parameters.set("minimumVotes", String(criteria.minimumVotes));
  }
  if (criteria.runtimeMax !== undefined) parameters.set("runtimeMax", String(criteria.runtimeMax));
  if (criteria.originalLanguage !== undefined) {
    parameters.set("originalLanguage", criteria.originalLanguage);
  }
  if (criteria.availability !== "any") parameters.set("availability", criteria.availability);
  if (criteria.sort !== "popularity") parameters.set("sort", criteria.sort);
  if (criteria.page !== 1) parameters.set("page", String(criteria.page));
  return `/browse?${parameters.toString()}`;
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

function isRequestable(item: DiscoveryFeedItem) {
  return item.availability === "unavailable" || item.availability === "partial";
}

function availabilityLabel(item: DiscoveryFeedItem) {
  return {
    available: "Ready to watch",
    partial: "Partially available",
    processing: "Acquiring",
    requested: "Requested",
    unavailable: "Ready to request",
    unknown: "Availability unknown",
  }[item.availability];
}

function FilterPanel({
  criteria,
  idPrefix,
  onChange,
}: {
  criteria: DiscoveryBrowseQuery;
  idPrefix: string;
  onChange: (patch: Partial<DiscoveryBrowseQuery>) => void;
}) {
  const searchMode = criteria.query !== undefined;
  const genres = criteria.kind === "movie" ? DISCOVERY_MOVIE_GENRES : DISCOVERY_SERIES_GENRES;
  return (
    <div className={styles.filterFields}>
      <label htmlFor={`${idPrefix}-sort`}>
        <span>Order</span>
        <select
          id={`${idPrefix}-sort`}
          onChange={(event) =>
            onChange({ sort: event.target.value as DiscoveryBrowseQuery["sort"] })
          }
          value={criteria.sort}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${idPrefix}-availability`}>
        <span>Availability</span>
        <select
          id={`${idPrefix}-availability`}
          onChange={(event) =>
            onChange({
              availability: event.target.value as DiscoveryBrowseQuery["availability"],
            })
          }
          value={criteria.availability}
        >
          {availabilityOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label data-disabled={searchMode || undefined} htmlFor={`${idPrefix}-genre`}>
        <span>Genre</span>
        <select
          disabled={searchMode}
          id={`${idPrefix}-genre`}
          onChange={(event) =>
            onChange({
              genre: (event.target.value || undefined) as DiscoveryBrowseGenre | undefined,
            })
          }
          value={criteria.genre ?? ""}
        >
          <option value="">All genres</option>
          {genres.map((genre) => (
            <option key={genre} value={genre}>
              {titleCase(genre)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.rangeFields}>
        <label htmlFor={`${idPrefix}-year-from`}>
          <span>From year</span>
          <input
            id={`${idPrefix}-year-from`}
            inputMode="numeric"
            max={criteria.yearTo ?? 2200}
            min={1870}
            onBlur={(event) => {
              const value = Number(event.target.value);
              onChange({ yearFrom: Number.isInteger(value) && value >= 1870 ? value : undefined });
            }}
            placeholder="Any"
            type="number"
            defaultValue={criteria.yearFrom}
          />
        </label>
        <label htmlFor={`${idPrefix}-year-to`}>
          <span>To year</span>
          <input
            id={`${idPrefix}-year-to`}
            inputMode="numeric"
            max={2200}
            min={criteria.yearFrom ?? 1870}
            onBlur={(event) => {
              const value = Number(event.target.value);
              onChange({ yearTo: Number.isInteger(value) && value >= 1870 ? value : undefined });
            }}
            placeholder="Any"
            type="number"
            defaultValue={criteria.yearTo}
          />
        </label>
      </div>
      <label htmlFor={`${idPrefix}-rating`}>
        <span>Minimum rating</span>
        <select
          id={`${idPrefix}-rating`}
          onChange={(event) =>
            onChange({
              minimumRating: event.target.value ? Number(event.target.value) : undefined,
            })
          }
          value={criteria.minimumRating ?? ""}
        >
          <option value="">Any rating</option>
          <option value="6">6.0+</option>
          <option value="7">7.0+</option>
          <option value="8">8.0+</option>
          <option value="9">9.0+</option>
        </select>
      </label>
      <label data-disabled={searchMode || undefined} htmlFor={`${idPrefix}-votes`}>
        <span>Minimum votes</span>
        <select
          disabled={searchMode}
          id={`${idPrefix}-votes`}
          onChange={(event) =>
            onChange({ minimumVotes: event.target.value ? Number(event.target.value) : undefined })
          }
          value={criteria.minimumVotes ?? ""}
        >
          <option value="">Any vote count</option>
          <option value="50">50+</option>
          <option value="250">250+</option>
          <option value="1000">1,000+</option>
          <option value="10000">10,000+</option>
        </select>
      </label>
      <label data-disabled={searchMode || undefined} htmlFor={`${idPrefix}-runtime`}>
        <span>Maximum runtime</span>
        <select
          disabled={searchMode}
          id={`${idPrefix}-runtime`}
          onChange={(event) =>
            onChange({ runtimeMax: event.target.value ? Number(event.target.value) : undefined })
          }
          value={criteria.runtimeMax ?? ""}
        >
          <option value="">Any runtime</option>
          <option value="30">30 minutes</option>
          <option value="60">60 minutes</option>
          <option value="90">90 minutes</option>
          <option value="120">2 hours</option>
          <option value="180">3 hours</option>
        </select>
      </label>
      <label data-disabled={searchMode || undefined} htmlFor={`${idPrefix}-language`}>
        <span>Original language</span>
        <select
          disabled={searchMode}
          id={`${idPrefix}-language`}
          onChange={(event) =>
            onChange({
              originalLanguage: (event.target.value || undefined) as
                DiscoveryBrowseQuery["originalLanguage"] | undefined,
            })
          }
          value={criteria.originalLanguage ?? ""}
        >
          {languageOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {searchMode ? (
        <p className={styles.filterNote}>
          Genre, runtime, vote count, and original-language filters resume when title search is
          cleared.
        </p>
      ) : null}
    </div>
  );
}

function BrowserContent({
  client,
  detailClient,
  initialCriteria,
  initialResponse,
  invalidCriteria = false,
  live = true,
  requestClient,
  themePreference = "system",
}: Required<Pick<DiscoveryBrowserProperties, "client" | "initialCriteria">> &
  Omit<DiscoveryBrowserProperties, "client" | "initialCriteria">) {
  const router = useRouter();
  const [criteria, setCriteria] = useState(initialCriteria);
  const [searchText, setSearchText] = useState(initialCriteria.query ?? "");
  const [isNavigating, startTransition] = useTransition();
  const [detailMedia, setDetailMedia] = useState<DetailMedia | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [composerMedia, setComposerMedia] = useState<RequestableMedia | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [requestedIds, setRequestedIds] = useState(() => new Set<string>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const [initialCriteriaKey] = useState(() => browseUrl(initialCriteria));

  const navigate = useCallback(
    (next: DiscoveryBrowseQuery, replace = false) => {
      setCriteria(next);
      startTransition(() => {
        if (replace) router.replace(browseUrl(next), { scroll: false });
        else router.push(browseUrl(next), { scroll: false });
      });
    },
    [router],
  );

  const changeCriteria = useCallback(
    (patch: Partial<DiscoveryBrowseQuery>) => {
      const next = { ...criteria, ...patch, page: 1 } as DiscoveryBrowseQuery;
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
      }
      if (patch.kind !== undefined) delete (next as Partial<DiscoveryBrowseQuery>).genre;
      navigate(next);
    },
    [criteria, navigate],
  );

  useEffect(() => {
    const normalized = searchText.trim();
    if (normalized === (criteria.query ?? "")) return;
    if (normalized.length === 1) return;
    const timeout = window.setTimeout(() => {
      const next = { ...criteria, page: 1 } as DiscoveryBrowseQuery;
      if (normalized.length >= 2) {
        next.query = normalized;
        delete next.genre;
        delete next.minimumVotes;
        delete next.originalLanguage;
        delete next.runtimeMax;
      } else {
        delete next.query;
      }
      navigate(next, true);
    }, 420);
    return () => window.clearTimeout(timeout);
  }, [criteria, navigate, searchText]);

  const query = useQuery({
    enabled: live,
    ...(initialResponse !== undefined && browseUrl(criteria) === initialCriteriaKey
      ? { initialData: initialResponse }
      : {}),
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => client.load(criteria, signal),
    queryKey: ["discovery-browse", criteria],
    staleTime: 60_000,
  });
  const data = query.data;
  const activeFilters = useMemo(() => {
    const filters: Array<{ key: keyof DiscoveryBrowseQuery; label: string }> = [];
    if (criteria.query) filters.push({ key: "query", label: `“${criteria.query}”` });
    if (criteria.genre) filters.push({ key: "genre", label: titleCase(criteria.genre) });
    if (criteria.yearFrom) filters.push({ key: "yearFrom", label: `From ${criteria.yearFrom}` });
    if (criteria.yearTo) filters.push({ key: "yearTo", label: `Through ${criteria.yearTo}` });
    if (criteria.minimumRating) {
      filters.push({ key: "minimumRating", label: `${criteria.minimumRating}+ rating` });
    }
    if (criteria.minimumVotes) {
      filters.push({ key: "minimumVotes", label: `${criteria.minimumVotes}+ votes` });
    }
    if (criteria.runtimeMax) {
      filters.push({ key: "runtimeMax", label: `≤ ${criteria.runtimeMax} min` });
    }
    if (criteria.originalLanguage) {
      filters.push({ key: "originalLanguage", label: criteria.originalLanguage.toUpperCase() });
    }
    if (criteria.availability !== "any") {
      filters.push({
        key: "availability",
        label:
          availabilityOptions.find(({ value }) => value === criteria.availability)?.label ??
          criteria.availability,
      });
    }
    return filters;
  }, [criteria]);

  const rememberFocus = () => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const restoreFocus = () => window.setTimeout(() => returnFocus.current?.focus(), 0);
  const openDetails = (item: DiscoveryFeedItem) => {
    rememberFocus();
    setDetailMedia(itemMedia(item));
    setDetailOpen(true);
  };
  const openRequest = (item: DiscoveryFeedItem) => {
    rememberFocus();
    setComposerMedia(itemMedia(item));
    setComposerOpen(true);
  };

  const errorKind =
    query.error instanceof DiscoveryBrowseClientError ? query.error.kind : "unavailable";
  const boundaryCopy = {
    forbidden: ["Browse permission required", "Your current role cannot browse connected media."],
    invalid_response: [
      "Browse response rejected",
      "The response failed Omnifin’s safety checks and was not displayed.",
    ],
    not_configured: [
      "Connect Seerr to start browsing",
      "An administrator needs to validate one Seerr connector.",
    ],
    signed_out: ["Sign in to browse", "Your session ended before any catalogue data was loaded."],
    unavailable: [
      "Browse is temporarily offline",
      "The gateway or Seerr could not be reached. Your library is unchanged.",
    ],
  }[errorKind];

  return (
    <div className="application-frame" style={{ "--ambient-accent": "#83e7d0" } as AmbientStyle}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <NavigationRail current="browse" />
      <div className="application-shell">
        <TopCommandBar
          connectionStatus={query.isError ? "attention" : "healthy"}
          themePreference={themePreference}
        />
        <main className={`${styles.browser} dashboard`} id="main-content" tabIndex={-1}>
          <header className={styles.hero}>
            <div>
              <p className={styles.kicker}>Intentional discovery</p>
              <h1>Browse without the guesswork.</h1>
              <p>
                Every result follows the criteria you can see. Open details or request a title
                without losing this view.
              </p>
            </div>
            <div aria-label="Media type" className={styles.kindSwitch} role="group">
              <button
                aria-pressed={criteria.kind === "movie"}
                onClick={() => changeCriteria({ kind: "movie" })}
                type="button"
              >
                <Film aria-hidden="true" /> Movies
              </button>
              <button
                aria-pressed={criteria.kind === "series"}
                onClick={() => changeCriteria({ kind: "series" })}
                type="button"
              >
                <Tv aria-hidden="true" /> Series
              </button>
            </div>
          </header>

          {invalidCriteria ? (
            <p className={styles.notice} role="status">
              Some shared filters were invalid and have been safely reset.
            </p>
          ) : null}

          <div className={styles.searchBar} data-liquid-glass>
            <Search aria-hidden="true" />
            <label className="sr-only" htmlFor="browse-search">
              Search within Browse
            </label>
            <input
              autoComplete="off"
              id="browse-search"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={`Search ${criteria.kind === "movie" ? "movies" : "series"} by title`}
              value={searchText}
            />
            {searchText ? (
              <button
                aria-label="Clear title search"
                onClick={() => setSearchText("")}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <details className={styles.mobileFilters}>
            <summary>
              <SlidersHorizontal aria-hidden="true" /> Filters
              {activeFilters.length > 0 ? <span>{activeFilters.length}</span> : null}
            </summary>
            <FilterPanel criteria={criteria} idPrefix="mobile" onChange={changeCriteria} />
          </details>

          {activeFilters.length > 0 ? (
            <div aria-label="Active filters" className={styles.activeFilters}>
              {activeFilters.map((filter) => (
                <button
                  key={filter.key}
                  onClick={() => changeCriteria({ [filter.key]: undefined })}
                  type="button"
                >
                  {filter.label} <X aria-hidden="true" />
                </button>
              ))}
              <button
                className={styles.clearFilters}
                onClick={() =>
                  navigate({
                    availability: "any",
                    kind: criteria.kind,
                    locale: criteria.locale,
                    page: 1,
                    sort: "popularity",
                  })
                }
                type="button"
              >
                Clear all
              </button>
            </div>
          ) : null}

          <div className={styles.workspace}>
            <aside aria-label="Browse filters" className={styles.filterRail} data-liquid-glass>
              <div className={styles.filterHeading}>
                <div>
                  <p>Refine</p>
                  <h2>Your criteria</h2>
                </div>
                <SlidersHorizontal aria-hidden="true" />
              </div>
              <FilterPanel criteria={criteria} idPrefix="desktop" onChange={changeCriteria} />
            </aside>

            <section
              aria-busy={query.isFetching}
              aria-labelledby="browse-results-title"
              className={styles.results}
            >
              <div className={styles.resultsHeading}>
                <div>
                  <p className={styles.kicker}>Catalogue signal</p>
                  <h2 id="browse-results-title">
                    {criteria.kind === "movie" ? "Movies" : "Series"}
                  </h2>
                </div>
                <p aria-live="polite">
                  {query.isFetching || isNavigating ? (
                    <>
                      <LoaderCircle aria-hidden="true" /> Updating
                    </>
                  ) : data ? (
                    `${data.totalResults.toLocaleString()} candidates · page ${data.page}`
                  ) : (
                    "Catalogue unavailable"
                  )}
                </p>
              </div>

              {query.isPending ? (
                <div aria-label="Loading browse results" className={styles.grid} role="status">
                  {Array.from({ length: 10 }, (_, index) => (
                    <article className={styles.skeleton} key={index}>
                      <span /> <i /> <i />
                    </article>
                  ))}
                </div>
              ) : !data ? (
                <div className={styles.boundary} data-liquid-glass>
                  <CloudOff aria-hidden="true" />
                  <div>
                    <h3>{boundaryCopy[0]}</h3>
                    <p>{boundaryCopy[1]}</p>
                  </div>
                  <button onClick={() => void query.refetch()} type="button">
                    <RefreshCw aria-hidden="true" /> Try again
                  </button>
                </div>
              ) : data.items.length === 0 ? (
                <div className={styles.empty} data-liquid-glass>
                  <Sparkles aria-hidden="true" />
                  <h3>No titles match this page.</h3>
                  <p>
                    Loosen one visible filter
                    {data.page < data.totalPages ? " or inspect the next catalogue page" : ""}.
                  </p>
                </div>
              ) : (
                <div className={styles.grid}>
                  {data.items.map((item) => {
                    const requested = requestedIds.has(item.id);
                    const artwork = item.artwork.posterPath;
                    const accent = accentColors[item.tmdbId % accentColors.length]!;
                    return (
                      <article
                        className={styles.card}
                        key={item.id}
                        style={{ "--browse-accent": accent } as CardStyle}
                      >
                        <button
                          aria-label={`View details for ${item.title}`}
                          className={styles.cardPrimary}
                          onClick={() => openDetails(item)}
                          type="button"
                        >
                          <span className={styles.poster}>
                            {artwork ? (
                              // Same-origin opaque artwork reference; native lazy loading protects LCP.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img alt="" decoding="async" loading="lazy" src={artwork} />
                            ) : null}
                            <span className={styles.posterGlow} />
                          </span>
                          <span className={styles.cardCopy}>
                            <strong>{item.title}</strong>
                            <span>
                              {item.year ?? "Year unknown"}
                              {item.voteAverage === null ? null : (
                                <>
                                  {" "}
                                  · <Star aria-hidden="true" /> {item.voteAverage.toFixed(1)}
                                </>
                              )}
                            </span>
                            <small>{requested ? "Requested" : availabilityLabel(item)}</small>
                          </span>
                        </button>
                        {isRequestable(item) && !requested ? (
                          <button
                            aria-label={`Request ${item.title}`}
                            className={styles.requestButton}
                            onClick={() => openRequest(item)}
                            type="button"
                          >
                            <Sparkles aria-hidden="true" /> Request
                          </button>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}

              {data && data.totalPages > 1 ? (
                <nav aria-label="Browse pages" className={styles.pagination}>
                  <button
                    disabled={criteria.page <= 1}
                    onClick={() => navigate({ ...criteria, page: criteria.page - 1 })}
                    type="button"
                  >
                    <ChevronLeft aria-hidden="true" /> Previous
                  </button>
                  <span>
                    Page {data.page} of {data.totalPages}
                  </span>
                  <button
                    disabled={criteria.page >= data.totalPages}
                    onClick={() => navigate({ ...criteria, page: criteria.page + 1 })}
                    type="button"
                  >
                    Next <ChevronRight aria-hidden="true" />
                  </button>
                </nav>
              ) : null}
            </section>
          </div>
        </main>
      </div>
      <MobileNavigation current="browse" />

      {detailMedia ? (
        <MediaDetailDrawer
          {...(detailClient ? { client: detailClient } : {})}
          key={detailMedia.id}
          media={detailMedia}
          onOpenChange={(open) => {
            setDetailOpen(open);
            if (!open) {
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
          onOpenChange={(open) => {
            setComposerOpen(open);
            if (!open) {
              setComposerMedia(null);
              restoreFocus();
            }
          }}
          open={composerOpen}
        />
      ) : null}
    </div>
  );
}

export function DiscoveryBrowser({
  client = discoveryBrowseClient,
  ...properties
}: DiscoveryBrowserProperties) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserContent client={client} key={browseUrl(properties.initialCriteria)} {...properties} />
    </QueryClientProvider>
  );
}
