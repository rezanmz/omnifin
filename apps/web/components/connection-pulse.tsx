import { CircleAlert, CircleCheck, CloudOff } from "lucide-react";
import Link from "next/link";
import type { ServiceStatus } from "../lib/dashboard-data";

const statusCopy: Record<ServiceStatus, string> = {
  attention: "One service needs attention",
  healthy: "All connected services are healthy",
  offline: "Connected services are offline",
};

export function ConnectionPulse({ status }: { status: ServiceStatus }) {
  const Icon = status === "healthy" ? CircleCheck : status === "attention" ? CircleAlert : CloudOff;
  return (
    <Link
      href="/operations/health"
      className="connection-pulse"
      data-status={status}
      data-directional-item
      prefetch={false}
      aria-label={statusCopy[status]}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
      <span className="connection-pulse__label">
        {status === "healthy" ? "Systems quiet" : "Review systems"}
      </span>
      <span className="connection-pulse__dot" aria-hidden="true" />
    </Link>
  );
}
