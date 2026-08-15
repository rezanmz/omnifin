"use client";

import "./library-title-drawer.css";

import type {
  LibraryRemovalMode,
  LibraryRemovalOperation,
  LibraryRemovalPreview,
} from "@omnifin/contracts/library";
import { AlertTriangle, Check, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  MediaLibraryClientError,
  type MediaDownloadEligibility,
  type MediaLibraryClient,
} from "../lib/media-library";

type RemovalState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "confirming";
      preview: LibraryRemovalPreview;
      mode: LibraryRemovalMode;
      typedTitle: string;
    }
  | { kind: "submitting"; preview: LibraryRemovalPreview; mode: LibraryRemovalMode }
  | { kind: "complete"; operation: LibraryRemovalOperation }
  | { kind: "error"; message: string };

function removalErrorMessage(error: unknown) {
  if (error instanceof MediaLibraryClientError) {
    if (error.kind === "signed_out")
      return "Your session ended. Sign in again before removing this title.";
    if (error.kind === "forbidden")
      return "Removal permission or the paired Jellyfin delete capability changed.";
    if (error.code === "library_removal_preview_expired")
      return "This preview expired. Review the current removal effects again.";
  }
  return "The removal was not started. Your library and requests are unchanged.";
}

function modeLabel(mode: LibraryRemovalMode) {
  switch (mode) {
    case "delete_files_keep_monitored":
      return "Delete organized files; keep monitoring";
    case "delete_files_and_unmonitor":
      return "Delete organized files and stop monitoring";
    case "remove_from_radarr_and_delete_files":
      return "Remove from Radarr and delete organized files";
    case "delete_unmanaged_files":
      return "Delete organized files";
  }
}

function modeWarning(mode: LibraryRemovalMode) {
  if (mode === "delete_files_keep_monitored") {
    return "Radarr remains monitored and can acquire this title again.";
  }
  if (mode === "delete_unmanaged_files")
    return "This title is unmanaged; Jellyfin deletes only its organized file.";
  return "Automatic reacquisition is prevented for this title.";
}

function formatBytes(sizeBytes: number | null) {
  if (sizeBytes === null) return "Size unavailable";
  return `${(sizeBytes / 1_073_741_824).toFixed(1)} GB`;
}

export function LibraryRemovalAction({
  client,
  media,
}: {
  client: MediaLibraryClient;
  media: { id: string; title: string };
}) {
  const [eligibility, setEligibility] = useState<MediaDownloadEligibility | { status: "loading" }>({
    status: "loading",
  });
  const [state, setState] = useState<RemovalState>({ kind: "idle" });
  const requestController = useRef<AbortController | null>(null);
  const available = Boolean(
    client.commitRemoval && client.loadRemovalEligibility && client.loadRemovalPreview,
  );

  useEffect(() => {
    if (!available || !client.loadRemovalEligibility) return;
    const controller = new AbortController();
    void client
      .loadRemovalEligibility(controller.signal)
      .then(setEligibility)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setEligibility({ status: "unavailable" });
        }
      });
    return () => controller.abort();
  }, [available, client]);

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    [],
  );

  if (!available || eligibility.status !== "ready") return null;

  async function openPreview() {
    if (!client.loadRemovalPreview || state.kind === "loading") return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setState({ kind: "loading" });
    try {
      const preview = await client.loadRemovalPreview(media.id, controller.signal);
      if (!controller.signal.aborted) {
        setState({ kind: "confirming", mode: preview.options[0]!.mode, preview, typedTitle: "" });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setState({ kind: "error", message: removalErrorMessage(error) });
      }
    } finally {
      if (requestController.current === controller) requestController.current = null;
    }
  }

  async function commit() {
    if (state.kind !== "confirming" || !client.commitRemoval) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const { mode, preview } = state;
    setState({ kind: "submitting", mode, preview });
    try {
      const operation = await client.commitRemoval(
        media.id,
        {
          confirmationTitle: preview.confirmation.expectedTitle,
          mode,
          previewId: preview.previewId,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) setState({ kind: "complete", operation });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setState({ kind: "error", message: removalErrorMessage(error) });
      }
    } finally {
      if (requestController.current === controller) requestController.current = null;
    }
  }

  return (
    <section aria-label={`Remove ${media.title} from library`} className="library-title__download">
      <span aria-hidden="true" className="library-title__download-icon">
        <Trash2 />
      </span>
      <div>
        <strong>Remove from library</strong>
        <span>Removes only the selected organized title through the verified source of truth.</span>
      </div>
      {state.kind === "idle" || state.kind === "error" ? (
        <button
          className="button button--glass"
          data-directional-item
          onClick={() => void openPreview()}
          type="button"
        >
          <Trash2 aria-hidden="true" /> Review removal
        </button>
      ) : null}
      {state.kind === "loading" || state.kind === "submitting" ? (
        <span className="library-title__download" role="status">
          <LoaderCircle aria-hidden="true" className="library-title__spinner" />
          {state.kind === "loading"
            ? "Checking current ownership…"
            : "Removing through connected services…"}
        </span>
      ) : null}
      {state.kind === "confirming" ? (
        <div className="library-title__removal-confirmation">
          <p>
            <AlertTriangle aria-hidden="true" /> Review the exact removal before it begins.
          </p>
          <p>
            {formatBytes(state.preview.sizeBytes)} organized media. Request history and independent
            torrent copies stay unchanged; storage reclamation may be delayed.
          </p>
          {state.preview.options.map((option) => (
            <label key={option.mode}>
              <input
                checked={state.mode === option.mode}
                name={`removal-mode-${media.id}`}
                onChange={() => setState({ ...state, mode: option.mode })}
                type="radio"
                value={option.mode}
              />
              <span>
                <strong>{modeLabel(option.mode)}</strong>
                <span>{modeWarning(option.mode)}</span>
              </span>
            </label>
          ))}
          <label>
            <span>
              Type <strong>{state.preview.confirmation.expectedTitle}</strong> to confirm
            </span>
            <input
              aria-label={`Confirm removal of ${state.preview.confirmation.expectedTitle}`}
              onChange={(event) => setState({ ...state, typedTitle: event.target.value })}
              value={state.typedTitle}
            />
          </label>
          <button
            className="button button--danger"
            data-directional-item
            disabled={state.typedTitle !== state.preview.confirmation.expectedTitle}
            onClick={() => void commit()}
            type="button"
          >
            Remove title
          </button>
          <button
            className="button button--glass"
            onClick={() => setState({ kind: "idle" })}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}
      {state.kind === "complete" ? (
        <p role="status">
          <Check aria-hidden="true" />{" "}
          {state.operation.state === "succeeded"
            ? "Removal completed."
            : "Removal needs reconciliation; no duplicate deletion will run."}
        </p>
      ) : null}
      {state.kind === "error" ? <p role="status">{state.message}</p> : null}
    </section>
  );
}
