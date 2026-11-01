import type { DesktopPreviewCursorEvent, DesktopPreviewPointerEvent } from "@goat/contracts";
import { create } from "zustand";

import {
  attachBrowserPointer,
  detachBrowserPointer,
  reduceBrowserPointer,
  type BrowserPointerOwners,
} from "./browserPointerOrdering";

interface BrowserPointerStoreState extends BrowserPointerOwners {
  readonly byTabId: Record<string, DesktopPreviewPointerEvent>;
  readonly apply: (event: DesktopPreviewCursorEvent) => void;
  readonly clear: (tabId: string) => void;
  readonly detach: (tabId: string) => void;
  readonly attach: (tabId: string) => void;
}

export const useBrowserPointerStore = create<BrowserPointerStoreState>()((set) => ({
  byTabId: {},
  ownerByTabId: {},
  detached: new Set(),
  apply: (event) => set((state) => reduceBrowserPointer(state, event)),
  clear: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTabId)) return state;
      const { [tabId]: _removed, ...byTabId } = state.byTabId;
      return { byTabId };
    }),
  detach: (tabId) => set((state) => detachBrowserPointer(state, tabId)),
  attach: (tabId) => set((state) => attachBrowserPointer(state, tabId)),
}));
