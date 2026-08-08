import { ExternalLink } from "lucide-react";

export interface ConnectedServiceAction {
  href: string;
  kind: "service_navigation";
  label: string;
  service: "radarr" | "sonarr";
}

/**
 * Renders capability-gated connected-service actions as new-tab links. Only
 * same-origin gateway paths are ever opened: the gateway resolves the
 * destination server-side per click, so configured UI origins never reach the
 * browser contract.
 */
export function ConnectedServiceActions({
  actions,
  className,
  linkClassName,
}: {
  actions: ConnectedServiceAction[];
  className?: string;
  linkClassName?: string;
}) {
  const safeActions = actions.flatMap((action) => {
    const href = action.href.startsWith("/v1/")
      ? action.href.replace(/^\/v1\//u, "/api/")
      : action.href.startsWith("/api/")
        ? action.href
        : undefined;
    return href === undefined ? [] : [{ ...action, href }];
  });
  if (safeActions.length === 0) return null;
  return (
    <nav aria-label="Connected services" className={className}>
      {safeActions.map((action) => (
        <a
          aria-label={`${action.label} in a new tab`}
          className={linkClassName}
          data-directional-item
          href={action.href}
          key={action.service}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLink aria-hidden="true" />
          {action.label}
        </a>
      ))}
    </nav>
  );
}
