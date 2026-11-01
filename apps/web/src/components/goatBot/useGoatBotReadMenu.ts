import type { ContextMenuItem } from "@goat/contracts";
import { useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

import { readLocalApi } from "~/localApi";

import { useMarkGoatBotRead } from "./useGoatBotWaitingCount";

type GoatBotReadMenuAction = "mark-read";

const isMenuKey = (event: KeyboardEvent) =>
  event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

/**
 * Right-click (or Shift+F10 / the menu key) on a GOAT Bot entry: "Mark all as read" clears its
 * waiting badge for every client. Disabled with nothing unread; absent on servers that cannot
 * count read tasks, so the platform menu stays.
 */
export function useGoatBotReadMenu(count: number | undefined) {
  const markRead = useMarkGoatBotRead();
  const unread = count !== undefined && count > 0;
  const open = useRef(false);
  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || !markRead || open.current) return;
    const items: ContextMenuItem<GoatBotReadMenuAction>[] = [
      { id: "mark-read", label: "Mark all as read", disabled: !unread },
    ];
    open.current = true;
    const action = await api.contextMenu.show(items, position).catch(() => null);
    open.current = false;
    if (action === "mark-read") await markRead();
  };
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    // Keyboard-opened context menus report the origin; anchor those to the item.
    void showMenu(
      event.clientX === 0 && event.clientY === 0
        ? { x: bounds.left, y: bounds.bottom }
        : { x: event.clientX, y: event.clientY },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isMenuKey(event)) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    void showMenu({ x: bounds.left, y: bounds.bottom });
  };
  return markRead === null ? {} : { onContextMenu, onKeyDown };
}
