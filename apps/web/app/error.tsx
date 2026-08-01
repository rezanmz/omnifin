"use client";

import { ErrorRecoveryBoundary } from "../components/error-recovery-boundary";

interface RouteErrorProperties {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RouteError({ reset }: RouteErrorProperties) {
  return <ErrorRecoveryBoundary onRetry={reset} />;
}
