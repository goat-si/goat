import type { ContextMenuShow, ContextMenuSource } from "@goat/contracts";

import { readLocalApi } from "./localApi";

type ContextMenuEvent = Pick<MouseEvent, "type" | "button" | "detail">;

export function contextMenuSourceOf(event: ContextMenuEvent): ContextMenuSource | undefined {
  if (event.type === "click") return event.detail === 0 ? "keyboard" : "mouse";
  if (event.button === -1) return "keyboard";
  // Other browser engines can report a pointer button for a keyboard context menu.
  return window.desktopBridge ? "mouse" : undefined;
}

export function contextMenuForEvent(event: ContextMenuEvent): ContextMenuShow | undefined {
  const api = readLocalApi();
  if (!api) return undefined;
  const source = contextMenuSourceOf(event);
  return (items, position) => api.contextMenu.show(items, position, source);
}
