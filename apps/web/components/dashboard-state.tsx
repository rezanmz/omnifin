import {
  Ban,
  Clock3,
  LibraryBig,
  LockKeyhole,
  OctagonX,
  RefreshCw,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import Link from "next/link";

export type DashboardStateKind =
  | "empty"
  | "loading"
  | "offline"
  | "permission-denied"
  | "recoverable-error"
  | "stale"
  | "terminal-error"
  | "unsupported";

const stateCopy = {
  empty: {
    action: { href: "/settings", label: "Review library setup" },
    copy: "Once Jellyfin has playable media, discovery and watch progress will appear here.",
    eyebrow: "Nothing queued",
    icon: LibraryBig,
    severity: "neutral",
    title: "Your library is quiet.",
  },
  offline: {
    action: { href: "/", label: "Retry connection" },
    copy: "Omnifin cannot reach the gateway. Your media services and credentials remain untouched.",
    eyebrow: "Access interrupted",
    icon: Unplug,
    severity: "warning",
    title: "The control room is offline.",
  },
  "permission-denied": {
    action: { href: "/", label: "Return to discovery" },
    copy: "Your current role does not allow this view. Ask an administrator if you need operational access.",
    eyebrow: "Permission required",
    icon: LockKeyhole,
    severity: "warning",
    title: "This console is restricted.",
  },
  "recoverable-error": {
    action: { href: "/", label: "Try again" },
    copy: "A temporary response could not be completed. No upstream change was applied, so it is safe to retry.",
    eyebrow: "Request interrupted",
    icon: TriangleAlert,
    severity: "warning",
    title: "That signal did not resolve.",
  },
  stale: {
    action: { href: "/", label: "Refresh now" },
    copy: "Cached media is still available, but operational details may have changed since the gateway last responded.",
    eyebrow: "Last updated 12 minutes ago",
    icon: Clock3,
    severity: "info",
    title: "You are viewing an earlier signal.",
  },
  "terminal-error": {
    action: { href: "/settings", label: "Review configuration" },
    copy: "The gateway rejected this configuration. An administrator must correct the connector before this view can recover.",
    eyebrow: "Configuration blocked",
    icon: OctagonX,
    severity: "danger",
    title: "This connection needs repair.",
  },
  unsupported: {
    action: { href: "/settings", label: "Review connector settings" },
    copy: "The connected service does not advertise the capability required for this view. Existing media remains unchanged.",
    eyebrow: "Capability unavailable",
    icon: Ban,
    severity: "info",
    title: "This service cannot complete that action.",
  },
} as const;

export function DashboardState({ kind }: { kind: DashboardStateKind }) {
  if (kind === "loading") {
    return (
      <div className="dashboard-skeleton" aria-busy="true" aria-label="Loading dashboard">
        <h1 className="sr-only">Loading your dashboard</h1>
        <div aria-hidden="true" className="dashboard-skeleton__geometry">
          <div className="dashboard-skeleton__hero" />
          {Array.from({ length: 2 }, (_, railIndex) => (
            <section className="dashboard-skeleton__section" key={railIndex}>
              <div className="dashboard-skeleton__heading" />
              <div className="dashboard-skeleton__rail">
                {Array.from({ length: railIndex === 0 ? 4 : 5 }, (_, cardIndex) => (
                  <div className="dashboard-skeleton__card" key={cardIndex}>
                    <div className="dashboard-skeleton__poster" />
                    <div className="dashboard-skeleton__line" />
                    <div className="dashboard-skeleton__line dashboard-skeleton__line--short" />
                  </div>
                ))}
              </div>
            </section>
          ))}
          <div className="dashboard-skeleton__calendar">
            <div className="dashboard-skeleton__heading" />
            <div className="dashboard-skeleton__calendar-grid">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="dashboard-skeleton__calendar-item" key={index} />
              ))}
            </div>
          </div>
          <div className="dashboard-skeleton__dock" />
        </div>
        <span className="sr-only" role="status">
          Loading your dashboard…
        </span>
      </div>
    );
  }

  const copy = stateCopy[kind];
  const Icon = copy.icon;
  const refreshesDashboard = kind === "offline" || kind === "recoverable-error" || kind === "stale";
  const actionContent = (
    <>
      {refreshesDashboard && <RefreshCw aria-hidden="true" size={17} />}
      {copy.action.label}
    </>
  );
  return (
    <section
      className="dashboard-state"
      data-severity={copy.severity}
      aria-labelledby={`dashboard-${kind}-title`}
    >
      <span className="dashboard-state__icon" aria-hidden="true">
        <Icon size={25} />
      </span>
      <p className="eyebrow">{copy.eyebrow}</p>
      <h1 id={`dashboard-${kind}-title`}>{copy.title}</h1>
      <p>{copy.copy}</p>
      {refreshesDashboard ? (
        <a className="button button--glass" href={copy.action.href}>
          {actionContent}
        </a>
      ) : (
        <Link className="button button--glass" href={copy.action.href}>
          {actionContent}
        </Link>
      )}
    </section>
  );
}
