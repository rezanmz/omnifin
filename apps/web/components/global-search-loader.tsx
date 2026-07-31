"use client";

import { Command, Search } from "lucide-react";
import type { ComponentType, RefObject } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { GlobalSearchProperties } from "./global-search";

function GlobalSearchPlaceholder({
  activate,
  busy,
  inputReference,
  interactive,
  preload,
  query,
  setQuery,
}: {
  activate?: () => void;
  busy?: boolean;
  inputReference?: RefObject<HTMLInputElement | null>;
  interactive?: boolean;
  preload?: () => void;
  query?: string;
  setQuery?: (query: string) => void;
}) {
  return (
    <div className="global-search" data-liquid-glass>
      <Search aria-hidden="true" className="global-search__icon" size={18} strokeWidth={1.7} />
      <label className="sr-only" htmlFor="global-search-placeholder">
        Search media and commands
      </label>
      <input
        aria-autocomplete="list"
        aria-busy={busy || undefined}
        aria-controls="global-search-results"
        aria-expanded="false"
        aria-haspopup="listbox"
        autoComplete="off"
        data-directional-item
        disabled={!interactive}
        id="global-search-placeholder"
        onClick={activate}
        onChange={(event) => {
          setQuery?.(event.currentTarget.value);
          activate?.();
        }}
        onFocus={activate}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") activate?.();
        }}
        onPointerEnter={preload}
        placeholder="Search everything…"
        ref={inputReference}
        role="combobox"
        type="text"
        value={query}
      />
      <kbd className="global-search__shortcut">
        <Command aria-hidden="true" size={12} /> K
      </kbd>
    </div>
  );
}

const loadGlobalSearch = () => import("./global-search").then((module_) => module_.GlobalSearch);

const subscribeToHydration = () => () => undefined;
const clientHydrated = () => true;
const serverHydrated = () => false;

export function GlobalSearchLoader(properties: GlobalSearchProperties) {
  const [SearchComponent, setSearchComponent] =
    useState<ComponentType<GlobalSearchProperties> | null>(null);
  const [loading, setLoading] = useState(false);
  const hydrated = useSyncExternalStore(subscribeToHydration, clientHydrated, serverHydrated);
  const [pendingQuery, setPendingQuery] = useState(properties.initialQuery ?? "");
  const [restoreFocus, setRestoreFocus] = useState(false);
  const [shortcutRequested, setShortcutRequested] = useState(false);
  const placeholderReference = useRef<HTMLInputElement>(null);

  const activate = useCallback((shortcut = false) => {
    if (shortcut) setShortcutRequested(true);
    setLoading(true);
    void loadGlobalSearch()
      .then((Component) => {
        setRestoreFocus(shortcut || document.activeElement === placeholderReference.current);
        setSearchComponent(() => Component);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      activate(true);
    };

    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [activate]);

  if (!SearchComponent) {
    return (
      <GlobalSearchPlaceholder
        activate={() => activate()}
        busy={loading}
        inputReference={placeholderReference}
        interactive={hydrated}
        preload={() => void loadGlobalSearch()}
        query={pendingQuery}
        setQuery={setPendingQuery}
      />
    );
  }

  return (
    <SearchComponent
      {...properties}
      initialFocus={restoreFocus}
      initialOpen={properties.initialOpen || shortcutRequested || pendingQuery.trim().length > 0}
      initialQuery={pendingQuery}
    />
  );
}
