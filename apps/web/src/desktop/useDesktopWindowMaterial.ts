import type { DesktopWindowMaterialState } from "@goat/contracts";
import { useEffect, useState } from "react";

// Older desktop builds lack the material bridge; their clients keep the CSS-only settings.
export function hasDesktopWindowMaterialApi(): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  return Boolean(bridge?.getWindowMaterialState && bridge.onWindowMaterialStateChanged);
}

export function useDesktopWindowMaterial() {
  const bridge = window.desktopBridge;
  const available = hasDesktopWindowMaterialApi();
  const [state, setState] = useState<DesktopWindowMaterialState | null>(null);

  useEffect(() => {
    if (!bridge?.getWindowMaterialState || !bridge.onWindowMaterialStateChanged) return;
    let disposed = false;
    const accept = (next: DesktopWindowMaterialState) => {
      if (disposed) return;
      setState((current) => (current && current.revision >= next.revision ? current : next));
    };
    // Pushes can overtake the initial IPC response.
    const unsubscribe = bridge.onWindowMaterialStateChanged(accept);
    void bridge.getWindowMaterialState().then(accept, (error: unknown) => {
      if (!disposed) console.error("Could not read desktop window material.", error);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  return { available, state };
}
