"use client";

import { useEffect, useState } from "react";

const MAXIMUM_IDLE_DELAY_MS = 1_200;

/**
 * Lets the browser commit the route shell before mounting an expensive client island.
 * The timeout keeps controls available on continuously busy devices, while the
 * animation-frame fallback provides the same paint-first ordering in Safari.
 */
export function useIdleRender(minimumDelayMs = 0) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const browser = window as unknown as {
      cancelIdleCallback?: (handle: number) => void;
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    };
    let idleHandle = 0;
    let secondFrame = 0;
    let firstFrame = 0;
    const scheduleWhenIdle = () => {
      if (browser.requestIdleCallback && browser.cancelIdleCallback) {
        idleHandle = browser.requestIdleCallback(() => setReady(true), {
          timeout: MAXIMUM_IDLE_DELAY_MS,
        });
        return;
      }
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => setReady(true));
      });
    };
    const delayHandle =
      minimumDelayMs > 0 ? window.setTimeout(scheduleWhenIdle, minimumDelayMs) : undefined;
    if (delayHandle === undefined) scheduleWhenIdle();

    return () => {
      if (delayHandle !== undefined) window.clearTimeout(delayHandle);
      if (idleHandle) browser.cancelIdleCallback?.(idleHandle);
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [minimumDelayMs]);

  return ready;
}
