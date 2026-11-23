import { useEffect, useEffectEvent } from "react";

export function useDesktopPanelMenu(
  enabled: boolean,
  toggle: () => void,
  maximize: () => void,
  close: () => void,
) {
  const onClose = useEffectEvent(close);
  // oxlint-disable-next-line goat/react-effect-budget -- Subscribe to desktop menu events while this thread is active.
  useEffect(() => {
    if (!enabled) return;
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggle();
      else if (action === "rightPanel.toggleMaximized") maximize();
      else if (action === "rightPanel.close") onClose();
    });
  }, [enabled, toggle, maximize]);
}
