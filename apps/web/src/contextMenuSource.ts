import type { ContextMenuShow, ContextMenuSource } from "@goat/contracts";

import { readLocalApi } from "./localApi";

// Menus opened by openContextMenuFromKeyboard; a script-made event cannot keep button -1.
const keyboardContextMenus = new WeakSet<Event>();

type ContextMenuEvent = Pick<MouseEvent, "type" | "button" | "detail"> & {
  readonly nativeEvent?: Event;
};

export function contextMenuSourceOf(event: ContextMenuEvent): ContextMenuSource | undefined {
  if (event.nativeEvent !== undefined && keyboardContextMenus.has(event.nativeEvent)) {
    return "keyboard";
  }
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

/**
 * Opens an element's context menu from the keyboard. Chromium on macOS turns neither
 * Shift+F10 nor the ContextMenu key into a `contextmenu` event, so the key is handled
 * here and the element's own handler receives a menu event that reads as keyboard-opened.
 * Preventing the key keeps other platforms from opening the menu a second time.
 */
export function openContextMenuFromKeyboard(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault"> & {
    readonly currentTarget: Element;
  },
): void {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  const bounds = event.currentTarget.getBoundingClientRect();
  const menu = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: bounds.left,
    clientY: bounds.bottom,
  });
  keyboardContextMenus.add(menu);
  event.currentTarget.dispatchEvent(menu);
}
