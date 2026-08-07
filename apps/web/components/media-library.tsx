"use client";

import type {
  LibraryBrowseItem,
  LibraryBrowseKind,
  LibraryBrowseResponse,
  LibraryBrowseSort,
} from "@omnifin/contracts/library";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Clapperboard,
  Clock3,
  CloudOff,
  Film,
  Info,
  Library,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Tv,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";

import { handleDirectionalFocus } from "../lib/directional-focus";
import {
  mediaLibraryClient,
  mediaLibraryOutcomeFromError,
  sameOriginMediaPath,
  type MediaLibraryClient,
  type MediaLibraryLoadOutcome,
} from "../lib/media-library";
import type { PlaybackClient } from "../lib/playback";
import type { ThemePreference } from "../lib/theme";
import { ApplicationShellContent } from "./application-shell";
import { SavedTitleActions } from "./saved-title-actions";
import theaterStyles from "./theater-player.module.css";
import type { PlayableLibrarySelection } from "./library-title-drawer";
import styles from "./media-library.module.css";

const TheaterPlayer = dynamic(
  () => import("./theater-player").then((module) => module.TheaterPlayer),
  {
    loading: () => (
      <div aria-label="Opening theater player" className={theaterStyles.chunkLoader} role="status">
        <span aria-hidden="true" className={theaterStyles.chunkLoaderOrb} />
        <span>Opening theater…</span>
      </div>
    ),
    ssr: false,
  },
);

const LibraryTitleDrawer = dynamic(
  () => import("./library-title-drawer").then((module) => module.LibraryTitleDrawer),
  { ssr: false },
);

const lazyMediaLibraryDemoClient: MediaLibraryClient = {
  async load(input, signal) {
    const { mediaLibraryDemoClient } = await import("../lib/media-library-demo");
    return mediaLibraryDemoClient.load(input, signal);
  },
  async loadSeasonEpisodes(referenceId, seasonNumber, input, signal) {
    const { mediaLibraryDemoClient } = await import("../lib/media-library-demo");
    return mediaLibraryDemoClient.loadSeasonEpisodes!(referenceId, seasonNumber, input, signal);
  },
  async loadExtras(referenceId, input, signal) {
    const { mediaLibraryDemoClient } = await import("../lib/media-library-demo");
    return mediaLibraryDemoClient.loadExtras!(referenceId, input, signal);
  },
  async loadTitle(referenceId, signal) {
    const { mediaLibraryDemoClient } = await import("../lib/media-library-demo");
    return mediaLibraryDemoClient.loadTitle!(referenceId, signal);
  },
  async updatePlaybackState(referenceId, request, signal, idempotencyKey) {
    const { mediaLibraryDemoClient } = await import("../lib/media-library-demo");
    return mediaLibraryDemoClient.updatePlaybackState!(
      referenceId,
      request,
      signal,
      idempotencyKey,
    );
  },
};

const KIND_OPTIONS: { icon: typeof Library; label: string; value: LibraryBrowseKind }[] = [
  { icon: Library, label: "All", value: "all" },
  { icon: Film, label: "Movies", value: "movies" },
  { icon: Tv, label: "Series", value: "series" },
];

const SORT_OPTIONS: { label: string; value: LibraryBrowseSort }[] = [
  { label: "Recently added", value: "recent" },
  { label: "Title", value: "title" },
  { label: "Release year", value: "year" },
];

const fallbackAccents = ["#6f8d84", "#8e715f", "#647a98", "#8b6f8d", "#9b8659"] as const;

type AmbientStyle = CSSProperties & { "--ambient-accent": string };
type PosterStyle = CSSProperties & { "--library-accent": string };

export interface MediaLibraryProperties {
  client?: MediaLibraryClient;
  initialOutcome?: MediaLibraryLoadOutcome;
  live?: boolean;
  playbackClient?: PlaybackClient;
  themePreference?: ThemePreference;
}

function fallbackAccent(item: LibraryBrowseItem) {
  let hash = 0;
  for (const character of `${item.media.kind}:${item.media.title}`) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return fallbackAccents[hash % fallbackAccents.length]!;
}

function itemAccent(item: LibraryBrowseItem) {
  return item.media.artwork.accentColor ?? fallbackAccent(item);
}

function itemCaption(item: LibraryBrowseItem) {
  return (
    item.media.subtitle ??
    [item.media.year, item.media.runtimeMinutes ? `${item.media.runtimeMinutes} min` : null]
      .filter(Boolean)
      .join(" · ")
  );
}

function uniqueItems(pages: LibraryBrowseResponse[]) {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.items.filter((item) => {
      if (seen.has(item.media.id)) return false;
      seen.add(item.media.id);
      return true;
    }),
  );
}

function locallyFilteredItems(
  items: LibraryBrowseItem[],
  kind: LibraryBrowseKind,
  query: string,
  sort: LibraryBrowseSort,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => {
    const matchesKind =
      kind === "all" ||
      (kind === "movies" && item.media.kind === "movie") ||
      (kind === "series" && item.media.kind === "series");
    const matchesQuery =
      !normalizedQuery ||
      [item.media.title, item.media.subtitle, item.media.overview]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    return matchesKind && matchesQuery;
  });
  if (sort === "title") {
    return filtered.toSorted((left, right) => left.media.title.localeCompare(right.media.title));
  }
  if (sort === "year") {
    return filtered.toSorted(
      (left, right) =>
        (right.media.year ?? 0) - (left.media.year ?? 0) ||
        left.media.title.localeCompare(right.media.title),
    );
  }
  return filtered;
}

function LibraryShell({
  accent = "#6f8d84",
  children,
  connectionStatus,
}: {
  accent?: string;
  children: React.ReactNode;
  connectionStatus: "attention" | "healthy" | "offline";
}) {
  return (
    <ApplicationShellContent accent={accent} status={connectionStatus}>
      <main
        className={`${styles.library} dashboard`}
        id="main-content"
        style={{ "--ambient-accent": accent } as AmbientStyle}
        tabIndex={-1}
      >
        {children}
      </main>
    </ApplicationShellContent>
  );
}

function LoadingLibrary() {
  return (
    <LibraryShell connectionStatus="attention">
      <section aria-busy="true" aria-labelledby="library-loading-title" className={styles.loading}>
        <div className={styles.loadingHero}>
          <span />
          <h1 id="library-loading-title">Gathering your library…</h1>
          <i />
          <i />
        </div>
        <div className={styles.loadingControls} />
        <div aria-hidden="true" className={styles.loadingGrid}>
          {Array.from({ length: 10 }, (_, index) => (
            <article key={index}>
              <span />
              <i />
              <b />
            </article>
          ))}
        </div>
        <span className="sr-only" role="status">
          Loading movies and series from your paired Jellyfin account.
        </span>
      </section>
    </LibraryShell>
  );
}

const boundaryCopy = {
  forbidden: {
    action: "Return to discovery",
    detail: "Your current Omnifin role does not include media-library access.",
    href: "/",
    icon: ShieldAlert,
    kicker: "Library boundary",
    title: "This library is not available to your account.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Use OIDC or Jellyfin, then pair your Jellyfin identity to see its private library.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Your shelf is waiting",
    title: "Sign in to open your library.",
  },
} as const;

function AccessBoundary({ kind }: { kind: keyof typeof boundaryCopy }) {
  const copy = boundaryCopy[kind];
  const Icon = copy.icon;
  return (
    <LibraryShell connectionStatus="attention">
      <section className={styles.boundary} data-liquid-glass role="status">
        <span aria-hidden="true" className={styles.boundaryIcon}>
          <Icon />
        </span>
        <p className="eyebrow">{copy.kicker}</p>
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
        <Link className="button button--primary" href={copy.href}>
          {copy.action}
        </Link>
      </section>
    </LibraryShell>
  );
}

function UnavailableLibrary({ onRetry }: { onRetry: () => void }) {
  return (
    <LibraryShell connectionStatus="offline">
      <section className={styles.boundary} data-liquid-glass role="alert">
        <span aria-hidden="true" className={styles.boundaryIcon}>
          <CloudOff />
        </span>
        <p className="eyebrow">Signal interrupted</p>
        <h1>Your library is still safely at home.</h1>
        <p>
          Omnifin cannot reach the paired Jellyfin server right now. Nothing was changed, and no
          cached title is being presented as current.
        </p>
        <button className="button button--glass" onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" size={17} /> Try again
        </button>
      </section>
    </LibraryShell>
  );
}

function EmptyLibrary({ clearSearch, filtered }: { clearSearch: () => void; filtered: boolean }) {
  return (
    <section className={styles.empty} data-liquid-glass role="status">
      <span aria-hidden="true" className={styles.emptyOrbit}>
        <Clapperboard />
      </span>
      <p className="eyebrow">{filtered ? "No close matches" : "A quiet shelf"}</p>
      <h2>{filtered ? "Try a wider view." : "Your paired library is empty."}</h2>
      <p>
        {filtered
          ? "Clear the search or switch media types to bring more of your collection into view."
          : "Add a movie or series in Jellyfin and it will appear here after the next scan."}
      </p>
      {filtered ? (
        <button className="button button--glass" onClick={clearSearch} type="button">
          <X aria-hidden="true" size={16} /> Clear filters
        </button>
      ) : (
        <Link className="button button--glass" href="/">
          Explore discovery
        </Link>
      )}
    </section>
  );
}

function LibraryCard({ item, onSelect }: { item: LibraryBrowseItem; onSelect: () => void }) {
  const artworkPath = sameOriginMediaPath(
    item.media.artwork.posterPath ?? item.media.artwork.backdropPath,
  );
  const accent = itemAccent(item);
  const progress = item.playback
    ? Math.round((item.playback.positionSeconds / item.playback.durationSeconds) * 100)
    : 0;
  const caption = itemCaption(item);
  return (
    <article className={styles.card} style={{ "--library-accent": accent } as PosterStyle}>
      <SavedTitleActions compact referenceId={item.media.id} title={item.media.title} />
      <button
        aria-label={`View details for ${item.media.title}${caption ? `, ${caption}` : ""}`}
        className={styles.cardAction}
        data-directional-item
        data-library-id={item.media.id}
        onClick={onSelect}
        type="button"
      >
        <span className={styles.poster} data-artwork-source={artworkPath ? "remote" : "generated"}>
          {artworkPath ? (
            // Artwork remains on Omnifin's authenticated origin and is loaded only near view.
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="" decoding="async" loading="lazy" src={artworkPath} />
          ) : null}
          <span aria-hidden="true" className={styles.posterOrb} />
          <span aria-hidden="true" className={styles.posterArc} />
          <span aria-hidden="true" className={styles.posterIndex}>
            {item.media.kind === "series" ? "TV" : "FM"}
          </span>
          <span aria-hidden="true" className={styles.posterShade} />
          <span aria-hidden="true" className={styles.playBadge}>
            <Info size={18} />
          </span>
          {item.playback?.played ? (
            <span className={styles.watchedBadge}>
              <Check aria-hidden="true" size={12} /> Watched
            </span>
          ) : null}
          {progress > 0 && !item.playback?.played ? (
            <span
              aria-label={`${progress}% watched`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progress}
              className={styles.progress}
              role="progressbar"
            >
              <i aria-hidden="true" style={{ width: `${progress}%` }} />
            </span>
          ) : null}
        </span>
        <span className={styles.cardCopy}>
          <strong>{item.media.title}</strong>
          <span>{caption}</span>
        </span>
      </button>
    </article>
  );
}

function MediaLibraryContent({
  client,
  initialOutcome,
  live,
  playbackClient,
}: Required<Pick<MediaLibraryProperties, "client">> &
  Pick<MediaLibraryProperties, "initialOutcome" | "live" | "playbackClient">) {
  const [kind, setKind] = useState<LibraryBrowseKind>("all");
  const [sort, setSort] = useState<LibraryBrowseSort>("recent");
  const [draftQuery, setDraftQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selected, setSelected] = useState<LibraryBrowseItem | null>(null);
  const [playing, setPlaying] = useState<PlayableLibrarySelection | null>(null);
  const searchReference = useRef<HTMLInputElement>(null);
  const refreshAvailable = live ?? initialOutcome === undefined;
  const initialFeed = initialOutcome?.status === "ready" ? initialOutcome.feed : undefined;
  const initialData: InfiniteData<LibraryBrowseResponse, string | undefined> | undefined =
    initialFeed ? { pageParams: [undefined], pages: [initialFeed] } : undefined;
  const query = useInfiniteQuery({
    enabled: refreshAvailable,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    ...(initialData === undefined ? {} : { initialData }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      client.load(
        {
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
          kind,
          limit: 30,
          ...(submittedQuery ? { query: submittedQuery } : {}),
          sort,
        },
        signal,
      ),
    queryKey: ["media-library", kind, submittedQuery, sort],
    retry: false,
    staleTime: 20_000,
  });

  if (!refreshAvailable && initialOutcome) {
    if (initialOutcome.status === "loading") return <LoadingLibrary />;
    if (initialOutcome.status === "forbidden" || initialOutcome.status === "signed_out") {
      return <AccessBoundary kind={initialOutcome.status} />;
    }
    if (initialOutcome.status === "unavailable") {
      return <UnavailableLibrary onRetry={() => undefined} />;
    }
  }
  if (query.isPending) return <LoadingLibrary />;
  if (!query.data) {
    const outcome = mediaLibraryOutcomeFromError(query.error);
    return outcome === "unavailable" ? (
      <UnavailableLibrary onRetry={() => void query.refetch()} />
    ) : (
      <AccessBoundary kind={outcome} />
    );
  }

  const pages = query.data.pages;
  const latestPage = pages.at(-1)!;
  if (latestPage.state === "unavailable") {
    return <UnavailableLibrary onRetry={() => void query.refetch()} />;
  }
  const loadedItems = uniqueItems(pages);
  const items = refreshAvailable
    ? loadedItems
    : locallyFilteredItems(loadedItems, kind, submittedQuery, sort);
  const accent = items[0] ? itemAccent(items[0]) : "#6f8d84";
  const filtersActive = kind !== "all" || Boolean(submittedQuery);
  const totalResults = refreshAvailable ? latestPage.totalResults : items.length;
  const resultCopy =
    totalResults === null
      ? `${items.length} ${items.length === 1 ? "title" : "titles"} loaded`
      : items.length < totalResults
        ? `${items.length} of ${totalResults} titles loaded`
        : `${totalResults} ${totalResults === 1 ? "title" : "titles"}`;

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedQuery(draftQuery.trim());
  }

  function clearFilters() {
    setDraftQuery("");
    setSubmittedQuery("");
    setKind("all");
    searchReference.current?.focus();
  }

  function moveKindSelection(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (!["ArrowLeft", "ArrowRight", "End", "Home"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? KIND_OPTIONS.length - 1
          : event.key === "ArrowRight"
            ? (currentIndex + 1) % KIND_OPTIONS.length
            : (currentIndex - 1 + KIND_OPTIONS.length) % KIND_OPTIONS.length;
    const next = KIND_OPTIONS[nextIndex]!;
    setKind(next.value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("button")
      [nextIndex]?.focus();
  }

  return (
    <LibraryShell accent={accent} connectionStatus={query.isError ? "attention" : "healthy"}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.heroGlyph} data-liquid-glass>
            <Sparkles aria-hidden="true" size={19} />
          </span>
          <p className="eyebrow">Your private collection</p>
          <h1>Every story, in its place.</h1>
          <p>
            Browse what your paired Jellyfin account can actually play. Omnifin keeps the service,
            token, and original media identity behind the glass.
          </p>
          <Link className={`button button--glass ${styles.historyLink}`} href="/history">
            <Clock3 aria-hidden="true" size={16} /> Viewing history
          </Link>
        </div>
        <dl className={styles.heroMetrics} data-liquid-glass>
          <div>
            <dt>Total</dt>
            <dd>{totalResults ?? "—"}</dd>
          </div>
          <div>
            <dt>Loaded</dt>
            <dd>{items.length}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{latestPage.source.displayName}</dd>
          </div>
        </dl>
      </header>

      <section aria-label="Library controls" className={styles.controls} data-liquid-glass>
        <form className={styles.search} onSubmit={submitSearch} role="search">
          <Search aria-hidden="true" size={18} />
          <label className="sr-only" htmlFor="library-search">
            Search your library
          </label>
          <input
            autoComplete="off"
            id="library-search"
            maxLength={100}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search your library"
            ref={searchReference}
            type="search"
            value={draftQuery}
          />
          {draftQuery ? (
            <button
              aria-label="Clear library search"
              className={styles.searchClear}
              onClick={() => {
                setDraftQuery("");
                if (submittedQuery) setSubmittedQuery("");
              }}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
          ) : null}
          <button className={styles.searchSubmit} type="submit">
            Search
          </button>
        </form>

        <div aria-label="Media type" className={styles.kindControl} role="radiogroup">
          {KIND_OPTIONS.map(({ icon: Icon, label, value }, index) => (
            <button
              aria-checked={kind === value}
              data-selected={kind === value || undefined}
              key={value}
              onClick={() => setKind(value)}
              onKeyDown={(event) => moveKindSelection(event, index)}
              role="radio"
              tabIndex={kind === value ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" size={15} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <label className={styles.sortControl}>
          <span>Sort</span>
          <select
            aria-label="Sort library"
            onChange={(event) => setSort(event.target.value as LibraryBrowseSort)}
            value={sort}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" size={15} />
        </label>
      </section>

      <section aria-labelledby="library-results-title" className={styles.results}>
        <div className={styles.resultsHeading}>
          <div>
            <p className="eyebrow">
              {submittedQuery ? `Results for “${submittedQuery}”` : "On your shelves"}
            </p>
            <h2 id="library-results-title">{resultCopy}</h2>
          </div>
          <span aria-live="polite" className={styles.refreshStatus} role="status">
            {query.isFetchingNextPage
              ? "Bringing in more titles…"
              : query.isFetching
                ? "Refreshing…"
                : query.isError
                  ? "Showing saved results · refresh interrupted"
                  : "Up to date"}
          </span>
        </div>

        {items.length > 0 ? (
          <div
            aria-label="Library titles"
            className={styles.grid}
            onKeyDown={(event) => handleDirectionalFocus(event, { axis: "grid" })}
            role="list"
          >
            {items.map((item) => (
              <div key={item.media.id} role="listitem">
                <LibraryCard item={item} onSelect={() => setSelected(item)} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyLibrary clearSearch={clearFilters} filtered={filtersActive} />
        )}

        {refreshAvailable && query.hasNextPage ? (
          <div className={styles.more}>
            <button
              className="button button--glass"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              type="button"
            >
              {query.isFetchingNextPage ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={17} />
              ) : (
                <Sparkles aria-hidden="true" size={17} />
              )}
              {query.isFetchingNextPage ? "Loading more…" : "Reveal more"}
            </button>
          </div>
        ) : null}
      </section>

      {selected ? (
        <LibraryTitleDrawer
          client={client}
          item={selected}
          onClose={() => {
            const selectedId = selected.media.id;
            setSelected(null);
            requestAnimationFrame(() => {
              document
                .querySelector<HTMLButtonElement>(`[data-library-id="${selectedId}"]`)
                ?.focus();
            });
          }}
          onPlay={(selection) => setPlaying(selection)}
          open
        />
      ) : null}

      {playing ? (
        <SelectedTheater
          selection={playing}
          onClose={() => setPlaying(null)}
          {...(playbackClient === undefined ? {} : { playbackClient })}
        />
      ) : null}
    </LibraryShell>
  );
}

function SelectedTheater({
  onClose,
  playbackClient,
  selection,
}: {
  onClose: () => void;
  playbackClient?: PlaybackClient;
  selection: PlayableLibrarySelection;
}) {
  const artworkPath = sameOriginMediaPath(
    selection.media.artwork.backdropPath ?? selection.media.artwork.posterPath,
  );
  return (
    <TheaterPlayer
      {...(playbackClient === undefined ? {} : { client: playbackClient })}
      media={{
        accent: selection.media.artwork.accentColor ?? "#6f8d84",
        ...(artworkPath === undefined ? {} : { artworkPath }),
        eyebrow:
          selection.media.subtitle ??
          [
            selection.media.year,
            selection.media.runtimeMinutes ? `${selection.media.runtimeMinutes} min` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        id: selection.media.id,
        ...(selection.mediaSources === undefined ? {} : { mediaSources: selection.mediaSources }),
        positionSeconds: selection.startPositionSeconds ?? selection.playback.positionSeconds,
        ...(selection.sourceReferenceId === undefined
          ? {}
          : { sourceReferenceId: selection.sourceReferenceId }),
        title: selection.media.title,
      }}
      onClose={onClose}
      startWhenReady
    />
  );
}

export function MediaLibrary({
  client,
  initialOutcome,
  live,
  playbackClient,
}: MediaLibraryProperties) {
  const resolvedClient =
    client ??
    (live === false && initialOutcome?.status === "ready"
      ? lazyMediaLibraryDemoClient
      : mediaLibraryClient);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { gcTime: 5 * 60_000, retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MediaLibraryContent
        client={resolvedClient}
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
        {...(live === undefined ? {} : { live })}
        {...(playbackClient === undefined ? {} : { playbackClient })}
      />
    </QueryClientProvider>
  );
}
