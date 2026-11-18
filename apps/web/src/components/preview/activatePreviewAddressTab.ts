import { scopedThreadKey, type ScopedThreadRef } from "@goat/client-runtime/environment";
import { readThreadPreviewState, setActivePreviewTab } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

export function activatePreviewAddressTab(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  targetTabId: string,
): boolean {
  const threadKey = scopedThreadKey(threadRef);
  const current = readThreadPreviewState(threadRef);
  if (current.serverEpoch !== serverEpoch || !current.sessions[targetTabId]) return false;
  const panel = useRightPanelStore.getState();
  const surface = panel.byThreadKey[threadKey]?.surfaces.find(
    (entry) => entry.kind === "preview" && entry.resourceId === targetTabId,
  );
  if (!surface) return false;
  setActivePreviewTab(threadRef, targetTabId);
  panel.activateSurface(threadRef, surface.id);
  return true;
}
