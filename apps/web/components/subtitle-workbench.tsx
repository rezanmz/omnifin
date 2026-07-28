"use client";

import type { SubtitleCandidate, SubtitleSearchResponse } from "@omnifin/contracts/subtitles";
import {
  Captions,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  createSubtitleDownloadIdempotencyKey,
  SubtitleClientError,
  subtitleClient,
  type SubtitleClient,
} from "../lib/subtitles";
import styles from "./subtitle-workbench.module.css";

export interface SubtitleWorkbenchProperties {
  client?: SubtitleClient;
  csrfToken: string;
  mediaReferenceId: string;
  mediaTitle: string;
  onClose: () => void;
}

type SearchState =
  | { kind: "loading" }
  | { data: SubtitleSearchResponse; kind: "ready" }
  | { error: SubtitleClientError | Error; kind: "error" };

type DownloadState =
  | { kind: "idle" }
  | { idempotencyKey: string; kind: "submitting" }
  | { acceptedAt: string; kind: "accepted"; replayed: boolean }
  | { error: SubtitleClientError | Error; idempotencyKey: string | null; kind: "error" };

function readableToken(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function resultDescription(result: SubtitleCandidate) {
  const attributes = [
    result.hearingImpaired ? "SDH" : null,
    result.forced ? "Forced" : null,
    result.originalFormat ? "Original format" : null,
  ].filter(Boolean);
  return [result.provider, result.uploader ? `by ${result.uploader}` : null, ...attributes]
    .filter(Boolean)
    .join(" · ");
}

function targetLabel(media: SubtitleSearchResponse["media"]) {
  if (media.kind === "movie") return media.year ? `${media.title} · ${media.year}` : media.title;
  const episode = `S${String(media.seasonNumber).padStart(2, "0")}E${String(media.episodeNumber).padStart(2, "0")}`;
  return [media.title, episode, media.year].filter((value) => value !== null).join(" · ");
}

function searchWindow(data: SubtitleSearchResponse) {
  const minutes = Math.max(
    1,
    Math.round((Date.parse(data.expiresAt) - Date.parse(data.generatedAt)) / 60_000),
  );
  return `Results stay available for ${minutes} min`;
}

function downloadCopy(state: DownloadState) {
  if (state.kind === "submitting") return "Sending…";
  if (state.kind === "accepted") return "Accepted";
  if (state.kind === "error") return "Try again";
  return "Add subtitle";
}

export function SubtitleWorkbench({
  client = subtitleClient,
  csrfToken,
  mediaReferenceId,
  mediaTitle,
  onClose,
}: SubtitleWorkbenchProperties) {
  const titleId = useId();
  const closeReference = useRef<HTMLButtonElement>(null);
  const searchControllerReference = useRef<AbortController | null>(null);
  const [searchState, setSearchState] = useState<SearchState>({ kind: "loading" });
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});

  const search = useCallback(() => {
    searchControllerReference.current?.abort();
    const controller = new AbortController();
    searchControllerReference.current = controller;
    setDownloads({});
    setSearchState({ kind: "loading" });
    void client
      .search(mediaReferenceId, { csrfToken, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setSearchState({ data, kind: "ready" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSearchState({
          error: error instanceof Error ? error : new Error("Subtitle search failed."),
          kind: "error",
        });
      });
  }, [client, csrfToken, mediaReferenceId]);

  useEffect(() => {
    closeReference.current?.focus();
    search();
    return () => searchControllerReference.current?.abort();
  }, [search]);

  async function downloadResult(result: SubtitleCandidate, searchId: string) {
    const previous = downloads[result.id];
    const retainedKey =
      previous?.kind === "error" &&
      (previous.error instanceof SubtitleClientError
        ? ["pending", "unavailable"].includes(previous.error.kind)
        : true)
        ? previous.idempotencyKey
        : null;
    let idempotencyKey: string;
    try {
      idempotencyKey = retainedKey ?? createSubtitleDownloadIdempotencyKey();
    } catch (error) {
      setDownloads((current) => ({
        ...current,
        [result.id]: {
          error: error instanceof Error ? error : new Error("Subtitle download failed."),
          idempotencyKey: null,
          kind: "error",
        },
      }));
      return;
    }
    setDownloads((current) => ({
      ...current,
      [result.id]: { idempotencyKey, kind: "submitting" },
    }));
    try {
      const created = await client.download(searchId, result.id, {
        csrfToken,
        idempotencyKey,
      });
      setDownloads((current) => ({
        ...current,
        [result.id]: {
          acceptedAt: created.download.acceptedAt,
          kind: "accepted",
          replayed: created.replayed,
        },
      }));
    } catch (error) {
      const safeError = error instanceof Error ? error : new Error("Subtitle download failed.");
      if (safeError instanceof SubtitleClientError && safeError.kind === "expired") {
        setSearchState({ error: safeError, kind: "error" });
      }
      setDownloads((current) => ({
        ...current,
        [result.id]: { error: safeError, idempotencyKey, kind: "error" },
      }));
    }
  }

  const resultCount = searchState.kind === "ready" ? searchState.data.results.length : null;
  const liveMessage =
    searchState.kind === "loading"
      ? `Searching Bazarr for ${mediaTitle}.`
      : searchState.kind === "error"
        ? searchState.error.message
        : resultCount === 0
          ? `No subtitle candidates found for ${mediaTitle}.`
          : `${resultCount} subtitle ${resultCount === 1 ? "candidate" : "candidates"} found.`;

  return (
    <section
      aria-labelledby={titleId}
      className={styles.workbench}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div aria-hidden="true" className={styles.refraction} />
      <header className={styles.header}>
        <span aria-hidden="true" className={styles.headerIcon}>
          <Captions size={20} />
        </span>
        <div className={styles.heading}>
          <span>Subtitle workbench</span>
          <h3 id={titleId}>{mediaTitle}</h3>
        </div>
        <button
          aria-label="Close subtitle workbench"
          className={styles.iconButton}
          onClick={onClose}
          ref={closeReference}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      <p aria-atomic="true" className="sr-only" role="status">
        {liveMessage}
      </p>

      {searchState.kind === "loading" && (
        <div aria-busy="true" className={styles.loadingState}>
          <div className={styles.loadingLead}>
            <span className={styles.searchOrb}>
              <Search aria-hidden="true" size={20} />
              <LoaderCircle aria-hidden="true" className={styles.orbit} size={46} />
            </span>
            <span>
              <strong>Looking for the best match</strong>
              <small>Comparing language, release, episode, and format signals.</small>
            </span>
          </div>
          <div aria-hidden="true" className={styles.skeletonList}>
            {[0, 1, 2].map((index) => (
              <span className={styles.skeletonRow} key={index}>
                <i />
                <i />
                <i />
              </span>
            ))}
          </div>
        </div>
      )}

      {searchState.kind === "error" && (
        <div className={styles.boundaryState} role="alert">
          <span aria-hidden="true" className={styles.boundaryIcon}>
            <CircleAlert size={22} />
          </span>
          <div>
            <strong>
              {searchState.error instanceof SubtitleClientError &&
              searchState.error.kind === "expired"
                ? "Those results have expired"
                : "Subtitles are out of reach"}
            </strong>
            <p>{searchState.error.message}</p>
          </div>
          <button className={styles.retryButton} onClick={search} type="button">
            <RefreshCw aria-hidden="true" size={16} /> Search again
          </button>
        </div>
      )}

      {searchState.kind === "ready" && searchState.data.results.length === 0 && (
        <div className={styles.boundaryState}>
          <span aria-hidden="true" className={styles.boundaryIcon}>
            <Search size={22} />
          </span>
          <div>
            <strong>No close matches yet</strong>
            <p>Bazarr searched its configured providers but did not return a candidate.</p>
          </div>
          <button className={styles.retryButton} onClick={search} type="button">
            <RefreshCw aria-hidden="true" size={16} /> Search again
          </button>
        </div>
      )}

      {searchState.kind === "ready" && searchState.data.results.length > 0 && (
        <>
          <div className={styles.resultMeta}>
            <span>
              <Sparkles aria-hidden="true" size={14} />
              {targetLabel(searchState.data.media)}
            </span>
            <small>{searchWindow(searchState.data)}</small>
          </div>
          <div className={styles.results}>
            {searchState.data.results.map((result, index) => {
              const state = downloads[result.id] ?? ({ kind: "idle" } satisfies DownloadState);
              const accepted = state.kind === "accepted";
              const failed = state.kind === "error";
              return (
                <article
                  className={styles.result}
                  data-accepted={accepted || undefined}
                  key={result.id}
                >
                  <div className={styles.resultRank} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <div className={styles.resultBody}>
                    <div className={styles.resultTopline}>
                      <div>
                        <h4>{result.language}</h4>
                        <p>{resultDescription(result)}</p>
                      </div>
                      <span
                        aria-label={`${result.language} match score`}
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={Math.round(result.score)}
                        className={styles.score}
                        role="meter"
                        style={{ "--score": `${result.score}%` } as React.CSSProperties}
                      >
                        <i aria-hidden="true" />
                        <b>{Math.round(result.score)}</b>
                      </span>
                    </div>
                    <div className={styles.tags}>
                      {result.matches.slice(0, 4).map((match) => (
                        <span key={match}>{readableToken(match)}</span>
                      ))}
                      {result.forced && <span data-special="true">Forced</span>}
                      {result.hearingImpaired && <span data-special="true">SDH</span>}
                      {result.originalFormat && <span data-special="true">Original</span>}
                    </div>
                    {(result.releaseNames.length > 0 || result.dontMatches.length > 0) && (
                      <details className={styles.details}>
                        <summary>
                          Match details <ChevronDown aria-hidden="true" size={14} />
                        </summary>
                        <div>
                          {result.releaseNames.length > 0 && (
                            <p>
                              <span>Release</span>
                              {result.releaseNames.join(" · ")}
                            </p>
                          )}
                          {result.dontMatches.length > 0 && (
                            <p>
                              <span>Different</span>
                              {result.dontMatches.map(readableToken).join(" · ")}
                            </p>
                          )}
                        </div>
                      </details>
                    )}
                    {failed && (
                      <p className={styles.rowError} role="alert">
                        {state.error.message}
                      </p>
                    )}
                    {accepted && (
                      <p className={styles.acceptedCopy} role="status">
                        Bazarr accepted this subtitle. It will appear after Bazarr finishes
                        processing it.
                      </p>
                    )}
                  </div>
                  <button
                    aria-label={`${downloadCopy(state)} — ${result.language} from ${result.provider}`}
                    className={styles.downloadButton}
                    data-accepted={accepted || undefined}
                    disabled={state.kind === "submitting" || accepted}
                    onClick={() => void downloadResult(result, searchState.data.searchId)}
                    type="button"
                  >
                    {state.kind === "submitting" ? (
                      <LoaderCircle aria-hidden="true" className={styles.spin} size={16} />
                    ) : accepted ? (
                      <Check aria-hidden="true" size={17} />
                    ) : (
                      <Download aria-hidden="true" size={16} />
                    )}
                    <span>{downloadCopy(state)}</span>
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}

      <footer className={styles.footer}>
        <span>
          <ShieldCheck aria-hidden="true" size={14} />
          Provider links and cache tokens stay inside the gateway.
        </span>
        {searchState.kind === "ready" && searchState.data.results.length > 0 && (
          <button onClick={search} type="button">
            <RefreshCw aria-hidden="true" size={14} /> Refresh
          </button>
        )}
      </footer>
    </section>
  );
}
