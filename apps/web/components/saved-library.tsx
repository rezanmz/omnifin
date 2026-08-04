"use client";

import type {
  SavedListAvailabilityFilter,
  SavedListItemSort,
  SavedListItemsResponse,
  SavedListSummary,
} from "@omnifin/contracts/saved";
import {
  Bookmark,
  BookmarkX,
  ChevronDown,
  CloudOff,
  Film,
  Library,
  ListPlus,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Tv,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";

import {
  createSavedListIdempotencyKey,
  savedListsClient,
  SavedListsClientError,
  type SavedListsClient,
  type SavedVersionedResponse,
  type SavedWorkspaceLoadOutcome,
} from "../lib/saved-lists";
import { savedListsDemoClient } from "../lib/saved-lists-demo";
import { ApplicationShellContent } from "./application-shell";
import styles from "./saved-library.module.css";

type SavedAmbientStyle = CSSProperties & { "--saved-accent": string };

export interface SavedLibraryProperties {
  client?: SavedListsClient;
  demo?: boolean;
  initialOutcome?: SavedWorkspaceLoadOutcome;
  initialPage?: SavedVersionedResponse<SavedListItemsResponse>;
  live?: boolean;
}

const FILTER_OPTIONS: { label: string; value: SavedListAvailabilityFilter }[] = [
  { label: "Everything", value: "all" },
  { label: "Owned", value: "owned" },
  { label: "Requestable", value: "requestable" },
  { label: "Requested", value: "requested" },
  { label: "Unavailable", value: "unavailable" },
];

const SORT_OPTIONS: { label: string; value: SavedListItemSort }[] = [
  { label: "Manual order", value: "manual" },
  { label: "Recently added", value: "added_desc" },
  { label: "Title", value: "title" },
];

function SavedShell({
  accent = "#84a8a0",
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
        className={`${styles.saved} dashboard`}
        id="main-content"
        style={{ "--saved-accent": accent } as SavedAmbientStyle}
        tabIndex={-1}
      >
        {children}
      </main>
    </ApplicationShellContent>
  );
}

function LoadingSaved() {
  return (
    <SavedShell status="attention">
      <section aria-busy="true" aria-labelledby="saved-loading-title" className={styles.loading}>
        <p className="eyebrow">Your private shelves</p>
        <h1 id="saved-loading-title">Gathering what you saved…</h1>
        <div aria-hidden="true" className={styles.loadingLayout}>
          <aside />
          <div>
            <i />
            <span />
            <section>
              {Array.from({ length: 6 }, (_, index) => (
                <article key={index} />
              ))}
            </section>
          </div>
        </div>
        <span className="sr-only" role="status">
          Loading Watch Later and your private lists.
        </span>
      </section>
    </SavedShell>
  );
}

const boundaryCopy = {
  forbidden: {
    action: "Return to discovery",
    detail: "This session cannot manage private saved titles.",
    href: "/",
    icon: ShieldAlert,
    kicker: "Private boundary",
    title: "Saved lists are not available to this account.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Sign in, then pair your Jellyfin identity to use private lists.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Your shelves are waiting",
    title: "Sign in to see what you saved.",
  },
} as const;

function SavedBoundary({ kind }: { kind: keyof typeof boundaryCopy }) {
  const copy = boundaryCopy[kind];
  const Icon = copy.icon;
  return (
    <SavedShell status="attention">
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
    </SavedShell>
  );
}

function SavedUnavailable({ retry }: { retry: () => void }) {
  return (
    <SavedShell status="offline">
      <section className={styles.boundary} data-liquid-glass role="alert">
        <span aria-hidden="true" className={styles.boundaryIcon}>
          <CloudOff />
        </span>
        <p className="eyebrow">Private signal interrupted</p>
        <h1>Your saved titles are still safe.</h1>
        <p>The gateway could not open the encrypted private-list records. Nothing was changed.</p>
        <button className="button button--primary" onClick={retry} type="button">
          Try again
        </button>
      </section>
    </SavedShell>
  );
}

function listCollection(outcome: Extract<SavedWorkspaceLoadOutcome, { status: "ready" }>) {
  return [outcome.snapshot.lists.watchLater, ...outcome.snapshot.lists.lists];
}

function listIcon(list: SavedListSummary) {
  return list.kind === "watch_later" ? Bookmark : Library;
}

function itemFacts(item: SavedListItemsResponse["items"][number]) {
  const availability =
    item.catalog.availability === "owned"
      ? "Ready to play"
      : item.catalog.availability === "requested"
        ? "Requested"
        : item.catalog.availability === "requestable"
          ? "Available to request"
          : "Needs attention";
  return [item.catalog.year, availability].filter(Boolean).join(" · ");
}

function SavedCard({
  busy,
  item,
  remove,
}: {
  busy: boolean;
  item: SavedListItemsResponse["items"][number];
  remove: () => void;
}) {
  const Icon = item.catalog.kind === "movie" ? Film : Tv;
  const posterPath = item.catalog.artwork.posterPath;
  return (
    <article className={styles.card} data-availability={item.catalog.availability}>
      <div className={styles.poster}>
        {posterPath ? (
          /* Authenticated artwork must load in the browser so its private session cookie is sent. */
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="" decoding="async" loading="lazy" src={posterPath} />
        ) : (
          <span aria-hidden="true" className={styles.posterFallback}>
            <Icon size={34} strokeWidth={1.25} />
          </span>
        )}
        <span className={styles.availability}>{itemFacts(item)}</span>
      </div>
      <div className={styles.cardCopy}>
        <div>
          <p className="eyebrow">{item.catalog.kind}</p>
          <h3>{item.catalog.title}</h3>
        </div>
        <button
          aria-label={`Remove ${item.catalog.title} from this private list`}
          className={styles.remove}
          disabled={busy}
          onClick={remove}
          type="button"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={17} />
          ) : (
            <Trash2 aria-hidden="true" size={17} />
          )}
          <span>Remove</span>
        </button>
      </div>
    </article>
  );
}

function EmptySaved({ filtered, listName }: { filtered: boolean; listName: string }) {
  return (
    <section className={styles.empty} data-liquid-glass>
      <span aria-hidden="true" className={styles.emptyIcon}>
        <BookmarkX />
      </span>
      <p className="eyebrow">{filtered ? "No matches" : "Room for something great"}</p>
      <h2>{filtered ? "Nothing here matches those filters." : `${listName} is empty.`}</h2>
      <p>
        {filtered
          ? "Try another title, availability, or sort order."
          : "Save an owned title from Library. Requestable discovery titles will join this shelf as connector support comes online."}
      </p>
      {!filtered ? (
        <Link className="button button--glass" href="/library">
          Browse your library
        </Link>
      ) : null}
    </section>
  );
}

export function SavedLibrary({
  client: clientOverride,
  demo = false,
  initialOutcome,
  initialPage,
  live,
}: SavedLibraryProperties) {
  const client = clientOverride ?? (demo ? savedListsDemoClient : savedListsClient);
  const [outcome, setOutcome] = useState<SavedWorkspaceLoadOutcome>(
    initialOutcome ?? { status: "unavailable" },
  );
  const [booting, setBooting] = useState(initialOutcome === undefined);
  const initialReady = initialOutcome?.status === "ready" ? initialOutcome : null;
  const [selectedListId, setSelectedListId] = useState(
    initialReady?.snapshot.lists.watchLater.id ?? "",
  );
  const [page, setPage] = useState<SavedVersionedResponse<SavedListItemsResponse> | null>(
    initialPage ?? null,
  );
  const [pageLoading, setPageLoading] = useState(initialPage === undefined);
  const [filter, setFilter] = useState<SavedListAvailabilityFilter>("all");
  const [sort, setSort] = useState<SavedListItemSort>("manual");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [busyCatalogId, setBusyCatalogId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const searchReference = useRef<HTMLInputElement>(null);
  const initialPageConsumed = useRef(false);
  const refreshAvailable = live ?? initialOutcome === undefined;

  useEffect(() => {
    if (!refreshAvailable || initialOutcome !== undefined) return;
    const controller = new AbortController();
    void client
      .load(controller.signal)
      .then((nextOutcome) => {
        setOutcome(nextOutcome);
        if (nextOutcome.status === "ready") {
          setSelectedListId(nextOutcome.snapshot.lists.watchLater.id);
        }
      })
      .finally(() => setBooting(false));
    return () => controller.abort();
  }, [client, initialOutcome, refreshAvailable, refreshRevision]);

  useEffect(() => {
    if (outcome.status !== "ready" || !selectedListId) return;
    if (!refreshAvailable && initialPage && !initialPageConsumed.current) {
      initialPageConsumed.current = true;
      return;
    }
    const controller = new AbortController();
    void client
      .listItems(
        selectedListId,
        {
          availability: filter,
          limit: 30,
          ...(query ? { query } : {}),
          sort,
        },
        controller.signal,
      )
      .then(setPage)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setPage(null);
        setError(
          reason instanceof SavedListsClientError
            ? reason.message
            : "This private list could not be opened.",
        );
      })
      .finally(() => setPageLoading(false));
    return () => controller.abort();
  }, [
    client,
    filter,
    initialPage,
    outcome,
    query,
    refreshAvailable,
    refreshRevision,
    selectedListId,
    sort,
  ]);

  const lists = useMemo(
    () => (outcome.status === "ready" ? listCollection(outcome) : []),
    [outcome],
  );
  const selectedList = lists.find((candidate) => candidate.id === selectedListId) ?? lists[0];
  const accent = page?.data.items[0]?.catalog.artwork.accentColor ?? "#84a8a0";

  if (booting) return <LoadingSaved />;
  if (outcome.status === "signed_out" || outcome.status === "forbidden") {
    return <SavedBoundary kind={outcome.status} />;
  }
  if (outcome.status === "unavailable") {
    return <SavedUnavailable retry={() => setRefreshRevision((value) => value + 1)} />;
  }
  const readyOutcome = outcome as Extract<SavedWorkspaceLoadOutcome, { status: "ready" }>;

  function chooseList(listId: string) {
    setSelectedListId(listId);
    setPage(null);
    setPageLoading(true);
    setError("");
    setQuery("");
    setDraftQuery("");
    setFilter("all");
    setSort("manual");
    setNotice("");
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = draftQuery.trim();
    if (nextQuery === query) return;
    setPageLoading(true);
    setError("");
    setQuery(nextQuery);
  }

  async function removeItem(item: SavedListItemsResponse["items"][number]) {
    if (!page || !selectedList) return;
    setBusyCatalogId(item.catalog.id);
    setError("");
    try {
      const result = await client.removeItem(selectedList.id, item.catalog.id, {
        csrfToken: readyOutcome.snapshot.csrfToken,
        etag: page.etag,
      });
      setPage({
        data: {
          ...page.data,
          items: page.data.items.filter((candidate) => candidate.catalog.id !== item.catalog.id),
          list: {
            ...page.data.list,
            itemCount: Math.max(0, page.data.list.itemCount - (result.data.removed ? 1 : 0)),
            revision: result.data.revision,
          },
        },
        etag: result.etag,
      });
      setNotice(`Removed ${item.catalog.title} from ${selectedList.name}.`);
    } catch (reason) {
      setError(
        reason instanceof SavedListsClientError
          ? reason.message
          : "The saved title could not be removed.",
      );
      if (reason instanceof SavedListsClientError && reason.retryMode === "refresh") {
        setRefreshRevision((value) => value + 1);
      }
    } finally {
      setBusyCatalogId(null);
    }
  }

  async function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newListName.trim();
    if (!name || creatingList) return;
    setCreatingList(true);
    setError("");
    try {
      const result = await client.createList(
        { description: null, name },
        {
          csrfToken: readyOutcome.snapshot.csrfToken,
          idempotencyKey: createSavedListIdempotencyKey(),
        },
      );
      setOutcome({
        snapshot: {
          ...readyOutcome.snapshot,
          lists: {
            ...readyOutcome.snapshot.lists,
            lists: [...readyOutcome.snapshot.lists.lists, result.data.list],
          },
        },
        status: "ready",
      });
      setNewListName("");
      chooseList(result.data.list.id);
      setNotice(`Created ${result.data.list.name}.`);
    } catch (reason) {
      setError(
        reason instanceof SavedListsClientError
          ? reason.message
          : "The private list could not be created.",
      );
    } finally {
      setCreatingList(false);
    }
  }

  return (
    <SavedShell accent={accent} status={error ? "attention" : "healthy"}>
      <header className={styles.hero}>
        <div>
          <span aria-hidden="true" className={styles.heroGlyph} data-liquid-glass>
            <Bookmark size={19} />
          </span>
          <p className="eyebrow">Private by design</p>
          <h1>Keep the next story close.</h1>
          <p>
            Watch Later and personal lists belong only to this Omnifin account. Saving a title never
            requests, downloads, deletes, or marks it watched.
          </p>
        </div>
        <dl className={styles.metrics} data-liquid-glass>
          <div>
            <dt>Lists</dt>
            <dd>{lists.length}</dd>
          </div>
          <div>
            <dt>Selected</dt>
            <dd>{selectedList?.itemCount ?? 0}</dd>
          </div>
          <div>
            <dt>Visibility</dt>
            <dd>Only you</dd>
          </div>
        </dl>
      </header>

      <div className={styles.workspace}>
        <aside aria-label="Your private lists" className={styles.listRail} data-liquid-glass>
          <div className={styles.listRailHeading}>
            <div>
              <p className="eyebrow">Saved</p>
              <h2>Your lists</h2>
            </div>
            <Sparkles aria-hidden="true" size={17} />
          </div>
          <nav>
            {lists.map((list) => {
              const Icon = listIcon(list);
              return (
                <button
                  aria-current={selectedListId === list.id ? "page" : undefined}
                  data-current={selectedListId === list.id || undefined}
                  key={list.id}
                  onClick={() => chooseList(list.id)}
                  type="button"
                >
                  <Icon aria-hidden="true" size={17} />
                  <span>
                    <strong>{list.name}</strong>
                    <small>{list.itemCount} titles</small>
                  </span>
                </button>
              );
            })}
          </nav>
          <form className={styles.createList} onSubmit={(event) => void createList(event)}>
            <label htmlFor="saved-new-list">New personal list</label>
            <div>
              <input
                autoComplete="off"
                id="saved-new-list"
                maxLength={80}
                onChange={(event) => setNewListName(event.target.value)}
                placeholder="Weekend picks"
                value={newListName}
              />
              <button
                aria-label="Create private list"
                disabled={!newListName.trim() || creatingList}
                type="submit"
              >
                {creatingList ? (
                  <LoaderCircle aria-hidden="true" className={styles.spinner} size={17} />
                ) : (
                  <ListPlus aria-hidden="true" size={17} />
                )}
              </button>
            </div>
          </form>
        </aside>

        <section aria-labelledby="saved-list-title" className={styles.collection}>
          <div className={styles.collectionHeading}>
            <div>
              <p className="eyebrow">
                {selectedList?.kind === "watch_later" ? "Up next, on your terms" : "Personal list"}
              </p>
              <h2 id="saved-list-title">{selectedList?.name ?? "Saved titles"}</h2>
              <p>{selectedList?.description ?? "A private shelf that changes only when you do."}</p>
            </div>
            <span className={styles.privateBadge}>
              <LockKeyhole aria-hidden="true" size={14} /> Private
            </span>
          </div>

          <section aria-label="Saved-list controls" className={styles.controls} data-liquid-glass>
            <form className={styles.search} onSubmit={submitSearch} role="search">
              <Search aria-hidden="true" size={17} />
              <label className="sr-only" htmlFor="saved-search">
                Search this private list
              </label>
              <input
                autoComplete="off"
                id="saved-search"
                maxLength={100}
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder="Search this list"
                ref={searchReference}
                type="search"
                value={draftQuery}
              />
              {draftQuery ? (
                <button
                  aria-label="Clear private-list search"
                  className={styles.clearSearch}
                  onClick={() => {
                    setDraftQuery("");
                    if (query) {
                      setPageLoading(true);
                      setError("");
                      setQuery("");
                    }
                    searchReference.current?.focus();
                  }}
                  type="button"
                >
                  <X aria-hidden="true" size={15} />
                </button>
              ) : null}
              <button className={styles.searchSubmit} type="submit">
                Search
              </button>
            </form>
            <label className={styles.selectControl}>
              <span className="sr-only">Filter saved titles</span>
              <select
                onChange={(event) => {
                  setPageLoading(true);
                  setError("");
                  setFilter(event.target.value as SavedListAvailabilityFilter);
                }}
                value={filter}
              >
                {FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" size={15} />
            </label>
            <label className={styles.selectControl}>
              <span className="sr-only">Sort saved titles</span>
              <select
                onChange={(event) => {
                  setPageLoading(true);
                  setError("");
                  setSort(event.target.value as SavedListItemSort);
                }}
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

          <div aria-live="polite" className={styles.liveRegion} role="status">
            {notice}
          </div>
          {error ? (
            <div className={styles.inlineError} role="alert">
              <CloudOff aria-hidden="true" size={17} />
              <span>{error}</span>
              <button
                onClick={() => {
                  setPageLoading(true);
                  setRefreshRevision((value) => value + 1);
                }}
                type="button"
              >
                Refresh
              </button>
            </div>
          ) : null}

          {pageLoading ? (
            <div aria-busy="true" aria-label="Loading private list" className={styles.cardGrid}>
              {Array.from({ length: 6 }, (_, index) => (
                <article className={styles.cardSkeleton} key={index} />
              ))}
            </div>
          ) : page && page.data.items.length > 0 ? (
            <div className={styles.cardGrid} role="list">
              {page.data.items.map((item) => (
                <div key={item.id} role="listitem">
                  <SavedCard
                    busy={busyCatalogId === item.catalog.id}
                    item={item}
                    remove={() => void removeItem(item)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptySaved
              filtered={Boolean(query) || filter !== "all"}
              listName={selectedList?.name ?? "This list"}
            />
          )}
        </section>
      </div>
    </SavedShell>
  );
}
