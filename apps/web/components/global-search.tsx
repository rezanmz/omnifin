"use client";

import "./global-search.css";

import type { Permission } from "@omnifin/contracts/auth";
import type { DiscoverySearchResult } from "@omnifin/contracts/discovery";
import {
  CalendarDays,
  CircleAlert,
  ClipboardCheck,
  Command,
  Compass,
  Download,
  Film,
  Gauge,
  KeyRound,
  Library,
  LoaderCircle,
  PanelRightOpen,
  Search,
  Settings2,
  Sparkles,
  Tv,
  UsersRound,
  UserRound,
  WifiOff,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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

type PaletteCommandGroup = "Navigate" | "Operate" | "Administer";

interface PaletteCommand {
  description: string;
  group: PaletteCommandGroup;
  href: string;
  icon: LucideIcon;
  id: string;
  keywords: readonly string[];
  label: string;
  permission?: Permission;
}

const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  {
    description: "Return to your cinematic dashboard",
    group: "Navigate",
    href: "/",
    icon: Compass,
    id: "discover",
    keywords: ["home", "dashboard", "discover"],
    label: "Discover",
  },
  {
    description: "Theme, sessions, and linked identities",
    group: "Navigate",
    href: "/settings",
    icon: Settings2,
    id: "account",
    keywords: ["account", "appearance", "theme", "session", "settings"],
    label: "Account & appearance",
  },
  {
    description: "Scans, metadata, artwork, and subtitles",
    group: "Operate",
    href: "/library",
    icon: Library,
    id: "library",
    keywords: ["library", "scan", "metadata", "artwork", "subtitle"],
    label: "Library care",
    permission: "library.manage",
  },
  {
    description: "Upcoming releases across your stack",
    group: "Navigate",
    href: "/calendar",
    icon: CalendarDays,
    id: "calendar",
    keywords: ["calendar", "upcoming", "release", "schedule"],
    label: "Calendar",
    permission: "media.view",
  },
  {
    description: "Review and decide pending requests",
    group: "Operate",
    href: "/operations/requests",
    icon: ClipboardCheck,
    id: "requests",
    keywords: ["request", "approval", "review", "pending"],
    label: "Request review",
    permission: "request.review",
  },
  {
    description: "Inspect progress, rates, and queue health",
    group: "Operate",
    href: "/operations/downloads",
    icon: Download,
    id: "downloads",
    keywords: ["download", "queue", "transfer", "torrent", "usenet"],
    label: "Download queue",
    permission: "downloads.manage",
  },
  {
    description: "Indexer performance and failure history",
    group: "Operate",
    href: "/operations/indexers",
    icon: Gauge,
    id: "indexers",
    keywords: ["indexer", "prowlarr", "failure", "statistics"],
    label: "Indexer intelligence",
    permission: "acquisition.manage",
  },
  {
    description: "Resolve playback and media reports",
    group: "Operate",
    href: "/operations/issues",
    icon: CircleAlert,
    id: "issues",
    keywords: ["issue", "report", "playback", "resolve"],
    label: "Issue workbench",
    permission: "issue.manage",
  },
  {
    description: "Service health, storage, and live signals",
    group: "Operate",
    href: "/operations/health",
    icon: Gauge,
    id: "health",
    keywords: ["health", "status", "storage", "service", "operation"],
    label: "System health",
    permission: "acquisition.manage",
  },
  {
    description: "Configure and verify upstream services",
    group: "Administer",
    href: "/settings/connectors",
    icon: Settings2,
    id: "connectors",
    keywords: ["connector", "service", "configure", "jellyfin", "seerr"],
    label: "Manage connectors",
    permission: "connectors.manage",
  },
  {
    description: "Roles, access, and active accounts",
    group: "Administer",
    href: "/settings/users",
    icon: UsersRound,
    id: "users",
    keywords: ["user", "role", "access", "permission", "account"],
    label: "User access",
    permission: "roles.manage",
  },
  {
    description: "OIDC issuers and claim mappings",
    group: "Administer",
    href: "/settings/identity-providers",
    icon: KeyRound,
    id: "identity-providers",
    keywords: ["oidc", "authentik", "identity", "provider", "mapping"],
    label: "Identity providers",
    permission: "recovery.oidc.manage",
  },
];

export type CommandPermissionLoader = (signal?: AbortSignal) => Promise<readonly Permission[]>;

type PermissionState =
  { kind: "loading" | "unavailable" } | { kind: "ready"; permissions: readonly Permission[] };

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
  initialPermissions?: readonly Permission[];
  initialQuery?: string;
  permissionLoader?: CommandPermissionLoader;
  requestClient?: MediaRequestClient;
}

async function loadPalettePermissions(signal?: AbortSignal): Promise<readonly Permission[]> {
  const response = await fetch("/api/auth/session", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) return [];
  if (!response.ok) throw new Error("Command access could not be read.");
  await import("../lib/zod-browser");
  const { sessionResponseSchema } = await import("@omnifin/contracts/auth");
  const parsed = sessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Command access did not match the public contract.");
  return parsed.data.principal ? parsed.data.principal.permissions : [];
}

function matchingCommands(
  permissions: readonly Permission[],
  query: string,
): readonly PaletteCommand[] {
  const allowed = new Set(permissions);
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return PALETTE_COMMANDS.filter((command) => {
    if (command.permission && !allowed.has(command.permission)) return false;
    const haystack = [command.label, command.description, ...command.keywords]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
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

function CommandOption({
  command,
  index,
  onDismiss,
  onKeyDown,
}: {
  command: PaletteCommand;
  index: number;
  onDismiss: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>, index: number) => void;
}) {
  const Icon = command.icon;
  return (
    <a
      aria-label={`${command.label}. ${command.description}`}
      aria-selected="false"
      className="command-option"
      data-search-option
      href={command.href}
      onClick={onDismiss}
      onKeyDown={(event) => onKeyDown(event, index)}
      role="option"
    >
      <span className="command-option__icon">
        <Icon aria-hidden="true" />
      </span>
      <span className="command-option__copy">
        <strong>{command.label}</strong>
        <small>{command.description}</small>
      </span>
      <span className="command-option__arrow" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

function CommandPaletteHome({
  commands,
  onDismiss,
  onKeyDown,
  permissionState,
  query,
}: {
  commands: readonly PaletteCommand[];
  onDismiss: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>, index: number) => void;
  permissionState: PermissionState;
  query: string;
}) {
  let optionIndex = 0;
  return (
    <div className="command-palette">
      <div className="command-palette__intro">
        <div className="command-palette__orb" aria-hidden="true">
          <Command />
        </div>
        <div>
          <p>{query ? `Commands matching “${query}”` : "Move through Omnifin"}</p>
          <span>
            {query
              ? "Keep typing to search movies, series, and people too."
              : "Jump to the work you can access. Restricted destinations stay out of view."}
          </span>
        </div>
        <div className="search-console__key-guide" aria-label="Keyboard guidance">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
        </div>
      </div>
      {commands.length > 0 ? (
        <div
          aria-label="Available destinations"
          className="command-palette__groups"
          id="global-search-listbox"
          role="listbox"
        >
          {(["Navigate", "Operate", "Administer"] as const).map((group) => {
            const groupedCommands = commands.filter((command) => command.group === group);
            if (groupedCommands.length === 0) return null;
            const groupId = `command-group-${group.toLowerCase()}`;
            return (
              <div
                aria-labelledby={groupId}
                className="command-palette__group"
                key={group}
                role="group"
              >
                <p id={groupId}>{group}</p>
                {groupedCommands.map((command) => {
                  const index = optionIndex++;
                  return (
                    <CommandOption
                      command={command}
                      index={index}
                      key={command.id}
                      onDismiss={onDismiss}
                      onKeyDown={onKeyDown}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="command-palette__empty" role="status">
          <Search aria-hidden="true" />
          <p>No matching destination</p>
          <span>Type a second character to search your media library.</span>
        </div>
      )}
      <footer className="command-palette__footer">
        <span>
          <Search aria-hidden="true" /> Search the whole signal
        </span>
        <span>Type at least two characters to find movies, series, and people.</span>
        {permissionState.kind === "loading" ? <i>Checking access…</i> : null}
        {permissionState.kind === "unavailable" ? <i>Showing safe destinations</i> : null}
      </footer>
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
  initialPermissions,
  initialQuery = "",
  permissionLoader = loadPalettePermissions,
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
  const [permissionState, setPermissionState] = useState<PermissionState>(() =>
    initialPermissions ? { kind: "ready", permissions: initialPermissions } : { kind: "loading" },
  );
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
    if (!open || permissionState.kind !== "loading") return;
    const controller = new AbortController();
    let current = true;
    void permissionLoader(controller.signal)
      .then((permissions) => {
        if (current) setPermissionState({ kind: "ready", permissions });
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setPermissionState({ kind: "unavailable" });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [open, permissionLoader, permissionState.kind]);

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
  const permissions = permissionState.kind === "ready" ? permissionState.permissions : [];
  const commandMatches = matchingCommands(permissions, normalizedQuery);

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
    const hasVisibleOptions =
      (normalizedQuery.length < 2 && commandMatches.length > 0) ||
      (searchState.kind === "ready" && (searchState.items.length > 0 || commandMatches.length > 0));
    if (event.key === "ArrowDown" && hasVisibleOptions) {
      event.preventDefault();
      event.stopPropagation();
      focusResult("first");
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLElement>, index: number) {
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
        Search media and commands
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
            <span>Command &amp; discovery</span>
            {searchState.kind === "loading" ? (
              <span className="search-console__searching">
                <LoaderCircle aria-hidden="true" /> Searching
              </span>
            ) : searchState.kind === "ready" ? (
              <span role="status">
                {searchState.totalResults.toLocaleString()} result
                {searchState.totalResults === 1 ? "" : "s"}
                {commandMatches.length > 0
                  ? ` · ${commandMatches.length.toLocaleString()} command${commandMatches.length === 1 ? "" : "s"}`
                  : ""}
              </span>
            ) : (
              <span>Local · Seerr</span>
            )}
          </header>

          {normalizedQuery.length < 2 ? (
            <CommandPaletteHome
              commands={commandMatches}
              onDismiss={() => setOpen(false)}
              onKeyDown={handleOptionKeyDown}
              permissionState={permissionState}
              query={normalizedQuery}
            />
          ) : searchState.kind === "loading" || searchState.kind === "idle" ? (
            <SearchLoading />
          ) : searchState.kind === "error" ? (
            <SearchError
              errorKind={searchState.errorKind}
              onRetry={() => setRetry((value) => value + 1)}
            />
          ) : searchState.items.length === 0 && commandMatches.length === 0 ? (
            <SearchEmpty query={normalizedQuery} />
          ) : (
            <div
              className="search-console__results"
              data-command-only={selectedResult === null ? true : undefined}
            >
              <div
                aria-label="Matching commands, titles, and people"
                className="search-console__list"
                id="global-search-listbox"
                role="listbox"
              >
                {commandMatches.map((command, index) => (
                  <CommandOption
                    command={command}
                    index={index}
                    key={command.id}
                    onDismiss={() => setOpen(false)}
                    onKeyDown={handleOptionKeyDown}
                  />
                ))}
                {searchState.items.map((result, index) => (
                  <button
                    aria-selected={selectedResult?.id === result.id}
                    className="search-result"
                    data-search-option
                    key={result.id}
                    onClick={() => setSelectedId(result.id)}
                    onFocus={() => setSelectedId(result.id)}
                    onKeyDown={(event) => handleOptionKeyDown(event, commandMatches.length + index)}
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
