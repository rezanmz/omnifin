import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiquidGlassEnvironment } from "./liquid-glass-environment";

describe("LiquidGlassEnvironment", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-liquid-glass-ready");
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lets meaningful content paint before enabling backdrop refinement", () => {
    vi.useFakeTimers();
    let idleCallback: IdleRequestCallback | undefined;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 17;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    render(<LiquidGlassEnvironment />);

    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
    act(() => vi.advanceTimersByTime(179));
    expect(requestIdleCallback).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(requestIdleCallback).toHaveBeenCalledOnce();
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");

    act(() => idleCallback?.({ didTimeout: false, timeRemaining: () => 12 }));
    expect(document.documentElement).toHaveAttribute("data-liquid-glass-ready");
  });
});
