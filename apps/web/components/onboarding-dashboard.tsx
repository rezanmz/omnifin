"use client";

import type { CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  CheckCircle2,
  CircleAlert,
  CloudOff,
  Database,
  Download,
  ExternalLink,
  KeyRound,
  ListChecks,
  LockKeyhole,
  Radar,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Subtitles,
  UserRoundCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import type { DeploymentReadinessOutcome } from "../lib/deployment-readiness";
import {
  loadSetupReadiness,
  type SetupReadinessModel,
  type SetupReadinessOutcome,
  type SetupReadinessStep,
  type SetupReadinessStepId,
  type SetupReadinessStepState,
} from "../lib/setup-readiness";
import { AppearanceSelector } from "./appearance-selector";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";

interface StepContent {
  action: string;
  attention: string;
  icon: LucideIcon;
  label: string;
  notConfigured: string;
  ready: string;
  readyAction: string;
  requirement: "Essential" | "Optional" | "Recommended";
  settingsHref: string;
  surfaceHref?: string;
}

type DeploymentCheckId = Extract<
  DeploymentReadinessOutcome,
  { status: "ready" }
>["readiness"]["checks"][number]["id"];

interface DeploymentCheckContent {
  attention: string;
  icon: LucideIcon;
  label: string;
  ready: string;
}

const DEPLOYMENT_GUIDE_URL =
  "https://github.com/rezanmz/omnifin/blob/main/docs/deployment.md#requirements-for-a-supported-deployment";

const DEPLOYMENT_CHECK_CONTENT: Readonly<Record<DeploymentCheckId, DeploymentCheckContent>> =
  Object.freeze({
    recovery: {
      attention: "Add a dedicated break-glass secret before relying on this installation.",
      icon: KeyRound,
      label: "Recovery access",
      ready: "A valid break-glass secret is configured; verify the recovery drill separately.",
    },
    runtime: {
      attention: "Run a tagged image with its production runtime before exposing the service.",
      icon: Box,
      label: "Production runtime",
      ready: "The gateway is running with production safeguards enabled.",
    },
    storage: {
      attention: "Move SQLite out of memory and onto the private data volume before keeping state.",
      icon: Database,
      label: "Persistent storage",
      ready:
        "SQLite is file-backed and its migration ledger is readable; verify the host volume and backups.",
    },
    transport: {
      attention: "Finish the canonical HTTPS origin and secure-session cookie boundary.",
      icon: LockKeyhole,
      label: "HTTPS sessions",
      ready: "The canonical origin and secure session-cookie policy agree on HTTPS.",
    },
  });

const STEP_CONTENT: Readonly<Record<SetupReadinessStepId, StepContent>> = Object.freeze({
  acquisition: {
    action: "Configure acquisition services",
    attention: "At least one configured Radarr or Sonarr connection needs attention.",
    icon: Workflow,
    label: "Movie & series automation",
    notConfigured: "Connect Radarr, Sonarr, or both for automatic acquisition workflows.",
    ready: "At least one healthy automation service is ready for exact-title operations.",
    readyAction: "Open acquisition calendar",
    requirement: "Optional",
    settingsHref: "/settings/connectors",
    surfaceHref: "/calendar",
  },
  discovery: {
    action: "Configure discovery",
    attention: "The Seerr connection needs validation or recovery before requests can flow.",
    icon: Radar,
    label: "Discovery & requests",
    notConfigured: "Connect Seerr to unlock live discovery, requests, and approvals.",
    ready: "Seerr is validated for discovery and identity-aware request workflows.",
    readyAction: "Open discovery",
    requirement: "Optional",
    settingsHref: "/settings/connectors",
    surfaceHref: "/",
  },
  downloads: {
    action: "Configure download clients",
    attention: "A configured download client needs validation or recovery.",
    icon: Download,
    label: "Download clients",
    notConfigured: "Connect qBittorrent, SABnzbd, or both for private queue controls.",
    ready: "At least one healthy download client is ready for exact-item controls.",
    readyAction: "Open download queue",
    requirement: "Optional",
    settingsHref: "/settings/connectors",
    surfaceHref: "/operations/downloads",
  },
  identity: {
    action: "Review media identity",
    attention: "The linked Jellyfin identity needs proof again before media access can resume.",
    icon: UserRoundCheck,
    label: "Jellyfin identity",
    notConfigured: "Link the administrator’s own Jellyfin account with fresh proof of control.",
    ready: "Your local administrator is paired to a verified Jellyfin identity.",
    readyAction: "Review account access",
    requirement: "Essential",
    settingsHref: "/settings",
  },
  indexers: {
    action: "Configure indexers",
    attention: "The Prowlarr connection needs validation or recovery.",
    icon: ListChecks,
    label: "Indexer intelligence",
    notConfigured: "Connect Prowlarr for provider health, failures, statistics, and safe tests.",
    ready: "Prowlarr is healthy and ready to surface indexer intelligence.",
    readyAction: "Open indexer intelligence",
    requirement: "Optional",
    settingsHref: "/settings/connectors",
    surfaceHref: "/operations/indexers",
  },
  jellyfin: {
    action: "Validate Jellyfin service",
    attention: "The Jellyfin service exists but is disabled, stale, or unhealthy.",
    icon: Server,
    label: "Jellyfin service",
    notConfigured: "Connect and validate Jellyfin before enabling the media control plane.",
    ready: "Jellyfin is enabled from a successful, configuration-bound health probe.",
    readyAction: "Review Jellyfin connection",
    requirement: "Essential",
    settingsHref: "/settings/connectors",
  },
  oidc: {
    action: "Configure OpenID Connect",
    attention: "An identity provider exists but still needs discovery validation or enablement.",
    icon: KeyRound,
    label: "OpenID Connect",
    notConfigured:
      "Add Authentik or another standards-based provider when centralized sign-in fits your home.",
    ready: "At least one validated OIDC provider is available alongside Jellyfin sign-in.",
    readyAction: "Review identity providers",
    requirement: "Recommended",
    settingsHref: "/settings/identity-providers",
  },
  subtitles: {
    action: "Configure subtitles",
    attention: "The Bazarr connection needs validation or recovery.",
    icon: Subtitles,
    label: "Subtitle operations",
    notConfigured: "Connect Bazarr to search and download subtitles from the library workspace.",
    ready: "Bazarr is healthy and ready for guarded subtitle operations.",
    readyAction: "Open library care",
    requirement: "Optional",
    settingsHref: "/settings/connectors",
    surfaceHref: "/library",
  },
});

const STATE_LABELS: Readonly<Record<SetupReadinessStepState, string>> = Object.freeze({
  attention: "Needs attention",
  not_configured: "Not connected",
  partial: "Partially ready",
  ready: "Ready",
});

function stepDescription(step: SetupReadinessStep) {
  const content = STEP_CONTENT[step.id];
  if (step.state === "ready") return content.ready;
  if (step.state === "partial") {
    return `${content.ready} ${step.configuredCount - step.readyCount} configured connection still needs attention.`;
  }
  if (step.state === "attention") return content.attention;
  return content.notConfigured;
}

function SetupStepCard({ step }: { step: SetupReadinessStep }) {
  const content = STEP_CONTENT[step.id];
  const complete = step.state === "ready" || step.state === "partial";
  const href = complete && content.surfaceHref ? content.surfaceHref : content.settingsHref;
  const action = complete ? content.readyAction : content.action;
  const Icon = content.icon;
  return (
    <article className="setup-step" data-state={step.state}>
      <div className="setup-step__topline">
        <span className="setup-step__icon" aria-hidden="true">
          <Icon size={20} strokeWidth={1.65} />
        </span>
        <span className="setup-step__requirement">{content.requirement}</span>
        <span className="setup-step__state">
          {complete ? <CheckCircle2 aria-hidden="true" size={15} /> : null}
          {STATE_LABELS[step.state]}
        </span>
      </div>
      <div className="setup-step__copy">
        <h3>{content.label}</h3>
        <p>{stepDescription(step)}</p>
      </div>
      <Link className="setup-step__action" data-directional-item href={href}>
        {action} <ArrowRight aria-hidden="true" size={15} />
      </Link>
    </article>
  );
}

function SetupLoading() {
  return (
    <section
      aria-busy="true"
      aria-label="Checking setup readiness"
      className="setup-loading"
      role="status"
    >
      <div className="setup-loading__hero">
        <span />
        <span />
        <span />
      </div>
      <div className="deployment-posture deployment-posture--loading" aria-hidden="true">
        <span />
        <span />
        <div>
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      </div>
      <div className="setup-loading__grid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <article
            className="setup-step setup-step--loading"
            data-testid="setup-step-skeleton"
            key={index}
          >
            <span />
            <span />
            <span />
          </article>
        ))}
      </div>
      <span className="sr-only">Checking private identity and service readiness…</span>
    </section>
  );
}

export function DeploymentReadinessPanel({
  onRetry,
  outcome,
}: {
  onRetry: () => void;
  outcome: Extract<DeploymentReadinessOutcome, { status: "ready" | "unavailable" }>;
}) {
  if (outcome.status === "unavailable") {
    return (
      <section
        aria-labelledby="deployment-posture-title"
        className="deployment-posture"
        data-state="unavailable"
      >
        <div className="deployment-posture__heading">
          <span className="deployment-posture__mark" aria-hidden="true">
            <CircleAlert size={23} strokeWidth={1.6} />
          </span>
          <div>
            <p className="section-kicker">Host flight check</p>
            <h2 id="deployment-posture-title">Deployment posture could not be verified.</h2>
            <p>
              Identity and connector readiness remain visible. Retry this private check before
              treating the host as production-ready.
            </p>
          </div>
        </div>
        <div className="deployment-posture__actions">
          <button
            className="button button--glass"
            data-directional-item
            onClick={onRetry}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={17} /> Check host again
          </button>
          <a
            className="deployment-posture__runbook"
            data-directional-item
            href={DEPLOYMENT_GUIDE_URL}
            rel="noreferrer"
            target="_blank"
          >
            Deployment runbook <span className="sr-only">(opens in a new tab)</span>
            <ExternalLink aria-hidden="true" size={15} />
          </a>
        </div>
      </section>
    );
  }

  const { readiness } = outcome;
  const ready = readiness.state === "ready";
  return (
    <section
      aria-labelledby="deployment-posture-title"
      className="deployment-posture"
      data-state={readiness.state}
    >
      <div className="deployment-posture__heading">
        <span className="deployment-posture__mark" aria-hidden="true">
          {ready ? (
            <ShieldCheck size={23} strokeWidth={1.6} />
          ) : (
            <ShieldAlert size={23} strokeWidth={1.6} />
          )}
        </span>
        <div>
          <p className="section-kicker">Host flight check</p>
          <h2 id="deployment-posture-title">
            {ready ? "Host prerequisites are configured." : "Finish the host hardening boundary."}
          </h2>
          <p>
            {ready
              ? "Runtime and transport checks pass; recovery and SQLite settings are configured. Complete the host verification in the runbook."
              : "This stack can stay useful while you finish the host checks below, but it should remain private."}
          </p>
        </div>
      </div>
      <div className="deployment-posture__summary">
        <strong>{readiness.readyCount}</strong>
        <span>of {readiness.total} host checks</span>
      </div>
      <div aria-label="Deployment readiness checks" className="deployment-checks" role="list">
        {readiness.checks.map((item) => {
          const content = DEPLOYMENT_CHECK_CONTENT[item.id];
          const Icon = content.icon;
          const checkReady = item.state === "ready";
          return (
            <article
              className="deployment-check"
              data-state={item.state}
              key={item.id}
              role="listitem"
            >
              <span className="deployment-check__icon" aria-hidden="true">
                <Icon size={19} strokeWidth={1.65} />
              </span>
              <div>
                <span className="deployment-check__label">
                  {content.label}
                  {checkReady ? (
                    <CheckCircle2 aria-hidden="true" size={15} />
                  ) : (
                    <CircleAlert aria-hidden="true" size={15} />
                  )}
                </span>
                <p>{checkReady ? content.ready : content.attention}</p>
              </div>
            </article>
          );
        })}
      </div>
      <a
        className="deployment-posture__runbook"
        data-directional-item
        href={DEPLOYMENT_GUIDE_URL}
        rel="noreferrer"
        target="_blank"
      >
        Review the deployment boundary <span className="sr-only">(opens in a new tab)</span>
        <ExternalLink aria-hidden="true" size={15} />
      </a>
    </section>
  );
}

function SetupBoundary({
  onRetry,
  status,
}: {
  onRetry: () => void;
  status: Exclude<SetupReadinessOutcome["status"], "ready">;
}) {
  const signedOut = status === "signed_out";
  const forbidden = status === "forbidden";
  const Icon = signedOut ? KeyRound : forbidden ? ShieldAlert : CloudOff;
  return (
    <section aria-labelledby="setup-boundary-title" className="setup-boundary">
      <span className="setup-boundary__icon" aria-hidden="true">
        <Icon size={28} strokeWidth={1.5} />
      </span>
      <div>
        <p className="eyebrow">Private setup guide</p>
        <h1 id="setup-boundary-title">
          {signedOut
            ? "Sign in to continue setup."
            : forbidden
              ? "Administrator access required."
              : "Setup status is temporarily unavailable."}
        </h1>
        <p>
          {signedOut
            ? "Your session ended before Omnifin could inspect browser-safe readiness signals."
            : forbidden
              ? "Your current role cannot inspect identity providers or service configuration."
              : "The gateway could not complete a safe readiness check. No settings were changed."}
        </p>
      </div>
      {signedOut ? (
        <Link className="button button--primary" href="/login">
          Continue to sign in <ArrowRight aria-hidden="true" size={17} />
        </Link>
      ) : forbidden ? (
        <Link className="button button--glass" href="/settings">
          Review account access <ArrowRight aria-hidden="true" size={17} />
        </Link>
      ) : (
        <button className="button button--glass" onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" size={17} /> Check again
        </button>
      )}
    </section>
  );
}

type ProgressStyle = CSSProperties & { "--setup-progress": string };

function SetupHero({ model }: { model: SetupReadinessModel }) {
  const progress = model.essentialCompleted / model.essentialTotal;
  const nextEssential = model.steps
    .slice(0, 2)
    .find(({ state }) => state !== "ready" && state !== "partial");
  const nextContent = nextEssential ? STEP_CONTENT[nextEssential.id] : null;
  return (
    <section className="setup-hero" data-core-ready={model.coreReady || undefined}>
      <div className="setup-hero__copy">
        <p className="eyebrow">Live homelab readiness</p>
        <h1 id="onboarding-title">
          {model.coreReady
            ? "Core is ready. Shape the rest around your stack."
            : "Two essentials stand between first sign-in and movie night."}
        </h1>
        <p>
          {model.coreReady
            ? "Identity and Jellyfin are verified. Add only the services you use; Omnifin keeps partial stacks useful and names every degraded edge."
            : "Finish the identity and Jellyfin checks first. Optional services stay optional, and every connection must be validated before Omnifin trusts it."}
        </p>
        <div className="setup-hero__actions">
          <Link
            className="button button--primary"
            data-directional-item
            href={nextContent?.settingsHref ?? "/"}
          >
            {nextContent?.action ?? "Enter the dashboard"}
            <ArrowRight aria-hidden="true" size={17} />
          </Link>
          <Link className="button button--glass" data-directional-item href="/settings/connectors">
            <Server aria-hidden="true" size={17} /> Service connections
          </Link>
        </div>
      </div>
      <div className="setup-hero__meter-wrap">
        <div
          aria-label="Essential setup progress"
          aria-valuemax={model.essentialTotal}
          aria-valuemin={0}
          aria-valuenow={model.essentialCompleted}
          className="setup-hero__meter"
          role="progressbar"
          style={{ "--setup-progress": `${progress * 360}deg` } as ProgressStyle}
        >
          <span className="setup-hero__meter-core">
            <strong>{model.essentialCompleted}</strong>
            <small>of {model.essentialTotal}</small>
          </span>
        </div>
        <p>{model.essentialCompleted} of 2 essentials ready</p>
        <span>
          <Sparkles aria-hidden="true" size={15} /> {model.optionalReady} of 6 stack extensions
          ready
        </span>
      </div>
    </section>
  );
}

function SetupReady({
  onRetry,
  outcome,
}: {
  onRetry: () => void;
  outcome: Extract<SetupReadinessOutcome, { status: "ready" }>;
}) {
  const model = outcome.readiness;
  const essential = model.steps.slice(0, 2);
  const optional = model.steps.slice(2);
  return (
    <>
      <SetupHero model={model} />
      <DeploymentReadinessPanel onRetry={onRetry} outcome={outcome.deployment} />
      <section aria-labelledby="setup-essential-title" className="setup-section">
        <div className="setup-section__heading">
          <div>
            <p className="section-kicker">Required foundation</p>
            <h2 id="setup-essential-title">Make the core trustworthy.</h2>
          </div>
          <span>
            {model.essentialCompleted}/{model.essentialTotal} ready
          </span>
        </div>
        <div className="setup-grid setup-grid--essential">
          {essential.map((step) => (
            <SetupStepCard key={step.id} step={step} />
          ))}
        </div>
      </section>
      <section aria-labelledby="setup-optional-title" className="setup-section">
        <div className="setup-section__heading">
          <div>
            <p className="section-kicker">Your stack, your shape</p>
            <h2 id="setup-optional-title">Connect only what earns its place.</h2>
          </div>
          <span>
            {model.optionalReady}/{model.optionalTotal} ready
          </span>
        </div>
        <div className="setup-grid">
          {optional.map((step) => (
            <SetupStepCard key={step.id} step={step} />
          ))}
        </div>
      </section>
      <aside className="setup-safety-note">
        <ShieldCheck aria-hidden="true" size={22} />
        <div>
          <strong>Readiness never exposes the machinery.</strong>
          <p>
            This screen uses normalized local status only. Secret values, connector addresses,
            external identifiers, database paths, and raw upstream responses remain hidden.
          </p>
        </div>
      </aside>
      <AppearanceSelector compact />
    </>
  );
}

export interface OnboardingDashboardProperties {
  displayProfile?: DisplayProfile;
  initialOutcome?: SetupReadinessOutcome;
  loadReadiness?: () => Promise<SetupReadinessOutcome>;
}

export function OnboardingDashboard({
  displayProfile = "standard",
  initialOutcome,
  loadReadiness = loadSetupReadiness,
}: OnboardingDashboardProperties) {
  const [outcome, setOutcome] = useState<SetupReadinessOutcome | null>(initialOutcome ?? null);
  const refresh = useCallback(() => setOutcome(null), []);

  useEffect(() => {
    if (outcome !== null) return;
    let active = true;
    void loadReadiness().then((next) => {
      if (active) setOutcome(next);
    });
    return () => {
      active = false;
    };
  }, [loadReadiness, outcome]);

  return (
    <div className="onboarding-layout" data-display-profile={displayProfile}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <header className="onboarding-masthead">
        <BrandMark />
        <div className="onboarding-masthead__actions">
          <span className="onboarding-masthead__status">
            {outcome?.status === "ready" ? (
              <ShieldCheck aria-hidden="true" size={16} />
            ) : outcome === null ? (
              <RefreshCw aria-hidden="true" className="setup-spin" size={16} />
            ) : (
              <CircleAlert aria-hidden="true" size={16} />
            )}
            {outcome?.status === "ready" ? "Private readiness" : "Setup guide"}
          </span>
          <Link className="onboarding-masthead__back" href="/">
            <ArrowLeft aria-hidden="true" size={16} /> Home
          </Link>
        </div>
      </header>
      <main className="onboarding" id="main-content" tabIndex={-1}>
        {outcome === null ? (
          <SetupLoading />
        ) : outcome.status === "ready" ? (
          <SetupReady onRetry={refresh} outcome={outcome} />
        ) : (
          <SetupBoundary onRetry={refresh} status={outcome.status} />
        )}
      </main>
    </div>
  );
}
