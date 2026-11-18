import type { DesktopPreviewSetCaptureDrawnInputSchema } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { PreviewTabState } from "./Manager.ts";
import type { DesktopBrowserHost } from "./DesktopBrowserHost.ts";

export function makeTabVisibility(
  tabs: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>,
  host: DesktopBrowserHost["Service"],
  findWebContents: (id: number) => Electron.WebContents | undefined,
) {
  const setShown = Effect.fn("PreviewManager.setShown")(function* (tabId: string, shown: boolean) {
    const serverTab = (yield* SynchronizedRef.get(tabs)).get(tabId)?.serverTab;
    if (serverTab) host.setShown(serverTab, shown);
  });
  const setCaptureDrawn = Effect.fn("PreviewManager.setCaptureDrawn")(function* ({
    tabId,
    webContentsId,
    drawn,
  }: typeof DesktopPreviewSetCaptureDrawnInputSchema.Type) {
    const tab = (yield* SynchronizedRef.get(tabs)).get(tabId);
    if (!tab?.serverTab || tab.webContentsId !== webContentsId) return;
    const guest = findWebContents(webContentsId);
    if (guest && !guest.isDestroyed()) host.setCaptureDrawn(guest, drawn);
  });
  const hideDestroyedGuest = Effect.fn("PreviewManager.hideDestroyedGuest")(function* (
    webContentsId: number,
  ) {
    for (const tab of (yield* SynchronizedRef.get(tabs)).values()) {
      if (tab.webContentsId === webContentsId && tab.serverTab) host.setShown(tab.serverTab, false);
    }
  });
  return { setShown, setCaptureDrawn, hideDestroyedGuest };
}
