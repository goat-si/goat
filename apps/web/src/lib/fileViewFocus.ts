/**
 * Focus inside a file view: a file surface or its file tree. The tree's rows
 * live in a shadow root, so a key event targets the tree's host element here.
 */
export function isFileViewFocused(
  target: EventTarget | null = typeof document === "undefined" ? null : document.activeElement,
): boolean {
  return (
    typeof Element !== "undefined" &&
    target instanceof Element &&
    target.closest("[data-file-view], [data-file-browser-panel]") !== null
  );
}
