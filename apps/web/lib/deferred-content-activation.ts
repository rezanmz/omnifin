const CONTENT_NAVIGATION_KEYS = new Set([" ", "ArrowDown", "End", "PageDown"]);

export function isDeferredContentNavigation(event: KeyboardEvent) {
  if (!CONTENT_NAVIGATION_KEYS.has(event.key)) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest('input, textarea, select, [contenteditable="true"]');
}
