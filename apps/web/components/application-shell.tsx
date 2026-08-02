"use client";

import type { ServiceStatus } from "../lib/dashboard-data";
import type { ThemePreference } from "../lib/theme";
import { usePathname, useSearchParams } from "next/navigation";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { MobileNavigation, NavigationRail, type PrimaryDestination } from "./navigation-rail";
import { TopCommandBar } from "./top-command-bar";

const DEFAULT_ACCENT = "#6f8d84";
const DEFAULT_SIGNAL: ApplicationShellSignal = {
  accent: DEFAULT_ACCENT,
  displayProfile: "standard",
  status: "healthy",
};
const PUBLIC_ROUTE_PREFIXES = ["/link", "/login", "/onboarding", "/recovery"] as const;

type ShellStyle = CSSProperties & { "--ambient-accent": string };

interface ApplicationShellSignal {
  accent: string;
  displayProfile: "standard" | "ten-foot";
  status: ServiceStatus;
}

interface ApplicationShellContextValue {
  setSignal: (signal: ApplicationShellSignal) => void;
}

const ApplicationShellContext = createContext<ApplicationShellContextValue | null>(null);

function destinationForPath(pathname: string): PrimaryDestination | null {
  if (pathname === "/") return "discover";
  if (pathname === "/library" || pathname.startsWith("/library/")) return "library";
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) return "calendar";
  if (pathname === "/operations/requests" || pathname.startsWith("/operations/requests/")) {
    return "requests";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/operations" || pathname.startsWith("/operations/")) return "operations";
  return null;
}

export function routeUsesApplicationShell(pathname: string, testView: string | null = null) {
  if (pathname === "/" && testView === "onboarding") return false;
  return !PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function ShellFrame({
  accent,
  children,
  current,
  displayProfile,
  status,
  themePreference,
}: {
  accent: string;
  children: ReactNode;
  current: PrimaryDestination | null;
  displayProfile: "standard" | "ten-foot";
  status: ServiceStatus;
  themePreference: ThemePreference;
}) {
  return (
    <div
      className="application-frame"
      data-display-profile={displayProfile}
      style={{ "--ambient-accent": accent } as ShellStyle}
    >
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <NavigationRail current={current} />
      <div className="application-shell">
        <TopCommandBar connectionStatus={status} themePreference={themePreference} />
        {children}
      </div>
      <MobileNavigation current={current} />
    </div>
  );
}

export function ApplicationShellBoundary({
  children,
  themePreference,
}: {
  children: ReactNode;
  themePreference: ThemePreference;
}) {
  const pathname = usePathname();
  const searchParameters = useSearchParams();
  const [registeredSignal, setRegisteredSignal] = useState<{
    pathname: string;
    signal: ApplicationShellSignal;
  }>(() => ({ pathname, signal: DEFAULT_SIGNAL }));
  const context = useMemo<ApplicationShellContextValue>(
    () => ({
      setSignal: (signal) => setRegisteredSignal({ pathname, signal }),
    }),
    [pathname],
  );
  const testView = searchParameters.get("test-view");
  const usesShell = routeUsesApplicationShell(pathname, testView);
  const signal = registeredSignal.pathname === pathname ? registeredSignal.signal : DEFAULT_SIGNAL;

  if (!usesShell) return children;

  return (
    <ApplicationShellContext.Provider value={context}>
      <ShellFrame
        accent={signal.accent}
        current={destinationForPath(pathname)}
        displayProfile={signal.displayProfile}
        status={signal.status}
        themePreference={themePreference}
      >
        {children}
      </ShellFrame>
    </ApplicationShellContext.Provider>
  );
}

export function ApplicationShellContent({
  accent = DEFAULT_ACCENT,
  children,
  current,
  displayProfile = "standard",
  status,
  themePreference = "system",
}: {
  accent?: string;
  children: ReactNode;
  current: PrimaryDestination;
  displayProfile?: "standard" | "ten-foot";
  status: ServiceStatus;
  themePreference?: ThemePreference;
}) {
  const shell = useContext(ApplicationShellContext);

  useEffect(() => {
    shell?.setSignal({ accent, displayProfile, status });
  }, [accent, displayProfile, shell, status]);

  if (shell) return children;

  return (
    <ShellFrame
      accent={accent}
      current={current}
      displayProfile={displayProfile}
      status={status}
      themePreference={themePreference}
    >
      {children}
    </ShellFrame>
  );
}
