"use client";

import { Command, Search } from "lucide-react";
import type { ComponentType, RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { GlobalSearchProperties } from "./global-search";
import {
  captureDocumentScrollPosition,
  focusWithoutDocumentScroll,
  restoreDocumentScrollPosition,
  stabilizeDocumentScrollPosition,
  type DocumentScrollPosition,
} from "../lib/focus-preservation";

function GlobalSearchPlaceholder({
  activate,
  busy,
  inputReference,
  interactive,
  preload,
  query,
  setQuery,
}: {
  activate?: (focusRequested?: boolean, activationPosition?: DocumentScrollPosition | null) => void;
  busy?: boolean;
  inputReference?: RefObject<HTMLInputElement | null>;
  interactive?: boolean;
  preload?: () => void;
  query?: string;
  setQuery?: (query: string) => void;
}) {
  const editScrollReference = useRef<DocumentScrollPosition | null>(null);
  const pointerActivationPositionReference = useRef<DocumentScrollPosition | null>(null);
  const pointerScrollReference = useRef<DocumentScrollPosition | null>(null);
  const pointerActivationReference = useRef(false);

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
        aria-keyshortcuts="Meta+K Control+K"
        autoComplete="off"
        data-directional-item
        disabled={!interactive}
        id="global-search-placeholder"
        onClick={(event) => {
          event.preventDefault();
          activate?.(true);
        }}
        onBlur={() => {
          pointerActivationReference.current = false;
        }}
        onChange={(event) => {
          setQuery?.(event.currentTarget.value);
          restoreDocumentScrollPosition(editScrollReference.current);
          editScrollReference.current = null;
          activate?.(true);
        }}
        onBeforeInput={() => {
          editScrollReference.current = captureDocumentScrollPosition();
        }}
        onFocus={() => {
          restoreDocumentScrollPosition(pointerScrollReference.current);
          pointerScrollReference.current = null;
          if (!pointerActivationReference.current) activate?.(true);
        }}
        onKeyDown={(event) => {
          if (
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")
          ) {
            editScrollReference.current = captureDocumentScrollPosition();
          }
          if (event.key === "ArrowDown" || event.key === "Enter") activate?.(true);
        }}
        onPointerEnter={preload}
        onPointerDown={(event) => {
          const position = captureDocumentScrollPosition();
          pointerActivationPositionReference.current = position;
          pointerScrollReference.current = position;
          pointerActivationReference.current = true;
          if (document.activeElement !== event.currentTarget) {
            event.preventDefault();
            focusWithoutDocumentScroll(event.currentTarget);
          }
        }}
        onPointerCancel={() => {
          pointerActivationReference.current = false;
          pointerActivationPositionReference.current = null;
        }}
        placeholder="Search everything…"
        onPointerUp={() => {
          pointerActivationReference.current = false;
          const position = pointerActivationPositionReference.current;
          pointerActivationPositionReference.current = null;
          activate?.(true, position);
        }}
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
  const [openRequested, setOpenRequested] = useState(false);
  const activationScrollReference = useRef<DocumentScrollPosition | null>(null);
  const placeholderReference = useRef<HTMLInputElement>(null);

  const activate = useCallback(
    (focusRequested = false, activationPosition?: DocumentScrollPosition | null) => {
      activationScrollReference.current ??= activationPosition ?? captureDocumentScrollPosition();
      if (focusRequested) setOpenRequested(true);
      setLoading(true);
      void loadGlobalSearch()
        .then((Component) => {
          setRestoreFocus(
            (requested) =>
              requested ||
              focusRequested ||
              document.activeElement === placeholderReference.current,
          );
          setSearchComponent(() => Component);
        })
        .catch(() => setLoading(false));
    },
    [],
  );

  useLayoutEffect(() => {
    if (!SearchComponent) return;
    const stopStabilizing = stabilizeDocumentScrollPosition(activationScrollReference.current);
    activationScrollReference.current = null;
    return stopStabilizing;
  }, [SearchComponent]);

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
        activate={(focusRequested, activationPosition) =>
          activate(focusRequested, activationPosition)
        }
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
      initialOpen={properties.initialOpen || openRequested || pendingQuery.trim().length > 0}
      initialQuery={pendingQuery}
    />
  );
}
