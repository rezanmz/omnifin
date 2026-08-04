/* eslint-disable @next/next/no-html-link-for-pages -- Shell anchors provide a no-JavaScript fallback and are progressively enhanced by ApplicationShellEnhancements. */
import type { ApplicationDestination } from "../lib/application-shell-route";
import { BrandMark } from "./brand-mark";
import { ShellIcon, type ShellIconName } from "./shell-icon";

const destinations = [
  { href: "/", icon: "compass", id: "discover", label: "Discover" },
  { href: "/browse", icon: "search", id: "browse", label: "Browse" },
  { href: "/library", icon: "library", id: "library", label: "Library" },
  { href: "/saved", icon: "bookmark", id: "saved", label: "Saved" },
  { href: "/calendar", icon: "calendar", id: "calendar", label: "Calendar" },
  { href: "/operations/health", icon: "gauge", id: "operations", label: "Operations" },
  { href: "/operations/requests", icon: "clipboard", id: "requests", label: "Requests" },
] as const satisfies readonly {
  href: string;
  icon: ShellIconName;
  id: ApplicationDestination;
  label: string;
}[];

export function NavigationRail({
  current = "discover",
}: {
  current?: ApplicationDestination | null;
}) {
  return (
    <aside aria-label="Primary navigation" className="navigation-rail" data-liquid-glass>
      <a className="navigation-rail__brand" data-shell-link href="/" aria-label="Omnifin home">
        <BrandMark compact />
      </a>
      <nav className="navigation-rail__nav">
        {destinations.map(({ href, icon, id, label }) => (
          <a
            aria-current={current === id ? "page" : undefined}
            className="navigation-rail__item"
            data-current={current === id || undefined}
            data-destination={id}
            data-directional-item
            data-shell-link
            href={href}
            key={href}
          >
            <ShellIcon aria-hidden="true" name={icon} size={21} strokeWidth={1.55} />
            <span className="navigation-rail__tooltip">{label}</span>
          </a>
        ))}
      </nav>
      <a
        aria-current={current === "settings" ? "page" : undefined}
        className="navigation-rail__item navigation-rail__settings"
        data-current={current === "settings" || undefined}
        href="/settings"
        aria-label="Settings"
        data-directional-item
        data-destination="settings"
        data-shell-link
      >
        <ShellIcon aria-hidden="true" name="settings" size={21} strokeWidth={1.55} />
        <span className="navigation-rail__tooltip">Settings</span>
      </a>
    </aside>
  );
}

export function MobileNavigation({
  current = "discover",
}: {
  current?: ApplicationDestination | null;
}) {
  return (
    <nav aria-label="Primary navigation" className="mobile-navigation" data-liquid-glass>
      {destinations.map(({ href, icon, id, label }) => (
        <a
          aria-current={current === id ? "page" : undefined}
          className="mobile-navigation__item"
          data-current={current === id || undefined}
          data-destination={id}
          data-directional-item
          data-shell-link
          href={href}
          key={href}
        >
          <ShellIcon aria-hidden="true" name={icon} size={20} strokeWidth={1.65} />
          <span>{label}</span>
        </a>
      ))}
      <a
        aria-current={current === "settings" ? "page" : undefined}
        className="mobile-navigation__item"
        data-current={current === "settings" || undefined}
        data-destination="settings"
        data-directional-item
        data-shell-link
        href="/settings"
      >
        <ShellIcon aria-hidden="true" name="settings" size={20} strokeWidth={1.65} />
        <span>Settings</span>
      </a>
    </nav>
  );
}
