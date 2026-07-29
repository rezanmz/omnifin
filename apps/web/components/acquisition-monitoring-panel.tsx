import type { AcquisitionMonitoringState } from "@omnifin/contracts/acquisition";
import {
  Check,
  Eye,
  EyeOff,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import type { AcquisitionMonitoringClientErrorKind } from "../lib/acquisition-monitoring";
import styles from "./acquisition-monitoring-panel.module.css";

export type AcquisitionMonitoringPanelState =
  | { kind: "loading" }
  | { data: AcquisitionMonitoringState; kind: "ready"; statusMessage?: string }
  | { data: AcquisitionMonitoringState; kind: "confirming" }
  | { data: AcquisitionMonitoringState; kind: "submitting" }
  | { errorKind: AcquisitionMonitoringClientErrorKind; kind: "error" };

const ERROR_COPY: Record<
  AcquisitionMonitoringClientErrorKind,
  { detail: string; retry: boolean; title: string }
> = {
  configuration: {
    detail: "An administrator needs to validate one matching Radarr or Sonarr connection.",
    retry: false,
    title: "Monitoring is not configured",
  },
  forbidden: {
    detail: "Your current role can inspect media, but monitoring changes require operator access.",
    retry: false,
    title: "Operator access required",
  },
  invalid_response: {
    detail: "The upstream state could not be verified, so no monitoring change was attempted.",
    retry: true,
    title: "State could not be verified",
  },
  rate_limited: {
    detail: "The acquisition service asked for a short pause. Its current state remains unchanged.",
    retry: true,
    title: "Monitoring is cooling down",
  },
  signed_out: {
    detail: "Your session ended before monitoring state could be verified.",
    retry: false,
    title: "Sign in to manage monitoring",
  },
  unavailable: {
    detail: "The gateway or acquisition service is temporarily unreachable.",
    retry: true,
    title: "Monitoring signal is offline",
  },
};

function formatVerifiedAt(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AcquisitionMonitoringPanel({
  onBegin,
  onCancel,
  onConfirm,
  onRetry,
  state,
  title,
}: {
  onBegin: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  state: AcquisitionMonitoringPanelState;
  title: string;
}) {
  if (state.kind === "loading") {
    return (
      <section aria-label="Loading monitoring state" className={styles.panel} role="status">
        <span aria-hidden="true" className={styles.skeletonIcon} />
        <span className={styles.skeletonCopy}>
          <i />
          <i />
          <i />
        </span>
        <span aria-hidden="true" className={styles.skeletonAction} />
        <span className="sr-only">Loading exact-target monitoring state.</span>
      </section>
    );
  }

  if (state.kind === "error") {
    const copy = ERROR_COPY[state.errorKind];
    return (
      <section aria-live="polite" className={styles.panel} data-state="error">
        <span aria-hidden="true" className={styles.icon}>
          <ShieldAlert />
        </span>
        <div className={styles.copy}>
          <small>Monitoring unavailable</small>
          <strong>{copy.title}</strong>
          <p>{copy.detail}</p>
        </div>
        {state.errorKind === "signed_out" ? (
          <a className={styles.action} href="/login">
            Sign in
          </a>
        ) : copy.retry ? (
          <button className={styles.action} onClick={onRetry} type="button">
            <RotateCcw aria-hidden="true" /> Retry
          </button>
        ) : null}
      </section>
    );
  }

  const monitored = state.data.monitored;
  const targetLabel = state.data.target.kind === "movie" ? "Whole movie" : "Whole series";

  if (state.kind === "confirming") {
    return (
      <section aria-live="polite" className={styles.panel} data-state="confirming">
        <span aria-hidden="true" className={styles.icon}>
          <ShieldCheck />
        </span>
        <div className={styles.copy}>
          <small>Confirm {targetLabel.toLowerCase()}</small>
          <strong>{monitored ? `Pause monitoring for ${title}?` : `Monitor ${title}?`}</strong>
          <p>
            {monitored
              ? "Existing files and downloads stay intact. Automatic missing and upgrade grabs will pause."
              : "The acquisition service may automatically grab missing or higher-quality releases."}
          </p>
        </div>
        <span className={styles.actions}>
          <button autoFocus className={styles.secondary} onClick={onCancel} type="button">
            Cancel
          </button>
          <button onClick={onConfirm} type="button">
            {monitored ? "Pause" : "Monitor"}
          </button>
        </span>
      </section>
    );
  }

  if (state.kind === "submitting") {
    return (
      <section aria-live="polite" className={styles.panel} data-state="submitting">
        <span aria-hidden="true" className={styles.icon}>
          <LoaderCircle />
        </span>
        <div className={styles.copy}>
          <small>Verifying exact target</small>
          <strong>{monitored ? "Pausing monitoring" : "Enabling monitoring"}</strong>
          <p>The current upstream state is being checked before the idempotent update.</p>
        </div>
        <span aria-hidden="true" className={styles.pendingPill}>
          Working
        </span>
      </section>
    );
  }

  const Icon = monitored ? Eye : EyeOff;
  return (
    <section
      aria-label={`Automatic monitoring for ${title}`}
      className={styles.panel}
      data-monitored={monitored || undefined}
      data-state="ready"
    >
      <span aria-hidden="true" className={styles.icon}>
        <Icon />
      </span>
      <div className={styles.copy}>
        <small>{targetLabel} · Automatic acquisition</small>
        <strong>{monitored ? "Watching for releases" : "Monitoring paused"}</strong>
        <p>
          {monitored
            ? `Verified ${formatVerifiedAt(state.data.verifiedAt)} · Missing and upgrade releases are eligible.`
            : `Verified ${formatVerifiedAt(state.data.verifiedAt)} · Existing files and queues are unchanged.`}
        </p>
        {state.statusMessage ? <span className="sr-only">{state.statusMessage}</span> : null}
      </div>
      <button
        aria-label={`${monitored ? "Pause" : "Enable"} monitoring for ${title}`}
        className={styles.action}
        onClick={onBegin}
        type="button"
      >
        {state.statusMessage ? <Check aria-hidden="true" /> : null}
        {monitored ? "Pause" : "Monitor"}
      </button>
    </section>
  );
}
