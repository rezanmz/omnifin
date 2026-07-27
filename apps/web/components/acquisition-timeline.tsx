"use client";

import type {
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
  RotateCcw,
  Search,
  ShieldAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  AcquisitionProvenanceClientError,
  acquisitionProvenanceClient,
  type AcquisitionProvenanceClient,
  type AcquisitionProvenanceClientErrorKind,
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
  onOpenChange: (open: boolean) => void;
  open: boolean;
  operation: OperationModel | null;
}

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

function TimelineReady({ data }: { data: AcquisitionProvenanceResponse }) {
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
      <div className="acquisition-timeline__footer">
        <span>
          <Radio aria-hidden="true" /> Read-only operational signal
        </span>
        <time dateTime={data.generatedAt}>Refreshed {formatTimestamp(data.generatedAt)}</time>
      </div>
    </>
  );
}

export function AcquisitionTimeline({
  client = acquisitionProvenanceClient,
  onOpenChange,
  open,
  operation,
}: AcquisitionTimelineProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [attempt, setAttempt] = useState(0);
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
    if (operation.provenance) return;
    const controller = new AbortController();
    let current = true;
    void client
      .read(operation.target, controller.signal)
      .then((data) => {
        if (current) setState({ data, kind: "ready", operationId: operation.id });
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof DOMException && error.name === "AbortError")) return;
        setState({
          errorKind: error instanceof AcquisitionProvenanceClientError ? error.kind : "unavailable",
          kind: "error",
          operationId: operation.id,
        });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [attempt, client, open, operation]);

  if (!operation) return null;
  const service = operation.target.service === "radarr" ? "Radarr" : "Sonarr";
  const visibleState: TimelineState = operation.provenance
    ? { data: operation.provenance, kind: "ready", operationId: operation.id }
    : "operationId" in state && state.operationId === operation.id
      ? state
      : { kind: "idle" };

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
            <i>
              <span aria-hidden="true" /> Live
            </i>
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
            <TimelineReady data={visibleState.data} />
          )}
        </div>
      </div>
    </dialog>
  );
}
