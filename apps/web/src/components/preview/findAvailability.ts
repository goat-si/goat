import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentId, PreviewSessionSnapshot, ScopedThreadRef } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { rendersServerTabNatively } from "~/browser/previewRuntime";
import { previewStateAtom, readThreadPreviewState } from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { previewBridge } from "./previewBridge";

const hasFindBridge = Boolean(
  previewBridge?.findInPage && previewBridge.stopFindInPage && previewBridge.onFindResult,
);
const noPreviewFindAtom = Atom.make(false);

export function canFindPreviewTab(
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
  nativeServerTab: boolean,
): boolean {
  return hasFindBridge && (snapshot?.runtime === "desktop" || nativeServerTab);
}

function canFind(
  environmentId: EnvironmentId,
  primary: EnvironmentId | null,
  snapshot: PreviewSessionSnapshot | undefined,
) {
  return canFindPreviewTab(snapshot, rendersServerTabNatively(environmentId, primary, snapshot));
}

const previewFindAtom = Atom.family(
  ([threadKey, environmentId, tabId]: readonly [string, EnvironmentId, string]) =>
    Atom.make((get) =>
      canFind(
        environmentId,
        get(primaryEnvironmentIdAtom),
        get(previewStateAtom(threadKey)).sessions[tabId],
      ),
    ),
);

export function readPreviewFindAvailable(thread: ScopedThreadRef) {
  if (!hasFindBridge) return false;
  const surface = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, thread);
  if (surface?.kind !== "preview" || !surface.resourceId) return false;
  return canFind(
    thread.environmentId,
    appAtomRegistry.get(primaryEnvironmentIdAtom),
    readThreadPreviewState(thread).sessions[surface.resourceId],
  );
}

export function usePreviewFindAvailable(thread: ScopedThreadRef | null) {
  const tabId = useRightPanelStore((state) => {
    if (!hasFindBridge || !thread) return null;
    const surface = selectActiveRightPanelSurface(state.byThreadKey, thread);
    return surface?.kind === "preview" ? surface.resourceId : null;
  });
  return useAtomValue(
    thread && tabId
      ? previewFindAtom([scopedThreadKey(thread), thread.environmentId, tabId])
      : noPreviewFindAtom,
  );
}
