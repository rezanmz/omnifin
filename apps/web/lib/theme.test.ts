import { describe, expect, it } from "vitest";

import { parseThemePreference } from "./theme";

describe("parseThemePreference", () => {
  it.each(["system", "light", "dark"] as const)("accepts %s", (preference) => {
    expect(parseThemePreference(preference)).toBe(preference);
  });

  it.each([undefined, null, "", "midnight", "DARK"])(
    "falls back to system for %s",
    (preference) => {
      expect(parseThemePreference(preference)).toBe("system");
    },
  );
});
