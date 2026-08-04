import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiquidGlassEnvironment } from "./liquid-glass-environment";

describe("LiquidGlassEnvironment", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-liquid-glass-ready");
    window.history.replaceState(null, "", "/");
    window.sessionStorage.removeItem("omnifin-test-material");
    vi.restoreAllMocks();
  });

  it("keeps expensive backdrop refinement out of the initial content paint", async () => {
    let animationCallback: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationCallback = callback;
      return 17;
    });
    window.history.replaceState(null, "", "/?test-view=ready");

    render(<LiquidGlassEnvironment />);

    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
    fireEvent.pointerMove(document.body, { clientX: 12, clientY: 18 });
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
    fireEvent.scroll(document);
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
    vi.mocked(window.requestAnimationFrame).mockClear();

    fireEvent.pointerDown(document.body);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    fireEvent.pointerUp(document.body);
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");

    act(() => animationCallback?.(performance.now()));
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-liquid-glass-ready"),
    );
  });

  it("cancels a pending material refinement when it unmounts", () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(23);
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame");
    const view = render(<LiquidGlassEnvironment />);

    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    fireEvent.keyUp(document.body, { key: "Tab" });
    view.unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(23);
    expect(document.documentElement).not.toHaveAttribute("data-liquid-glass-ready");
  });

  it("settles material fixtures only when the visual harness opts in", async () => {
    let animationCallback: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationCallback = callback;
      return 31;
    });
    window.sessionStorage.setItem("omnifin-test-material", "settled");

    render(<LiquidGlassEnvironment />);

    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    act(() => animationCallback?.(performance.now()));
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-liquid-glass-ready"),
    );
  });
});
