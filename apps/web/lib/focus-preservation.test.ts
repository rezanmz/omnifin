import { describe, expect, it, vi } from "vitest";

import { stabilizeDocumentScrollPosition } from "./focus-preservation";

describe("document scroll stabilization", () => {
  it("guards delayed browser scroll until the user signals scroll intent", () => {
    let scrollLeft = 0;
    let scrollTop = 1_200;
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const originalScrollX = Object.getOwnPropertyDescriptor(window, "scrollX");
    const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    const input = document.createElement("input");
    const link = document.createElement("a");
    Object.defineProperties(window, {
      scrollX: { configurable: true, get: () => scrollLeft },
      scrollY: { configurable: true, get: () => scrollTop },
    });
    vi.mocked(window.scrollTo).mockImplementation(((left: number, top?: number) => {
      scrollLeft = left;
      scrollTop = top ?? scrollTop;
    }) as typeof window.scrollTo);
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const frame = nextFrame++;
        frames.set(frame, callback);
        return frame;
      });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });
    const flushFrame = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    };

    document.body.append(input, link);
    try {
      const onStop = vi.fn();
      const stop = stabilizeDocumentScrollPosition({ left: 0, top: 1_200 }, onStop);
      for (let frame = 0; frame < 25; frame += 1) flushFrame();

      scrollTop = 88;
      window.dispatchEvent(new Event("scroll"));
      flushFrame();
      expect(scrollTop).toBe(1_200);

      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" }));
      scrollTop = 72;
      window.dispatchEvent(new Event("scroll"));
      flushFrame();
      expect(scrollTop).toBe(72);
      stop();
      expect(onStop).toHaveBeenCalledOnce();

      const stopTypingGuard = stabilizeDocumentScrollPosition({ left: 0, top: 72 });
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "m" }));
      scrollTop = 31;
      window.dispatchEvent(new Event("scroll"));
      flushFrame();
      expect(scrollTop).toBe(72);

      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
      scrollTop = 12;
      window.dispatchEvent(new Event("scroll"));
      flushFrame();
      expect(scrollTop).toBe(12);
      stopTypingGuard();

      const stopNavigationGuard = stabilizeDocumentScrollPosition({ left: 0, top: 12 });
      link.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      scrollTop = 8;
      window.dispatchEvent(new Event("scroll"));
      flushFrame();
      expect(scrollTop).toBe(8);
      stopNavigationGuard();

      const stopWheelGuard = stabilizeDocumentScrollPosition({ left: 0, top: 8 });
      window.dispatchEvent(new WheelEvent("wheel"));
      scrollTop = 4;
      window.dispatchEvent(new Event("scroll"));
      flushFrame();
      expect(scrollTop).toBe(4);
      stopWheelGuard();
    } finally {
      input.remove();
      link.remove();
      frames.clear();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.mocked(window.scrollTo).mockReset();
      if (originalScrollX) Object.defineProperty(window, "scrollX", originalScrollX);
      if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY);
    }
  });
});
