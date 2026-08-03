"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  applicationDestinationForPath,
  type ApplicationDestination,
} from "../lib/application-shell-route";
import { handleDirectionalFocus, type DirectionalAxis } from "../lib/directional-focus";
import type { ThemePreference } from "../lib/theme";
import { ApplicationShellStatus } from "./application-shell-status";
import { GlobalSearchLoader } from "./global-search-loader";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { ProfileMenuLoader } from "./profile-menu-loader";

const SHELL_MOUNTS = ["search", "status", "profile"] as const;

function mountedShellSlots() {
  return Object.fromEntries(
    SHELL_MOUNTS.map((slot) => [
      slot,
      document.querySelector<HTMLElement>(`[data-shell-mount="${slot}"]`),
    ]),
  ) as Record<(typeof SHELL_MOUNTS)[number], HTMLElement | null>;
}

function setCurrentDestination(current: ApplicationDestination | null) {
  for (const link of document.querySelectorAll<HTMLElement>("[data-destination]")) {
    const selected = link.dataset.destination === current;
    link.toggleAttribute("data-current", selected);
    if (selected) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function shellThemePreference(fallback: ThemePreference): ThemePreference {
  const preference = document.documentElement.dataset.themePreference;
  return preference === "dark" || preference === "light" || preference === "system"
    ? preference
    : fallback;
}

export function ApplicationShellEnhancements({
  initialCurrent = null,
  initialPreference = "system",
}: {
  initialCurrent?: ApplicationDestination | null;
  initialPreference?: ThemePreference;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const slots = mounted ? mountedShellSlots() : null;

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    for (const slot of SHELL_MOUNTS) {
      document
        .querySelector<HTMLElement>(`[data-shell-placeholder="${slot}"]`)
        ?.setAttribute("hidden", "");
    }
    return () => {
      for (const slot of SHELL_MOUNTS) {
        document
          .querySelector<HTMLElement>(`[data-shell-placeholder="${slot}"]`)
          ?.removeAttribute("hidden");
      }
    };
  }, [mounted]);

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

  const preference =
    typeof document === "undefined" ? initialPreference : shellThemePreference(initialPreference);

  return (
    <>
      <LiquidGlassEnvironment />
      {slots?.search ? createPortal(<GlobalSearchLoader />, slots.search) : null}
      {slots?.status ? createPortal(<ApplicationShellStatus />, slots.status) : null}
      {slots?.profile
        ? createPortal(<ProfileMenuLoader initialPreference={preference} />, slots.profile)
        : null}
    </>
  );
}
