"use client";

import { ErrorRecoveryBoundary } from "../components/error-recovery-boundary";
import "./foundation.css";

interface GlobalErrorProperties {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ reset }: GlobalErrorProperties) {
  return (
    <html data-theme-preference="system" lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <ErrorRecoveryBoundary fatal onRetry={reset} />
      </body>
    </html>
  );
}
