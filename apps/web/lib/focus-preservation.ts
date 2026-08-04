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
  frameLimit = 24,
) {
  if (!position || frameLimit < 1) return () => undefined;

  let active = true;
  let frame = 0;
  let frameRequest = 0;
  const stop = () => {
    if (!active) return;
    active = false;
    window.cancelAnimationFrame(frameRequest);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("touchmove", stop);
    window.removeEventListener("wheel", stop);
  };
  const restore = () => {
    if (!active) return;
    restoreImmediately(position);
    frame += 1;
    if (frame >= frameLimit) {
      stop();
      return;
    }
    frameRequest = window.requestAnimationFrame(restore);
  };

  window.addEventListener("pointerdown", stop, { passive: true });
  window.addEventListener("touchmove", stop, { passive: true });
  window.addEventListener("wheel", stop, { passive: true });
  restore();
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
