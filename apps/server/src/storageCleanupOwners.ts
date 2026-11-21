import type { OrchestrationV2ThreadShell } from "@goat/contracts";

/** Only a complete subagent chain within this worktree shares ownership. */
export function worktreeOwner<T extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">>(
  threads: ReadonlyArray<T>,
) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter(
    (thread) => thread.lineage.parentThreadId === null || !byId.has(thread.lineage.parentThreadId),
  );
  if (tops.length !== 1) return undefined;
  const owner = tops[0];
  if (owner === undefined) return undefined;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        current.lineage.relationshipToParent !== "subagent" ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent =
        current.lineage.parentThreadId === null
          ? undefined
          : byId.get(current.lineage.parentThreadId);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}
