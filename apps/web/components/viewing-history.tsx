"use client";

import type {
  ViewingHistoryEntry,
  ViewingHistoryKind,
  ViewingHistoryRange,
  ViewingHistoryResponse,
  ViewingHistoryState,
} from "@omnifin/contracts/library";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  CalendarClock,
  Check,
  ChevronDown,
  Clock3,
  CloudOff,
  Film,
  History,
  LoaderCircle,
  LockKeyhole,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Tv,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, type CSSProperties, type KeyboardEvent } from "react";

import { handleDirectionalFocus } from "../lib/directional-focus";
import { sameOriginMediaPath } from "../lib/media-library";
import type { PlaybackClient } from "../lib/playback";
import {
  viewingHistoryClient,
  viewingHistoryOutcomeFromError,
  type ViewingHistoryClient,
  type ViewingHistoryLoadOutcome,
} from "../lib/viewing-history";
import { ApplicationShellContent } from "./application-shell";
import theaterStyles from "./theater-player.module.css";
import styles from "./viewing-history.module.css";

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

const KIND_OPTIONS: { icon: typeof History; label: string; value: ViewingHistoryKind }[] = [
  { icon: History, label: "Everything", value: "all" },
  { icon: Film, label: "Movies", value: "movies" },
  { icon: Tv, label: "Episodes", value: "episodes" },
];

const STATE_OPTIONS: { label: string; value: ViewingHistoryState }[] = [
  { label: "All activity", value: "all" },
  { label: "Completed", value: "completed" },
  { label: "In progress", value: "in_progress" },
];

const RANGE_OPTIONS: { label: string; value: ViewingHistoryRange }[] = [
  { label: "Past 7 days", value: "7_days" },
  { label: "Past 30 days", value: "30_days" },
  { label: "Past 90 days", value: "90_days" },
  { label: "Past year", value: "1_year" },
  { label: "All time", value: "all" },
];

const fallbackAccents = ["#6f8d84", "#8e715f", "#647a98", "#8b6f8d"] as const;
type AmbientStyle = CSSProperties & { "--ambient-accent": string };
type EntryStyle = CSSProperties & { "--history-accent": string };

export interface ViewingHistoryProperties {
  client?: ViewingHistoryClient;
  initialOutcome?: ViewingHistoryLoadOutcome;
  live?: boolean;
  playbackClient?: PlaybackClient;
}

function fallbackAccent(entry: ViewingHistoryEntry) {
  let hash = 0;
  for (const character of `${entry.media.kind}:${entry.media.title}`) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return fallbackAccents[hash % fallbackAccents.length]!;
}

function uniqueEntries(pages: ViewingHistoryResponse[]) {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.items.filter((entry) => {
      if (seen.has(entry.media.id)) return false;
      seen.add(entry.media.id);
      return true;
    }),
  );
}

function rangeStart(range: ViewingHistoryRange, generatedAt: string) {
  if (range === "all") return null;
  const start = new Date(generatedAt);
  if (range === "1_year") start.setUTCFullYear(start.getUTCFullYear() - 1);
  else
    start.setUTCDate(start.getUTCDate() - (range === "7_days" ? 7 : range === "30_days" ? 30 : 90));
  return start.valueOf();
}

function locallyFilteredEntries(
  entries: ViewingHistoryEntry[],
  kind: ViewingHistoryKind,
  state: ViewingHistoryState,
  range: ViewingHistoryRange,
  generatedAt: string,
) {
  const since = rangeStart(range, generatedAt);
  return entries.filter(
    (entry) =>
      (kind === "all" ||
        (kind === "movies" && entry.media.kind === "movie") ||
        (kind === "episodes" && entry.media.kind === "episode")) &&
      (state === "all" || entry.activity === state) &&
      (since === null || Date.parse(entry.lastPlayedAt) >= since),
  );
}

function timestampLabel(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp));
}

function dayLabel(timestamp: string, generatedAt: string) {
  const date = new Date(timestamp);
  const generated = new Date(generatedAt);
  const dateKey = date.toISOString().slice(0, 10);
  const generatedKey = generated.toISOString().slice(0, 10);
  if (dateKey === generatedKey) return "Today";
  const yesterday = new Date(generated);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (dateKey === yesterday.toISOString().slice(0, 10)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function groupedEntries(entries: ViewingHistoryEntry[], generatedAt: string) {
  const groups = new Map<string, ViewingHistoryEntry[]>();
  for (const entry of entries) {
    const label = dayLabel(entry.lastPlayedAt, generatedAt);
    const group = groups.get(label) ?? [];
    group.push(entry);
    groups.set(label, group);
  }
  return [...groups.entries()];
}

function moveRadioSelection<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  options: readonly { value: T }[],
  onChange: (value: T) => void,
) {
  if (!["ArrowLeft", "ArrowRight", "End", "Home"].includes(event.key)) return;
  event.preventDefault();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowRight"
          ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length;
  onChange(options[nextIndex]!.value);
  event.currentTarget.parentElement
    ?.querySelectorAll<HTMLButtonElement>("button")
    [nextIndex]?.focus();
}

function HistoryShell({
  accent = "#6f8d84",
  children,
  status,
}: {
  accent?: string;
  children: React.ReactNode;
  status: "attention" | "healthy" | "offline";
}) {
  return (
    <ApplicationShellContent accent={accent} status={status}>
      <main
        className={`${styles.history} dashboard`}
        id="main-content"
        style={{ "--ambient-accent": accent } as AmbientStyle}
        tabIndex={-1}
      >
        {children}
      </main>
    </ApplicationShellContent>
  );
}

function HistoryLoading() {
  return (
    <HistoryShell status="attention">
      <section aria-busy="true" aria-labelledby="history-loading-title" className={styles.loading}>
        <p className="eyebrow">Private viewing history</p>
        <h1 id="history-loading-title">Replaying your recent signals…</h1>
        <div aria-hidden="true" className={styles.loadingList}>
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <span className="sr-only" role="status">
          Loading completed and in-progress titles from your paired Jellyfin account.
        </span>
      </section>
    </HistoryShell>
  );
}

const boundaryCopy = {
  forbidden: {
    detail: "Your current Omnifin role does not include private playback-history access.",
    icon: ShieldAlert,
    title: "Viewing history is not available to this account.",
  },
  signed_out: {
    detail: "Sign in and pair your Jellyfin identity to see only its playback activity.",
    icon: LockKeyhole,
    title: "Sign in to open your viewing history.",
  },
} as const;

function HistoryBoundary({ kind }: { kind: keyof typeof boundaryCopy }) {
  const copy = boundaryCopy[kind];
  const Icon = copy.icon;
  return (
    <HistoryShell status="attention">
      <section className={styles.boundary} data-liquid-glass role="status">
        <span aria-hidden="true">
          <Icon />
        </span>
        <p className="eyebrow">Private by design</p>
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
        <Link className="button button--primary" href={kind === "signed_out" ? "/login" : "/"}>
          {kind === "signed_out" ? "Sign in" : "Return to discovery"}
        </Link>
      </section>
    </HistoryShell>
  );
}

function HistoryUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <HistoryShell status="offline">
      <section className={styles.boundary} data-liquid-glass role="alert">
        <span aria-hidden="true">
          <CloudOff />
        </span>
        <p className="eyebrow">History signal interrupted</p>
        <h1>Your activity remains safely in Jellyfin.</h1>
        <p>
          Omnifin could not verify current playback history. No cached activity is shown as fresh.
        </p>
        <button className="button button--glass" onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" /> Try again
        </button>
      </section>
    </HistoryShell>
  );
}

function HistoryEntryCard({
  entry,
  onPlay,
}: {
  entry: ViewingHistoryEntry;
  onPlay: (entry: ViewingHistoryEntry, positionSeconds: number) => void;
}) {
  const artwork = sameOriginMediaPath(
    entry.media.artwork.posterPath ?? entry.media.artwork.backdropPath,
  );
  const accent = entry.media.artwork.accentColor ?? fallbackAccent(entry);
  const progress = Math.round(
    (entry.playback.positionSeconds / entry.playback.durationSeconds) * 100,
  );
  return (
    <article
      className={styles.entry}
      role="listitem"
      style={{ "--history-accent": accent } as EntryStyle}
    >
      <span className={styles.poster} data-artwork-source={artwork ? "remote" : "generated"}>
        {artwork ? (
          // Artwork remains on Omnifin's authenticated, opaque media route.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="" decoding="async" loading="lazy" src={artwork} />
        ) : null}
        <span aria-hidden="true">{entry.media.title.slice(0, 1)}</span>
      </span>
      <div className={styles.entryCopy}>
        <div className={styles.entryHeading}>
          <div>
            <p className="eyebrow">{entry.media.kind === "episode" ? "Episode" : "Movie"}</p>
            <h3>{entry.media.title}</h3>
          </div>
          <span className={styles.activity} data-activity={entry.activity}>
            {entry.activity === "completed" ? (
              <Check aria-hidden="true" />
            ) : (
              <Clock3 aria-hidden="true" />
            )}
            {entry.activity === "completed" ? "Completed" : "In progress"}
          </span>
        </div>
        {entry.media.subtitle ? <p className={styles.subtitle}>{entry.media.subtitle}</p> : null}
        <p className={styles.playedAt}>
          <CalendarClock aria-hidden="true" /> Last played {timestampLabel(entry.lastPlayedAt)}
        </p>
        {entry.activity === "in_progress" ? (
          <div className={styles.progressCopy}>
            <span
              aria-label={`${progress}% watched`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progress}
              className={styles.progress}
              role="progressbar"
            >
              <i style={{ width: `${progress}%` }} />
            </span>
            <small>{progress}%</small>
          </div>
        ) : null}
        <div className={styles.entryActions}>
          <button
            className="button button--primary"
            data-directional-item
            onClick={() =>
              onPlay(entry, entry.activity === "in_progress" ? entry.playback.positionSeconds : 0)
            }
            type="button"
          >
            <Play aria-hidden="true" fill="currentColor" />
            {entry.activity === "in_progress" ? "Resume" : "Play again"}
          </button>
          {entry.activity === "in_progress" ? (
            <button
              className="button button--glass"
              data-directional-item
              onClick={() => onPlay(entry, 0)}
              type="button"
            >
              <RotateCcw aria-hidden="true" /> From beginning
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function HistoryTheater({
  entry,
  onClose,
  playbackClient,
  positionSeconds,
}: {
  entry: ViewingHistoryEntry;
  onClose: () => void;
  playbackClient?: PlaybackClient;
  positionSeconds: number;
}) {
  const artworkPath = sameOriginMediaPath(
    entry.media.artwork.backdropPath ?? entry.media.artwork.posterPath,
  );
  return (
    <TheaterPlayer
      {...(playbackClient === undefined ? {} : { client: playbackClient })}
      media={{
        accent: entry.media.artwork.accentColor ?? fallbackAccent(entry),
        ...(artworkPath === undefined ? {} : { artworkPath }),
        eyebrow:
          entry.media.subtitle ??
          [
            entry.media.year,
            entry.media.runtimeMinutes ? `${entry.media.runtimeMinutes} min` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        id: entry.media.id,
        positionSeconds,
        title: entry.media.title,
      }}
      onClose={onClose}
      startWhenReady
    />
  );
}

function ViewingHistoryContent({
  client,
  initialOutcome,
  live,
  playbackClient,
}: Required<Pick<ViewingHistoryProperties, "client">> &
  Pick<ViewingHistoryProperties, "initialOutcome" | "live" | "playbackClient">) {
  const [kind, setKind] = useState<ViewingHistoryKind>("all");
  const [state, setState] = useState<ViewingHistoryState>("all");
  const [range, setRange] = useState<ViewingHistoryRange>("30_days");
  const [playing, setPlaying] = useState<{
    entry: ViewingHistoryEntry;
    positionSeconds: number;
  } | null>(null);
  const refreshAvailable = live ?? initialOutcome === undefined;
  const initialHistory = initialOutcome?.status === "ready" ? initialOutcome.history : undefined;
  const initialData: InfiniteData<ViewingHistoryResponse, string | undefined> | undefined =
    initialHistory ? { pageParams: [undefined], pages: [initialHistory] } : undefined;
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
          limit: 24,
          range,
          state,
        },
        signal,
      ),
    queryKey: ["viewing-history", kind, range, state],
    placeholderData: (previous) => previous,
    retry: false,
    staleTime: 15_000,
  });

  if (!refreshAvailable && initialOutcome) {
    if (initialOutcome.status === "loading") return <HistoryLoading />;
    if (initialOutcome.status === "forbidden" || initialOutcome.status === "signed_out") {
      return <HistoryBoundary kind={initialOutcome.status} />;
    }
    if (initialOutcome.status === "unavailable") {
      return <HistoryUnavailable onRetry={() => undefined} />;
    }
  }
  if (query.isPending) return <HistoryLoading />;
  if (!query.data) {
    const outcome = viewingHistoryOutcomeFromError(query.error);
    return outcome === "unavailable" ? (
      <HistoryUnavailable onRetry={() => void query.refetch()} />
    ) : (
      <HistoryBoundary kind={outcome} />
    );
  }

  const pages = query.data.pages;
  const latest = pages.at(-1)!;
  if (latest.state === "unavailable") {
    return <HistoryUnavailable onRetry={() => void query.refetch()} />;
  }
  const loadedEntries = uniqueEntries(pages);
  const entries = locallyFilteredEntries(loadedEntries, kind, state, range, latest.generatedAt);
  const groups = groupedEntries(entries, latest.generatedAt);
  const completed = entries.filter((entry) => entry.activity === "completed").length;
  const accent = entries[0]?.media.artwork.accentColor ?? "#6f8d84";

  return (
    <HistoryShell accent={accent} status={query.isError ? "attention" : "healthy"}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.heroGlyph} data-liquid-glass>
            <History aria-hidden="true" />
          </span>
          <p className="eyebrow">Private viewing history</p>
          <h1>Your story, in sequence.</h1>
          <p>
            A current, user-scoped view of what you completed and where you paused. Jellyfin remains
            the source of truth across every screen in your home.
          </p>
          <Link className="button button--glass" href="/library">
            Back to library
          </Link>
        </div>
        <dl className={styles.metrics} data-liquid-glass>
          <div>
            <dt>In view</dt>
            <dd>{entries.length}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{completed}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>Only you</dd>
          </div>
        </dl>
      </header>

      <section aria-label="Viewing history filters" className={styles.filters} data-liquid-glass>
        <div aria-label="Media type" className={styles.segmented} role="radiogroup">
          {KIND_OPTIONS.map(({ icon: Icon, label, value }, index) => (
            <button
              aria-checked={kind === value}
              data-selected={kind === value || undefined}
              key={value}
              onClick={() => setKind(value)}
              onKeyDown={(event) => moveRadioSelection(event, index, KIND_OPTIONS, setKind)}
              role="radio"
              tabIndex={kind === value ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
        <div aria-label="Playback state" className={styles.segmented} role="radiogroup">
          {STATE_OPTIONS.map(({ label, value }, index) => (
            <button
              aria-checked={state === value}
              data-selected={state === value || undefined}
              key={value}
              onClick={() => setState(value)}
              onKeyDown={(event) => moveRadioSelection(event, index, STATE_OPTIONS, setState)}
              role="radio"
              tabIndex={state === value ? 0 : -1}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <label className={styles.range}>
          <span>Date range</span>
          <select
            aria-label="Viewing history date range"
            onChange={(event) => setRange(event.target.value as ViewingHistoryRange)}
            value={range}
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
      </section>

      <section aria-labelledby="history-results-title" className={styles.results}>
        <div className={styles.resultsHeading}>
          <div>
            <p className="eyebrow">Jellyfin-backed activity</p>
            <h2 id="history-results-title">
              {entries.length === 1 ? "1 title" : `${entries.length} titles`} in view
            </h2>
          </div>
          <span aria-live="polite" role="status">
            {query.isFetchingNextPage
              ? "Loading earlier activity…"
              : query.isError
                ? "Earlier activity could not be verified"
                : "Up to date"}
          </span>
        </div>
        {query.isError && entries.length > 0 ? (
          <div className={styles.inlineError} role="alert">
            <CloudOff aria-hidden="true" />
            <span>Loaded activity is still visible, but the next page could not be verified.</span>
            <button onClick={() => void query.fetchNextPage()} type="button">
              Try again
            </button>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className={styles.empty} data-liquid-glass role="status">
            <History aria-hidden="true" />
            <h3>No activity matches this view.</h3>
            <p>Widen the date range or include another playback state.</p>
            <button
              className="button button--glass"
              onClick={() => {
                setKind("all");
                setState("all");
                setRange("30_days");
              }}
              type="button"
            >
              Reset filters
            </button>
          </div>
        ) : (
          <div className={styles.groups}>
            {groups.map(([label, group]) => (
              <section
                aria-labelledby={`history-day-${label.replaceAll(/[^a-z0-9]/giu, "-")}`}
                className={styles.day}
                key={label}
              >
                <h3 id={`history-day-${label.replaceAll(/[^a-z0-9]/giu, "-")}`}>{label}</h3>
                <div
                  className={styles.list}
                  onKeyDown={(event) => handleDirectionalFocus(event, { axis: "vertical" })}
                  role="list"
                >
                  {group.map((entry) => (
                    <HistoryEntryCard
                      entry={entry}
                      key={entry.media.id}
                      onPlay={(selected, positionSeconds) =>
                        setPlaying({ entry: selected, positionSeconds })
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {refreshAvailable && query.hasNextPage ? (
          <button
            className={`button button--glass ${styles.more}`}
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            type="button"
          >
            {query.isFetchingNextPage ? (
              <LoaderCircle aria-hidden="true" />
            ) : (
              <History aria-hidden="true" />
            )}
            {query.isFetchingNextPage ? "Loading earlier activity…" : "Load earlier activity"}
          </button>
        ) : null}
      </section>

      {playing ? (
        <HistoryTheater
          entry={playing.entry}
          onClose={() => setPlaying(null)}
          {...(playbackClient === undefined ? {} : { playbackClient })}
          positionSeconds={playing.positionSeconds}
        />
      ) : null}
    </HistoryShell>
  );
}

const lazyViewingHistoryDemoClient: ViewingHistoryClient = {
  async load(input, signal) {
    const { viewingHistoryDemoClient } = await import("../lib/viewing-history-demo");
    return viewingHistoryDemoClient.load(input, signal);
  },
};

export function ViewingHistory({
  client,
  initialOutcome,
  live,
  playbackClient,
}: ViewingHistoryProperties) {
  const resolvedClient =
    client ??
    (live === false && initialOutcome?.status === "ready"
      ? lazyViewingHistoryDemoClient
      : viewingHistoryClient);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { gcTime: 5 * 60_000, retry: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ViewingHistoryContent
        client={resolvedClient}
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
        {...(live === undefined ? {} : { live })}
        {...(playbackClient === undefined ? {} : { playbackClient })}
      />
    </QueryClientProvider>
  );
}
