import {
  useEffect,
  useEffectEvent,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ResolvedKeybindingsConfig } from "@goat/contracts";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";

// Closed keepMounted popups must stop blocking shortcuts once their exit transition ends.
export const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  "dialog-popup",
  "alert-dialog-popup",
  "command-dialog-popup",
  "menu-popup",
  "select-popup",
  "popover-popup",
  "combobox-popup",
  "autocomplete-popup",
]
  .map((slot) => `[data-slot="${slot}"]:is([data-open],[data-ending-style])`)
  .join(",");

export function useRightPanelNewShortcut(
  props: {
    open?: boolean;
    keybindings: ResolvedKeybindingsConfig;
    getShortcutContext: () => ShortcutMatchContext;
  },
  addSurfaceMenuOpen: boolean,
  setAddSurfaceMenuOpen: Dispatch<SetStateAction<boolean>>,
  addSurfaceTriggerRef: RefObject<HTMLButtonElement | null>,
) {
  const addSurfaceMenuBlocked = () =>
    !addSurfaceMenuOpen && document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS) !== null;
  const onNewSurfaceKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (
      resolveShortcutCommand(event, props.keybindings, {
        context: { ...props.getShortcutContext(), rightPanelOpen: true },
      }) !== "rightPanel.new"
    )
      return;
    if (addSurfaceMenuBlocked()) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      addSurfaceTriggerRef.current?.focus();
      setAddSurfaceMenuOpen(true);
    }
  });
  // Forwarded from a focused browser page. Focusing the trigger here would let ChatView's
  // window-focus handler see a plain button and refocus the composer, closing the menu.
  const onMenuAction = useEffectEvent((action: string) => {
    if (action === "rightPanel.new" && !addSurfaceMenuBlocked()) setAddSurfaceMenuOpen(true);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Subscribe to keyboard and desktop menu events while the panel is open.
  useEffect(() => {
    if (props.open === false) return;
    document.addEventListener("keydown", onNewSurfaceKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction(onMenuAction);
    return () => {
      document.removeEventListener("keydown", onNewSurfaceKeyDown, true);
      unsubscribe?.();
    };
  }, [props.open]);
}
