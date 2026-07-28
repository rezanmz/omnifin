"use client";

import type {
  AcquisitionCalendarAvailability,
  AcquisitionCalendarEvent,
} from "@omnifin/contracts/calendar";
import { Eye, Film, Tv, X } from "lucide-react";
import { useEffect, useRef } from "react";

import styles from "./acquisition-calendar-event-detail.module.css";

const AVAILABILITY_LABELS: Record<AcquisitionCalendarAvailability, string> = {
  available: "Available",
  missing: "Missing",
  monitored: "Monitored",
  queued: "Queued",
  unknown: "Untracked",
};

function formatEventTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatRuntime(minutes: number | null) {
  if (minutes === null) return "Runtime unavailable";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours === 0
    ? `${remainder} min`
    : remainder === 0
      ? `${hours} hr`
      : `${hours}h ${remainder}m`;
}

export function AcquisitionCalendarEventDetail({
  event,
  onClose,
}: {
  event: AcquisitionCalendarEvent;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const dismissWithKeyboard = (interaction: KeyboardEvent) => {
      if (interaction.key !== "Escape") return;
      interaction.preventDefault();
      onClose();
    };
    if (typeof element.showModal === "function") {
      if (!element.open) element.showModal();
    } else {
      element.setAttribute("open", "");
    }
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("keydown", dismissWithKeyboard);
      if (element.open && typeof element.close === "function") element.close();
    };
  }, [event.id, onClose]);

  const releaseLabel =
    event.kind === "episode"
      ? "Episode premiere"
      : event.releaseKind === "cinema"
        ? "Cinema release"
        : event.releaseKind === "physical"
          ? "Physical release"
          : event.releaseKind === "digital"
            ? "Digital release"
            : "Scheduled release";

  return (
    <dialog
      aria-describedby="calendar-event-description"
      aria-labelledby="calendar-event-title"
      aria-modal="true"
      className={styles.drawer}
      onCancel={(interaction) => {
        interaction.preventDefault();
        onClose();
      }}
      onClick={(interaction) => {
        if (interaction.target === interaction.currentTarget) onClose();
      }}
      ref={dialog}
    >
      <div className={styles.drawerGlass} data-liquid-glass>
        <header className={styles.drawerHeader}>
          <div>
            <p>{releaseLabel}</p>
            <span data-availability={event.availability}>
              <i aria-hidden="true" /> {AVAILABILITY_LABELS[event.availability]}
            </span>
          </div>
          <button aria-label="Close event details" autoFocus onClick={onClose} type="button">
            <X aria-hidden="true" size={19} />
          </button>
        </header>
        <div className={styles.drawerTitle}>
          <span aria-hidden="true">{event.kind === "movie" ? <Film /> : <Tv />}</span>
          <div>
            <p>{event.subtitle}</p>
            <h2 id="calendar-event-title">{event.title}</h2>
            <small>{event.year ?? "Year unavailable"}</small>
          </div>
        </div>
        <p className={styles.drawerOverview} id="calendar-event-description">
          {event.overview ?? "No synopsis is available for this scheduled arrival."}
        </p>
        <dl className={styles.drawerFacts}>
          <div>
            <dt>Arrival</dt>
            <dd>
              <time dateTime={event.eventAt}>{formatEventTime(event.eventAt)}</time>
            </dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatRuntime(event.runtimeMinutes)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{event.sourceName}</dd>
          </div>
          <div>
            <dt>Monitoring</dt>
            <dd>{event.monitored ? "Enabled" : "Not monitored"}</dd>
          </div>
        </dl>
        <div className={styles.drawerBoundary}>
          <Eye aria-hidden="true" size={18} />
          <p>
            <strong>Read-only calendar signal</strong>
            <span>
              Paths, service credentials, and upstream media identifiers remain in the gateway.
            </span>
          </p>
        </div>
      </div>
    </dialog>
  );
}
