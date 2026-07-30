"use client";

import "./manual-release-workbench.css";

import type {
  ManualReleaseCandidate,
  ManualReleaseSearchResponse,
} from "@omnifin/contracts/acquisition";
import {
  ArrowDownToLine,
  BadgeCheck,
  Check,
  Clock3,
  Database,
  Gauge,
  Languages,
  LockKeyhole,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  TriangleAlert,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  createManualReleaseGrabIdempotencyKey,
  ManualReleaseClientError,
  manualReleaseClient,
  type ManualReleaseClient,
  type ManualReleaseClientErrorKind,
  type ManualReleaseEligibilitySnapshot,
} from "../lib/manual-releases";
import type { OperationModel } from "../lib/dashboard-data";

type WorkbenchState =
  | { kind: "idle" }
  | { kind: "loading"; operationId: string }
  | {
      data: ManualReleaseSearchResponse;
      eligibility: ManualReleaseEligibilitySnapshot;
      kind: "ready";
      operationId: string;
    }
  | { errorKind: ManualReleaseClientErrorKind; kind: "error"; operationId: string };

type GrabState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; operationId: string; replayed: boolean }
  | { errorKind: ManualReleaseClientErrorKind; kind: "error" };

export interface ManualReleaseWorkbenchProperties {
  client?: ManualReleaseClient;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  operation: OperationModel | null;
}

const ERROR_COPY: Record<ManualReleaseClientErrorKind, { detail: string; title: string }> = {
  configuration: {
    detail: "Validate one matching Radarr or Sonarr connection before searching again.",
    title: "Release search is not configured",
  },
  conflict: {
    detail: "The secure request identifier was already used for a different release.",
    title: "Create a fresh grab attempt",
  },
  download_unavailable: {
    detail: "The service no longer considers this release downloadable. Refresh the result set.",
    title: "Release is no longer available",
  },
  expired: {
    detail: "Opaque release references are short-lived and cannot be reused after expiry.",
    title: "Search results expired",
  },
  forbidden: {
    detail: "Manual search and grab actions require operator access.",
    title: "Operator access required",
  },
  invalid_response: {
    detail: "The upstream response failed Omnifin’s public contract, so raw data was not shown.",
    title: "Release signal could not be verified",
  },
  override_required: {
    detail: "Review every rejection reason and explicitly confirm the override before continuing.",
    title: "Override confirmation required",
  },
  pending: {
    detail: "The grab may already have reached the download client. Retry the same receipt safely.",
    title: "Grab outcome is still pending",
  },
  rate_limited: {
    detail: "The acquisition service requested a short pause. Existing downloads are unchanged.",
    title: "Release search is cooling down",
  },
  signed_out: {
    detail: "Your session ended before the workbench could complete this operation.",
    title: "Sign in to continue",
  },
  unavailable: {
    detail: "The gateway could not confirm the operation. No automatic second mutation was sent.",
    title: "Operational signal is unavailable",
  },
};

const DECISION_COPY: Record<ManualReleaseCandidate["decision"], { label: string; rank: number }> = {
  approved: { label: "Approved", rank: 0 },
  temporarily_rejected: { label: "Held", rank: 1 },
  rejected: { label: "Rejected", rank: 2 },
};

function formatBytes(bytes: number) {
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatAge(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1_440)}d`;
}

function formatExpiry(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function candidateOrder(left: ManualReleaseCandidate, right: ManualReleaseCandidate) {
  const decision = DECISION_COPY[left.decision].rank - DECISION_COPY[right.decision].rank;
  if (decision !== 0) return decision;
  if (left.customFormatScore !== right.customFormatScore) {
    return right.customFormatScore - left.customFormatScore;
  }
  return (right.seeders ?? -1) - (left.seeders ?? -1);
}

function releaseLabel(release: ManualReleaseCandidate) {
  const peers =
    release.protocol === "torrent"
      ? `${release.seeders ?? 0} seeders, ${release.leechers ?? 0} leechers`
      : release.protocol;
  return `${release.title}, ${release.quality}, ${formatBytes(release.sizeBytes)}, ${release.indexer}, ${DECISION_COPY[release.decision].label}, ${peers}`;
}

function WorkbenchSkeleton() {
  return (
    <div
      aria-label="Searching manual releases"
      className="manual-workbench__skeleton"
      role="status"
    >
      <div className="manual-workbench__skeleton-list">
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index}>
            <i />
            <b />
            <b />
            <b />
          </span>
        ))}
      </div>
      <div className="manual-workbench__skeleton-inspector">
        <i />
        <b />
        <b />
        <b />
      </div>
      <span className="sr-only">Comparing verified releases from configured indexers.</span>
    </div>
  );
}

function CandidateList({
  releases,
  selectedId,
  onSelect,
}: {
  onSelect: (releaseId: string) => void;
  releases: ManualReleaseCandidate[];
  selectedId: string;
}) {
  return (
    <fieldset className="manual-workbench__release-fieldset">
      <legend className="sr-only">Choose a release to inspect</legend>
      <div aria-hidden="true" className="manual-workbench__column-headings">
        <span>Release signal</span>
        <span>Quality</span>
        <span>Score</span>
        <span>Peers</span>
        <span>Size</span>
      </div>
      <div className="manual-workbench__release-list">
        {releases.map((release) => (
          <label
            className="manual-release-row"
            data-decision={release.decision}
            data-selected={release.id === selectedId || undefined}
            key={release.id}
          >
            <input
              checked={release.id === selectedId}
              disabled={!release.downloadAllowed}
              name="manual-release"
              onChange={() => onSelect(release.id)}
              type="radio"
              value={release.id}
            />
            <span className="sr-only">{releaseLabel(release)}</span>
            <span aria-hidden="true" className="manual-release-row__selector">
              <i />
            </span>
            <span className="manual-release-row__identity">
              <strong>{release.title}</strong>
              <small>
                {release.indexer} · {formatAge(release.ageMinutes)} old
              </small>
            </span>
            <span className="manual-release-row__quality">
              <strong>{release.quality}</strong>
              <small>{release.protocol}</small>
            </span>
            <span className="manual-release-row__score">
              {release.customFormatScore > 0 ? "+" : ""}
              {release.customFormatScore}
            </span>
            <span className="manual-release-row__peers">
              {release.protocol === "torrent" ? (
                <>
                  <strong>{release.seeders ?? "—"}</strong>
                  <small>/{release.leechers ?? "—"}</small>
                </>
              ) : (
                <strong>—</strong>
              )}
            </span>
            <span className="manual-release-row__size">{formatBytes(release.sizeBytes)}</span>
            <span className="manual-release-row__decision">
              {DECISION_COPY[release.decision].label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CandidateInspector({
  onReview,
  release,
}: {
  onReview: () => void;
  release: ManualReleaseCandidate;
}) {
  return (
    <aside className="manual-inspector" aria-label="Selected release details">
      <div className="manual-inspector__signal" data-decision={release.decision}>
        <span aria-hidden="true">
          {release.decision === "approved" ? <BadgeCheck /> : <ShieldAlert />}
        </span>
        <div>
          <small>Decision signal</small>
          <strong>{DECISION_COPY[release.decision].label}</strong>
        </div>
      </div>

      <div className="manual-inspector__title">
        <span>{release.quality}</span>
        <h3>{release.title}</h3>
        <p>
          {release.releaseGroup ? `${release.releaseGroup} · ` : ""}
          {release.indexer}
        </p>
      </div>

      <dl className="manual-inspector__metrics">
        <div>
          <dt>
            <Gauge aria-hidden="true" /> Custom score
          </dt>
          <dd>
            {release.customFormatScore > 0 ? "+" : ""}
            {release.customFormatScore}
          </dd>
        </div>
        <div>
          <dt>
            <Database aria-hidden="true" /> Size
          </dt>
          <dd>{formatBytes(release.sizeBytes)}</dd>
        </div>
        <div>
          <dt>
            <UsersRound aria-hidden="true" /> Seed / leech
          </dt>
          <dd>
            {release.seeders ?? "—"} / {release.leechers ?? "—"}
          </dd>
        </div>
        <div>
          <dt>
            <Clock3 aria-hidden="true" /> Published
          </dt>
          <dd>{formatAge(release.ageMinutes)} ago</dd>
        </div>
      </dl>

      <section className="manual-inspector__formats" aria-labelledby="manual-format-heading">
        <span id="manual-format-heading">
          <Languages aria-hidden="true" /> Release profile
        </span>
        <ul>
          {release.languages.map((language) => (
            <li key={language}>{language}</li>
          ))}
          {release.customFormats.map((format) => (
            <li key={format}>{format}</li>
          ))}
          {release.fullSeason ? <li>Full season</li> : null}
        </ul>
      </section>

      {release.rejectionReasons.length > 0 ? (
        <section className="manual-inspector__rejections" aria-labelledby="rejection-heading">
          <span id="rejection-heading">
            <TriangleAlert aria-hidden="true" /> Rejection evidence
          </span>
          <ul>
            {release.rejectionReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="manual-inspector__verified">
          <Check aria-hidden="true" /> No rejection evidence was reported.
        </p>
      )}

      <button
        className="manual-inspector__review"
        disabled={!release.downloadAllowed}
        onClick={onReview}
        type="button"
      >
        <ArrowDownToLine aria-hidden="true" />
        {release.downloadAllowed ? "Review grab" : "Download unavailable"}
      </button>
    </aside>
  );
}

function ConfirmationPanel({
  confirmed,
  onCancel,
  onConfirmedChange,
  onSubmit,
  release,
  state,
}: {
  confirmed: boolean;
  onCancel: () => void;
  onConfirmedChange: (confirmed: boolean) => void;
  onSubmit: () => void;
  release: ManualReleaseCandidate;
  state: GrabState;
}) {
  const requiresOverride = release.requiresOverride;
  const submitting = state.kind === "submitting";

  if (state.kind === "success") {
    return (
      <section aria-live="polite" className="manual-confirmation" data-state="success">
        <span aria-hidden="true" className="manual-confirmation__icon">
          <Check />
        </span>
        <small>{state.replayed ? "Verified receipt" : "Release accepted"}</small>
        <h3>Grab handed to {release.protocol === "usenet" ? "Usenet" : "the download client"}</h3>
        <p>
          Operation {state.operationId.slice(-8)} is recorded. Progress will appear in acquisition
          provenance when the service reports it.
        </p>
        <button onClick={onCancel} type="button">
          Done
        </button>
      </section>
    );
  }

  return (
    <section
      aria-live={state.kind === "error" ? "assertive" : "polite"}
      className="manual-confirmation"
      data-state={state.kind}
    >
      <span aria-hidden="true" className="manual-confirmation__icon">
        {state.kind === "error" ? (
          <ShieldAlert />
        ) : submitting ? (
          <RefreshCw />
        ) : requiresOverride ? (
          <TriangleAlert />
        ) : (
          <LockKeyhole />
        )}
      </span>
      <small>
        {state.kind === "error"
          ? "Grab not confirmed"
          : submitting
            ? "Idempotent handoff"
            : requiresOverride
              ? "Explicit override"
              : "Exact-release confirmation"}
      </small>
      <h3>
        {state.kind === "error"
          ? ERROR_COPY[state.errorKind].title
          : submitting
            ? "Confirming one upstream mutation"
            : `Grab ${release.quality} from ${release.indexer}?`}
      </h3>
      <p>
        {state.kind === "error"
          ? ERROR_COPY[state.errorKind].detail
          : submitting
            ? "The same secure request identifier will be retained until a definitive receipt is returned."
            : requiresOverride
              ? "This release conflicts with the configured quality policy. Omnifin will record the override in the audit trail."
              : "This sends only the selected opaque release reference. Existing downloads and library files remain untouched."}
      </p>

      {requiresOverride && state.kind === "idle" ? (
        <label className="manual-confirmation__override">
          <input
            checked={confirmed}
            onChange={(event) => onConfirmedChange(event.currentTarget.checked)}
            type="checkbox"
          />
          <span aria-hidden="true">
            <Check />
          </span>
          <strong>I reviewed the rejection evidence and authorize this override.</strong>
        </label>
      ) : null}

      <div className="manual-confirmation__release">
        <span>{release.quality}</span>
        <strong>{release.title}</strong>
        <small>
          {formatBytes(release.sizeBytes)} · {release.protocol}
        </small>
      </div>

      <div className="manual-confirmation__actions">
        <button disabled={submitting} onClick={onCancel} type="button">
          {state.kind === "error" ? "Back to results" : "Cancel"}
        </button>
        <button
          disabled={submitting || (requiresOverride && !confirmed)}
          onClick={onSubmit}
          type="button"
        >
          {submitting ? <RefreshCw aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
          {state.kind === "error" ? "Retry receipt" : submitting ? "Confirming" : "Send release"}
        </button>
      </div>
    </section>
  );
}

export function ManualReleaseWorkbench({
  client = manualReleaseClient,
  onOpenChange,
  open,
  operation,
}: ManualReleaseWorkbenchProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const idempotencyKeyReference = useRef<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [attempt, setAttempt] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [grabState, setGrabState] = useState<GrabState>({ kind: "idle" });
  const [reviewing, setReviewing] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [state, setState] = useState<WorkbenchState>({ kind: "idle" });
  const operationId = operation?.id;

  useEffect(() => {
    const dialog = dialogReference.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !operation) return;
    const controller = new AbortController();
    let current = true;
    void Promise.all([
      client.search(operation.target, controller.signal),
      client.loadEligibility(controller.signal),
    ])
      .then(([data, eligibility]) => {
        if (!current) return;
        if (eligibility.status !== "ready") {
          setState({
            errorKind:
              eligibility.status === "signed_out"
                ? "signed_out"
                : eligibility.status === "forbidden"
                  ? "forbidden"
                  : "unavailable",
            kind: "error",
            operationId: operation.id,
          });
          return;
        }
        const ordered = data.releases.toSorted(candidateOrder);
        const firstAvailable = ordered.find((release) => release.downloadAllowed) ?? ordered[0];
        setSelectedId(firstAvailable?.id ?? "");
        setState({
          data: { ...data, releases: ordered },
          eligibility: eligibility.snapshot,
          kind: "ready",
          operationId: operation.id,
        });
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setState({
          errorKind: error instanceof ManualReleaseClientError ? error.kind : "unavailable",
          kind: "error",
          operationId: operation.id,
        });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [attempt, client, open, operation]);

  const visibleState: WorkbenchState =
    operationId && "operationId" in state && state.operationId === operationId
      ? state
      : { kind: "idle" };
  const selected =
    visibleState.kind === "ready"
      ? (visibleState.data.releases.find((release) => release.id === selectedId) ?? null)
      : null;
  const busy = grabState.kind === "submitting";

  if (!operation) return null;

  const close = () => {
    if (busy) return;
    setState({ kind: "idle" });
    setReviewing(false);
    setConfirmed(false);
    setGrabState({ kind: "idle" });
    idempotencyKeyReference.current = null;
    onOpenChange(false);
  };
  const submit = () => {
    if (!selected || visibleState.kind !== "ready" || busy) return;
    void (async () => {
      setGrabState({ kind: "submitting" });
      try {
        idempotencyKeyReference.current ??= createManualReleaseGrabIdempotencyKey();
        const result = await client.grab(
          {
            overrideRejections: selected.requiresOverride && confirmed,
            releaseId: selected.id,
          },
          {
            csrfToken: visibleState.eligibility.csrfToken,
            idempotencyKey: idempotencyKeyReference.current,
          },
        );
        idempotencyKeyReference.current = null;
        setGrabState({
          kind: "success",
          operationId: result.grab.operationId,
          replayed: result.replayed,
        });
      } catch (error) {
        const errorKind = error instanceof ManualReleaseClientError ? error.kind : "unavailable";
        if (errorKind === "conflict") idempotencyKeyReference.current = null;
        setGrabState({ errorKind, kind: "error" });
      }
    })();
  };

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="manual-workbench"
      data-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        if (open && !busy) onOpenChange(false);
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
      ref={dialogReference}
    >
      <div className="manual-workbench__glass" data-liquid-glass>
        <header className="manual-workbench__header">
          <div>
            <span className="manual-workbench__eyebrow">
              <Radio aria-hidden="true" /> Manual release workbench
            </span>
            <h2 id={titleId}>Release spectrum</h2>
            <p id={descriptionId}>
              Compare verified {operation.target.service === "radarr" ? "Radarr" : "Sonarr"}{" "}
              candidates for {operation.title}.
            </p>
          </div>
          <div className="manual-workbench__header-actions">
            {visibleState.kind === "ready" ? (
              <span
                title={`Opaque references expire at ${formatExpiry(visibleState.data.expiresAt)}`}
              >
                <Clock3 aria-hidden="true" /> Expires {formatExpiry(visibleState.data.expiresAt)}
              </span>
            ) : null}
            <button
              aria-label="Close manual release workbench"
              disabled={busy}
              onClick={close}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="manual-workbench__body">
          {visibleState.kind === "idle" || visibleState.kind === "loading" ? (
            <WorkbenchSkeleton />
          ) : visibleState.kind === "error" ? (
            <section className="manual-workbench__error" role="status">
              <span aria-hidden="true">
                <ShieldAlert />
              </span>
              <small>Signal interrupted</small>
              <h3>{ERROR_COPY[visibleState.errorKind].title}</h3>
              <p>{ERROR_COPY[visibleState.errorKind].detail}</p>
              {visibleState.errorKind === "signed_out" ? (
                <a href="/login">Sign in</a>
              ) : visibleState.errorKind === "forbidden" ? null : (
                <button
                  onClick={() => {
                    setState({ kind: "loading", operationId: operation.id });
                    setAttempt((value) => value + 1);
                  }}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" /> Search again
                </button>
              )}
            </section>
          ) : visibleState.data.releases.length === 0 ? (
            <section className="manual-workbench__error" role="status">
              <span aria-hidden="true">
                <Search />
              </span>
              <small>Search complete</small>
              <h3>No releases matched this target</h3>
              <p>Try again after indexers refresh or adjust the upstream quality profile.</p>
              <button
                onClick={() => {
                  setState({ kind: "loading", operationId: operation.id });
                  setAttempt((value) => value + 1);
                }}
                type="button"
              >
                <RefreshCw aria-hidden="true" /> Search again
              </button>
            </section>
          ) : (
            <>
              <section className="manual-workbench__results" aria-label="Manual release results">
                <div className="manual-workbench__result-heading">
                  <div>
                    <span>Verified release signal</span>
                    <strong>{visibleState.data.releases.length} candidates</strong>
                  </div>
                  <p>
                    Ranked by decision, custom-format score, then peer health. Raw GUIDs remain in
                    the gateway.
                  </p>
                </div>
                <CandidateList
                  onSelect={(releaseId) => {
                    setSelectedId(releaseId);
                    setReviewing(false);
                    setConfirmed(false);
                    setGrabState({ kind: "idle" });
                    idempotencyKeyReference.current = null;
                  }}
                  releases={visibleState.data.releases}
                  selectedId={selectedId}
                />
              </section>
              {selected ? (
                reviewing ? (
                  <ConfirmationPanel
                    confirmed={confirmed}
                    onCancel={() => {
                      if (grabState.kind === "success") close();
                      else {
                        setReviewing(false);
                        setGrabState({ kind: "idle" });
                      }
                    }}
                    onConfirmedChange={setConfirmed}
                    onSubmit={submit}
                    release={selected}
                    state={grabState}
                  />
                ) : (
                  <CandidateInspector onReview={() => setReviewing(true)} release={selected} />
                )
              ) : null}
            </>
          )}
        </div>

        <footer className="manual-workbench__footer">
          <span>
            <LockKeyhole aria-hidden="true" /> Opaque references · local authorization
          </span>
          <span>
            <Radio aria-hidden="true" /> No automatic grab retries
          </span>
        </footer>
      </div>
    </dialog>
  );
}
