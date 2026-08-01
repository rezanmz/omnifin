import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useIdleRender } from "./use-idle-render";

describe("useIdleRender", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts deferred work in the browser's idle window", () => {
    let scheduled: IdleRequestCallback | undefined;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      scheduled = callback;
      return 17;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);

    const { result, unmount } = renderHook(() => useIdleRender());

    expect(result.current).toBe(false);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1_200 });
    act(() => scheduled?.({ didTimeout: false, timeRemaining: () => 12 }));
    expect(result.current).toBe(true);

    unmount();
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
  });

  it("waits for two painted frames when idle callbacks are unavailable", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);

    const { result, unmount } = renderHook(() => useIdleRender());
    expect(result.current).toBe(false);

    act(() => frames[0]?.(0));
    expect(result.current).toBe(false);
    act(() => frames[1]?.(16));
    expect(result.current).toBe(true);

    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
  });

  it("honors a paint grace period before requesting idle time", () => {
    vi.useFakeTimers();
    const requestIdleCallback = vi.fn(() => 23);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    renderHook(() => useIdleRender(800));
    expect(requestIdleCallback).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(799));
    expect(requestIdleCallback).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(requestIdleCallback).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});
