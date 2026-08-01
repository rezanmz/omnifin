"use client";

import type { ErrorRecoveryScreenProperties } from "./error-recovery-screen";
import "./error-recovery-boundary.css";

export function ErrorRecoveryBoundary({ fatal = false, onRetry }: ErrorRecoveryScreenProperties) {
  return (
    <div className="error-boundary-layout">
      <main
        aria-labelledby="error-boundary-title"
        className="error-boundary-card"
        id="main-content"
        ref={(node) => node?.focus()}
        tabIndex={-1}
      >
        <div aria-atomic="true" role="alert">
          <p>{fatal ? "Application recovery" : "View interrupted"}</p>
          <h1 id="error-boundary-title">
            {fatal ? "Omnifin needs a clean restart." : "This view lost its signal."}
          </h1>
          <p>
            Try the view again, or return home. Check service activity before repeating an
            interrupted action. Private error details remain hidden.
          </p>
        </div>
        <div className="error-boundary-actions">
          <button className="error-boundary-action" onClick={onRetry} type="button">
            Try again
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- A document navigation replaces the failed React tree. */}
          <a className="error-boundary-action" href="/">
            Return home
          </a>
        </div>
      </main>
    </div>
  );
}
