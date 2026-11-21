import { scopeThreadRef } from "@goat/client-runtime/environment";
import { WORKTREE_HOLDER_SCAN_LIMIT, type ScopedThreadRef, type ProjectId } from "@goat/contracts";
import { resolveWorktreeCleanup } from "@goat/shared/projectSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { readThreadShell } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

const MAX_NAMED_HOLDERS = 5;

export function useThreadWorktreeConfirmation() {
  const loadHolders = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
  });
  const loadTitles = useAtomQueryRunner(orchestrationEnvironment.threadTitleLookup, {
    reportFailure: false,
    refresh: true,
  });
  return async (
    target: ScopedThreadRef,
    thread: { worktreePath: string | null; projectId: ProjectId } | null,
  ) => {
    if (!thread?.worktreePath) return { lines: [], keepWorktree: false };
    const worktreePath = thread.worktreePath;
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId);
    const automaticCleanup = config?.settings
      ? resolveWorktreeCleanup(config.settings, thread.projectId).worktreeOnDelete
      : false;
    const lines: string[] = [];
    const occupants = await loadHolders({
      environmentId: target.environmentId,
      input: { worktreePath },
    });
    if (occupants._tag !== "Success")
      return {
        lines: [
          automaticCleanup
            ? "The server's automatic cleanup setting may still remove the worktree."
            : "The worktree will be kept.",
        ],
        keepWorktree: true,
      };
    const unguarded = occupants.value.removalGuarded !== true;
    if (unguarded || occupants.value.managed !== true)
      lines.push(
        unguarded && automaticCleanup
          ? "The server's automatic cleanup setting may still remove the worktree."
          : "The worktree will be kept.",
      );
    const ids = occupants.value.threadIds.filter((id) => id !== target.threadId);
    if (ids.length > WORKTREE_HOLDER_SCAN_LIMIT)
      throw new Error("Too many threads use this worktree to confirm deletion.");
    const shown = ids.slice(0, MAX_NAMED_HOLDERS);
    const missing = shown.filter(
      (id) => readThreadShell(scopeThreadRef(target.environmentId, id)) === null,
    );
    let titles: Record<string, string> = {};
    if (missing.length > 0) {
      const answer = await loadTitles({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, lookupOnly: true, lookupThreadIds: missing },
      });
      if (answer._tag === "Success") titles = answer.value.lookupTitles ?? {};
    }
    for (const id of shown) {
      const holder = readThreadShell(scopeThreadRef(target.environmentId, id));
      const kind = holder?.sideChatOf === target.threadId ? "side chat" : "thread";
      lines.push(
        `Worktree kept because ${kind} "${holder?.title ?? titles[id] ?? id}" still uses it.`,
      );
    }
    if (ids.length > shown.length)
      lines.push(`The worktree is kept for these and ${ids.length - shown.length} more threads.`);
    return {
      lines,
      keepWorktree: unguarded || occupants.value.managed !== true || ids.length > 0,
    };
  };
}
