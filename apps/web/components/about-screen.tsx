import type { RuntimeIdentity } from "@omnifin/contracts/runtime";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Fingerprint,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

import "@fontsource-variable/manrope/wght.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-500.css";
import type { DisplayProfile } from "../lib/dashboard-data";
import type { RuntimeIdentityLoadOutcome } from "../lib/runtime-identity";
import { AppearanceSelector } from "./appearance-selector";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { RuntimeIdentityActions } from "./runtime-identity-actions";
import "./about-screen.css";

function channelLabel(identity: RuntimeIdentity) {
  if (identity.channel === "stable") return "Stable release";
  if (identity.channel === "edge") return "Protected edge";
  return "Development build";
}

function VerificationBadge({ identity }: { identity: RuntimeIdentity }) {
  const verified = identity.verification === "verified";
  return (
    <span className="about-passport__verification" data-verified={verified || undefined}>
      {verified ? (
        <CheckCircle2 aria-hidden="true" size={18} />
      ) : (
        <CircleAlert aria-hidden="true" size={18} />
      )}
      {verified ? "Release verified" : "Not release-verified"}
    </span>
  );
}

function IdentityPassport({ identity }: { identity: RuntimeIdentity }) {
  const verified = identity.verification === "verified";
  return (
    <article className="about-passport" data-liquid-glass data-verified={verified || undefined}>
      <div className="about-passport__flare" aria-hidden="true" />
      <header className="about-passport__header">
        <div>
          <p className="section-kicker">Build passport</p>
          <p className="about-passport__channel">{channelLabel(identity)}</p>
        </div>
        <VerificationBadge identity={identity} />
      </header>
      <div className="about-passport__version-block">
        <span aria-hidden="true" className="about-passport__monogram">
          O
        </span>
        <p className="about-passport__version" aria-label={`Version ${identity.version}`}>
          {identity.version}
        </p>
        <p>
          {verified
            ? "This running image is bound to an immutable source revision."
            : "This local build is intentionally marked as unverified development software."}
        </p>
      </div>
      <dl className="about-passport__facts">
        <div>
          <dt>Channel</dt>
          <dd>{identity.channel}</dd>
        </div>
        <div>
          <dt>License</dt>
          <dd>{identity.license}</dd>
        </div>
        <div className="about-passport__revision">
          <dt>Revision</dt>
          <dd>{identity.revision ?? "Local development"}</dd>
        </div>
        <div>
          <dt>Identity schema</dt>
          <dd>v{identity.schemaVersion}</dd>
        </div>
      </dl>
      <div className="about-passport__footer">
        <RuntimeIdentityActions identity={identity} />
        <a
          className="about-passport__source"
          href={identity.sourceUrl}
          rel="noreferrer"
          target="_blank"
        >
          {verified ? "View corresponding source" : "View project source"}
          <ArrowUpRight aria-hidden="true" size={17} />
        </a>
      </div>
    </article>
  );
}

function UnavailablePassport() {
  return (
    <article className="about-passport about-passport--unavailable" data-liquid-glass>
      <div className="about-passport__unavailable" role="status">
        <span aria-hidden="true">
          <Fingerprint size={29} strokeWidth={1.45} />
        </span>
        <p className="section-kicker">Local verification</p>
        <h2>Build identity is unavailable.</h2>
        <p>
          The local gateway did not provide a valid runtime identity. Omnifin will not guess a
          version, revision, or source location.
        </p>
        <Link className="about-passport__retry" href="/about">
          <RefreshCw aria-hidden="true" size={17} />
          Try again
        </Link>
      </div>
    </article>
  );
}

function AboutNavigation() {
  return (
    <nav aria-label="About navigation" className="about-topbar">
      <Link aria-label="Omnifin home" className="about-topbar__brand" href="/">
        <BrandMark />
      </Link>
      <Link className="about-topbar__back" href="/">
        <ArrowLeft aria-hidden="true" size={17} />
        Open Omnifin
      </Link>
    </nav>
  );
}

function AboutHero() {
  return (
    <header className="about-hero">
      <div className="about-hero__seal" aria-hidden="true">
        <ShieldCheck size={24} strokeWidth={1.45} />
      </div>
      <p className="eyebrow">Local software identity</p>
      <h1>Know exactly what is running.</h1>
      <p>
        Version, provenance, and license information comes directly from this Omnifin
        installation—without telemetry or a request to an external service.
      </p>
    </header>
  );
}

function AboutFooter() {
  return (
    <footer className="about-footer">
      <span>AGPL-3.0-only</span>
      <span aria-hidden="true">·</span>
      <span>No telemetry</span>
      <span aria-hidden="true">·</span>
      <span>Identity supplied by your local gateway</span>
    </footer>
  );
}

export function AboutScreenSkeleton({
  displayProfile = "standard",
}: {
  displayProfile?: DisplayProfile;
}) {
  return (
    <div className="about-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main aria-busy="true" className="about-shell" id="main-content" tabIndex={-1}>
        <AboutNavigation />
        <AboutHero />
        <div className="sr-only" role="status">
          Loading local build identity…
        </div>
        <div aria-hidden="true" className="about-grid">
          <article className="about-passport about-passport--skeleton" data-liquid-glass>
            <div className="about-passport__header">
              <span className="about-skeleton-line about-skeleton-line--heading" />
              <span className="about-skeleton-line about-skeleton-line--badge" />
            </div>
            <div className="about-passport__version-block">
              <span className="about-skeleton-line about-skeleton-line--version" />
              <span className="about-skeleton-line about-skeleton-line--copy" />
            </div>
            <div className="about-passport__facts about-passport__facts--skeleton">
              {[0, 1, 2, 3].map((index) => (
                <div key={index}>
                  <span className="about-skeleton-line about-skeleton-line--label" />
                  <span className="about-skeleton-line about-skeleton-line--fact" />
                </div>
              ))}
            </div>
            <div className="about-passport__footer">
              <span className="about-skeleton-line about-skeleton-line--action" />
              <span className="about-skeleton-line about-skeleton-line--action" />
            </div>
          </article>
          <aside className="about-sidebar">
            {[0, 1].map((index) => (
              <section className="about-integrity about-integrity--skeleton" key={index}>
                <span className="about-skeleton-line about-skeleton-line--label" />
                <span className="about-skeleton-line about-skeleton-line--sidebar-title" />
                <span className="about-skeleton-line about-skeleton-line--copy" />
                <span className="about-skeleton-line about-skeleton-line--copy" />
                <span className="about-skeleton-line about-skeleton-line--copy" />
              </section>
            ))}
          </aside>
        </div>
        <AboutFooter />
      </main>
    </div>
  );
}

export function AboutScreen({
  displayProfile = "standard",
  outcome,
}: {
  displayProfile?: DisplayProfile;
  outcome: RuntimeIdentityLoadOutcome;
}) {
  return (
    <div className="about-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="about-shell" id="main-content" tabIndex={-1}>
        <AboutNavigation />
        <AboutHero />
        <div className="about-grid">
          {outcome.status === "ready" ? (
            <IdentityPassport identity={outcome.identity} />
          ) : (
            <UnavailablePassport />
          )}
          <aside className="about-sidebar" aria-label="Trust and appearance">
            <section className="about-integrity">
              <p className="section-kicker">What this proves</p>
              <h2>Transparent by construction.</h2>
              <p>
                Stable and edge images start only when their embedded revision matches the exact
                corresponding-source address shown here.
              </p>
              <ul>
                <li>No installation identifiers</li>
                <li>No connector or account details</li>
                <li>No external verification request</li>
              </ul>
            </section>
            <AppearanceSelector compact />
          </aside>
        </div>
        <AboutFooter />
      </main>
    </div>
  );
}
