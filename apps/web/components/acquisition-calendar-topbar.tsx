"use client";

import { ArrowLeft, Monitor, Moon, Radio, Sun } from "lucide-react";
import Link from "next/link";

import type { ThemePreference } from "../lib/theme";
import { BrandMark } from "./brand-mark";
import { useTheme } from "./theme-provider";
import styles from "./acquisition-calendar.module.css";

const THEME_OPTIONS = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
] satisfies { icon: typeof Sun; label: string; value: ThemePreference }[];

function ThemeControl() {
  const { preference, setPreference } = useTheme();

  const moveSelection = (currentIndex: number, direction: -1 | 1) => {
    const nextIndex = (currentIndex + direction + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    const next = THEME_OPTIONS[nextIndex];
    if (!next) return;
    setPreference(next.value);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-calendar-theme="${next.value}"]`)?.focus();
    });
  };

  return (
    <div aria-label="Color theme" className={styles.themeControl} role="radiogroup">
      {THEME_OPTIONS.map(({ icon: Icon, label, value }, index) => (
        <button
          aria-checked={preference === value}
          aria-label={`${label} theme`}
          data-calendar-theme={value}
          data-selected={preference === value || undefined}
          key={value}
          onClick={() => setPreference(value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(index, -1);
            }
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              moveSelection(index, 1);
            }
          }}
          role="radio"
          tabIndex={preference === value ? 0 : -1}
          type="button"
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.7} />
        </button>
      ))}
    </div>
  );
}

export function AcquisitionCalendarTopbar() {
  return (
    <header className={styles.topbar} data-liquid-glass>
      <BrandMark />
      <nav aria-label="Calendar navigation" className={styles.topbarActions}>
        <Link className={styles.operationsLink} href="/operations/downloads" prefetch={false}>
          <Radio aria-hidden="true" size={16} /> Operations
        </Link>
        <Link className={styles.back} href="/" prefetch={false}>
          <ArrowLeft aria-hidden="true" size={17} /> Discover
        </Link>
        <ThemeControl />
      </nav>
    </header>
  );
}
