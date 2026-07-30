import { CalendarDays, ClipboardCheck, Compass, Gauge, Library, Settings2 } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { DirectionalNavigationRegion } from "./directional-navigation-group";

const destinations = [
  { current: true, href: "/", icon: Compass, label: "Discover" },
  { current: false, href: "/library", icon: Library, label: "Library" },
  { current: false, href: "/calendar", icon: CalendarDays, label: "Calendar" },
  { current: false, href: "/operations/health", icon: Gauge, label: "Operations" },
  { current: false, href: "/operations/requests", icon: ClipboardCheck, label: "Requests" },
] as const;

export function NavigationRail() {
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
        {destinations.map(({ current, href, icon: Icon, label }) => (
          <Link
            aria-current={current ? "page" : undefined}
            className="navigation-rail__item"
            data-current={current || undefined}
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

export function MobileNavigation() {
  return (
    <DirectionalNavigationRegion
      ariaLabel="Primary navigation"
      as="nav"
      axis="horizontal"
      className="mobile-navigation"
      liquidGlass
    >
      {destinations.map(({ current, href, icon: Icon, label }) => (
        <Link
          aria-current={current ? "page" : undefined}
          className="mobile-navigation__item"
          data-current={current || undefined}
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
