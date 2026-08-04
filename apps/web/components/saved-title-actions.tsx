"use client";

import type { SavedMembershipSummary } from "@omnifin/contracts/saved";
import { Bookmark, BookmarkCheck, Heart, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSavedListIdempotencyKey,
  SavedListsClientError,
  savedListsClient,
  type SavedListsClient,
  type SavedWorkspaceSnapshot,
} from "../lib/saved-lists";
import styles from "./saved-title-actions.module.css";

interface ResolvedTitle {
  etag: string;
  snapshot: SavedWorkspaceSnapshot;
  summary: SavedMembershipSummary;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { action: "favorite" | "watch_later"; kind: "pending" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface SavedTitleActionsProperties {
  client?: SavedListsClient;
  compact?: boolean;
  eager?: boolean;
  referenceId: string;
  title: string;
}

function boundaryError(status: "forbidden" | "signed_out" | "unavailable") {
  if (status === "signed_out") {
    return new SavedListsClientError(
      "signed_out",
      "session_required",
      "Sign in again to manage private saved titles.",
    );
  }
  if (status === "forbidden") {
    return new SavedListsClientError(
      "forbidden",
      "permission_required",
      "This account cannot manage private saved titles.",
    );
  }
  return new SavedListsClientError(
    "unavailable",
    "saved_lists_unavailable",
    "Watch Later is temporarily unavailable.",
  );
}

function actionError(error: unknown) {
  if (error instanceof SavedListsClientError) {
    if (error.kind === "signed_out") return "Your session ended. Sign in again to save this title.";
    if (error.kind === "forbidden") return "This account cannot manage private saved titles.";
    if (error.kind === "precondition" || error.kind === "conflict") {
      return "This list changed on another screen. Try once more.";
    }
    if (error.kind === "rate_limited") return "Saving is cooling down. Try again shortly.";
  }
  return "The saved-title change could not be confirmed. Nothing else was changed.";
}

async function resolveTitle(
  client: SavedListsClient,
  referenceId: string,
  signal?: AbortSignal,
): Promise<ResolvedTitle> {
  const outcome = await client.load(signal);
  if (outcome.status !== "ready") throw boundaryError(outcome.status);
  const listId = outcome.snapshot.lists.watchLater.id;
  const [summary, list] = await Promise.all([
    client.issueLibraryTarget(referenceId, {
      csrfToken: outcome.snapshot.csrfToken,
      ...(signal === undefined ? {} : { signal }),
    }),
    client.readList(listId, signal),
  ]);
  return { etag: list.etag, snapshot: outcome.snapshot, summary };
}

export function SavedTitleActions({
  client = savedListsClient,
  compact = false,
  eager = false,
  referenceId,
  title,
}: SavedTitleActionsProperties) {
  const [resolved, setResolved] = useState<ResolvedTitle | null>(null);
  const [state, setState] = useState<ActionState>({ kind: eager ? "loading" : "idle" });
  const mounted = useRef(true);
  const pending = state.kind === "loading" || state.kind === "pending";

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const next = await resolveTitle(client, referenceId, signal);
      if (mounted.current && !signal?.aborted) {
        setResolved(next);
        setState({ kind: "ready" });
      }
      return next;
    },
    [client, referenceId],
  );

  useEffect(() => {
    mounted.current = true;
    if (!eager) {
      return () => {
        mounted.current = false;
      };
    }
    const controller = new AbortController();
    void refresh(controller.signal).catch((error: unknown) => {
      if (!mounted.current || controller.signal.aborted) return;
      setState({ kind: "error", message: actionError(error) });
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [eager, refresh]);

  async function toggleWatchLater() {
    if (pending) return;
    setState({ action: "watch_later", kind: "pending" });
    try {
      const current = resolved ?? (await resolveTitle(client, referenceId));
      const listId = current.snapshot.lists.watchLater.id;
      let etag: string;
      let summary: SavedMembershipSummary;
      if (current.summary.watchLater) {
        if (!current.summary.catalogReferenceId) {
          throw new SavedListsClientError(
            "invalid_response",
            "saved_catalog_reference_missing",
            "The saved title is missing its private catalog reference.",
          );
        }
        const result = await client.removeItem(listId, current.summary.catalogReferenceId, {
          csrfToken: current.snapshot.csrfToken,
          etag: current.etag,
        });
        etag = result.etag;
        summary = { ...current.summary, watchLater: false };
      } else {
        const result = await client.addItem(
          listId,
          { targetReferenceId: current.summary.targetReferenceId },
          {
            csrfToken: current.snapshot.csrfToken,
            etag: current.etag,
            idempotencyKey: createSavedListIdempotencyKey(),
          },
        );
        etag = result.etag;
        summary = {
          ...current.summary,
          catalogReferenceId: result.data.item.catalog.id,
          watchLater: true,
        };
      }
      if (mounted.current) {
        setResolved({ ...current, etag, summary });
        setState({ kind: "ready" });
      }
    } catch (error) {
      if (mounted.current) setState({ kind: "error", message: actionError(error) });
    }
  }

  async function toggleFavorite() {
    if (pending || resolved?.summary.favorite.state !== "synced") return;
    setState({ action: "favorite", kind: "pending" });
    try {
      const favorite = !resolved.summary.favorite.value;
      await client.updateFavorite(
        resolved.summary.targetReferenceId,
        { favorite },
        { csrfToken: resolved.snapshot.csrfToken },
      );
      if (mounted.current) {
        setResolved({
          ...resolved,
          summary: { ...resolved.summary, favorite: { state: "synced", value: favorite } },
        });
        setState({ kind: "ready" });
      }
    } catch (error) {
      if (mounted.current) setState({ kind: "error", message: actionError(error) });
    }
  }

  const watchLater = resolved?.summary.watchLater === true;
  const favorite =
    resolved?.summary.favorite.state === "synced" ? resolved.summary.favorite.value : false;
  const favoriteAvailable = resolved?.summary.favorite.state === "synced";
  const WatchIcon =
    state.kind === "pending" && state.action === "watch_later"
      ? LoaderCircle
      : watchLater
        ? BookmarkCheck
        : Bookmark;

  if (compact) {
    return (
      <button
        aria-label={`Toggle ${title} in Watch Later`}
        aria-pressed={resolved ? watchLater : undefined}
        className={styles.compact}
        data-active={watchLater || undefined}
        data-directional-item
        disabled={pending}
        onClick={(event) => {
          event.stopPropagation();
          void toggleWatchLater();
        }}
        title={watchLater ? "Remove from Watch Later" : "Save to Watch Later"}
        type="button"
      >
        <WatchIcon aria-hidden="true" className={pending ? styles.spin : undefined} />
      </button>
    );
  }

  return (
    <div className={styles.actions}>
      <div aria-label={`Save ${title}`} className={styles.buttons} role="group">
        <button
          aria-pressed={resolved ? watchLater : undefined}
          className="button button--glass"
          disabled={pending}
          onClick={() => void toggleWatchLater()}
          type="button"
        >
          <WatchIcon aria-hidden="true" className={pending ? styles.spin : undefined} />
          {watchLater ? "In Watch Later" : "Watch Later"}
        </button>
        <button
          aria-pressed={favoriteAvailable ? favorite : undefined}
          className="button button--glass"
          disabled={pending || !favoriteAvailable}
          onClick={() => void toggleFavorite()}
          title={favoriteAvailable ? undefined : "Favorite state is unavailable from Jellyfin"}
          type="button"
        >
          {state.kind === "pending" && state.action === "favorite" ? (
            <LoaderCircle aria-hidden="true" className={styles.spin} />
          ) : (
            <Heart aria-hidden="true" fill={favorite ? "currentColor" : "none"} />
          )}
          {favorite ? "Jellyfin Favorite" : "Favorite"}
        </button>
      </div>
      <p aria-live="polite" className={styles.status} data-state={state.kind} role="status">
        {state.kind === "loading"
          ? "Checking private saved state…"
          : state.kind === "pending"
            ? state.action === "favorite"
              ? "Synchronizing with Jellyfin…"
              : "Updating Watch Later…"
            : state.kind === "error"
              ? state.message
              : ""}
      </p>
    </div>
  );
}
