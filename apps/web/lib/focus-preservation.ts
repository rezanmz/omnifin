export interface DocumentScrollPosition {
  left: number;
  top: number;
}

export function captureDocumentScrollPosition(): DocumentScrollPosition {
  return { left: window.scrollX, top: window.scrollY };
}

function restoreImmediately(position: DocumentScrollPosition) {
  const root = document.documentElement;
  const previousBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo(position.left, position.top);
  root.style.scrollBehavior = previousBehavior;
}

export function restoreDocumentScrollPosition(position: DocumentScrollPosition | null) {
  if (!position) return;

  restoreImmediately(position);
  window.requestAnimationFrame(() => {
    restoreImmediately(position);
    window.requestAnimationFrame(() => restoreImmediately(position));
  });
}

export function stabilizeDocumentScrollPosition(
  position: DocumentScrollPosition | null,
  onStop: () => void = () => undefined,
) {
  if (!position) return () => undefined;

  let active = true;
  let frameRequest = 0;
  const stop = () => {
    if (!active) return;
    active = false;
    window.cancelAnimationFrame(frameRequest);
    window.removeEventListener("keydown", stopForDocumentScrollKey);
    window.removeEventListener("scroll", restore);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("touchmove", stop);
    window.removeEventListener("wheel", stop);
    onStop();
  };
  const stopForDocumentScrollKey = (event: KeyboardEvent) => {
    if (event.key === "PageDown" || event.key === "PageUp" || event.key === "Tab") {
      stop();
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return;
    if (
      [" ", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Enter", "Home"].includes(
        event.key,
      )
    )
      stop();
  };
  const restore = () => {
    window.cancelAnimationFrame(frameRequest);
    frameRequest = window.requestAnimationFrame(() => {
      frameRequest = 0;
      if (!active || (window.scrollX === position.left && window.scrollY === position.top)) return;
      restoreImmediately(position);
    });
  };

  window.addEventListener("keydown", stopForDocumentScrollKey);
  window.addEventListener("scroll", restore, { passive: true });
  window.addEventListener("pointerdown", stop, { passive: true });
  window.addEventListener("touchmove", stop, { passive: true });
  window.addEventListener("wheel", stop, { passive: true });
  restoreImmediately(position);
  return stop;
}

export function focusWithoutDocumentScroll(
  target: HTMLElement | null | undefined,
  options: { select?: boolean } = {},
) {
  if (!target) return;

  const position = captureDocumentScrollPosition();
  target.focus({ preventScroll: true });
  if (options.select && target instanceof HTMLInputElement) target.select();
  restoreDocumentScrollPosition(position);
}

export function revealWithinScrollContainer(target: HTMLElement) {
  const scroller = target.closest<HTMLElement>(".search-console__list, .command-palette__groups");
  if (!scroller) return;

  const targetBounds = target.getBoundingClientRect();
  const scrollerBounds = scroller.getBoundingClientRect();
  if (targetBounds.top < scrollerBounds.top) {
    scroller.scrollTop -= scrollerBounds.top - targetBounds.top;
  } else if (targetBounds.bottom > scrollerBounds.bottom) {
    scroller.scrollTop += targetBounds.bottom - scrollerBounds.bottom;
  }
}
