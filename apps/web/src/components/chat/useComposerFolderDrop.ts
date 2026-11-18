import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@goat/contracts";
import { serializeComposerFileLink } from "@goat/shared/composerTrigger";
import { useLayoutEffect, useRef } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { readPreparedConnection } from "../../state/session";
import { toastManager } from "../ui/toast";
import { folderDropTarget, insertDroppedComposerFolders } from "./folderDrop";
import { pendingDraftWork } from "./pendingDraftWork";

export function useComposerFolderDrop(input: {
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
  draftKey: string;
  insertAtEnd: (text: string, options: { ensureLeadingBoundary: true }) => boolean;
  focus: () => void;
}): (folders: File[]) => void {
  const { environmentId, primaryEnvironmentId, draftKey, insertAtEnd, focus } = input;
  const currentDrop = useRef<{
    draftKey: string;
    environmentId: EnvironmentId;
    signal: AbortSignal;
  } | null>(null);
  // A conversion can outlive the draft, even if the user switches away and back.
  // oxlint-disable-next-line goat/react-effect-budget -- invalidates pending IPC on draft changes
  useLayoutEffect(() => {
    const controller = new AbortController();
    currentDrop.current = { draftKey, environmentId, signal: controller.signal };
    return () => controller.abort();
  }, [draftKey, environmentId]);

  return useStableCallback((folders: File[]) => {
    const active = currentDrop.current;
    if (active?.draftKey !== draftKey || active.environmentId !== environmentId) return;
    const { signal } = active;
    if (signal.aborted) return;
    const bridge = window.desktopBridge;
    const primaryRunsInWsl =
      environmentId === primaryEnvironmentId &&
      bridge
        ?.getLocalEnvironmentBootstraps()
        .some(
          (entry) =>
            entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID && typeof entry.runningDistro === "string",
        );
    const target = folderDropTarget({
      localEnvironmentDisabled: isLocalEnvironmentDisabled(),
      environmentId,
      primaryEnvironmentId,
      connection: readPreparedConnection(environmentId),
      isDesktopRenderer: bridge !== undefined,
      primaryRunsInWsl: primaryRunsInWsl === true,
    });
    if (target === "remote") {
      toastManager.add({
        type: "error",
        title: "Folders can only be referenced on a server running on this computer",
      });
      return;
    }

    pendingDraftWork.begin(draftKey);
    void insertDroppedComposerFolders({
      folders,
      target,
      signal,
      bridge,
      onUnavailable: (folder) => {
        toastManager.add({
          type: "error",
          title: `Couldn't get the path of "${folder.name}"`,
          description: "Type the folder path with @ instead.",
        });
      },
      insert: (path) => {
        const inserted = insertAtEnd(`${serializeComposerFileLink(path)} `, {
          ensureLeadingBoundary: true,
        });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add folder",
            description: "The composer is busy; try again once it is ready.",
          });
        }
        return inserted;
      },
    }).finally(() => {
      pendingDraftWork.end(draftKey);
      if (!signal.aborted) focus();
    });
  });
}
