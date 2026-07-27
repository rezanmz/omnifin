"use client";

import { Check, Moon, Monitor, Sun, type LucideIcon } from "lucide-react";

import { THEME_PREFERENCES, type ThemePreference } from "../lib/theme";
import { useTheme } from "./theme-provider";

const OPTIONS: Record<ThemePreference, { description: string; icon: LucideIcon; label: string }> = {
  dark: {
    description: "Keep Omnifin dark on this browser.",
    icon: Moon,
    label: "Dark",
  },
  light: {
    description: "Keep Omnifin light on this browser.",
    icon: Sun,
    label: "Light",
  },
  system: {
    description: "Follow this device’s appearance setting.",
    icon: Monitor,
    label: "System",
  },
};

export function AppearanceSelector({ compact = false }: { compact?: boolean }) {
  const { preference, resolvedTheme, setPreference } = useTheme();

  const moveSelection = (current: ThemePreference, direction: -1 | 1) => {
    const currentIndex = THEME_PREFERENCES.indexOf(current);
    const nextIndex =
      (currentIndex + direction + THEME_PREFERENCES.length) % THEME_PREFERENCES.length;
    const nextPreference = THEME_PREFERENCES[nextIndex]!;
    setPreference(nextPreference);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-theme-option="${nextPreference}"]`)?.focus();
    });
  };

  return (
    <section className="appearance-selector" data-compact={compact || undefined}>
      <div className="appearance-selector__heading">
        <div>
          <p className="section-kicker">Appearance</p>
          <h2>Choose your atmosphere.</h2>
        </div>
        <span className="appearance-selector__resolved" aria-live="polite">
          {preference === "system"
            ? `System · ${resolvedTheme}`
            : `${OPTIONS[preference].label} theme`}
        </span>
      </div>
      <div aria-label="Color theme" className="appearance-selector__options" role="radiogroup">
        {THEME_PREFERENCES.map((value) => {
          const option = OPTIONS[value];
          const Icon = option.icon;
          const selected = preference === value;
          return (
            <button
              aria-checked={selected}
              className="appearance-selector__option"
              data-selected={selected || undefined}
              data-theme-option={value}
              key={value}
              onClick={() => setPreference(value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveSelection(value, -1);
                }
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  moveSelection(value, 1);
                }
              }}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <span className="appearance-selector__icon" aria-hidden="true">
                <Icon size={19} strokeWidth={1.7} />
              </span>
              <span>
                <strong>{option.label}</strong>
                {!compact ? <small>{option.description}</small> : null}
              </span>
              <Check className="appearance-selector__check" aria-hidden="true" size={17} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
