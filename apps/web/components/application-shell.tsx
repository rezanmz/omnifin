"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { ServiceStatus } from "../lib/dashboard-data";
import {
  routeUsesApplicationShell,
  type ApplicationDestination,
} from "../lib/application-shell-route";
import type { ThemePreference } from "../lib/theme";

const DEFAULT_ACCENT = "#8de9d5";
const DEFAULT_SIGNAL: ApplicationShellSignal = {
  accent: DEFAULT_ACCENT,
  displayProfile: "standard",
  status: "attention",
};

type ShellStyle = CSSProperties & { "--ambient-accent": string };

export interface ApplicationShellSignal {
  accent: string;
  displayProfile: "standard" | "ten-foot";
  status: ServiceStatus;
}

interface ApplicationShellContextValue {
  setSignal: (signal: ApplicationShellSignal) => void;
  signal: ApplicationShellSignal;
}

const ApplicationShellContext = createContext<ApplicationShellContextValue | null>(null);

export function ApplicationShellBoundary({
  backdrop,
  children,
  environment,
  mobileNavigation,
  navigation,
  topCommandBar,
}: {
  backdrop: ReactNode;
  children: ReactNode;
  environment: ReactNode;
  mobileNavigation: ReactNode;
  navigation: ReactNode;
  topCommandBar: ReactNode;
}) {
  const pathname = usePathname();
  const [registeredSignal, setRegisteredSignal] = useState<{
    pathname: string;
    signal: ApplicationShellSignal;
  }>(() => ({ pathname, signal: DEFAULT_SIGNAL }));
  const signal = registeredSignal.pathname === pathname ? registeredSignal.signal : DEFAULT_SIGNAL;
  const context = useMemo<ApplicationShellContextValue>(
    () => ({
      setSignal: (nextSignal) =>
        setRegisteredSignal((current) =>
          current.pathname === pathname &&
          current.signal.accent === nextSignal.accent &&
          current.signal.displayProfile === nextSignal.displayProfile &&
          current.signal.status === nextSignal.status
            ? current
            : { pathname, signal: nextSignal },
        ),
      signal,
    }),
    [pathname, signal],
  );

  if (!routeUsesApplicationShell(pathname)) return children;

  return (
    <ApplicationShellContext.Provider value={context}>
      <div
        className="application-frame"
        data-display-profile={signal.displayProfile}
        style={{ "--ambient-accent": signal.accent } as ShellStyle}
      >
        {environment}
        {backdrop}
        {navigation}
        <div className="application-shell">
          {topCommandBar}
          {children}
        </div>
        {mobileNavigation}
      </div>
    </ApplicationShellContext.Provider>
  );
}

export function useApplicationShellSignal() {
  return useContext(ApplicationShellContext)?.signal ?? DEFAULT_SIGNAL;
}

export function ApplicationShellContent({
  accent = DEFAULT_ACCENT,
  children,
  displayProfile = "standard",
  status,
}: {
  accent?: string;
  children: ReactNode;
  current: ApplicationDestination;
  displayProfile?: "standard" | "ten-foot";
  status: ServiceStatus;
  themePreference?: ThemePreference;
}) {
  const shell = useContext(ApplicationShellContext);

  useEffect(() => {
    shell?.setSignal({ accent, displayProfile, status });
  }, [accent, displayProfile, shell, status]);

  if (shell) return children;
  return children;
}
