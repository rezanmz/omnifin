import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThemePreference } from "../lib/theme";
import { AppearanceSelector } from "./appearance-selector";
import { ThemeProvider, useTheme } from "./theme-provider";

function installColorScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        addEventListener: (_event: string, listener: () => void) => {
          listeners.add(listener);
        },
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        get matches() {
          return query === "(prefers-color-scheme: dark)" && dark;
        },
        media: query,
        onchange: null,
        removeEventListener: (_event: string, listener: () => void) => {
          listeners.delete(listener);
        },
        removeListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  return (nextDark: boolean) => {
    dark = nextDark;
    for (const listener of listeners) listener();
  };
}

function ThemeProbe({ onPreference }: { onPreference?: (value: ThemePreference) => void }) {
  const theme = useTheme();
  useEffect(() => onPreference?.(theme.preference), [onPreference, theme.preference]);
  return <output>{`${theme.preference}:${theme.resolvedTheme}`}</output>;
}

describe("ThemeProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies an explicit theme to the document", async () => {
    installColorScheme(false);
    render(
      <ThemeProvider initialPreference="dark">
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(await screen.findByText("dark:dark")).toBeVisible();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-resolved-theme", "dark");
  });

  it("tracks system color-scheme changes without pinning a theme", async () => {
    const setDark = installColorScheme(false);
    render(
      <ThemeProvider initialPreference="system">
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(await screen.findByText("system:light")).toBeVisible();
    expect(document.documentElement).not.toHaveAttribute("data-theme");

    act(() => setDark(true));
    expect(await screen.findByText("system:dark")).toBeVisible();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("persists changes made with the accessible appearance control", async () => {
    installColorScheme(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider initialPreference="system">
        <AppearanceSelector />
      </ThemeProvider>,
    );

    const dark = await screen.findByRole("radio", { name: /dark/i });
    await user.click(dark);

    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.cookie).toContain("omnifin-theme=dark");
  });

  it("supports arrow-key selection inside the radio group", async () => {
    installColorScheme(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider initialPreference="system">
        <AppearanceSelector />
      </ThemeProvider>,
    );

    const system = await screen.findByRole("radio", { name: /system/i });
    system.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("radio", { name: /light/i })).toHaveAttribute("aria-checked", "true");
  });

  it("adopts the signed-in account theme and persists subsequent changes", async () => {
    installColorScheme(false);
    const calls: Array<{ method?: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ method: init?.method, url });
        if (url.endsWith("/api/auth/session")) {
          return new Response(
            JSON.stringify({
              csrfToken: "csrf-account-000",
              principal: { userId: "u1" },
              theme: "dark",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/api/profile/appearance")) {
          return new Response(JSON.stringify({ theme: "dark" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const user = userEvent.setup();
    render(
      <ThemeProvider initialPreference="light">
        <AppearanceSelector />
      </ThemeProvider>,
    );

    const dark = await screen.findByRole("radio", { name: /dark/i });
    expect(dark).toHaveAttribute("aria-checked", "true");

    const light = screen.getByRole("radio", { name: /light/i });
    await user.click(light);
    expect(light).toHaveAttribute("aria-checked", "true");
    expect(
      calls.some((call) => call.url.endsWith("/api/profile/appearance") && call.method === "PATCH"),
    ).toBe(true);
    expect(calls.filter((call) => call.url.endsWith("/api/profile/appearance")).length).toBe(1);
  });
});
