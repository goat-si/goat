import type { ContextMenuShow, ContextMenuSource } from "@goat/contracts";

import { readLocalApi } from "./localApi";

type ContextMenuEvent = Pick<MouseEvent, "type" | "button" | "detail">;

// Chromium uses no button for keyboard context menus and zero clicks for keyboard activation.
export function contextMenuSourceOf(event: ContextMenuEvent): ContextMenuSource {
  return (event.type === "click" ? event.detail === 0 : event.button === -1) ? "keyboard" : "mouse";
}

export function contextMenuForEvent(event: ContextMenuEvent): ContextMenuShow | undefined {
  const api = readLocalApi();
  if (!api) return undefined;
  const source = contextMenuSourceOf(event);
  return (items, position) => api.contextMenu.show(items, position, source);
}
