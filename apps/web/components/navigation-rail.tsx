import { CalendarDays, ClipboardCheck, Compass, Gauge, Library, Settings2 } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { DirectionalNavigationRegion } from "./directional-navigation-group";

const destinations = [
  { href: "/", icon: Compass, id: "discover", label: "Discover" },
  { href: "/library", icon: Library, id: "library", label: "Library" },
  { href: "/calendar", icon: CalendarDays, id: "calendar", label: "Calendar" },
  { href: "/operations/health", icon: Gauge, id: "operations", label: "Operations" },
  { href: "/operations/requests", icon: ClipboardCheck, id: "requests", label: "Requests" },
] as const;

type PrimaryDestination = (typeof destinations)[number]["id"];

export function NavigationRail({ current = "discover" }: { current?: PrimaryDestination }) {
  return (
    <DirectionalNavigationRegion
      ariaLabel="Primary navigation"
      as="aside"
      axis="vertical"
      className="navigation-rail"
      liquidGlass
    >
      <Link className="navigation-rail__brand" href="/" aria-label="Omnifin home" prefetch={false}>
        <BrandMark compact />
      </Link>
      <nav className="navigation-rail__nav">
        {destinations.map(({ href, icon: Icon, id, label }) => (
          <Link
            aria-current={current === id ? "page" : undefined}
            className="navigation-rail__item"
            data-current={current === id || undefined}
            data-directional-item
            href={href}
            key={href}
            prefetch={false}
          >
            <Icon aria-hidden="true" size={21} strokeWidth={1.55} />
            <span className="navigation-rail__tooltip">{label}</span>
          </Link>
        ))}
      </nav>
      <Link
        className="navigation-rail__item navigation-rail__settings"
        href="/settings"
        aria-label="Settings"
        data-directional-item
        prefetch={false}
      >
        <Settings2 aria-hidden="true" size={21} strokeWidth={1.55} />
        <span className="navigation-rail__tooltip">Settings</span>
      </Link>
    </DirectionalNavigationRegion>
  );
}

export function MobileNavigation({ current = "discover" }: { current?: PrimaryDestination }) {
  return (
    <DirectionalNavigationRegion
      ariaLabel="Primary navigation"
      as="nav"
      axis="horizontal"
      className="mobile-navigation"
      liquidGlass
    >
      {destinations.map(({ href, icon: Icon, id, label }) => (
        <Link
          aria-current={current === id ? "page" : undefined}
          className="mobile-navigation__item"
          data-current={current === id || undefined}
          data-directional-item
          href={href}
          key={href}
          prefetch={false}
        >
          <Icon aria-hidden="true" size={20} strokeWidth={1.65} />
          <span>{label}</span>
        </Link>
      ))}
      <Link
        className="mobile-navigation__item"
        data-directional-item
        href="/settings"
        prefetch={false}
      >
        <Settings2 aria-hidden="true" size={20} strokeWidth={1.65} />
        <span>Settings</span>
      </Link>
    </DirectionalNavigationRegion>
  );
}
