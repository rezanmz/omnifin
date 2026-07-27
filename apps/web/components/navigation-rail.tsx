"use client";

import { CalendarDays, Compass, Gauge, Library, Settings2 } from "lucide-react";
import Link from "next/link";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { BrandMark } from "./brand-mark";

const destinations = [
  { current: true, href: "/", icon: Compass, label: "Discover" },
  { current: false, href: "/#rail-continue-watching", icon: Library, label: "Library" },
  { current: false, href: "/#upcoming-heading", icon: CalendarDays, label: "Calendar" },
  { current: false, href: "/#operations-heading", icon: Gauge, label: "Operations" },
] as const;

export function NavigationRail() {
  return (
    <aside
      className="navigation-rail"
      aria-label="Primary navigation"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "vertical" })}
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
    </aside>
  );
}

export function MobileNavigation() {
  return (
    <nav
      className="mobile-navigation"
      aria-label="Primary navigation"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "horizontal" })}
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
    </nav>
  );
}
