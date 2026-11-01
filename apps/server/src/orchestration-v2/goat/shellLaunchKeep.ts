import type { OrchestrationV2ThreadShell } from "@goat/contracts";

type ThreadShell = OrchestrationV2ThreadShell;

// Launch records from another machine name that machine's thread, so only null means this one.
function localLauncherId(thread: ThreadShell): string | null {
  const launcher = thread.launchedBy;
  return launcher?.kind === "launch" &&
    launcher.via !== "delegate_task" &&
    launcher.environmentId === null
    ? launcher.threadId
    : null;
}

/**
 * Adds back what a sidebar launch fold walks through above each kept row: the thread on this
 * machine that launched it, that launcher's subagent parents, and their own launchers. Without
 * them a cold connect shows a launched thread outside its launcher's group and badge.
 */
export function keepLocalLaunchers(
  all: ReadonlyArray<ThreadShell>,
  kept: ReadonlyArray<ThreadShell>,
): ReadonlyArray<ThreadShell> {
  const byId = new Map<string, ThreadShell>(all.map((thread) => [thread.id, thread]));
  const keep = new Set<string>(kept.map((thread) => thread.id));
  const pending = [...kept];
  let added = false;
  for (let thread = pending.pop(); thread !== undefined; thread = pending.pop()) {
    const parentId =
      thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
    for (const id of [localLauncherId(thread), parentId]) {
      const row = id === null || keep.has(id) ? undefined : byId.get(id);
      if (row === undefined) continue;
      keep.add(row.id);
      pending.push(row);
      added = true;
    }
  }
  return added ? all.filter((thread) => keep.has(thread.id)) : kept;
}
