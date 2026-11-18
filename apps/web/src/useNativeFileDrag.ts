import { AuthOrchestrationOperateScope, type EnvironmentId } from "@goat/contracts";
import { resolvePathLinkTarget, splitFilePathPosition } from "@goat/shared/fileLinks";
import type { DragEvent } from "react";

import { toastManager } from "./components/ui/toast";
import { isMacPlatform } from "./lib/utils";
import { isLocalEnvironmentDisabled } from "./localEnvironment";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "./state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "./state/session";

export function useNativeFileDrag(
  environmentId: EnvironmentId | null | undefined,
  resolvePath: () => string | Promise<string>,
  enabled = true,
) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOperate = useEnvironmentScope(environmentId ?? null, AuthOrchestrationOperateScope);
  const startFileDrag =
    typeof window === "undefined" ? undefined : window.desktopBridge?.startFileDrag;
  if (
    !enabled ||
    typeof startFileDrag !== "function" ||
    !isMacPlatform(navigator.platform) ||
    environmentId == null ||
    environmentId !== primaryEnvironmentId ||
    !canOperate
  ) {
    return {};
  }
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      const chip = event.currentTarget;
      if (chip.ownerDocument !== document || isLocalEnvironmentDisabled()) return;

      event.preventDefault();
      event.stopPropagation();
      const pending = new AbortController();
      for (const endEvent of ["pointerup", "pointercancel", "blur"] as const) {
        window.addEventListener(endEvent, () => pending.abort(), {
          once: true,
          capture: true,
          signal: pending.signal,
        });
      }
      void (async () => {
        const { path } = splitFilePathPosition(await resolvePath());
        if (
          pending.signal.aborted ||
          !chip.isConnected ||
          readPrimaryEnvironmentId() !== environmentId ||
          !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
        ) {
          return;
        }
        const started = await startFileDrag({ environmentId, path });
        if (!started) {
          toastManager.add({ type: "error", title: "The file is unavailable on this Mac" });
        }
      })()
        .catch(() => {
          if (!pending.signal.aborted) {
            toastManager.add({ type: "error", title: "Unable to drag file" });
          }
        })
        .finally(() => pending.abort());
    },
  };
}

export function useNativeMentionDrag(
  environmentId: EnvironmentId | null | undefined,
  path: string,
  cwd: string | null | undefined,
) {
  return useNativeFileDrag(environmentId, () => (cwd ? resolvePathLinkTarget(path, cwd) : path));
}
