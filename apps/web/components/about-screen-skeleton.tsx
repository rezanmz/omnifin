/* eslint-disable @next/next/no-html-link-for-pages -- The loading boundary stays server-only so its response script nonce remains intact. */
import "@fontsource-variable/manrope/wght.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-500.css";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import "./about-screen.css";

export function AboutScreenSkeleton({
  displayProfile = "standard",
  embedded = false,
}: {
  displayProfile?: DisplayProfile;
  embedded?: boolean;
}) {
  const Shell = embedded ? "div" : "main";
  return (
    <div className="about-layout" data-display-profile={displayProfile}>
      {embedded ? null : <CinematicBackdrop />}
      <Shell
        aria-busy="true"
        className="about-shell"
        {...(embedded ? {} : { id: "main-content", tabIndex: -1 })}
      >
        <nav aria-label="About navigation" className="about-topbar">
          <a aria-label="Omnifin home" className="about-topbar__brand" href="/">
            <BrandMark />
          </a>
          <a className="about-topbar__back" href="/">
            <svg
              aria-hidden="true"
              fill="none"
              height="17"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="17"
            >
              <path d="m12 19-7-7 7-7M19 12H5" />
            </svg>
            Open Omnifin
          </a>
        </nav>
        <header className="about-hero">
          <div className="about-hero__seal" aria-hidden="true">
            <svg
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.45"
              viewBox="0 0 24 24"
              width="24"
            >
              <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </div>
          <p className="eyebrow">Local software identity</p>
          <h1>Know exactly what is running.</h1>
          <p>
            Version, provenance, and license information comes directly from this Omnifin
            installation—without telemetry or a request to an external service.
          </p>
        </header>
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
        <footer className="about-footer">
          <span>AGPL-3.0-only</span>
          <span aria-hidden="true">·</span>
          <span>No telemetry</span>
          <span aria-hidden="true">·</span>
          <span>Identity supplied by your local gateway</span>
        </footer>
      </Shell>
    </div>
  );
}
