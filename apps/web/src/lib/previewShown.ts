import type { ScopedThreadRef } from "@goat/contracts";

import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "../state/entities";

// The previewOpen shortcut context matches ChatView: a remembered preview tab counts
// only where a browser can render it.
export function readPreviewShown(threadRef: ScopedThreadRef): boolean {
  return (
    selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview" &&
    (isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(threadRef.environmentId))
  );
}

export function useRoutePreviewShown(threadRef: ScopedThreadRef | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(threadRef?.environmentId ?? null);
  const panel = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "preview",
  );
  return panel && (isPreviewSupportedInRuntime() || serverBrowser);
}
