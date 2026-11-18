import {
  type PreviewAdjustInput,
  PreviewControlRequiredError,
  PreviewSessionLookupError,
  PreviewStopLoadingError,
  type PreviewError,
  type PreviewSessionSnapshot,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { PreviewManager } from "./Manager.ts";
import { tabKey } from "./ServerBrowserPointer.ts";
import type { ServerTab } from "./ServerBrowserTab.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

export interface NativePreviewAdjustment {
  readonly adjustPreview: (
    input: PreviewAdjustInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
}

export function makeNativePreviewAdjustment(
  tabs: ReadonlyMap<string, ServerTab>,
  manager: PreviewManager["Service"],
  stopLoading: (tab: ServerTab, session: ServerTab["cdp"]) => Promise<void>,
): NativePreviewAdjustment["adjustPreview"] {
  return Effect.fn("ServerBrowser.adjustPreview")(function* (input) {
    if (!input.stopLoading) return yield* manager.adjust(input);
    const { threadId, tabId } = input;
    const tab = tabs.get(tabKey(threadId, tabId));
    const missing = new PreviewSessionLookupError({ threadId, tabId });
    if (!tab) return yield* missing;
    if (!tab.desktop) return yield* new PreviewControlRequiredError({ tabId });
    yield* Effect.tryPromise({
      try: () => tab.control.nativeViewer(() => stopLoading(tab, tab.cdp)),
      catch: (cause) =>
        cause instanceof BrowserControlInterrupted
          ? new PreviewControlRequiredError({ tabId })
          : new PreviewStopLoadingError({ tabId, cause }),
    });
    const preview = yield* manager.list({ threadId });
    return preview.sessions.find((snapshot) => snapshot.tabId === tabId) ?? (yield* missing);
  });
}
