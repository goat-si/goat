import type { MouseEvent } from "react";

export function isSelectionClick(event: MouseEvent<HTMLElement>) {
  if (event.detail === 0) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    if (
      event.currentTarget.contains(range.startContainer) ||
      event.currentTarget.contains(range.endContainer)
    ) {
      return true;
    }
  }
  return false;
}
