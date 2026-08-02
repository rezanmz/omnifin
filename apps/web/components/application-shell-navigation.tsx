"use client";

import { usePathname } from "next/navigation";

import { applicationDestinationForPath } from "../lib/application-shell-route";
import { MobileNavigation, NavigationRail } from "./navigation-rail";

export function ApplicationShellNavigation({ mobile = false }: { mobile?: boolean }) {
  const current = applicationDestinationForPath(usePathname());
  return mobile ? <MobileNavigation current={current} /> : <NavigationRail current={current} />;
}
