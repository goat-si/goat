import { scopeProjectRef } from "@goat/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { NewThreadHandler } from "./useHandleNewThread";

/** "New thread on <branch>": a draft in the thread's project, branch and checkout. */
export async function startThreadOnBranch(
  handleNewThread: NewThreadHandler,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "branch" | "worktreePath">,
): Promise<void> {
  const result = await settlePromise(() =>
    handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      envMode: thread.worktreePath ? "worktree" : "local",
      startFromOrigin: false,
    }),
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not create thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}
