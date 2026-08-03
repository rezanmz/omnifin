import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiquidGlassEnvironment } from "./liquid-glass-environment";

describe("LiquidGlassEnvironment", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-liquid-glass-ready");
    vi.restoreAllMocks();
  });

  it("keeps expensive backdrop refinement out of the initial content paint", () => {
    let animationCallback: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationCallback = callback;
      return 17;
    });

    render(<LiquidGlassEnvironment />);

    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
    fireEvent.pointerMove(document.body, { clientX: 12, clientY: 18 });
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
    fireEvent.scroll(document);
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
    vi.mocked(window.requestAnimationFrame).mockClear();

    fireEvent.pointerDown(document.body);
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");

    act(() => animationCallback?.(performance.now()));
    expect(document.documentElement).toHaveAttribute("data-liquid-glass-ready");
  });

  it("cancels a pending material refinement when it unmounts", () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(23);
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame");
    const view = render(<LiquidGlassEnvironment />);

    fireEvent.keyDown(document.body, { key: "Tab" });
    view.unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(23);
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
  });
});
