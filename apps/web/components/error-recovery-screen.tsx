"use client";

import { useEffect, useId, useRef } from "react";

import "../app/not-found.css";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import "./error-recovery-screen.css";

export interface ErrorRecoveryScreenProperties {
  fatal?: boolean;
  onRetry: () => void;
}

function AlertGlyph() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="24"
    >
      <path d="M10.3 3.7 2.4 17.4A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.6L13.7 3.7a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function RetryGlyph() {
  return (
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
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function HomeGlyph() {
  return (
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
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
    </svg>
  );
}

export function ErrorRecoveryScreen({ fatal = false, onRetry }: ErrorRecoveryScreenProperties) {
  const mainReference = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    mainReference.current?.focus();
  }, []);

  const title = fatal ? "Omnifin needs a clean restart." : "This view lost its signal.";
  const description = fatal
    ? "The application shell could not finish loading. Try the view again, or return home. Check service activity before repeating an interrupted action."
    : "Omnifin stopped this view before it could finish rendering. Try it again, or return home. Check service activity before repeating an interrupted action.";

  return (
    <div className="utility-layout" data-display-profile="standard">
      <CinematicBackdrop />
      <main
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="utility-card error-recovery-card"
        id="main-content"
        ref={mainReference}
        tabIndex={-1}
      >
        <BrandMark />
        <div aria-atomic="true" role="alert">
          <span className="utility-card__icon error-recovery-card__icon" aria-hidden="true">
            <AlertGlyph />
          </span>
          <p className="eyebrow">{fatal ? "Application recovery" : "View interrupted"}</p>
          <h1 id={titleId}>{title}</h1>
          <p id={descriptionId}>{description}</p>
        </div>
        <div className="error-recovery-card__actions">
          <button className="button button--primary" onClick={onRetry} type="button">
            <RetryGlyph /> Try again
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- A document navigation replaces the failed React tree. */}
          <a className="button button--glass" href="/">
            <HomeGlyph /> Return home
          </a>
        </div>
      </main>
    </div>
  );
}
