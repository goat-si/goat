import type { MouseEvent } from "react";

export function isSelectionClick(event: MouseEvent<HTMLElement>) {
  if (event.detail === 0) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!range.collapsed && range.intersectsNode(event.currentTarget)) return true;
  }
  return false;
}
