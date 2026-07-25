import type { KeyboardEvent } from "react";

type DirectionalAxis = "grid" | "horizontal" | "vertical";

interface DirectionalFocusOptions {
  axis: DirectionalAxis;
  itemSelector?: string;
  scrollContainerSelector?: string;
}

const defaultItemSelector = "[data-directional-item]";

function isTextEditingArrow(target: HTMLElement, key: string) {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) {
    return false;
  }

  if (key === "Home" || key === "End" || key === "ArrowUp" || key === "ArrowDown") {
    return true;
  }

  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? start;
  return key === "ArrowLeft" ? start > 0 : key === "ArrowRight" ? end < target.value.length : false;
}

function center(element: HTMLElement) {
  const rectangle = element.getBoundingClientRect();
  return {
    height: rectangle.height,
    width: rectangle.width,
    x: rectangle.left + rectangle.width / 2,
    y: rectangle.top + rectangle.height / 2,
  };
}

function findSpatialTarget(items: HTMLElement[], currentIndex: number, key: string) {
  const current = center(items[currentIndex]!);
  let best: { element: HTMLElement; score: number } | undefined;

  for (const [index, element] of items.entries()) {
    if (index === currentIndex) continue;
    const candidate = center(element);
    const horizontal = candidate.x - current.x;
    const vertical = candidate.y - current.y;
    const inDirection =
      (key === "ArrowLeft" && horizontal < -1) ||
      (key === "ArrowRight" && horizontal > 1) ||
      (key === "ArrowUp" && vertical < -1) ||
      (key === "ArrowDown" && vertical > 1);
    if (!inDirection) continue;

    const primary =
      key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(horizontal) : Math.abs(vertical);
    const secondary =
      key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(vertical) : Math.abs(horizontal);
    const score = primary + secondary * 2.4;
    if (!best || score < best.score) best = { element, score };
  }

  return best?.element;
}

function linearTarget(
  items: HTMLElement[],
  currentIndex: number,
  key: string,
  axis: DirectionalAxis,
) {
  const movesBackward = key === "ArrowLeft" || key === "ArrowUp";
  const movesForward = key === "ArrowRight" || key === "ArrowDown";
  const keyMatchesAxis =
    axis === "grid" ||
    (axis === "horizontal" && (key === "ArrowLeft" || key === "ArrowRight")) ||
    (axis === "vertical" && (key === "ArrowUp" || key === "ArrowDown"));
  if (!keyMatchesAxis) return undefined;
  if (movesBackward) return items[Math.max(0, currentIndex - 1)];
  if (movesForward) return items[Math.min(items.length - 1, currentIndex + 1)];
  return undefined;
}

function scrollFocusedItem(target: HTMLElement, scope: HTMLElement, selector?: string) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (selector) {
    const scroller =
      scope.closest<HTMLElement>(selector) ?? scope.querySelector<HTMLElement>(selector);
    if (scroller && typeof scroller.scrollTo === "function") {
      const targetCenter = target.offsetLeft + target.offsetWidth / 2;
      scroller.scrollTo({
        behavior: reducedMotion ? "auto" : "smooth",
        left: Math.max(0, targetCenter - scroller.clientWidth / 2),
      });
    }
  }

  target.scrollIntoView?.({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "nearest",
    inline: "nearest",
  });
}

export function handleDirectionalFocus(
  event: KeyboardEvent<HTMLElement>,
  { axis, itemSelector = defaultItemSelector, scrollContainerSelector }: DirectionalFocusOptions,
) {
  const { key } = event;
  if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(key)) {
    return;
  }

  const eventTarget = event.target;
  if (!(eventTarget instanceof HTMLElement) || isTextEditingArrow(eventTarget, key)) return;
  const current = eventTarget.closest<HTMLElement>(itemSelector);
  const scope = event.currentTarget;
  if (!current || !scope.contains(current)) return;

  const items = Array.from(scope.querySelectorAll<HTMLElement>(itemSelector)).filter(
    (item) => !item.hidden && item.getAttribute("aria-hidden") !== "true",
  );
  const currentIndex = items.indexOf(current);
  if (currentIndex < 0 || items.length === 0) return;

  let target = key === "Home" ? items[0] : key === "End" ? items.at(-1) : undefined;
  if (!target && axis === "grid") {
    target = findSpatialTarget(items, currentIndex, key);
  }
  target ??= linearTarget(items, currentIndex, key, axis);

  const recognizedForAxis =
    key === "Home" ||
    key === "End" ||
    axis === "grid" ||
    (axis === "horizontal" && (key === "ArrowLeft" || key === "ArrowRight")) ||
    (axis === "vertical" && (key === "ArrowUp" || key === "ArrowDown"));
  if (!recognizedForAxis) return;

  event.preventDefault();
  if (!target || target === current) return;
  target.focus({ preventScroll: true });
  scrollFocusedItem(target, scope, scrollContainerSelector);
}
