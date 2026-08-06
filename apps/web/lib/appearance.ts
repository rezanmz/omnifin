import type { ThemePreference } from "../lib/theme";

const CSRF_HEADER = "x-omnifin-csrf";

export interface AppearanceClient {
  load(signal?: AbortSignal): Promise<{ theme: ThemePreference } | null>;
  update(theme: ThemePreference, csrfToken: string): Promise<boolean>;
}

export const appearanceClient: AppearanceClient = {
  async load(signal) {
    const response = await fetch("/api/profile/appearance", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return null;
    try {
      const body = (await response.json()) as unknown;
      const theme = String((body as { theme?: unknown })?.theme ?? "");
      if (theme === "system" || theme === "light" || theme === "dark") {
        return { theme };
      }
      return null;
    } catch {
      return null;
    }
  },

  async update(theme, csrfToken) {
    const response = await fetch("/api/profile/appearance", {
      body: JSON.stringify({ theme }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [CSRF_HEADER]: csrfToken,
      },
      method: "PATCH",
    });
    return response.ok;
  },
};
