import type { ServiceStatus } from "../lib/dashboard-data";
import { ShellIcon, type ShellIconName } from "./shell-icon";

const statusCopy: Record<ServiceStatus, string> = {
  attention: "One service needs attention",
  healthy: "All connected services are healthy",
  offline: "Connected services are offline",
};

export function ConnectionPulse({ status }: { status: ServiceStatus }) {
  const icon: ShellIconName =
    status === "healthy" ? "check" : status === "attention" ? "warning" : "cloud-off";
  return (
    <a
      href="/operations/health"
      className="connection-pulse"
      data-status={status}
      data-directional-item
      data-shell-link
      aria-label={statusCopy[status]}
    >
      <ShellIcon aria-hidden="true" name={icon} size={17} strokeWidth={1.8} />
      <span className="connection-pulse__label">
        {status === "healthy" ? "Systems quiet" : "Review systems"}
      </span>
      <span className="connection-pulse__dot" aria-hidden="true" />
    </a>
  );
}
