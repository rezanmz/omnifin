"use client";

import "./acquisition-timeline.css";

import type {
  AcquisitionMonitoringState,
  AcquisitionEvent,
  AcquisitionProvenanceResponse,
} from "@omnifin/contracts/acquisition";
import {
  ArrowUp,
  Check,
  CircleAlert,
  Clock3,
  Download,
  HardDriveDownload,
  History,
  PackageCheck,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  AcquisitionMonitoringPanel,
  type AcquisitionMonitoringPanelState,
} from "./acquisition-monitoring-panel";
import {
  AcquisitionMonitoringClientError,
  acquisitionMonitoringClient,
  type AcquisitionMonitoringClient,
  type AcquisitionMonitoringClientErrorKind,
} from "../lib/acquisition-monitoring";

import {
  AcquisitionRecoveryClientError,
  acquisitionRecoveryClient,
  createAcquisitionSearchIdempotencyKey,
  type AcquisitionRecoveryClient,
  type AcquisitionRecoveryClientErrorKind,
} from "../lib/acquisition-recovery";
import {
  AcquisitionProvenanceClientError,
  acquisitionProvenanceClient,
  watchAcquisitionProvenanceEvents,
  type AcquisitionProvenanceClient,
  type AcquisitionProvenanceClientErrorKind,
  type AcquisitionProvenanceStreamStatus,
} from "../lib/acquisition-provenance";
import type { OperationModel } from "../lib/dashboard-data";

type TimelineState =
  | { kind: "idle" }
  | { kind: "loading"; operationId: string }
  | { data: AcquisitionProvenanceResponse; kind: "ready"; operationId: string }
  | {
      errorKind: AcquisitionProvenanceClientErrorKind;
      kind: "error";
      operationId: string;
    };

export interface AcquisitionTimelineProperties {
  client?: AcquisitionProvenanceClient;
  monitoringClient?: AcquisitionMonitoringClient;
  onManualSearch?: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  operation: OperationModel | null;
  recoveryClient?: AcquisitionRecoveryClient;
  watchEvents?: typeof watchAcquisitionProvenanceEvents;
}

type RecoveryState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "submitting" }
  | { kind: "success"; operationId: string; replayed: boolean }
  | { errorKind: AcquisitionRecoveryClientErrorKind; kind: "error" };

interface MonitoringSnapshot {
  operationId: string;
  state: AcquisitionMonitoringPanelState;
}

interface MonitoringPreparationSnapshot {
  operationId: string;
  status: "error" | "ready";
}

interface ConnectionSnapshot {
  operationId: string;
  status: AcquisitionProvenanceStreamStatus;
}

const FALLBACK_POLL_INTERVAL_MS = 15_000;

const EVENT_COPY: Record<AcquisitionEvent["kind"], { label: string; icon: typeof Search }> = {
  download_failed: { icon: CircleAlert, label: "Download failed" },
  downloading: { icon: Download, label: "Downloading" },
  grabbed: { icon: HardDriveDownload, label: "Release grabbed" },
  ignored: { icon: ShieldAlert, label: "Release ignored" },
  imported: { icon: PackageCheck, label: "Imported" },
  queued: { icon: Clock3, label: "Queued" },
  search_completed: { icon: Check, label: "Search completed" },
  search_queued: { icon: Clock3, label: "Search queued" },
  search_started: { icon: Search, label: "Search started" },
  stalled: { icon: TriangleAlert, label: "Needs attention" },
  upgraded: { icon: ArrowUp, label: "Quality upgraded" },
};

const ERROR_COPY: Record<
  AcquisitionProvenanceClientErrorKind,
  { action: string | null; detail: string; title: string }
> = {
  forbidden: {
    action: null,
    detail: "Your current role can see media, but operational provenance requires operator access.",
    title: "Operator access required",
  },
  invalid_response: {
    action: "Try again",
    detail: "The upstream response failed the public contract, so no raw service data was shown.",
    title: "Signal could not be verified",
  },
  not_configured: {
    action: null,
    detail:
      "An administrator needs to validate and enable one matching Radarr or Sonarr connection.",
    title: "Acquisition history is not connected",
  },
  rate_limited: {
    action: "Try again",
    detail: "The acquisition service asked for a short pause. The active queue remains unchanged.",
    title: "History is cooling down",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before operational history could be loaded.",
    title: "Sign in to inspect provenance",
  },
  unavailable: {
    action: "Try again",
    detail:
      "The gateway or acquisition service is temporarily unreachable. No upstream action was attempted.",
    title: "Operational signal is offline",
  },
};

function formatBytes(bytes: number | null) {
  if (bytes === null) return null;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function TimelineSkeleton() {
  return (
    <div
      aria-label="Loading acquisition history"
      className="acquisition-timeline__skeleton"
      role="status"
    >
      <div className="acquisition-timeline__skeleton-stats">
        <span />
        <span />
        <span />
      </div>
      {Array.from({ length: 5 }, (_, index) => (
        <div className="acquisition-timeline__skeleton-row" key={index}>
          <i />
          <span>
            <b />
            <b />
          </span>
        </div>
      ))}
      <span className="sr-only">Loading title-level acquisition events.</span>
    </div>
  );
}

function TimelineEvent({ event }: { event: AcquisitionEvent }) {
  const presentation = EVENT_COPY[event.kind];
  const Icon = presentation.icon;
  const releaseDetails = [
    event.release.quality,
    event.release.indexer,
    event.release.downloadClient,
    formatBytes(event.release.sizeBytes),
  ].filter((value): value is string => Boolean(value));

  return (
    <li className="acquisition-event" data-state={event.state}>
      <span className="acquisition-event__marker" aria-hidden="true">
        <Icon />
      </span>
      <article>
        <div className="acquisition-event__heading">
          <div>
            <span>{presentation.label}</span>
            <strong>{event.release.title ?? event.summary}</strong>
          </div>
          <time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time>
        </div>
        {event.release.title !== null && <p>{event.summary}</p>}
        {releaseDetails.length > 0 && (
          <ul aria-label="Release details" className="acquisition-event__details">
            {releaseDetails.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
            {event.release.protocol !== "unknown" && <li>{event.release.protocol}</li>}
          </ul>
        )}
      </article>
    </li>
  );
}

function TimelineReady({
  data,
  monitoring,
  recovery,
}: {
  data: AcquisitionProvenanceResponse;
  monitoring: ReactNode;
  recovery: ReactNode;
}) {
  const active = data.events.filter((event) => event.state === "active").length;
  const attention = data.events.filter(
    (event) => event.state === "warning" || event.state === "failure",
  ).length;
  const sources = new Set(
    data.events.flatMap((event) =>
      [event.release.indexer, event.release.downloadClient].filter((source): source is string =>
        Boolean(source),
      ),
    ),
  ).size;

  return (
    <>
      <div className="acquisition-timeline__stats" aria-label="Acquisition summary">
        <div>
          <span>Events</span>
          <strong>{data.events.length.toString().padStart(2, "0")}</strong>
        </div>
        <div>
          <span>In motion</span>
          <strong>{active.toString().padStart(2, "0")}</strong>
        </div>
        <div data-attention={attention > 0 || undefined}>
          <span>{attention > 0 ? "Attention" : "Sources"}</span>
          <strong>{(attention > 0 ? attention : sources).toString().padStart(2, "0")}</strong>
        </div>
      </div>

      {data.state === "degraded" && (
        <div className="acquisition-timeline__degraded" role="status">
          <TriangleAlert aria-hidden="true" />
          <span>
            <strong>Partial history</strong>
            One acquisition source is temporarily unavailable. Verified events remain visible.
          </span>
        </div>
      )}

      {data.events.length === 0 ? (
        <section className="acquisition-timeline__empty" role="status">
          <span aria-hidden="true">
            <History />
          </span>
          <h3>No acquisition events yet</h3>
          <p>Searches, grabs, downloads, imports, and upgrades will form a trace here.</p>
        </section>
      ) : (
        <ol className="acquisition-timeline__events">
          {data.events.map((event) => (
            <TimelineEvent event={event} key={event.id} />
          ))}
        </ol>
      )}
      {monitoring}
      {recovery}
      <div className="acquisition-timeline__footer">
        <span>
          <Radio aria-hidden="true" /> Verified operational signal
        </span>
        <time dateTime={data.generatedAt}>Refreshed {formatTimestamp(data.generatedAt)}</time>
      </div>
    </>
  );
}

function RecoveryPanel({
  onConfirm,
  onManualSearch,
  onNewAttempt,
  onStart,
  state,
  targetLabel,
}: {
  onConfirm: () => void;
  onManualSearch?: () => void;
  onNewAttempt: () => void;
  onStart: () => void;
  state: RecoveryState;
  targetLabel: string;
}) {
  if (state.kind === "idle") {
    return (
      <section className="acquisition-recovery">
        <span aria-hidden="true" className="acquisition-recovery__icon">
          <RefreshCw />
        </span>
        <div>
          <small>Contextual recovery</small>
          <strong>Search this target again</strong>
          <p>Queue a new automatic search without changing files or monitoring settings.</p>
        </div>
        <span className="acquisition-recovery__actions">
          {onManualSearch ? (
            <button
              className="acquisition-recovery__secondary"
              onClick={onManualSearch}
              type="button"
            >
              Browse releases
            </button>
          ) : null}
          <button onClick={onStart} type="button">
            Review search
          </button>
        </span>
      </section>
    );
  }
  if (state.kind === "confirming") {
    return (
      <section className="acquisition-recovery" data-state="confirming">
        <span aria-hidden="true" className="acquisition-recovery__icon">
          <ShieldCheck />
        </span>
        <div>
          <small>Exact-target confirmation</small>
          <strong>Queue {targetLabel}?</strong>
          <p>This starts discovery only. Existing downloads and library files remain untouched.</p>
        </div>
        <span className="acquisition-recovery__actions">
          <button className="acquisition-recovery__secondary" onClick={onStart} type="button">
            Cancel
          </button>
          <button onClick={onConfirm} type="button">
            Queue search
          </button>
        </span>
      </section>
    );
  }
  if (state.kind === "submitting") {
    return (
      <section aria-live="polite" className="acquisition-recovery" data-state="submitting">
        <span aria-hidden="true" className="acquisition-recovery__icon">
          <RefreshCw />
        </span>
        <div>
          <small>Submitting securely</small>
          <strong>Reserving one search</strong>
          <p>The target is idempotency-protected while the service confirms the command.</p>
        </div>
      </section>
    );
  }
  if (state.kind === "success") {
    return (
      <section aria-live="polite" className="acquisition-recovery" data-state="success">
        <span aria-hidden="true" className="acquisition-recovery__icon">
          <Check />
        </span>
        <div>
          <small>{state.replayed ? "Verified receipt" : "Search queued"}</small>
          <strong>Acquisition search is in motion</strong>
          <p>
            Command {state.operationId.split(":").at(-1)} was accepted. New evidence will appear
            here.
          </p>
        </div>
        <button onClick={onNewAttempt} type="button">
          Done
        </button>
      </section>
    );
  }
  const signedOut = state.errorKind === "signed_out";
  const forbidden = state.errorKind === "forbidden";
  return (
    <section aria-live="polite" className="acquisition-recovery" data-state="error">
      <span aria-hidden="true" className="acquisition-recovery__icon">
        <ShieldAlert />
      </span>
      <div>
        <small>Search not queued</small>
        <strong>
          {signedOut
            ? "Sign in to continue"
            : forbidden
              ? "Operator access required"
              : "Verify history before another attempt"}
        </strong>
        <p>
          {signedOut || forbidden
            ? "No upstream action was attempted."
            : "The outcome was not confirmed. Review the timeline before creating a fresh search."}
        </p>
      </div>
      {signedOut ? (
        <a href="/login">Sign in</a>
      ) : forbidden ? null : (
        <button onClick={onNewAttempt} type="button">
          New attempt
        </button>
      )}
    </section>
  );
}

export function AcquisitionTimeline({
  client = acquisitionProvenanceClient,
  monitoringClient = acquisitionMonitoringClient,
  onManualSearch,
  onOpenChange,
  open,
  operation,
  recoveryClient = acquisitionRecoveryClient,
  watchEvents = watchAcquisitionProvenanceEvents,
}: AcquisitionTimelineProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [attempt, setAttempt] = useState(0);
  const [monitoringAttempt, setMonitoringAttempt] = useState(0);
  const idempotencyKeyReference = useRef<string | null>(null);
  const operationIdReference = useRef(operation?.id);
  const [recoveryState, setRecoveryState] = useState<RecoveryState>({ kind: "idle" });
  const [monitoringSnapshot, setMonitoringSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [monitoringPreparation, setMonitoringPreparation] =
    useState<MonitoringPreparationSnapshot | null>(null);
  const [connectionSnapshot, setConnectionSnapshot] = useState<ConnectionSnapshot | null>(null);
  const [state, setState] = useState<TimelineState>({ kind: "idle" });

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
    let current = true;
    let fallbackActive = false;
    let hasData = operation.provenance !== undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let readController: AbortController | undefined;
    let refresh: Promise<void> | undefined;
    const operationId = operation.id;

    const loadSnapshot = () => {
      if (refresh) return refresh;
      readController = new AbortController();
      refresh = client
        .read(operation.target, readController.signal)
        .then((data) => {
          if (!current) return;
          hasData = true;
          setState({ data, kind: "ready", operationId });
        })
        .catch((error: unknown) => {
          if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
          if (!hasData) {
            setState({
              errorKind:
                error instanceof AcquisitionProvenanceClientError ? error.kind : "unavailable",
              kind: "error",
              operationId,
            });
          }
        })
        .finally(() => {
          refresh = undefined;
        });
      return refresh;
    };

    const schedulePoll = () => {
      if (!current || !fallbackActive) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        if (!current || !fallbackActive) return;
        if (document.visibilityState === "hidden") {
          schedulePoll();
          return;
        }
        void loadSnapshot().finally(schedulePoll);
      }, FALLBACK_POLL_INTERVAL_MS);
    };

    const beginFallback = () => {
      if (fallbackActive) return;
      fallbackActive = true;
      if (hasData) schedulePoll();
      else void loadSnapshot().finally(schedulePoll);
    };

    const stopWatching = watchEvents(operation.target, {
      onSnapshot: (event) => {
        if (!current) return;
        hasData = true;
        readController?.abort();
        setState({ data: event.provenance, kind: "ready", operationId });
      },
      onStatus: (status) => {
        if (!current) return;
        setConnectionSnapshot({ operationId, status });
        if (status === "fallback") beginFallback();
        if (status === "live") {
          fallbackActive = false;
          if (pollTimer) clearTimeout(pollTimer);
        }
      },
    });

    if (!operation.provenance) void loadSnapshot();
    return () => {
      current = false;
      fallbackActive = false;
      if (pollTimer) clearTimeout(pollTimer);
      readController?.abort();
      stopWatching();
    };
  }, [attempt, client, open, operation, watchEvents]);

  useEffect(() => {
    if (!open || !operation || (!monitoringClient.prepare && !recoveryClient.prepare)) return;
    let current = true;
    const operationId = operation.id;
    void Promise.all([
      Promise.resolve().then(() => monitoringClient.prepare?.()),
      Promise.resolve().then(() => recoveryClient.prepare?.()),
    ]).then(
      () => {
        if (current) setMonitoringPreparation({ operationId, status: "ready" });
      },
      () => {
        if (current) setMonitoringPreparation({ operationId, status: "error" });
      },
    );
    return () => {
      current = false;
    };
  }, [monitoringAttempt, monitoringClient, open, operation, recoveryClient]);

  useEffect(() => {
    if (!open || !operation) return;
    if (operation.monitoring) return;
    const controller = new AbortController();
    let current = true;
    void monitoringClient
      .read(
        { mediaId: operation.target.mediaId, service: operation.target.service },
        controller.signal,
      )
      .then((data) => {
        if (current) {
          setMonitoringSnapshot({
            operationId: operation.id,
            state: { data, kind: "ready" },
          });
        }
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setMonitoringSnapshot({
          operationId: operation.id,
          state: {
            errorKind:
              error instanceof AcquisitionMonitoringClientError ? error.kind : "unavailable",
            kind: "error",
          },
        });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [monitoringAttempt, monitoringClient, open, operation]);

  useEffect(() => {
    if (operationIdReference.current === operation?.id) return;
    operationIdReference.current = operation?.id;
    idempotencyKeyReference.current = null;
    setRecoveryState({ kind: "idle" });
  }, [operation?.id]);

  if (!operation) return null;
  const service = operation.target.service === "radarr" ? "Radarr" : "Sonarr";
  const targetLabel =
    operation.target.service === "sonarr" && operation.target.seasonNumber !== undefined
      ? `${operation.title} season ${operation.target.seasonNumber}`
      : operation.title;
  const visibleState: TimelineState =
    "operationId" in state && state.operationId === operation.id
      ? state
      : operation.provenance
        ? { data: operation.provenance, kind: "ready", operationId: operation.id }
        : { kind: "idle" };
  const connectionStatus =
    connectionSnapshot?.operationId === operation.id
      ? connectionSnapshot.status
      : ("connecting" as const);
  const connectionLabel =
    connectionStatus === "live"
      ? "Live"
      : connectionStatus === "fallback"
        ? "Refreshing"
        : "Connecting";
  const visibleMonitoringState: AcquisitionMonitoringPanelState =
    (monitoringClient.prepare || recoveryClient.prepare) &&
    monitoringPreparation?.operationId !== operation.id
      ? { kind: "loading" }
      : monitoringPreparation?.operationId === operation.id &&
          monitoringPreparation.status === "error"
        ? { errorKind: "unavailable", kind: "error" }
        : monitoringSnapshot?.operationId === operation.id
          ? monitoringSnapshot.state
          : operation.monitoring
            ? { data: operation.monitoring, kind: "ready" }
            : { kind: "loading" };

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="acquisition-timeline"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        if (open) onOpenChange(false);
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onOpenChange(false);
      }}
      ref={dialogReference}
    >
      <div className="acquisition-timeline__glass">
        <header className="acquisition-timeline__header">
          <div>
            <span className="acquisition-timeline__eyebrow">
              <Radio aria-hidden="true" /> Acquisition provenance
            </span>
            <h2 id={titleId}>Signal history</h2>
          </div>
          <button
            aria-label="Close acquisition history"
            className="acquisition-timeline__close"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div
          aria-label="Acquisition event history"
          className="acquisition-timeline__body"
          role="region"
          tabIndex={0}
        >
          <section className="acquisition-timeline__title" aria-label="Selected acquisition">
            <span aria-hidden="true" className="acquisition-timeline__title-mark">
              {operation.title.slice(0, 1)}
            </span>
            <div>
              <span>{service} · title-level trace</span>
              <h3>{operation.title}</h3>
              <p id={descriptionId}>
                Every verified handoff from release discovery through library import.
              </p>
            </div>
            <span
              aria-atomic="true"
              aria-label={`Acquisition updates: ${connectionLabel}`}
              aria-live="polite"
              className="acquisition-timeline__connection"
              data-state={connectionStatus}
            >
              <span aria-hidden="true" /> {connectionLabel}
            </span>
          </section>

          {visibleState.kind === "idle" || visibleState.kind === "loading" ? (
            <TimelineSkeleton />
          ) : visibleState.kind === "error" ? (
            <section className="acquisition-timeline__error" role="status">
              <span aria-hidden="true">
                <ShieldAlert />
              </span>
              <small>Signal interrupted</small>
              <h3>{ERROR_COPY[visibleState.errorKind].title}</h3>
              <p>{ERROR_COPY[visibleState.errorKind].detail}</p>
              {visibleState.errorKind === "signed_out" ? (
                <a href="/login">Sign in</a>
              ) : ERROR_COPY[visibleState.errorKind].action ? (
                <button
                  onClick={() => {
                    setState({ kind: "loading", operationId: operation.id });
                    setAttempt((value) => value + 1);
                  }}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" /> {ERROR_COPY[visibleState.errorKind].action}
                </button>
              ) : null}
            </section>
          ) : (
            <TimelineReady
              data={visibleState.data}
              monitoring={
                <AcquisitionMonitoringPanel
                  onBegin={() => {
                    if (visibleMonitoringState.kind !== "ready") return;
                    setMonitoringSnapshot({
                      operationId: operation.id,
                      state: { data: visibleMonitoringState.data, kind: "confirming" },
                    });
                  }}
                  onCancel={() => {
                    if (visibleMonitoringState.kind !== "confirming") return;
                    setMonitoringSnapshot({
                      operationId: operation.id,
                      state: { data: visibleMonitoringState.data, kind: "ready" },
                    });
                  }}
                  onConfirm={() => {
                    void (async () => {
                      if (visibleMonitoringState.kind !== "confirming") return;
                      const currentState: AcquisitionMonitoringState = visibleMonitoringState.data;
                      setMonitoringSnapshot({
                        operationId: operation.id,
                        state: { data: currentState, kind: "submitting" },
                      });
                      const eligibility = await recoveryClient.loadEligibility();
                      if (eligibility.status !== "ready") {
                        const errorKind: AcquisitionMonitoringClientErrorKind =
                          eligibility.status === "signed_out"
                            ? "signed_out"
                            : eligibility.status === "forbidden"
                              ? "forbidden"
                              : "unavailable";
                        setMonitoringSnapshot({
                          operationId: operation.id,
                          state: { errorKind, kind: "error" },
                        });
                        return;
                      }
                      try {
                        const updated = await monitoringClient.update(
                          {
                            expectedMonitored: currentState.monitored,
                            mediaId: currentState.target.mediaId,
                            monitored: !currentState.monitored,
                            service: currentState.target.service,
                          },
                          { csrfToken: eligibility.snapshot.csrfToken },
                        );
                        setMonitoringSnapshot({
                          operationId: operation.id,
                          state: {
                            data: updated,
                            kind: "ready",
                            statusMessage: `Monitoring ${updated.monitored ? "enabled" : "paused"} for ${operation.title}.`,
                          },
                        });
                      } catch (error) {
                        setMonitoringSnapshot({
                          operationId: operation.id,
                          state: {
                            errorKind:
                              error instanceof AcquisitionMonitoringClientError
                                ? error.kind
                                : "unavailable",
                            kind: "error",
                          },
                        });
                      }
                    })();
                  }}
                  onRetry={() => {
                    setMonitoringPreparation(null);
                    setMonitoringSnapshot(null);
                    setMonitoringAttempt((value) => value + 1);
                  }}
                  state={visibleMonitoringState}
                  title={operation.title}
                />
              }
              recovery={
                <RecoveryPanel
                  onConfirm={() => {
                    void (async () => {
                      setRecoveryState({ kind: "submitting" });
                      const eligibility = await recoveryClient.loadEligibility();
                      if (eligibility.status !== "ready") {
                        setRecoveryState({
                          errorKind:
                            eligibility.status === "signed_out"
                              ? "signed_out"
                              : eligibility.status === "forbidden"
                                ? "forbidden"
                                : "unavailable",
                          kind: "error",
                        });
                        return;
                      }
                      try {
                        idempotencyKeyReference.current ??= createAcquisitionSearchIdempotencyKey();
                        const result = await recoveryClient.queueSearch(operation.target, {
                          csrfToken: eligibility.snapshot.csrfToken,
                          idempotencyKey: idempotencyKeyReference.current,
                        });
                        idempotencyKeyReference.current = null;
                        setRecoveryState({
                          kind: "success",
                          operationId: result.search.operationId,
                          replayed: result.replayed,
                        });
                      } catch (error) {
                        setRecoveryState({
                          errorKind:
                            error instanceof AcquisitionRecoveryClientError
                              ? error.kind
                              : "unavailable",
                          kind: "error",
                        });
                      }
                    })();
                  }}
                  {...(onManualSearch ? { onManualSearch } : {})}
                  onNewAttempt={() => {
                    idempotencyKeyReference.current = null;
                    setRecoveryState({ kind: "idle" });
                  }}
                  onStart={() =>
                    setRecoveryState((current) =>
                      current.kind === "confirming" ? { kind: "idle" } : { kind: "confirming" },
                    )
                  }
                  state={recoveryState}
                  targetLabel={targetLabel}
                />
              }
            />
          )}
        </div>
      </div>
    </dialog>
  );
}
