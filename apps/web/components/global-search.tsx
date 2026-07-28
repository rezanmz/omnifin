"use client";

import type { DiscoverySearchResult } from "@omnifin/contracts/discovery";
import {
  Command,
  Film,
  LoaderCircle,
  PanelRightOpen,
  Search,
  Sparkles,
  Tv,
  UserRound,
  WifiOff,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  DiscoverySearchClientError,
  discoverySearchClient,
  type DiscoverySearchClient,
  type DiscoverySearchClientErrorKind,
} from "../lib/discovery-search";
import type { MediaRequestClient } from "../lib/media-requests";
import type { DiscoveryMediaDetailClient } from "../lib/media-details";
import type { DetailMedia } from "./media-detail-drawer";
import type { RequestableMedia } from "./request-composer";

const RequestComposer = dynamic(
  () => import("./request-composer").then((module) => module.RequestComposer),
  { ssr: false },
);
const MediaDetailDrawer = dynamic(
  () => import("./media-detail-drawer").then((module) => module.MediaDetailDrawer),
  { ssr: false },
);

const SEARCH_RESULT_LIMIT = 12;
const SEARCH_ACCENTS = ["#d8ff70", "#75d8c8", "#e8a575", "#a88be4", "#7eb6e8", "#e27f9f"];

type SearchState =
  | { kind: "idle" }
  | { kind: "loading"; requestKey: string }
  | {
      items: readonly DiscoverySearchResult[];
      kind: "ready";
      requestKey: string;
      totalResults: number;
    }
  | { errorKind: DiscoverySearchClientErrorKind; kind: "error"; requestKey: string };

export interface GlobalSearchProperties {
  client?: DiscoverySearchClient;
  debounceMs?: number;
  detailClient?: DiscoveryMediaDetailClient;
  initialFocus?: boolean;
  initialOpen?: boolean;
  initialQuery?: string;
  requestClient?: MediaRequestClient;
}

function searchLanguage() {
  if (typeof navigator === "undefined") return "en";
  const language = navigator.language;
  if (/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(language)) return language;
  const base = language.slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/u.test(base) ? base : "en";
}

function resultLabel(result: DiscoverySearchResult) {
  if (result.kind === "movie") return "Movie";
  if (result.kind === "series") return "Series";
  return "Person";
}

function resultIcon(result: DiscoverySearchResult) {
  if (result.kind === "movie") return <Film aria-hidden="true" />;
  if (result.kind === "series") return <Tv aria-hidden="true" />;
  return <UserRound aria-hidden="true" />;
}

function availabilityLabel(result: DiscoverySearchResult, locallyRequested = false) {
  if (result.kind === "person") return "Profile";
  if (locallyRequested) return "Requested";
  return {
    available: "Available",
    partial: "Partial",
    processing: "Acquiring",
    requested: "Requested",
    unavailable: "Requestable",
    unknown: "Status unknown",
  }[result.availability];
}

function resultMeta(result: DiscoverySearchResult) {
  if (result.kind === "person") {
    return result.knownFor.length > 0
      ? result.knownFor
          .slice(0, 2)
          .map((credit) => credit.title)
          .join(" · ")
      : "Cast and crew";
  }
  return [result.year, result.voteAverage === null ? null : `${result.voteAverage.toFixed(1)} ★`]
    .filter((value) => value !== null)
    .join(" · ");
}

function previewCopy(result: DiscoverySearchResult) {
  if (result.kind === "person") {
    if (result.knownFor.length === 0) return "No indexed credits are available for this profile.";
    return `Known for ${result.knownFor
      .slice(0, 3)
      .map((credit) => credit.title)
      .join(", ")}.`;
  }
  return result.overview ?? "No synopsis is available for this title.";
}

function accentStyle(result: DiscoverySearchResult): CSSProperties {
  const accent = SEARCH_ACCENTS[result.tmdbId % SEARCH_ACCENTS.length]!;
  return { "--search-accent": accent } as CSSProperties;
}

function SearchPrompt() {
  return (
    <div className="search-console__prompt">
      <div className="search-console__prompt-mark" aria-hidden="true">
        <Search />
      </div>
      <div>
        <p>Search the whole signal</p>
        <span>Type at least two characters to find movies, series, and people.</span>
      </div>
      <div className="search-console__key-guide" aria-label="Keyboard guidance">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </div>
    </div>
  );
}

function SearchLoading() {
  return (
    <div className="search-console__loading" aria-label="Searching" role="status">
      <div className="search-console__loading-list">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="search-console__loading-row" key={index}>
            <span />
            <div>
              <i />
              <i />
            </div>
          </div>
        ))}
      </div>
      <div className="search-console__loading-preview" />
      <span className="sr-only">Searching movies, series, and people.</span>
    </div>
  );
}

function SearchEmpty({ query }: { query: string }) {
  return (
    <div className="search-console__empty" role="status">
      <span className="search-console__empty-orbit" aria-hidden="true" />
      <p>No signal for “{query}”</p>
      <span>Check the spelling, or try a title, person, or original-language name.</span>
    </div>
  );
}

const ERROR_COPY: Record<DiscoverySearchClientErrorKind, { detail: string; title: string }> = {
  forbidden: {
    detail: "Your current role cannot browse media. An administrator can review your access.",
    title: "Discovery permission required",
  },
  invalid_response: {
    detail: "The upstream response failed Omnifin’s safety checks. No raw data was displayed.",
    title: "Search response rejected",
  },
  not_configured: {
    detail: "An administrator needs to validate and enable one Seerr connection.",
    title: "Discovery is not connected",
  },
  rate_limited: {
    detail: "Seerr asked for a short pause. Try the same search again in a moment.",
    title: "Search is cooling down",
  },
  signed_out: {
    detail: "Your session ended. Sign in again to continue searching your media stack.",
    title: "Sign in to search",
  },
  unavailable: {
    detail: "The gateway or Seerr could not be reached. Your current screen remains available.",
    title: "Search is temporarily offline",
  },
};

function SearchError({
  errorKind,
  onRetry,
}: {
  errorKind: DiscoverySearchClientErrorKind;
  onRetry: () => void;
}) {
  const copy = ERROR_COPY[errorKind];
  return (
    <div className="search-console__error" role="status">
      <WifiOff aria-hidden="true" />
      <div>
        <p>{copy.title}</p>
        <span>{copy.detail}</span>
      </div>
      {errorKind === "signed_out" ? (
        <a className="search-console__retry" href="/login">
          Sign in
        </a>
      ) : errorKind === "forbidden" || errorKind === "not_configured" ? null : (
        <button className="search-console__retry" onClick={onRetry} type="button">
          Try again
        </button>
      )}
    </div>
  );
}

export function GlobalSearch({
  client = discoverySearchClient,
  debounceMs = 240,
  detailClient,
  initialFocus = false,
  initialOpen = false,
  initialQuery = "",
  requestClient,
}: GlobalSearchProperties) {
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState(initialQuery);
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composerMedia, setComposerMedia] = useState<RequestableMedia | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailMedia, setDetailMedia] = useState<DetailMedia | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [requestedIds, setRequestedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const rootReference = useRef<HTMLDivElement>(null);
  const inputReference = useRef<HTMLInputElement>(null);
  const suppressFocusOpenReference = useRef(false);
  const normalizedQuery = query.trim();
  const requestKey = `${normalizedQuery}\0${retry}`;

  useLayoutEffect(() => {
    if (!initialFocus) return;
    inputReference.current?.focus();
    inputReference.current?.select();
  }, [initialFocus]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      setOpen(true);
      inputReference.current?.focus();
      inputReference.current?.select();
    };
    const dismiss = (event: PointerEvent) => {
      if (!rootReference.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", shortcut);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("keydown", shortcut);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, []);

  useEffect(() => {
    if (!open || normalizedQuery.length < 2) return;
    const controller = new AbortController();
    let current = true;
    const timeout = window.setTimeout(() => {
      setState({ kind: "loading", requestKey });
      void client
        .search({ language: searchLanguage(), page: 1, query: normalizedQuery }, controller.signal)
        .then((response) => {
          if (!current) return;
          const items = response.items.slice(0, SEARCH_RESULT_LIMIT);
          setSelectedId(items[0]?.id ?? null);
          setState({ items, kind: "ready", requestKey, totalResults: response.totalResults });
        })
        .catch((error: unknown) => {
          if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
          setSelectedId(null);
          setState({
            errorKind: error instanceof DiscoverySearchClientError ? error.kind : "unavailable",
            kind: "error",
            requestKey,
          });
        });
    }, debounceMs);
    return () => {
      current = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [client, debounceMs, normalizedQuery, open, requestKey]);

  const searchState: SearchState =
    normalizedQuery.length >= 2 && (state.kind === "idle" || state.requestKey !== requestKey)
      ? { kind: "loading", requestKey }
      : state;
  const selectedResult =
    searchState.kind === "ready"
      ? (searchState.items.find((item) => item.id === selectedId) ?? searchState.items[0] ?? null)
      : null;
  const selectedLocallyRequested = selectedResult ? requestedIds.has(selectedResult.id) : false;
  const selectedRequestable =
    selectedResult !== null &&
    selectedResult.kind !== "person" &&
    !selectedLocallyRequested &&
    (selectedResult.availability === "unavailable" || selectedResult.availability === "partial");

  const focusResult = useCallback((position: "first" | "last") => {
    const options = rootReference.current?.querySelectorAll<HTMLElement>("[data-search-option]");
    const target = position === "first" ? options?.[0] : options?.[options.length - 1];
    target?.focus();
  }, []);

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" && searchState.kind === "ready" && searchState.items.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      focusResult("first");
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const options = rootReference.current?.querySelectorAll<HTMLElement>("[data-search-option]");
    if (!options || options.length === 0) return;
    let target: HTMLElement | undefined;
    if (event.key === "ArrowDown") target = options[Math.min(index + 1, options.length - 1)];
    if (event.key === "ArrowUp")
      target = index === 0 ? (inputReference.current ?? undefined) : options[index - 1];
    if (event.key === "Home") target = options[0];
    if (event.key === "End") target = options[options.length - 1];
    if (event.key === "Escape") {
      event.preventDefault();
      suppressFocusOpenReference.current = true;
      setOpen(false);
      inputReference.current?.focus();
      return;
    }
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      target.focus();
    }
  }

  return (
    <div
      className="global-search"
      data-liquid-glass
      data-open={open || undefined}
      ref={rootReference}
    >
      <Search aria-hidden="true" className="global-search__icon" size={18} strokeWidth={1.7} />
      <label className="sr-only" htmlFor="global-search">
        Search movies, series, and people
      </label>
      <input
        aria-autocomplete="list"
        aria-controls="global-search-results"
        aria-expanded={open}
        aria-haspopup="listbox"
        autoComplete="off"
        data-directional-item
        enterKeyHint="search"
        id="global-search"
        name="search"
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (suppressFocusOpenReference.current) {
            suppressFocusOpenReference.current = false;
            return;
          }
          setOpen(true);
        }}
        onKeyDown={handleInputKeyDown}
        placeholder="Search everything…"
        ref={inputReference}
        role="combobox"
        type="text"
        value={query}
      />
      {query ? (
        <button
          aria-label="Clear search"
          className="global-search__clear"
          onClick={() => {
            setQuery("");
            inputReference.current?.focus();
          }}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      ) : (
        <kbd className="global-search__shortcut">
          <Command aria-hidden="true" size={12} /> K
        </kbd>
      )}

      {open ? (
        <section aria-label="Search results" className="search-console" id="global-search-results">
          <header className="search-console__header">
            <span>Discovery signal</span>
            {searchState.kind === "loading" ? (
              <span className="search-console__searching">
                <LoaderCircle aria-hidden="true" /> Searching
              </span>
            ) : searchState.kind === "ready" ? (
              <span role="status">
                {searchState.totalResults.toLocaleString()} result
                {searchState.totalResults === 1 ? "" : "s"}
              </span>
            ) : (
              <span>Seerr · Live</span>
            )}
          </header>

          {normalizedQuery.length < 2 ? (
            <SearchPrompt />
          ) : searchState.kind === "loading" || searchState.kind === "idle" ? (
            <SearchLoading />
          ) : searchState.kind === "error" ? (
            <SearchError
              errorKind={searchState.errorKind}
              onRetry={() => setRetry((value) => value + 1)}
            />
          ) : searchState.items.length === 0 ? (
            <SearchEmpty query={normalizedQuery} />
          ) : (
            <div className="search-console__results">
              <div
                aria-label="Matching titles and people"
                className="search-console__list"
                id="global-search-listbox"
                role="listbox"
              >
                {searchState.items.map((result, index) => (
                  <button
                    aria-selected={selectedResult?.id === result.id}
                    className="search-result"
                    data-search-option
                    key={result.id}
                    onClick={() => setSelectedId(result.id)}
                    onFocus={() => setSelectedId(result.id)}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    onPointerEnter={() => setSelectedId(result.id)}
                    role="option"
                    style={accentStyle(result)}
                    type="button"
                  >
                    <span className="search-result__icon">{resultIcon(result)}</span>
                    <span className="search-result__copy">
                      <strong>{result.title}</strong>
                      <small>{resultMeta(result)}</small>
                    </span>
                    <span className="search-result__meta">
                      <span className="search-result__kind">{resultLabel(result)}</span>
                      <span className="search-result__state">
                        {availabilityLabel(result, requestedIds.has(result.id))}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {selectedResult ? (
                <aside className="search-preview" style={accentStyle(selectedResult)}>
                  <div className="search-preview__art" aria-hidden="true">
                    <span />
                    <i>{selectedResult.title.slice(0, 1)}</i>
                  </div>
                  <div className="search-preview__signal">
                    <span>{resultLabel(selectedResult)}</span>
                    <span>{availabilityLabel(selectedResult, selectedLocallyRequested)}</span>
                  </div>
                  <h2>{selectedResult.title}</h2>
                  <p>{previewCopy(selectedResult)}</p>
                  <div className="search-preview__footer">
                    <span>Seerr match</span>
                    {selectedResult.kind === "person" ? (
                      <span>Profile match</span>
                    ) : (
                      <div className="search-preview__actions">
                        <button
                          aria-label={`View details for ${selectedResult.title}`}
                          className="search-preview__detail-action"
                          data-directional-item
                          onClick={() => {
                            setDetailMedia(selectedResult);
                            setDetailOpen(true);
                            setOpen(false);
                          }}
                          type="button"
                        >
                          Details <PanelRightOpen aria-hidden="true" />
                        </button>
                        {selectedRequestable ? (
                          <button
                            aria-label={`Request ${selectedResult.title}`}
                            data-directional-item
                            onClick={() => {
                              setComposerMedia(selectedResult);
                              setComposerOpen(true);
                            }}
                            type="button"
                          >
                            Request <Sparkles aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                </aside>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
      <MediaDetailDrawer
        {...(detailClient ? { client: detailClient } : {})}
        key={detailMedia?.id ?? "media-detail"}
        media={detailMedia}
        onOpenChange={(nextOpen) => {
          setDetailOpen(nextOpen);
          if (!nextOpen) setDetailMedia(null);
        }}
        onRequest={(media) => {
          setDetailOpen(false);
          setDetailMedia(null);
          setComposerMedia(media);
          setComposerOpen(true);
        }}
        open={detailOpen}
      />
      <RequestComposer
        {...(requestClient ? { client: requestClient } : {})}
        key={composerMedia?.id ?? "request-composer"}
        media={composerMedia}
        onCreated={() => {
          if (!composerMedia) return;
          setRequestedIds((current) => new Set([...current, composerMedia.id]));
        }}
        onOpenChange={(nextOpen) => {
          setComposerOpen(nextOpen);
          if (!nextOpen) setComposerMedia(null);
        }}
        open={composerOpen}
      />
    </div>
  );
}
