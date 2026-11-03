import { scopedThreadKey } from "@goat/client-runtime/environment";
import type { ScopedThreadRef } from "@goat/contracts";
import { create } from "zustand";
import { useRightPanelStore } from "~/rightPanelStore";
import { toastManager } from "~/components/ui/toast";

interface BrowserClaimRequestState {
  pending: { threadKey: string } | null;
  request: (threadRef: ScopedThreadRef) => void;
  consume: (request: { threadKey: string }) => boolean;
}

export const useBrowserClaimRequest = create<BrowserClaimRequestState>((set, get) => ({
  pending: null,
  request: (threadRef) => set({ pending: { threadKey: scopedThreadKey(threadRef) } }),
  consume: (request) => {
    if (get().pending !== request) return false;
    set({ pending: null });
    return true;
  },
}));

export function openBrowserClaim(threadRef: ScopedThreadRef | null): void {
  if (!threadRef) {
    toastManager.add({ type: "info", title: "Open a thread to let an agent use a browser tab." });
    return;
  }
  useBrowserClaimRequest.getState().request(threadRef);
  useRightPanelStore.getState().open(threadRef, "preview");
}
