"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import {
  applicationDestinationForPath,
  type ApplicationDestination,
} from "../lib/application-shell-route";
import { handleDirectionalFocus, type DirectionalAxis } from "../lib/directional-focus";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";

function setCurrentDestination(current: ApplicationDestination | null) {
  for (const link of document.querySelectorAll<HTMLElement>("[data-destination]")) {
    const selected = link.dataset.destination === current;
    link.toggleAttribute("data-current", selected);
    if (selected) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

export function ApplicationShellEnhancements({
  initialCurrent = null,
}: {
  initialCurrent?: ApplicationDestination | null;
}) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    setCurrentDestination(pathname ? applicationDestinationForPath(pathname) : initialCurrent);
  }, [initialCurrent, pathname]);

  useEffect(() => {
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      const target =
        event.target instanceof Element ? event.target.closest("a[data-shell-link]") : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        target.target ||
        target.hasAttribute("download")
      ) {
        return;
      }
      const destination = new URL(target.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      event.preventDefault();
      router.push(`${destination.pathname}${destination.search}${destination.hash}`);
    };
    document.addEventListener("click", navigate);
    return () => document.removeEventListener("click", navigate);
  }, [router]);

  useEffect(() => {
    const regions = [
      [document.querySelector<HTMLElement>(".navigation-rail"), "vertical"],
      [document.querySelector<HTMLElement>(".mobile-navigation"), "horizontal"],
      [document.querySelector<HTMLElement>(".top-command-bar"), "horizontal"],
    ] as const satisfies readonly (readonly [HTMLElement | null, DirectionalAxis])[];
    const cleanups: (() => void)[] = [];
    for (const [region, axis] of regions) {
      if (!region) continue;
      const navigate = (event: KeyboardEvent) => handleDirectionalFocus(event, { axis });
      region.addEventListener("keydown", navigate);
      cleanups.push(() => region.removeEventListener("keydown", navigate));
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  return <LiquidGlassEnvironment />;
}
