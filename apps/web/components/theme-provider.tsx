"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { appearanceClient } from "../lib/appearance";
import { THEME_COOKIE_NAME, type ResolvedTheme, type ThemePreference } from "../lib/theme";

const DARK_MODE_QUERY = "(prefers-color-scheme: dark)";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: "#070a0d",
  light: "#eef3f5",
};

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme | null;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolvedTheme: "light",
  setPreference: () => undefined,
});

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_MODE_QUERY).matches ? "dark" : "light";
}

function applyTheme(preference: ThemePreference, resolvedTheme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.resolvedTheme = resolvedTheme;

  if (preference === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }

  for (const themeColor of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    themeColor.setAttribute("content", THEME_COLORS[resolvedTheme]);
  }
}

export function ThemeProvider({
  children,
  initialPreference,
}: Readonly<{ children: ReactNode; initialPreference: ThemePreference }>) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme | null>(() =>
    initialPreference === "system" ? null : initialPreference,
  );
  const csrfTokenReference = useRef<string | null>(null);
  const userChangedReference = useRef(false);

  useEffect(() => {
    const media = window.matchMedia(DARK_MODE_QUERY);
    const synchronize = () => {
      const nextResolved = preference === "system" ? systemTheme() : preference;
      setResolvedTheme(nextResolved);
      applyTheme(preference, nextResolved);
    };

    synchronize();
    if (preference !== "system") return;
    media.addEventListener("change", synchronize);
    return () => media.removeEventListener("change", synchronize);
  }, [preference]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let csrfToken: string | null = null;
      let sessionTheme: ThemePreference | null = null;
      try {
        const sessionResponse = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (sessionResponse.ok) {
          const session = (await sessionResponse.json()) as unknown;
          const record = session as { csrfToken?: unknown; principal?: unknown; theme?: unknown };
          const principal = record.principal;
          csrfToken =
            typeof record.csrfToken === "string" && record.csrfToken !== ""
              ? record.csrfToken
              : null;
          const theme = String(record.theme ?? "");
          if (theme === "system" || theme === "light" || theme === "dark") {
            sessionTheme = theme;
          }
          if (principal !== null && principal !== undefined && sessionTheme === null) {
            try {
              const account = await appearanceClient.load(controller.signal);
              sessionTheme = account?.theme ?? null;
            } catch {
              sessionTheme = null;
            }
          }
        }
      } catch {
        csrfToken = null;
        sessionTheme = null;
      }
      if (csrfToken === null) {
        if (sessionTheme !== null && !userChangedReference.current) {
          setPreferenceState(sessionTheme);
        }
        return;
      }
      csrfTokenReference.current = csrfToken;
      if (sessionTheme !== null && !userChangedReference.current) {
        setPreferenceState(sessionTheme);
      }
    })();
    return () => controller.abort();
  }, []);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    userChangedReference.current = true;
    setPreferenceState(nextPreference);
    document.cookie = `${THEME_COOKIE_NAME}=${nextPreference}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
    const csrfToken = csrfTokenReference.current;
    if (csrfToken === null) return;
    void appearanceClient.update(nextPreference, csrfToken).catch(() => undefined);
  }, []);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
