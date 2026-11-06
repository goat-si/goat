import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { PreviewTabState } from "./Manager.ts";
import type { DesktopBrowserHost } from "./DesktopBrowserHost.ts";

export function makeTabVisibility(
  tabs: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>,
  host: DesktopBrowserHost["Service"],
) {
  const setShown = Effect.fn("PreviewManager.setShown")(function* (tabId: string, shown: boolean) {
    const serverTab = (yield* SynchronizedRef.get(tabs)).get(tabId)?.serverTab;
    if (serverTab) host.setShown(serverTab, shown);
  });
  const hideDestroyedGuest = Effect.fn("PreviewManager.hideDestroyedGuest")(function* (
    webContentsId: number,
  ) {
    for (const tab of (yield* SynchronizedRef.get(tabs)).values()) {
      if (tab.webContentsId === webContentsId && tab.serverTab) host.setShown(tab.serverTab, false);
    }
  });
  return { setShown, hideDestroyedGuest };
}
