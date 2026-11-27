import { useEffect, useEffectEvent } from "react";
import { subscribePanelMenuAction } from "~/lib/panelMenuActions";

export function useDesktopPanelMenu(
  enabled: boolean,
  toggle: () => void,
  maximize: () => void,
  close: () => void,
) {
  const onClose = useEffectEvent(close);
  // oxlint-disable-next-line goat/react-effect-budget -- Subscribe to desktop menu and command palette panel actions while this thread is active.
  useEffect(() => {
    if (!enabled) return;
    const onAction = (action: string) => {
      if (action === "rightPanel.toggle") toggle();
      else if (action === "rightPanel.toggleMaximized") maximize();
      else if (action === "rightPanel.close") onClose();
    };
    const unsubscribeMenu = window.desktopBridge?.onMenuAction(onAction);
    const unsubscribePalette = subscribePanelMenuAction(onAction);
    return () => {
      unsubscribeMenu?.();
      unsubscribePalette();
    };
  }, [enabled, toggle, maximize]);
}
