import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useServerConfigs } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { canPromoteThread } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

/** Whether the user may promote this thread: a delegated task on a server that supports it. */
export function useCanPromoteThread(thread: EnvironmentThreadShell | null | undefined): boolean {
  const serverConfigs = useServerConfigs();
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  if (!thread || !canOperate) return false;
  return canPromoteThread(
    thread,
    serverConfigs.get(thread.environmentId)?.environment.capabilities,
  );
}

/**
 * Promotes a delegated task's child thread to a top-level thread, then opens it. The parent
 * hears that the task ended; the thread keeps its history and any running turn.
 */
export function usePromoteThread(): (threadRef: ScopedThreadRef) => Promise<boolean> {
  const promote = useAtomCommand(threadEnvironment.promote, { reportFailure: false });
  const navigate = useNavigate();
  return async (threadRef: ScopedThreadRef) => {
    const result = await promote({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not promote task",
        description: "It may have been promoted or deleted already.",
      });
      return false;
    }
    toastManager.add({ type: "success", title: "Promoted to a thread" });
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    return true;
  };
}
