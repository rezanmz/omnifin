"use client";

import "./profile-menu.css";

import { ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { AppearanceSelector } from "./appearance-selector";

export function ProfileMenu({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const panelId = useId();
  const rootReference = useRef<HTMLDivElement>(null);
  const triggerReference = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusFrame = requestAnimationFrame(() => {
      rootReference.current?.querySelector<HTMLElement>(".profile-popover__close")?.focus();
    });
    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootReference.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerReference.current?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={rootReference}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? "Close profile menu" : "Open profile menu"}
        className="user-avatar"
        data-directional-item
        onClick={() => setOpen((current) => !current)}
        ref={triggerReference}
        type="button"
      >
        <span aria-hidden="true">RN</span>
      </button>
      {open ? (
        <section
          aria-label="Profile and appearance"
          aria-modal="false"
          className="profile-popover"
          id={panelId}
          role="dialog"
        >
          <div className="profile-popover__header">
            <div>
              <p className="section-kicker">Personal controls</p>
              <h2>Profile &amp; appearance</h2>
            </div>
            <button
              aria-label="Close profile menu"
              className="profile-popover__close"
              onClick={() => {
                setOpen(false);
                triggerReference.current?.focus();
              }}
              type="button"
            >
              <X aria-hidden="true" size={17} />
            </button>
          </div>
          <AppearanceSelector compact />
          <Link className="profile-popover__account" href="/settings">
            Account &amp; access
            <ArrowUpRight aria-hidden="true" size={16} />
          </Link>
        </section>
      ) : null}
    </div>
  );
}
