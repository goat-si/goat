import type {
  OrchestrationV2ThreadShell,
  OrchestratorMcpThreadFoldState,
  ThreadId,
} from "@goat/contracts";
import {
  foldsUnderLauncher,
  type LaunchAttention,
  type LaunchLift,
  launchLiftInputOfShell,
  launchStateOfLift,
  moreUrgentLaunchLift,
  ownLaunchLift,
  staysFoldedUnderLauncher,
} from "@goat/shared/threadLaunchState";
import type { ProjectionLaunchEdge } from "../orchestration-v2/ProjectionLaunchEdges.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";

type Edge = Pick<ProjectionLaunchEdge, "id" | "lineage" | "launchedBy" | "pinnedAt">;

/** The thread that started this one with thread.launch, create_threads or ssh.thread_launch. */
export function launcherThreadIdOf(thread: Pick<Edge, "launchedBy" | "lineage">): ThreadId | null {
  const launcher = thread.launchedBy;
  return launcher !== undefined &&
    foldsUnderLauncher({ lineage: thread.lineage, launchedBy: launcher })
    ? launcher.threadId
    : null;
}

const push = (map: Map<ThreadId, ThreadId[]>, key: ThreadId, value: ThreadId) =>
  map.set(key, [...(map.get(key) ?? []), value]);

/**
 * The sidebar's launch fold over this environment's threads, from their lineage alone: which
 * threads fold under which row, and which subagents' requests a row carries. Subagents have no
 * row, so what one launched folds under its nearest ancestor that has one. A launch recorded
 * from another environment names a thread there and folds under nothing here.
 */
export function launchGraph(edges: ReadonlyArray<Edge>) {
  const byId = new Map(edges.map((edge) => [edge.id, edge] as const));
  const isSubagent = (edge: Edge) => edge.lineage.relationshipToParent === "subagent";
  const ownerOf = (threadId: ThreadId, rootThreadId?: ThreadId): ThreadId | null => {
    const seen = new Set<ThreadId>();
    let at = byId.get(threadId);
    const rootId = rootThreadId ?? at?.lineage.rootThreadId;
    const root = rootId === undefined ? undefined : byId.get(rootId);
    while (at !== undefined && isSubagent(at)) {
      if (seen.has(at.id) || at.lineage.parentThreadId === null) break;
      seen.add(at.id);
      at = byId.get(at.lineage.parentThreadId);
    }
    if (at !== undefined && !isSubagent(at)) return at.id;
    // A link missing from the active rows (archived) or a loop falls back to the lineage root
    // when that thread has a row, as in the sidebar.
    return root !== undefined && !isSubagent(root) ? root.id : null;
  };
  const launcherOf = new Map<ThreadId, ThreadId>();
  const launched = new Map<ThreadId, ThreadId[]>();
  const subagents = new Map<ThreadId, ThreadId[]>();
  for (const edge of edges) {
    if (isSubagent(edge)) {
      const owner =
        edge.lineage.parentThreadId === null
          ? null
          : ownerOf(edge.lineage.parentThreadId, edge.lineage.rootThreadId);
      if (owner !== null) push(subagents, owner, edge.id);
      continue;
    }
    const launcher = edge.launchedBy;
    if (launcher === undefined || launcher.environmentId !== null || !foldsUnderLauncher(edge))
      continue;
    const parent = ownerOf(launcher.threadId);
    if (parent !== null && parent !== edge.id) launcherOf.set(edge.id, parent);
  }
  // Launch records cannot form a loop, but copied databases can; every thread on one keeps its
  // own row, as in the sidebar.
  const onLoop = new Set<ThreadId>();
  for (const start of launcherOf.keys()) {
    const path: ThreadId[] = [];
    let at: ThreadId | undefined = start;
    while (at !== undefined && !path.includes(at) && !onLoop.has(at)) {
      path.push(at);
      at = launcherOf.get(at);
    }
    if (at !== undefined && path.includes(at))
      for (const key of path.slice(path.indexOf(at))) onLoop.add(key);
  }
  for (const [child, parent] of launcherOf) if (!onLoop.has(child)) push(launched, parent, child);
  /** The roots and every thread whose state can reach their fold state. */
  const reach = (roots: Iterable<ThreadId>): ReadonlySet<ThreadId> => {
    const found = new Set<ThreadId>();
    const pending = [...roots];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (found.has(at)) continue;
      found.add(at);
      for (const subagent of subagents.get(at) ?? []) found.add(subagent);
      pending.push(...(launched.get(at) ?? []));
    }
    return found;
  };
  /** Fold states from the shells reach named; a thread without a shell counts as finished. */
  const foldStates = (
    shells: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
    nowMs: number,
  ): ((threadId: ThreadId) => OrchestratorMcpThreadFoldState) => {
    const ownLift = (shell: OrchestrationV2ThreadShell, delegated?: LaunchAttention) =>
      ownLaunchLift(launchLiftInputOfShell(shell), delegated);
    const lifts = new Map<ThreadId, LaunchLift | null>();
    const visiting = new Set<ThreadId>();
    const liftOf = (threadId: ThreadId): LaunchLift | null => {
      const shell = shells.get(threadId);
      if (shell === undefined || visiting.has(threadId)) return null;
      if (lifts.has(threadId)) return lifts.get(threadId) ?? null;
      visiting.add(threadId);
      let delegated: LaunchAttention | undefined;
      for (const subagent of subagents.get(threadId) ?? []) {
        const request = shells.get(subagent);
        // Only goat_task_create children ask through their owner; provider subagents ask inline.
        const lift = request?.creationSource === "mcp" ? ownLift(request) : null;
        if (lift === "approval" || lift === "input")
          delegated = delegated === "approval" ? "approval" : lift;
      }
      let lift = ownLift(shell, delegated);
      for (const childId of launched.get(threadId) ?? []) {
        const child = shells.get(childId);
        const childLift = liftOf(childId);
        if (
          child !== undefined &&
          staysFoldedUnderLauncher({
            childLift,
            childSettled: child.settledOverride === "settled",
            launcherSnoozed: isSnoozed(shell, nowMs),
            launcherSettled: shell.settledOverride === "settled",
          })
        )
          lift = moreUrgentLaunchLift(lift, childLift);
      }
      visiting.delete(threadId);
      lifts.set(threadId, lift);
      return lift;
    };
    return (threadId) => launchStateOfLift(liftOf(threadId));
  };
  return { reach, foldStates };
}
