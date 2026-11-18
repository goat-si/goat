import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewSessionSnapshot, ScopedThreadRef } from "@goat/contracts";
import { rendersServerTabNatively } from "~/browser/previewRuntime";
import { readThreadPreviewState, useThreadPreviewState } from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { previewBridge } from "./previewBridge";

export function canFindPreviewTab(
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
  nativeServerTab: boolean,
): boolean {
  return Boolean(
    (snapshot?.runtime === "desktop" || nativeServerTab) &&
    previewBridge?.findInPage &&
    previewBridge.stopFindInPage &&
    previewBridge.onFindResult,
  );
}

function canFind(
  thread: ScopedThreadRef | null,
  primary: EnvironmentId | null,
  snapshot: PreviewSessionSnapshot | undefined,
) {
  return (
    thread !== null &&
    canFindPreviewTab(snapshot, rendersServerTabNatively(thread.environmentId, primary, snapshot))
  );
}

export function readPreviewFindAvailable(thread: ScopedThreadRef) {
  const surface = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, thread);
  const id = surface?.kind === "preview" ? surface.resourceId : undefined;
  return canFind(
    thread,
    appAtomRegistry.get(primaryEnvironmentIdAtom),
    id ? readThreadPreviewState(thread).sessions[id] : undefined,
  );
}

export function usePreviewFindAvailable(thread: ScopedThreadRef | null) {
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, thread),
  );
  const id = surface?.kind === "preview" ? surface.resourceId : undefined;
  const preview = useThreadPreviewState(thread);
  return canFind(
    thread,
    useAtomValue(primaryEnvironmentIdAtom),
    id ? preview.sessions[id] : undefined,
  );
}
