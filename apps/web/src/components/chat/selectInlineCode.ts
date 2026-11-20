import type { MouseEvent as ReactMouseEvent } from "react";

// Native word selection stops at hyphens and dots, so a double-click takes the whole span.
export function selectInlineCode(event: ReactMouseEvent<HTMLElement>) {
  window.getSelection()?.selectAllChildren(event.currentTarget);
}
