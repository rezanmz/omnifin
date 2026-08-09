"use client";

import type {
  LibraryArtworkCandidate,
  LibraryArtworkSearchResponse,
  LibraryAttentionIssue,
  LibraryAttentionItem,
} from "@omnifin/contracts/library";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Brush,
  Check,
  CircleAlert,
  CloudOff,
  ImageIcon,
  Library,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import {
  createLibraryIdempotencyKey,
  LibraryClientError,
  libraryOperationsClient,
  type LibraryLoadOutcome,
  type LibraryOperationsClient,
  type LibrarySnapshot,
} from "../lib/library-operations";
import type { ThemePreference } from "../lib/theme";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { useTheme } from "./theme-provider";
import styles from "./library-care.module.css";

function generatedTimestamp(value: string) {
  const date = new Date(value);
  const hour = date.getUTCHours();
  return `${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${date.getUTCDate()}, ${date.getUTCFullYear()} at ${hour % 12 || 12}:${String(date.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export interface LibraryCareProperties {
  client?: LibraryOperationsClient;
  initialOutcome?: LibraryLoadOutcome;
}

type Filter = "all" | "artwork" | "details" | "unmatched";
type AsyncState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; message: string }
  | { error: Error; kind: "error" };
type ArtworkState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { data: LibraryArtworkSearchResponse; kind: "ready" }
  | { error: Error; kind: "error" };

const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Unmatched", value: "unmatched" },
  { label: "Artwork", value: "artwork" },
  { label: "Details", value: "details" },
];

const THEME_OPTIONS: { icon: LucideIcon; label: string; value: ThemePreference }[] = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
];

const ISSUE_COPY: Record<LibraryAttentionIssue, string> = {
  missing_identity: "Unmatched",
  missing_overview: "No overview",
  missing_poster: "No artwork",
  missing_year: "No year",
};

function webApiPath(path: string) {
  return path.replace(/^\/v1\//u, "/api/");
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function ThemeControl() {
  const { preference, setPreference } = useTheme();

  const moveSelection = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const lastIndex = THEME_OPTIONS.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? lastIndex
          : ["ArrowRight", "ArrowDown"].includes(event.key)
            ? (currentIndex + 1) % THEME_OPTIONS.length
            : (currentIndex - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    const next = THEME_OPTIONS[nextIndex];
    if (!next) return;
    setPreference(next.value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("button")
      [nextIndex]?.focus();
  };

  return (
    <div aria-label="Color theme" className={styles.themeControl} role="radiogroup">
      {THEME_OPTIONS.map(({ icon: Icon, label, value }, index) => (
        <button
          aria-checked={preference === value}
          aria-label={`${label} theme`}
          data-selected={preference === value || undefined}
          key={value}
          onClick={() => setPreference(value)}
          onKeyDown={(event) => moveSelection(event, index)}
          role="radio"
          tabIndex={preference === value ? 0 : -1}
          type="button"
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.7} />
        </button>
      ))}
    </div>
  );
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.layout}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <header className={styles.topbar} data-liquid-glass>
          <BrandMark />
          <div className={styles.topbarActions}>
            <Link className={styles.back} href="/">
              <ArrowLeft aria-hidden="true" size={17} /> Discover
            </Link>
            <ThemeControl />
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

const STATE_COPY = {
  forbidden: {
    action: "Return to discovery",
    detail:
      "Your current role can enjoy media, while scans, metadata, and artwork changes remain behind the operator boundary.",
    href: "/",
    icon: LockKeyhole,
    kicker: "Operational boundary",
    title: "Operator access required.",
  },
  not_configured: {
    action: "Review connection",
    detail:
      "Relink or validate Jellyfin to establish the private control path used for library care.",
    href: "/settings",
    icon: Library,
    kicker: "No library signal",
    title: "Reconnect Jellyfin.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before Omnifin could inspect the linked Jellyfin library.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Session required",
    title: "Sign in to continue.",
  },
  unavailable: {
    action: null,
    detail: "The gateway or Jellyfin cannot be reached right now. No library metadata was changed.",
    href: null,
    icon: CloudOff,
    kicker: "Signal interrupted",
    title: "Library care is offline.",
  },
} as const;

function EntryState({
  kind,
  onRetry,
}: {
  kind: Exclude<LibraryLoadOutcome["status"], "ready">;
  onRetry: () => void;
}) {
  const state = STATE_COPY[kind];
  const Icon = state.icon;
  return (
    <PageFrame>
      <section className={styles.statePanel} role={kind === "unavailable" ? "alert" : "status"}>
        <span aria-hidden="true" className={styles.stateIcon}>
          <Icon />
        </span>
        <p className="eyebrow">{state.kicker}</p>
        <h1>{state.title}</h1>
        <p>{state.detail}</p>
        {state.href ? (
          <Link className={styles.primaryAction} href={state.href}>
            {state.action} <ArrowRight aria-hidden="true" size={16} />
          </Link>
        ) : (
          <button className={styles.primaryAction} onClick={onRetry} type="button">
            <RefreshCw aria-hidden="true" size={16} /> Try again
          </button>
        )}
      </section>
    </PageFrame>
  );
}

function LoadingState() {
  return (
    <PageFrame>
      <div aria-busy="true" aria-label="Loading library care" className={styles.loading}>
        <div className={styles.loadingHero}>
          <i />
          <b />
          <span />
        </div>
        <div className={styles.loadingCommand} />
        <div className={styles.loadingGrid}>
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index}>
              <i />
              <b />
              <em />
            </span>
          ))}
        </div>
        <span className="sr-only">Inspecting unmatched media, artwork, and metadata.</span>
      </div>
    </PageFrame>
  );
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <span className={styles.metric}>
      <Icon aria-hidden="true" size={17} />
      <span>
        <strong>{value}</strong>
        <small>{label}</small>
      </span>
    </span>
  );
}

function PosterArtwork({
  inspector = false,
  path,
  title,
}: {
  inspector?: boolean;
  path: string | null;
  title: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (path && !failed) {
    return (
      <>
        {loaded ? null : inspector ? (
          <ImageIcon aria-hidden="true" size={34} strokeWidth={1.2} />
        ) : (
          <span className={styles.posterFallback} aria-hidden="true">
            <ImageIcon size={31} strokeWidth={1.25} />
            <i>{title.slice(0, 1)}</i>
          </span>
        )}
        {/* The gateway emits bounded, authenticated artwork through this same-origin path. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          data-loaded={loaded || undefined}
          {...(inspector ? {} : { loading: "lazy" as const })}
          onError={() => setFailed(true)}
          onLoad={() => setLoaded(true)}
          src={webApiPath(path)}
        />
      </>
    );
  }
  if (inspector) return <ImageIcon aria-hidden="true" size={34} strokeWidth={1.2} />;
  return (
    <span className={styles.posterFallback} aria-hidden="true">
      <ImageIcon size={31} strokeWidth={1.25} />
      <i>{title.slice(0, 1)}</i>
    </span>
  );
}

function RemoteArtworkPreview({ path, provider }: { path: string; provider: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className={styles.artworkCandidateFallback} aria-hidden="true">
        <ImageIcon size={21} strokeWidth={1.25} />
        <i>{provider.slice(0, 1)}</i>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" loading="lazy" onError={() => setFailed(true)} src={webApiPath(path)} />
  );
}

function LibraryCard({
  item,
  onSelect,
  selected,
}: {
  item: LibraryAttentionItem;
  onSelect: (trigger: HTMLButtonElement) => void;
  selected: boolean;
}) {
  return (
    <article className={styles.card} data-selected={selected || undefined}>
      <button
        aria-controls="library-item-inspector"
        aria-expanded={selected}
        aria-label={`Inspect ${item.title}`}
        className={styles.cardButton}
        onClick={(event) => onSelect(event.currentTarget)}
        type="button"
      >
        <span className={styles.poster}>
          <PosterArtwork
            key={item.posterPath ?? "missing"}
            path={item.posterPath}
            title={item.title}
          />
          <span className={styles.posterSheen} aria-hidden="true" />
          <span className={styles.issueCount}>{item.issues.length}</span>
        </span>
        <span className={styles.cardCopy}>
          <span>
            <strong>{item.title}</strong>
            <small>
              {item.kind === "movie" ? "Movie" : "Series"} · {item.year ?? "Year unknown"}
            </small>
          </span>
          <span className={styles.issueChips} aria-label="Items needing attention">
            {item.issues.slice(0, 2).map((issue) => (
              <i data-critical={issue === "missing_identity" || undefined} key={issue}>
                {ISSUE_COPY[issue]}
              </i>
            ))}
            {item.issues.length > 2 && <i>+{item.issues.length - 2}</i>}
          </span>
        </span>
        <ArrowRight aria-hidden="true" className={styles.cardArrow} size={18} />
      </button>
    </article>
  );
}

function ArtworkCandidate({
  applying,
  candidate,
  onApply,
}: {
  applying: boolean;
  candidate: LibraryArtworkCandidate;
  onApply: () => void;
}) {
  return (
    <article className={styles.artworkCandidate}>
      <div>
        <RemoteArtworkPreview path={candidate.previewPath} provider={candidate.providerName} />
        <span aria-hidden="true" />
      </div>
      <p>
        <strong>{candidate.providerName}</strong>
        <small>
          {candidate.width && candidate.height
            ? `${candidate.width} × ${candidate.height}`
            : "Resolution unknown"}
          {candidate.language ? ` · ${candidate.language}` : ""}
        </small>
      </p>
      <button disabled={applying} onClick={onApply} type="button">
        {applying ? (
          <LoaderCircle aria-hidden="true" className={styles.spin} size={15} />
        ) : (
          <Check aria-hidden="true" size={15} />
        )}
        Use
      </button>
    </article>
  );
}

function ItemInspector({
  client,
  csrfToken,
  item,
  onClose,
  onLibraryChanged,
  onRestoreFocus,
}: {
  client: LibraryOperationsClient;
  csrfToken: string;
  item: LibraryAttentionItem;
  onClose: () => void;
  onLibraryChanged: (message: string) => Promise<void>;
  onRestoreFocus: () => void;
}) {
  const titleId = useId();
  const metadataTitleId = `${titleId}-title-input`;
  const metadataYearId = `${titleId}-year-input`;
  const metadataOverviewId = `${titleId}-overview-input`;
  const closeReference = useRef<HTMLButtonElement>(null);
  const keys = useRef<Record<string, string>>({});
  const artworkController = useRef<AbortController | null>(null);
  const [title, setTitle] = useState(item.title);
  const [year, setYear] = useState(item.year === null ? "" : String(item.year));
  const [overview, setOverview] = useState(item.overview ?? "");
  const [metadataState, setMetadataState] = useState<AsyncState>({ kind: "idle" });
  const [refreshState, setRefreshState] = useState<AsyncState>({ kind: "idle" });
  const [artworkState, setArtworkState] = useState<ArtworkState>({ kind: "idle" });
  const [applyingResult, setApplyingResult] = useState<string | null>(null);

  useEffect(() => {
    closeReference.current?.focus();
    return () => artworkController.current?.abort();
  }, []);

  const keyFor = (operation: string) =>
    (keys.current[operation] ??= createLibraryIdempotencyKey(operation));
  const clearKey = (operation: string) => {
    delete keys.current[operation];
  };

  async function submitMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMetadataState({ kind: "running" });
    const parsedYear = year.trim() ? Number(year) : null;
    try {
      await client.updateMetadata(
        item.referenceId,
        { overview: overview.trim() || null, title: title.trim(), year: parsedYear },
        { csrfToken, idempotencyKey: keyFor("metadata") },
      );
      clearKey("metadata");
      setMetadataState({ kind: "success", message: "Metadata accepted" });
      await onLibraryChanged("Metadata accepted. Jellyfin is updating this title.");
    } catch (error) {
      setMetadataState({
        error: error instanceof Error ? error : new Error("Metadata update failed."),
        kind: "error",
      });
    }
  }

  async function refreshItem() {
    setRefreshState({ kind: "running" });
    try {
      await client.refresh(
        item.referenceId,
        { imageMode: "missing", metadataMode: "missing" },
        { csrfToken, idempotencyKey: keyFor("refresh") },
      );
      clearKey("refresh");
      setRefreshState({ kind: "success", message: "Refresh accepted" });
      await onLibraryChanged("Jellyfin accepted a focused metadata refresh.");
    } catch (error) {
      setRefreshState({
        error: error instanceof Error ? error : new Error("Refresh failed."),
        kind: "error",
      });
    }
  }

  function searchArtwork() {
    artworkController.current?.abort();
    const controller = new AbortController();
    artworkController.current = controller;
    setArtworkState({ kind: "loading" });
    void client
      .searchArtwork(
        item.referenceId,
        { includeAllLanguages: false, kind: "poster" },
        { csrfToken, signal: controller.signal },
      )
      .then((data) => {
        if (!controller.signal.aborted) setArtworkState({ data, kind: "ready" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setArtworkState({
          error: new Error(libraryErrorMessage(error)),
          kind: "error",
        });
      });
  }

  async function applyArtwork(searchId: string, resultId: string) {
    setApplyingResult(resultId);
    try {
      await client.applyArtwork(searchId, resultId, {
        csrfToken,
        idempotencyKey: keyFor(`artwork-${resultId}`),
      });
      clearKey(`artwork-${resultId}`);
      setArtworkState({ kind: "idle" });
      await onLibraryChanged("Artwork accepted. Jellyfin is refreshing the image cache.");
    } catch (error) {
      setArtworkState({
        error: new Error(libraryErrorMessage(error)),
        kind: "error",
      });
    } finally {
      setApplyingResult(null);
    }
  }

  function close() {
    onClose();
    requestAnimationFrame(onRestoreFocus);
  }

  return (
    <div
      aria-modal="true"
      aria-labelledby={titleId}
      className={styles.inspector}
      id="library-item-inspector"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        if (event.key === "Tab") {
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => !element.hidden);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
      role="dialog"
    >
      <div aria-hidden="true" className={styles.inspectorRefraction} />
      <header className={styles.inspectorHeader}>
        <span aria-hidden="true" className={styles.inspectorIcon}>
          <WandSparkles size={19} />
        </span>
        <div>
          <span>Library inspector</span>
          <h2 id={titleId}>{item.title}</h2>
        </div>
        <button
          aria-label="Close library inspector"
          onClick={close}
          ref={closeReference}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      <div className={styles.inspectorScroll}>
        <section className={styles.inspectorSummary}>
          <div className={styles.inspectorPoster}>
            <PosterArtwork
              inspector
              key={item.posterPath ?? "missing"}
              path={item.posterPath}
              title={item.title}
            />
          </div>
          <div>
            <p>{item.overview ?? "No overview has been added to this title yet."}</p>
            <div className={styles.issueChips}>
              {item.issues.map((issue) => (
                <i data-critical={issue === "missing_identity" || undefined} key={issue}>
                  {ISSUE_COPY[issue]}
                </i>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.inspectorSection} aria-labelledby={`${titleId}-metadata`}>
          <div className={styles.sectionHeading}>
            <span aria-hidden="true">
              <Brush size={17} />
            </span>
            <div>
              <h3 id={`${titleId}-metadata`}>Editorial details</h3>
              <p>Only these three fields can be changed from Omnifin.</p>
            </div>
          </div>
          <form className={styles.metadataForm} onSubmit={(event) => void submitMetadata(event)}>
            <label htmlFor={metadataTitleId}>
              <span>Title</span>
              <input
                id={metadataTitleId}
                maxLength={300}
                onChange={(event) => setTitle(event.currentTarget.value)}
                required
                value={title}
              />
            </label>
            <label htmlFor={metadataYearId}>
              <span>Year</span>
              <input
                id={metadataYearId}
                inputMode="numeric"
                max="2200"
                min="1870"
                onChange={(event) => setYear(event.currentTarget.value)}
                placeholder="Unknown"
                type="number"
                value={year}
              />
            </label>
            <label className={styles.overviewField} htmlFor={metadataOverviewId}>
              <span>Overview</span>
              <textarea
                aria-label="Overview"
                id={metadataOverviewId}
                maxLength={2000}
                onChange={(event) => setOverview(event.currentTarget.value)}
                placeholder="Add a concise story overview…"
                rows={4}
                value={overview}
              />
              <small aria-hidden="true">{overview.length} / 2,000</small>
            </label>
            {metadataState.kind === "error" && (
              <p className={styles.inlineError} role="alert">
                {metadataState.error.message}
              </p>
            )}
            <button
              className={styles.sectionAction}
              disabled={metadataState.kind === "running" || !title.trim()}
              type="submit"
            >
              {metadataState.kind === "running" ? (
                <LoaderCircle aria-hidden="true" className={styles.spin} size={16} />
              ) : (
                <Check aria-hidden="true" size={16} />
              )}
              Save details
            </button>
          </form>
        </section>

        <section className={styles.inspectorSection} aria-labelledby={`${titleId}-artwork`}>
          <div className={styles.sectionHeading}>
            <span aria-hidden="true">
              <ImageIcon size={17} />
            </span>
            <div>
              <h3 id={`${titleId}-artwork`}>Poster artwork</h3>
              <p>Preview provider art without exposing remote URLs to the browser.</p>
            </div>
          </div>
          {artworkState.kind === "idle" && (
            <button className={styles.artworkSearch} onClick={searchArtwork} type="button">
              <ScanSearch aria-hidden="true" size={17} /> Find artwork
            </button>
          )}
          {artworkState.kind === "loading" && (
            <div aria-busy="true" className={styles.artworkLoading}>
              <LoaderCircle aria-hidden="true" className={styles.spin} size={18} />
              Searching Jellyfin providers…
            </div>
          )}
          {artworkState.kind === "error" && (
            <div className={styles.artworkError} role="alert">
              <CircleAlert aria-hidden="true" size={18} />
              <span>{artworkState.error.message}</span>
              <button onClick={searchArtwork} type="button">
                Try again
              </button>
            </div>
          )}
          {artworkState.kind === "ready" && artworkState.data.results.length === 0 && (
            <div className={styles.artworkEmpty}>
              <ImageIcon aria-hidden="true" size={20} /> No provider artwork was found.
            </div>
          )}
          {artworkState.kind === "ready" && artworkState.data.results.length > 0 && (
            <div className={styles.artworkGrid}>
              {artworkState.data.results.map((candidate) => (
                <ArtworkCandidate
                  applying={applyingResult === candidate.id}
                  candidate={candidate}
                  key={candidate.id}
                  onApply={() => void applyArtwork(artworkState.data.searchId, candidate.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section className={styles.refreshPanel}>
          <span aria-hidden="true">
            <RefreshCw size={18} />
          </span>
          <div>
            <strong>Ask Jellyfin to fill the gaps</strong>
            <p>Refresh only missing metadata and images for this title.</p>
            {refreshState.kind === "error" && (
              <small role="alert">{refreshState.error.message}</small>
            )}
          </div>
          <button
            disabled={refreshState.kind === "running"}
            onClick={() => void refreshItem()}
            type="button"
          >
            {refreshState.kind === "running" ? (
              <LoaderCircle aria-hidden="true" className={styles.spin} size={15} />
            ) : (
              <Sparkles aria-hidden="true" size={15} />
            )}
            Refresh
          </button>
        </section>
      </div>

      <footer className={styles.inspectorFooter}>
        <ShieldCheck aria-hidden="true" size={14} /> Paths, provider IDs, and access tokens stay in
        the gateway.
      </footer>
    </div>
  );
}

function ReadyWorkspace({
  client,
  snapshot,
}: {
  client: LibraryOperationsClient;
  snapshot: LibrarySnapshot;
}) {
  const [items, setItems] = useState(snapshot.attention.items);
  const [nextCursor, setNextCursor] = useState(snapshot.attention.nextCursor);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanState, setScanState] = useState<AsyncState>({ kind: "idle" });
  const [loadMoreState, setLoadMoreState] = useState<AsyncState>({ kind: "idle" });
  const [announcement, setAnnouncement] = useState("");
  const scanKey = useRef<string | null>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);

  const selected = items.find(({ referenceId }) => referenceId === selectedId) ?? null;
  const summary = useMemo(
    () => ({
      artwork: items.filter(({ issues }) => issues.includes("missing_poster")).length,
      details: items.filter(({ issues }) =>
        issues.some((issue) => issue === "missing_overview" || issue === "missing_year"),
      ).length,
      unmatched: items.filter(({ identityState }) => identityState === "unmatched").length,
    }),
    [items],
  );
  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesQuery =
        !normalizedQuery || item.title.toLocaleLowerCase().includes(normalizedQuery);
      const matchesFilter =
        filter === "all" ||
        (filter === "unmatched" && item.identityState === "unmatched") ||
        (filter === "artwork" && item.issues.includes("missing_poster")) ||
        (filter === "details" &&
          item.issues.some((issue) => issue === "missing_overview" || issue === "missing_year"));
      return matchesQuery && matchesFilter;
    });
  }, [filter, items, query]);

  const reload = useCallback(async () => {
    const page = await client.loadAttention();
    setItems(page.items);
    setNextCursor(page.nextCursor);
    setSelectedId((current) =>
      current && page.items.some(({ referenceId }) => referenceId === current) ? current : null,
    );
  }, [client]);

  async function scanLibrary() {
    setScanState({ kind: "running" });
    try {
      scanKey.current ??= createLibraryIdempotencyKey("scan");
      await client.scan({ csrfToken: snapshot.csrfToken, idempotencyKey: scanKey.current });
      scanKey.current = null;
      setScanState({ kind: "success", message: "Scan accepted" });
      setAnnouncement("Jellyfin accepted a full library scan.");
    } catch (error) {
      setScanState({
        error: error instanceof Error ? error : new Error("Library scan failed."),
        kind: "error",
      });
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadMoreState({ kind: "running" });
    try {
      const page = await client.loadAttention(nextCursor);
      setItems((current) => {
        const known = new Set(current.map(({ referenceId }) => referenceId));
        return [...current, ...page.items.filter(({ referenceId }) => !known.has(referenceId))];
      });
      setNextCursor(page.nextCursor);
      setLoadMoreState({ kind: "success", message: "More titles loaded" });
      setAnnouncement(`${page.items.length} more library items loaded.`);
    } catch (error) {
      setLoadMoreState({
        error: error instanceof Error ? error : new Error("More titles could not be loaded."),
        kind: "error",
      });
    }
  }

  async function libraryChanged(message: string) {
    setAnnouncement(message);
    try {
      await reload();
    } catch {
      setAnnouncement(`${message} The attention list will refresh shortly.`);
    }
  }

  return (
    <PageFrame>
      <section className={styles.hero} aria-labelledby="library-care-title">
        <div>
          <p className="eyebrow">Library care</p>
          <h1 id="library-care-title">Make every title feel finished.</h1>
          <p>
            Find unmatched media, missing artwork, and thin metadata—then repair each detail through
            a guarded Jellyfin workflow.
          </p>
        </div>
        <div
          className={styles.heroLens}
          data-attention={items.length > 0 || undefined}
          data-liquid-glass
        >
          <span aria-hidden="true">
            {items.length > 0 ? <WandSparkles size={20} /> : <BadgeCheck size={20} />}
          </span>
          <div>
            <strong>
              {items.length > 0
                ? `${items.length} titles need a finishing touch`
                : "Library looks polished"}
            </strong>
            <small>{snapshot.principal.linkedServices[0]?.displayName ?? "Linked Jellyfin"}</small>
          </div>
        </div>
      </section>

      <section className={styles.commandGlass} aria-label="Library care controls" data-liquid-glass>
        <label className={styles.searchControl}>
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">Search attention items</span>
          <input
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search titles needing attention"
            type="search"
            value={query}
          />
        </label>
        <div className={styles.filters} aria-label="Attention filter">
          {FILTERS.map((option) => (
            <button
              aria-pressed={filter === option.value}
              data-selected={filter === option.value || undefined}
              key={option.value}
              onClick={() => setFilter(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          className={styles.scanButton}
          disabled={scanState.kind === "running"}
          onClick={() => void scanLibrary()}
          type="button"
        >
          {scanState.kind === "running" ? (
            <LoaderCircle aria-hidden="true" className={styles.spin} size={16} />
          ) : (
            <ScanSearch aria-hidden="true" size={16} />
          )}
          Scan library
        </button>
      </section>

      {scanState.kind === "error" && (
        <div className={styles.pageNotice} role="alert">
          <CircleAlert aria-hidden="true" size={17} /> {scanState.error.message}
        </div>
      )}

      <section className={styles.metrics} aria-label="Library attention summary">
        <Metric icon={WandSparkles} label="Need attention" value={items.length} />
        <Metric icon={ScanSearch} label="Unmatched" value={summary.unmatched} />
        <Metric icon={ImageIcon} label="Missing artwork" value={summary.artwork} />
        <Metric icon={Brush} label="Thin details" value={summary.details} />
      </section>

      <div className={styles.workspace} data-inspector-open={selected !== null || undefined}>
        <section
          aria-hidden={selected ? "true" : undefined}
          aria-labelledby="attention-collection-title"
          className={styles.collection}
          inert={selected ? true : undefined}
        >
          <div className={styles.collectionHeading}>
            <div>
              <p className="eyebrow">Attention queue</p>
              <h2 id="attention-collection-title">
                {filter === "all"
                  ? "Details worth finishing"
                  : FILTERS.find(({ value }) => value === filter)?.label}
              </h2>
            </div>
            <small>
              {visibleItems.length} {visibleItems.length === 1 ? "title" : "titles"}
            </small>
          </div>

          {items.length === 0 ? (
            <div className={styles.emptyState}>
              <span aria-hidden="true">
                <BadgeCheck size={26} />
              </span>
              <div>
                <strong>Nothing needs attention.</strong>
                <p>Jellyfin returned a complete library with artwork and essential details.</p>
              </div>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className={styles.emptyState}>
              <span aria-hidden="true">
                <Search size={24} />
              </span>
              <div>
                <strong>No titles match this view.</strong>
                <p>Clear the search or choose another attention filter.</p>
              </div>
            </div>
          ) : (
            <div className={styles.cardGrid}>
              {visibleItems.map((item) => (
                <LibraryCard
                  item={item}
                  key={item.referenceId}
                  onSelect={(trigger) => {
                    selectedTrigger.current = trigger;
                    setSelectedId(item.referenceId);
                  }}
                  selected={item.referenceId === selectedId}
                />
              ))}
            </div>
          )}

          {nextCursor && (
            <button
              className={styles.loadMore}
              disabled={loadMoreState.kind === "running"}
              onClick={() => void loadMore()}
              type="button"
            >
              {loadMoreState.kind === "running" ? (
                <LoaderCircle aria-hidden="true" className={styles.spin} size={16} />
              ) : (
                <ArrowRight aria-hidden="true" size={16} />
              )}
              Load more
            </button>
          )}
          {loadMoreState.kind === "error" && (
            <p className={styles.inlineError} role="alert">
              {loadMoreState.error.message}
            </p>
          )}
        </section>

        {selected && (
          <ItemInspector
            client={client}
            csrfToken={snapshot.csrfToken}
            item={selected}
            key={selected.referenceId}
            onClose={() => setSelectedId(null)}
            onLibraryChanged={libraryChanged}
            onRestoreFocus={() => selectedTrigger.current?.focus()}
          />
        )}
      </div>

      <p aria-atomic="true" className="sr-only" role="status">
        {announcement}
      </p>
      <footer className={styles.pageFooter}>
        <span>
          <ShieldCheck aria-hidden="true" size={15} /> Changes are authorized locally and audited.
        </span>
        <time dateTime={snapshot.attention.generatedAt}>
          Generated {generatedTimestamp(snapshot.attention.generatedAt)}
        </time>
      </footer>
    </PageFrame>
  );
}

export function LibraryCare({
  client = libraryOperationsClient,
  initialOutcome,
}: LibraryCareProperties) {
  const [outcome, setOutcome] = useState<LibraryLoadOutcome | null>(initialOutcome ?? null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (initialOutcome && revision === 0) return;
    let active = true;
    void client
      .load()
      .then((result) => {
        if (active) setOutcome(result);
      })
      .catch(() => {
        if (active) setOutcome({ status: "unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, initialOutcome, revision]);

  const reload = () => {
    setOutcome(null);
    setRevision((value) => value + 1);
  };

  if (!outcome) return <LoadingState />;
  if (outcome.status !== "ready") return <EntryState kind={outcome.status} onRetry={reload} />;
  return (
    <ReadyWorkspace
      client={client}
      key={`${outcome.snapshot.attention.generatedAt}:${revision}`}
      snapshot={outcome.snapshot}
    />
  );
}

export function libraryErrorMessage(error: unknown) {
  if (error instanceof LibraryClientError && error.kind === "expired") {
    return "These artwork choices expired. Search again to continue.";
  }
  return errorMessage(error, "The library operation could not be completed.");
}
