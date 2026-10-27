import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import { effectiveSnoozed } from "@goat/client-runtime/state/thread-settled";

import { sidebarDelegatedChildState, type SidebarChildAttention } from "../Sidebar.logic";

export type LaunchFoldThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "lineage"
  | "createdAt"
  | "pinnedAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "runtime"
  | "pendingBackgroundTasks"
> & {
  readonly source: Pick<EnvironmentThreadShell["source"], "launchedBy" | "pendingRuntimeRequest">;
};

export type LaunchChildState = "attention" | "working" | "finished";
/** The most urgent state among a row's folded descendants. */
export type LaunchLift = SidebarChildAttention | "working";

export interface LaunchFold<T> {
  /** Threads that keep a top-level row, in input order. */
  readonly roots: readonly T[];
  /** Folded threads, in input order. They stay searchable. */
  readonly folded: readonly T[];
  readonly childrenByParentKey: ReadonlyMap<string, readonly T[]>;
  readonly parentKeyByKey: ReadonlyMap<string, string>;
  readonly liftByKey: ReadonlyMap<string, LaunchLift>;
}

const LIFT_RANK: Record<LaunchLift, number> = { approval: 0, input: 1, working: 2 };
const STATE_RANK: Record<LaunchChildState, number> = { attention: 0, working: 1, finished: 2 };

const keyOf = (thread: Pick<LaunchFoldThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * The thread that launched this one with thread.launch, create_threads or ssh.thread_launch.
 * task.create children and provider subagents belong to the subagent model instead.
 */
function launcherKeyOf(thread: LaunchFoldThread): string | null {
  const launcher = thread.source.launchedBy;
  if (
    launcher?.kind !== "launch" ||
    launcher.via === "delegate_task" ||
    thread.lineage.relationshipToParent === "subagent"
  )
    return null;
  return scopedThreadKey(
    scopeThreadRef(launcher.environmentId ?? thread.environmentId, launcher.threadId),
  );
}

// Subagents never have rows; the row that owns one stands in for it, as for the open subagent.
function subagentOwnerKeyOf(thread: LaunchFoldThread): string | null {
  const parentId = thread.lineage.parentThreadId;
  return thread.lineage.relationshipToParent === "subagent" && parentId !== null
    ? scopedThreadKey(scopeThreadRef(thread.environmentId, parentId))
    : null;
}

function launchChildState(
  thread: Pick<
    LaunchFoldThread,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "pendingBackgroundTasks"
  >,
): LaunchChildState {
  const state = sidebarDelegatedChildState(thread);
  return state === "attention" ? "attention" : state === "finished" ? "finished" : "working";
}

function liftOf(thread: LaunchFoldThread): LaunchLift | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  return launchChildState(thread) === "working" ? "working" : null;
}

/**
 * Folds launched threads under their launcher's row in `visible`. A launcher that is a subagent
 * folds them under the subagent's owner row (`all` holds the subagent shells). A thread whose
 * launcher has no row here (archived, deleted, out of scope, another machine not connected),
 * a pinned thread, and a live thread whose launcher is snoozed keep their own row.
 */
export function foldLaunchedThreads<T extends LaunchFoldThread>(input: {
  readonly visible: readonly T[];
  readonly all: readonly LaunchFoldThread[];
  readonly now: string;
  /** Projects view folds only within one project's list. */
  readonly sameList?: (child: T, parent: T) => boolean;
}): LaunchFold<T> {
  const visibleByKey = new Map(input.visible.map((thread) => [keyOf(thread), thread] as const));
  const subagentOwnerByKey = new Map<string, string | null>();
  for (const thread of input.all) subagentOwnerByKey.set(keyOf(thread), subagentOwnerKeyOf(thread));
  const parentKeyByKey = new Map<string, string>();
  for (const thread of input.visible) {
    const own = keyOf(thread);
    let candidate = launcherKeyOf(thread);
    if (candidate === null || thread.pinnedAt != null) continue;
    const seen = new Set([own]);
    while (candidate !== null && !seen.has(candidate) && !visibleByKey.has(candidate)) {
      seen.add(candidate);
      candidate = subagentOwnerByKey.get(candidate) ?? null;
    }
    if (candidate === null || seen.has(candidate)) continue;
    const parent = visibleByKey.get(candidate);
    if (parent === undefined || input.sameList?.(thread, parent) === false) continue;
    if (launchChildState(thread) !== "finished" && effectiveSnoozed(parent, { now: input.now }))
      continue;
    parentKeyByKey.set(own, candidate);
  }
  // Launch records cannot form a loop, but copied databases can; every thread on one keeps its row.
  const onLoop = new Set<string>();
  for (const start of parentKeyByKey.keys()) {
    const path: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !path.includes(at) && !onLoop.has(at)) {
      path.push(at);
      at = parentKeyByKey.get(at);
    }
    if (at !== undefined && path.includes(at)) {
      for (const key of path.slice(path.indexOf(at))) onLoop.add(key);
    }
  }
  for (const key of onLoop) parentKeyByKey.delete(key);
  const childrenByParentKey = new Map<string, T[]>();
  const liftByKey = new Map<string, LaunchLift>();
  for (const [childKey, parentKey] of parentKeyByKey) {
    const child = visibleByKey.get(childKey);
    if (child === undefined) continue;
    const siblings = childrenByParentKey.get(parentKey) ?? [];
    siblings.push(child);
    childrenByParentKey.set(parentKey, siblings);
    const lift = liftOf(child);
    if (lift === null) continue;
    for (let at = parentKeyByKey.get(childKey); at !== undefined; at = parentKeyByKey.get(at)) {
      const current = liftByKey.get(at);
      if (current === undefined || LIFT_RANK[lift] < LIFT_RANK[current]) liftByKey.set(at, lift);
    }
  }
  for (const siblings of childrenByParentKey.values()) siblings.sort(compareLaunchChildren);
  return {
    roots: input.visible.filter((thread) => !parentKeyByKey.has(keyOf(thread))),
    folded: input.visible.filter((thread) => parentKeyByKey.has(keyOf(thread))),
    childrenByParentKey,
    parentKeyByKey,
    liftByKey,
  };
}

// People first, then running work, then finished; launch order within each, so lanes keep places.
function compareLaunchChildren(left: LaunchFoldThread, right: LaunchFoldThread): number {
  return (
    STATE_RANK[launchChildState(left)] - STATE_RANK[launchChildState(right)] ||
    left.createdAt.localeCompare(right.createdAt) ||
    keyOf(left).localeCompare(keyOf(right))
  );
}

/** Every ancestor key of a folded thread, nearest first. Empty for a top-level row. */
export function launchAncestorKeys(
  fold: Pick<LaunchFold<unknown>, "parentKeyByKey">,
  key: string,
): readonly string[] {
  const ancestors: string[] = [];
  for (let at = fold.parentKeyByKey.get(key); at !== undefined; at = fold.parentKeyByKey.get(at))
    ancestors.push(at);
  return ancestors;
}

export function summarizeLaunchGroup(children: readonly LaunchFoldThread[]): {
  readonly count: number;
  readonly running: number;
  readonly attention: number;
  readonly states: readonly LaunchChildState[];
} {
  const states = children.map(launchChildState);
  return {
    count: children.length,
    running: states.filter((state) => state === "working").length,
    attention: states.filter((state) => state === "attention").length,
    states,
  };
}

/** A launcher row carries its folded threads' urgency: a request ranks first, work as working. */
export function liftedPriorityRank(rank: 0 | 1 | 2 | null, lift: LaunchLift | undefined) {
  if (lift === "approval" || lift === "input") return 0;
  return lift === "working" && (rank === null || rank === 2) ? 1 : rank;
}

export function liftedChildAttention(
  lift: LaunchLift | undefined,
): SidebarChildAttention | undefined {
  return lift === "working" ? undefined : lift;
}

/** The top-level row that holds a thread: itself, or its outermost launcher when folded. */
export function launchRootKey(
  fold: Pick<LaunchFold<unknown>, "parentKeyByKey">,
  key: string | null,
): string | null {
  return key === null ? null : (launchAncestorKeys(fold, key).at(-1) ?? key);
}
