"use client";

import { useEffect } from "react";

import { useIdleRender } from "../lib/use-idle-render";

const GLASS_SELECTOR = "[data-liquid-glass]";
const GLASS_READY_ATTRIBUTE = "data-liquid-glass-ready";
const GLASS_PAINT_GRACE_MS = 180;

function percentage(value: number, start: number, size: number) {
  return `${Math.min(100, Math.max(0, ((value - start) / size) * 100)).toFixed(2)}%`;
}

export function LiquidGlassEnvironment() {
  const materialReady = useIdleRender(GLASS_PAINT_GRACE_MS);

  useEffect(() => {
    if (!materialReady) return;
    document.documentElement.setAttribute(GLASS_READY_ATTRIBUTE, "");
  }, [materialReady]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let activeSurface: HTMLElement | null = null;
    let animationFrame = 0;
    let pendingPointer: PointerEvent | null = null;

    const resetSurface = (surface: HTMLElement | null) => {
      if (!surface) return;
      surface.removeAttribute("data-glass-active");
      surface.style.removeProperty("--glass-pointer-x");
      surface.style.removeProperty("--glass-pointer-y");
    };

    const renderPointer = () => {
      animationFrame = 0;
      const event = pendingPointer;
      pendingPointer = null;
      if (!event) return;
      if (reducedMotion.matches || event.pointerType === "touch") {
        resetSurface(activeSurface);
        activeSurface = null;
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const surface = target?.closest<HTMLElement>(GLASS_SELECTOR) ?? null;
      if (surface !== activeSurface) {
        resetSurface(activeSurface);
        activeSurface = surface;
      }
      if (!surface) return;

      const bounds = surface.getBoundingClientRect();
      surface.style.setProperty(
        "--glass-pointer-x",
        percentage(event.clientX, bounds.left, bounds.width),
      );
      surface.style.setProperty(
        "--glass-pointer-y",
        percentage(event.clientY, bounds.top, bounds.height),
      );
      surface.setAttribute("data-glass-active", "");
    };

    const trackPointer = (event: PointerEvent) => {
      pendingPointer = event;
      if (!animationFrame) animationFrame = window.requestAnimationFrame(renderPointer);
    };

    const releasePointer = (event: PointerEvent) => {
      const nextTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (nextTarget?.closest(GLASS_SELECTOR) === activeSurface) return;
      resetSurface(activeSurface);
      activeSurface = null;
    };

    const followMotionPreference = () => {
      if (!reducedMotion.matches) return;
      resetSurface(activeSurface);
      activeSurface = null;
    };

    document.addEventListener("pointermove", trackPointer, { passive: true });
    document.addEventListener("pointerout", releasePointer, { passive: true });
    reducedMotion.addEventListener("change", followMotionPreference);
    return () => {
      document.removeEventListener("pointermove", trackPointer);
      document.removeEventListener("pointerout", releasePointer);
      reducedMotion.removeEventListener("change", followMotionPreference);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resetSurface(activeSurface);
    };
  }, []);

  return null;
}
