"use client";

import type {
  StackVerificationCheck,
  StackVerificationFindingCode,
  StackVerificationResponse,
} from "@omnifin/contracts/setup";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Download,
  FileJson2,
  FlaskConical,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  downloadStackVerification,
  runStackVerification,
  type StackVerificationOutcome,
} from "../lib/stack-verification";

const CHECK_LABELS: Readonly<Record<StackVerificationCheck["id"], string>> = Object.freeze({
  bazarr: "Bazarr",
  jellyfin: "Jellyfin",
  oidc: "OpenID Connect",
  prowlarr: "Prowlarr",
  qbittorrent: "qBittorrent",
  radarr: "Radarr",
  sabnzbd: "SABnzbd",
  seerr: "Seerr",
  sonarr: "Sonarr",
});

const FINDING_LABELS: Readonly<Record<StackVerificationFindingCode, string>> = Object.freeze({
  configuration_invalid: "Configuration rejected",
  destination_blocked: "Destination blocked",
  disabled: "Disabled locally",
  invalid_credentials: "Credentials rejected",
  rate_limited: "Upstream rate limited",
  response_invalid: "Unexpected response",
  timeout: "Timed out",
  unreachable: "Could not connect",
  unsupported_version: "Version unsupported",
  upstream_error: "Upstream error",
  verification_unavailable: "Check unavailable",
  version_redacted: "Version omitted for privacy",
});

const STATE_LABELS: Readonly<Record<StackVerificationCheck["state"], string>> = Object.freeze({
  attention: "Needs attention",
  not_configured: "Not configured",
  partial: "Partially ready",
  ready: "Verified",
});

interface StackVerificationPanelProperties {
  downloadReport?: (report: StackVerificationResponse) => void;
  initialOutcome?: StackVerificationOutcome;
  runVerification?: (signal?: AbortSignal) => Promise<StackVerificationOutcome>;
}

type PanelState =
  { kind: "idle" } | { kind: "running" } | { kind: "resolved"; outcome: StackVerificationOutcome };

function reportHeading(report: StackVerificationResponse) {
  if (report.state === "ready") return "Every configured service answered cleanly.";
  if (report.state === "partial") return "Most of the stack answered. One edge needs attention.";
  if (report.state === "attention") return "Configured services need attention.";
  return "There is no stack to verify yet.";
}

function reportDescription(report: StackVerificationResponse) {
  if (report.state === "ready") {
    return "Fresh identity and connector checks passed through the same guarded paths Omnifin uses in production.";
  }
  if (report.state === "not_configured") {
    return "Add an identity provider or media connector, validate it, then return for a complete flight check.";
  }
  return "Healthy services remain visible while each unavailable, disabled, or rejected edge is called out separately.";
}

function formattedGeneratedAt(generatedAt: string) {
  return generatedAt.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
}

function CheckCard({ check }: { check: StackVerificationCheck }) {
  const configured = check.configuredCount > 0;
  const ready = check.state === "ready";
  const unconfigured = check.state === "not_configured";
  const versions = check.versions.slice(0, 3);
  return (
    <li className="stack-verification-check" data-state={check.state}>
      <div className="stack-verification-check__topline">
        <span className="stack-verification-check__mark" aria-hidden="true">
          {ready ? (
            <CheckCircle2 size={18} />
          ) : unconfigured ? (
            <CircleDashed size={18} />
          ) : (
            <CircleAlert size={18} />
          )}
        </span>
        <span className="stack-verification-check__state">{STATE_LABELS[check.state]}</span>
      </div>
      <strong>{CHECK_LABELS[check.id]}</strong>
      <p>
        {configured
          ? `${check.readyCount} of ${check.configuredCount} configured ${check.configuredCount === 1 ? "connection" : "connections"} ready`
          : "No connection configured"}
      </p>
      {versions.length > 0 ? (
        <span className="stack-verification-check__version">
          {versions.join(", ")}
          {check.versions.length > versions.length
            ? ` +${check.versions.length - versions.length}`
            : ""}
        </span>
      ) : check.capabilities.length > 0 ? (
        <span className="stack-verification-check__version">
          {check.capabilities.length} verified capabilities
        </span>
      ) : null}
      {check.findings.length > 0 ? (
        <ul
          aria-label={`${CHECK_LABELS[check.id]} findings`}
          className="stack-verification-findings"
        >
          {check.findings.map((finding) => (
            <li key={finding.code}>
              {FINDING_LABELS[finding.code]}
              {finding.count > 1 ? ` ×${finding.count}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function VerificationBoundary({
  onRetry,
  status,
}: {
  onRetry: () => void;
  status: Exclude<StackVerificationOutcome["status"], "ready">;
}) {
  const signedOut = status === "signed_out";
  const forbidden = status === "forbidden";
  const inProgress = status === "in_progress";
  return (
    <div className="stack-verification-boundary" data-state={status}>
      <CircleAlert aria-hidden="true" size={21} />
      <div>
        <strong>
          {signedOut
            ? "Your administrative session ended."
            : forbidden
              ? "Full administrator access is required."
              : inProgress
                ? "A verification is already running."
                : "The stack could not be verified right now."}
        </strong>
        <p>
          {signedOut
            ? "Sign in again before starting a fresh service check."
            : forbidden
              ? "This diagnostic can reach every configured identity and media service, so partial roles cannot run it."
              : inProgress
                ? "Wait for the active run to finish, then refresh this report."
                : "Existing settings and upstream services were not changed. Restore the gateway connection and try again."}
        </p>
      </div>
      {signedOut ? (
        <Link className="button button--glass" href="/login">
          Sign in again
        </Link>
      ) : forbidden ? (
        <Link className="button button--glass" href="/settings">
          Review account access
        </Link>
      ) : (
        <button className="button button--glass" onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" size={17} /> Try again
        </button>
      )}
    </div>
  );
}

export function StackVerificationPanel({
  downloadReport = downloadStackVerification,
  initialOutcome,
  runVerification = (signal) => runStackVerification({ ...(signal ? { signal } : {}) }),
}: StackVerificationPanelProperties) {
  const [state, setState] = useState<PanelState>(
    initialOutcome ? { kind: "resolved", outcome: initialOutcome } : { kind: "idle" },
  );
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const run = useCallback(() => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState({ kind: "running" });
    void runVerification(nextController.signal)
      .then((outcome) => {
        if (!nextController.signal.aborted) setState({ kind: "resolved", outcome });
      })
      .catch((error: unknown) => {
        if (
          !nextController.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setState({ kind: "resolved", outcome: { status: "unavailable" } });
        }
      });
  }, [runVerification]);

  const report =
    state.kind === "resolved" && state.outcome.status === "ready"
      ? state.outcome.report
      : undefined;

  return (
    <section
      aria-labelledby="stack-verification-title"
      className="stack-verification"
      data-state={report?.state ?? state.kind}
    >
      <div className="stack-verification__heading">
        <span className="stack-verification__icon" aria-hidden="true">
          <FlaskConical size={24} strokeWidth={1.55} />
        </span>
        <div>
          <p className="section-kicker">Post-install flight check</p>
          <h2 id="stack-verification-title">
            {report ? reportHeading(report) : "Verify this home lab end to end."}
          </h2>
          <p>
            {report
              ? reportDescription(report)
              : "Run fresh, read-only upstream checks after installation, configuration changes, or upgrades. Each service is isolated so one failure cannot hide the rest."}
          </p>
        </div>
      </div>

      {state.kind === "idle" ? (
        <div className="stack-verification__idle">
          <div>
            <LockKeyhole aria-hidden="true" size={18} />
            <span>
              URLs, credentials, identities, media paths, and raw errors stay in the gateway.
            </span>
          </div>
          <button className="button button--primary" onClick={run} type="button">
            <ShieldCheck aria-hidden="true" size={17} /> Run stack verification
          </button>
        </div>
      ) : state.kind === "running" ? (
        <div
          aria-busy="true"
          aria-label="Verifying configured services"
          className="stack-verification__running"
          role="status"
        >
          <RefreshCw aria-hidden="true" className="setup-spin" size={22} />
          <div>
            <strong>Checking the private stack…</strong>
            <p>Slow or unavailable services remain isolated while the remaining checks continue.</p>
          </div>
        </div>
      ) : state.outcome.status !== "ready" ? (
        <VerificationBoundary onRetry={run} status={state.outcome.status} />
      ) : (
        <>
          <div aria-live="polite" className="stack-verification__summary">
            <span>
              <strong>{report!.readyCount}</strong>
              <small>ready</small>
            </span>
            <span>
              <strong>{report!.configuredCount}</strong>
              <small>configured</small>
            </span>
            <div>
              <FileJson2 aria-hidden="true" size={18} />
              <span>
                Privacy-safe snapshot
                <small>
                  <time dateTime={report!.generatedAt}>
                    {formattedGeneratedAt(report!.generatedAt)}
                  </time>
                </small>
              </span>
            </div>
          </div>
          <ul aria-label="Stack verification checks" className="stack-verification__checks">
            {report!.checks.map((check) => (
              <CheckCard check={check} key={check.id} />
            ))}
          </ul>
          <div className="stack-verification__actions">
            <button
              className="button button--primary"
              onClick={() => downloadReport(report!)}
              type="button"
            >
              <Download aria-hidden="true" size={17} /> Download safe JSON
            </button>
            <button className="button button--glass" onClick={run} type="button">
              <RefreshCw aria-hidden="true" size={17} /> Run again
            </button>
          </div>
        </>
      )}
      <p className="stack-verification__disclaimer">
        This local report is diagnostic evidence for your installation. It does not replace
        Omnifin’s protected public compatibility baseline.
      </p>
    </section>
  );
}
