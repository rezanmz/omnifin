"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { THEME_COOKIE_NAME, type ResolvedTheme, type ThemePreference } from "../lib/theme";

const DARK_MODE_QUERY = "(prefers-color-scheme: dark)";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: "#070a0d",
  light: "#eef3f5",
};

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
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

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", THEME_COLORS[resolvedTheme]);
}

export function ThemeProvider({
  children,
  initialPreference,
}: Readonly<{ children: ReactNode; initialPreference: ThemePreference }>) {
  const [preference, setPreferenceState] = useState(initialPreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    initialPreference === "system" ? "light" : initialPreference,
  );

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

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);
    document.cookie = `${THEME_COOKIE_NAME}=${nextPreference}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
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
