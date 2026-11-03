import { scopedThreadKey } from "@goat/client-runtime/environment";
import type { ScopedThreadRef } from "@goat/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { create } from "zustand";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { isThreadRoutePathname } from "~/threadRoutes";
import { toastManager } from "~/components/ui/toast";

interface BrowserClaimRequestState {
  pending: { threadKey: string } | null;
  request: (threadRef: ScopedThreadRef) => void;
  consume: (request: { threadKey: string }) => boolean;
}

let stopTracking: (() => void) | undefined;

export const useBrowserClaimRequest = create<BrowserClaimRequestState>((set, get) => ({
  pending: null,
  request: (threadRef) => {
    stopTracking?.();
    stopTracking = undefined;
    set({ pending: { threadKey: scopedThreadKey(threadRef) } });
  },
  consume: (request) => {
    if (get().pending !== request) return false;
    stopTracking?.();
    stopTracking = undefined;
    set({ pending: null });
    return true;
  },
}));

export function openBrowserClaim(threadRef: ScopedThreadRef | null, router: AnyRouter): void {
  if (!threadRef) {
    toastManager.add({ type: "info", title: "Open a thread to let an agent use a browser tab." });
    return;
  }
  useRightPanelStore.getState().open(threadRef, "preview");
  useBrowserClaimRequest.getState().request(threadRef);
  const pending = useBrowserClaimRequest.getState().pending;
  if (!pending) return;
  const cancel = () => useBrowserClaimRequest.getState().consume(pending);
  const stopPanel = useRightPanelStore.subscribe((state) => {
    if (selectActiveRightPanel(state.byThreadKey, threadRef) !== "preview") cancel();
  });
  const stopRoute = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
    if (!isThreadRoutePathname(toLocation.pathname, threadRef)) cancel();
  });
  stopTracking = () => {
    stopPanel();
    stopRoute();
  };
}
