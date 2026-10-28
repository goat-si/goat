import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import type { EnvironmentId } from "@goat/contracts";
import { effectiveSnoozed } from "@goat/client-runtime/state/thread-settled";
import {
  foldsUnderLauncher,
  type LaunchChildState,
  type LaunchLift,
  launchStateOfLift,
  moreUrgentLaunchLift,
  ownLaunchLift,
  staysFoldedUnderLauncher,
} from "@goat/shared/threadLaunchState";

import type { SidebarChildAttention } from "../Sidebar.logic";

export type { LaunchChildState, LaunchLift };

export type LaunchFoldThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "lineage"
  | "createdAt"
  | "pinnedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "runtime"
  | "pendingBackgroundTasks"
> & {
  readonly source: Pick<EnvironmentThreadShell["source"], "launchedBy" | "pendingRuntimeRequest">;
};

export interface LaunchFold<T> {
  /** Threads that keep a top-level row, in input order. */
  readonly roots: readonly T[];
  /** Folded threads, in input order. They stay searchable. */
  readonly folded: readonly T[];
  readonly childrenByParentKey: ReadonlyMap<string, readonly T[]>;
  readonly parentKeyByKey: ReadonlyMap<string, string>;
  readonly liftByKey: ReadonlyMap<string, LaunchLift>;
  /** Each thread's state with what is folded under it, as its dot and order show it. */
  readonly stateByKey: ReadonlyMap<string, LaunchChildState>;
  /** Folded threads whose own lift is "unseen". */
  readonly unseenKeys: ReadonlySet<string>;
}

const STATE_RANK: Record<LaunchChildState, number> = { attention: 0, working: 1, finished: 2 };

const keyOf = (thread: Pick<LaunchFoldThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** The launcher row a thread folds under, when it folds under one at all. */
function launcherKeyOf(thread: LaunchFoldThread): string | null {
  const launcher = thread.source.launchedBy;
  if (launcher === undefined || !foldsUnderLauncher({ ...thread, launchedBy: launcher }))
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

const ownLiftOf = (
  thread: LaunchFoldThread,
  delegated: SidebarChildAttention | undefined,
  unseen: boolean,
) =>
  ownLaunchLift(
    {
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
      runtimeStatus: thread.runtime?.status,
      pendingBackgroundTaskCount: thread.pendingBackgroundTasks.length,
    },
    delegated,
    unseen,
  );

/**
 * Folds launched threads under their launcher's row in `visible` (a subagent launcher: its owner's
 * row). A row's urgency is the most urgent of its own state, its subagents' requests and every
 * thread folded under it. No row for the launcher, a pin, live work under a snoozed launcher, or
 * unsettled finished work under a settled one keeps the thread's own row: nothing hides.
 */
export function foldLaunchedThreads<T extends LaunchFoldThread>(input: {
  readonly visible: readonly T[];
  readonly all: readonly LaunchFoldThread[];
  readonly now: string;
  /** Projects view folds only within one project. */
  readonly sameList?: (child: T, parent: T) => boolean;
  /** Pending requests of each row's task.create subagents, by owner row key. */
  readonly delegatedAttentionByKey?: ReadonlyMap<string, SidebarChildAttention>;
  /** A finished thread that would sit in Priority on its own row; folded, it lifts its launcher. */
  readonly unseen?: (thread: T) => boolean;
}): LaunchFold<T> {
  const visibleByKey = new Map(input.visible.map((thread) => [keyOf(thread), thread] as const));
  const subagentOwnerByKey = new Map<string, string | null>();
  for (const thread of input.all) subagentOwnerByKey.set(keyOf(thread), subagentOwnerKeyOf(thread));
  const candidateParent = new Map<string, string>();
  for (const thread of input.visible) {
    const own = keyOf(thread);
    let candidate = launcherKeyOf(thread);
    if (candidate === null) continue;
    const seen = new Set([own]);
    while (candidate !== null && !seen.has(candidate) && !visibleByKey.has(candidate)) {
      seen.add(candidate);
      candidate = subagentOwnerByKey.get(candidate) ?? null;
    }
    if (candidate === null || seen.has(candidate)) continue;
    const parent = visibleByKey.get(candidate);
    if (parent === undefined || input.sameList?.(thread, parent) === false) continue;
    candidateParent.set(own, candidate);
  }
  // Launch records cannot form a loop, but copied databases can; every thread on one keeps its row.
  const onLoop = new Set<string>();
  for (const start of candidateParent.keys()) {
    const path: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !path.includes(at) && !onLoop.has(at)) {
      path.push(at);
      at = candidateParent.get(at);
    }
    if (at !== undefined && path.includes(at)) {
      for (const key of path.slice(path.indexOf(at))) onLoop.add(key);
    }
  }
  for (const key of onLoop) candidateParent.delete(key);
  const candidateChildren = new Map<string, string[]>();
  for (const [child, parent] of candidateParent) {
    candidateChildren.set(parent, [...(candidateChildren.get(parent) ?? []), child]);
  }
  // Decide edges bottom-up, so whether a thread is live includes what stays folded under it.
  const parentKeyByKey = new Map<string, string>();
  const liftByKey = new Map<string, LaunchLift>();
  const subtreeLiftByKey = new Map<string, LaunchLift | null>();
  const unseenKeys = new Set<string>();
  const decide = (key: string): LaunchLift | null => {
    const thread = visibleByKey.get(key);
    if (thread === undefined) return null;
    let below: LaunchLift | null = null;
    for (const childKey of candidateChildren.get(key) ?? []) {
      const child = visibleByKey.get(childKey);
      const childLift = decide(childKey);
      if (child === undefined) continue;
      // Live work lifts a settled launcher into Priority; finished or unread work you have not
      // settled would sit in the closed settled shelf, so it keeps its row.
      if (
        !staysFoldedUnderLauncher({
          childLift,
          childSettled: child.settledOverride === "settled",
          launcherSnoozed: effectiveSnoozed(thread, { now: input.now }),
          launcherSettled: thread.settledOverride === "settled",
        })
      )
        continue;
      parentKeyByKey.set(childKey, key);
      below = moreUrgentLaunchLift(below, childLift);
    }
    if (below !== null) liftByKey.set(key, below);
    // Only a thread that may fold lifts as unread; a row's own unread is its own rank.
    const own = ownLiftOf(
      thread,
      input.delegatedAttentionByKey?.get(key),
      candidateParent.has(key) && input.unseen?.(thread) === true,
    );
    if (own === "unseen") unseenKeys.add(key);
    const lift = moreUrgentLaunchLift(own, below);
    subtreeLiftByKey.set(key, lift);
    return lift;
  };
  for (const thread of input.visible) {
    const key = keyOf(thread);
    if (!candidateParent.has(key)) decide(key);
  }
  const stateByKey = new Map<string, LaunchChildState>();
  for (const [key, lift] of subtreeLiftByKey) stateByKey.set(key, launchStateOfLift(lift));
  const childrenByParentKey = new Map<string, T[]>();
  for (const [childKey, parentKey] of parentKeyByKey) {
    const child = visibleByKey.get(childKey);
    if (child === undefined) continue;
    childrenByParentKey.set(parentKey, [...(childrenByParentKey.get(parentKey) ?? []), child]);
  }
  // People first, then running work, then finished; newest launch first within each.
  const rank = (thread: T) => STATE_RANK[stateByKey.get(keyOf(thread)) ?? "finished"];
  for (const siblings of childrenByParentKey.values()) {
    siblings.sort(
      (left, right) =>
        rank(left) - rank(right) ||
        right.createdAt.localeCompare(left.createdAt) ||
        keyOf(left).localeCompare(keyOf(right)),
    );
  }
  return {
    roots: input.visible.filter((thread) => !parentKeyByKey.has(keyOf(thread))),
    folded: input.visible.filter((thread) => parentKeyByKey.has(keyOf(thread))),
    childrenByParentKey,
    parentKeyByKey,
    liftByKey,
    stateByKey,
    unseenKeys: new Set([...unseenKeys].filter((key) => parentKeyByKey.has(key))),
  };
}

/** Unread threads folded anywhere under a row, nearest first. */
export function foldedUnseenUnder<T extends Pick<LaunchFoldThread, "environmentId" | "id">>(
  fold: Pick<LaunchFold<T>, "childrenByParentKey" | "unseenKeys">,
  key: string,
): readonly T[] {
  const found: T[] = [];
  const pending = [key];
  for (let at = pending.shift(); at !== undefined; at = pending.shift()) {
    for (const child of fold.childrenByParentKey.get(at) ?? []) {
      const childKey = keyOf(child);
      if (fold.unseenKeys.has(childKey)) found.push(child);
      pending.push(childKey);
    }
  }
  return found;
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

export function summarizeLaunchGroup(states: readonly LaunchChildState[]): {
  readonly count: number;
  readonly running: number;
  readonly attention: number;
  readonly states: readonly LaunchChildState[];
} {
  return {
    count: states.length,
    running: states.filter((state) => state === "working").length,
    attention: states.filter((state) => state === "attention").length,
    states,
  };
}

/** A launcher row carries its folded threads' urgency: a request ranks first, work as working. */
export function liftedPriorityRank(rank: 0 | 1 | 2 | null, lift: LaunchLift | undefined) {
  if (lift === "approval" || lift === "input") return 0;
  if (lift === "working" && (rank === null || rank === 2)) return 1;
  return lift === "unseen" ? (rank ?? 2) : rank;
}

export function liftedChildAttention(
  lift: LaunchLift | undefined,
): SidebarChildAttention | undefined {
  return lift === "approval" || lift === "input" ? lift : undefined;
}

/** The top-level row that holds a thread: itself, or its outermost launcher when folded. */
export function launchRootKey(
  fold: Pick<LaunchFold<unknown>, "parentKeyByKey">,
  key: string | null,
): string | null {
  return key === null ? null : (launchAncestorKeys(fold, key).at(-1) ?? key);
}

export type FoldedSection = "snoozed" | "settled" | "active";

/** A folded thread keeps its own lifecycle for its row's actions and the shelf membership sets. */
export function foldedSections(
  folded: readonly LaunchFoldThread[],
  capabilitiesOf: (
    environmentId: EnvironmentId,
  ) => { readonly threadSnooze?: boolean; readonly threadSettlement?: boolean } | undefined,
  now: string,
): ReadonlyMap<string, FoldedSection> {
  return new Map(
    folded.map((thread) => {
      const capabilities = capabilitiesOf(thread.environmentId);
      const section: FoldedSection =
        capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now })
          ? "snoozed"
          : capabilities?.threadSettlement === true && thread.settledOverride === "settled"
            ? "settled"
            : "active";
      return [keyOf(thread), section] as const;
    }),
  );
}

export const foldedKeysIn = (
  sections: ReadonlyMap<string, FoldedSection>,
  section: FoldedSection,
) => [...sections].flatMap(([key, value]) => (value === section ? [key] : []));
