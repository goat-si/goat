import type { ScopedThreadRef } from "@goat/contracts";

import { whenPreviewTabKnown } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { floatBrowserTab } from "./floatPreview";

export function showPreviewPopup(
  threadRef: ScopedThreadRef,
  popupTabId: string,
  from: "panel" | "floating",
): void {
  whenPreviewTabKnown(threadRef, popupTabId, () => {
    if (from === "floating") {
      // The page opened it, so a popup an agent drives follows its tab into the agent's card.
      floatBrowserTab(threadRef, popupTabId, { by: "agent" });
    } else {
      useRightPanelStore.getState().openBrowser(threadRef, popupTabId);
    }
  });
}
