import { scopedThreadKey } from "@goat/client-runtime/environment";
import type { ScopedThreadRef } from "@goat/contracts";

import {
  browserMiniPlayerSource,
  type PreviewMiniPlayerSource,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import { readThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { openPreviewSessionStack } from "./sessions/previewSessionStackStore";

/**
 * Who asks to show a preview outside the thread's panel: a person's own action, or an agent's
 * work (a tab it opened or revealed, a device it started). A forced agent reveal counts as asked.
 */
export type FloatPreviewRequest =
  | { readonly by: "person" }
  | { readonly by: "agent"; readonly force?: boolean };

/**
 * The one rule for showing a preview outside the panel. A browser tab an agent drives shows as its
 * thread's agents-on-screen card, small like computer use, whoever asks; only the person's own
 * Enlarge, click on the picture or Take over makes it large. A device has no
 * agent card yet, so a device an agent started opens as a background panel tab; only a person's
 * own request floats one. Everything else floats in the thread's mini player.
 */
export function floatPreview(
  threadRef: ScopedThreadRef,
  source: PreviewMiniPlayerSource,
  request: FloatPreviewRequest,
): void {
  if (source.kind === "browser") {
    const tab = readThreadPreviewState(threadRef).sessions[source.tabId];
    if (tab?.automationOwner !== undefined) {
      openPreviewSessionStack({
        environmentId: threadRef.environmentId,
        focus: { kind: "browser", threadId: threadRef.threadId, tabId: source.tabId },
        automatic: request.by === "agent" && request.force !== true,
        scope: request.by === "agent" ? "thread" : "window",
      });
      return;
    }
  } else if (request.by === "agent") {
    const { kind: _kind, ...target } = source;
    const shown = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.some(
        (surface) =>
          surface.kind === "device" &&
          surface.target?.hostId === target.hostId &&
          surface.target.deviceId === target.deviceId,
      );
    if (!shown) useRightPanelStore.getState().openDevice(threadRef, target, true);
    return;
  }
  usePreviewMiniPlayerStore.getState().open(threadRef, source);
}

export const floatBrowserTab = (
  threadRef: ScopedThreadRef,
  tabId: string,
  request: FloatPreviewRequest,
) => floatPreview(threadRef, browserMiniPlayerSource(tabId), request);
