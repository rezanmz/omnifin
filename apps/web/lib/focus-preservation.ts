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
