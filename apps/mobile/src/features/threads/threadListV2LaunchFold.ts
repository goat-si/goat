import {
  foldLaunchedThreads,
  LAUNCH_GROUP_CHILD_LIMIT,
  liftedPriorityRank,
  launchGroupSummaryText,
  shownLaunchChildren,
  summarizeLaunchGroup,
  type LaunchChildState,
  type LaunchFold,
  type LaunchLift,
} from "@goat/client-runtime/state/launch-fold";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  hasUnseenCompletion as threadHasUnseenCompletion,
  resolveThreadPriorityRank,
  type ThreadPriorityRank,
} from "@goat/client-runtime/state/thread-list-priority";
import { effectiveSnoozed, threadWokeAt } from "@goat/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@goat/contracts";
import { isSideChatThread } from "@goat/contracts";

export { LAUNCH_GROUP_CHILD_LIMIT, threadHasUnseenCompletion, type LaunchLift };

/** A subagent's identity, enough to find the row that owns a thread it launched. */
export type LaunchSubagentRow = Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">;

/** How the list places a thread: capabilities per environment and queued sends. */
export interface ThreadListV2Lifecycle {
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId> | undefined;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId> | undefined;
  readonly queuedThreadKeys?: ReadonlySet<string> | undefined;
}

const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

/**
 * Subagent rows from every thread shell. Streaming turns rewrite shells many times a second; the
 * previous array comes back until a subagent's identity or owner changes, so lists keep theirs.
 */
export function projectLaunchSubagentRows(
  previous: readonly LaunchSubagentRow[],
  shells: readonly EnvironmentThreadShell[],
): readonly LaunchSubagentRow[] {
  const next: LaunchSubagentRow[] = [];
  for (const shell of shells) {
    if (shell.lineage.relationshipToParent === "subagent") {
      next.push({ environmentId: shell.environmentId, id: shell.id, lineage: shell.lineage });
    }
  }
  const same =
    next.length === previous.length &&
    next.every((row, index) => {
      const before = previous[index];
      return (
        before !== undefined &&
        before.environmentId === row.environmentId &&
        before.id === row.id &&
        before.lineage.parentThreadId === row.lineage.parentThreadId &&
        before.lineage.rootThreadId === row.lineage.rootThreadId
      );
    });
  return same ? previous : next;
}

export function resolveThreadListV2WokeAt(
  thread: EnvironmentThreadShell,
  options: { readonly now: string },
): string | null {
  // Older servers cannot persist an acknowledgement.
  if (thread.lastVisitedAt === undefined || thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, options);
  const wokeAtMs = Date.parse(wokeAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt ?? "");
  return !Number.isNaN(wokeAtMs) && (Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ? wokeAt
    : null;
}

export function threadListV2Snoozed(
  thread: EnvironmentThreadShell,
  lifecycle: ThreadListV2Lifecycle,
): boolean {
  return (
    (lifecycle.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
    effectiveSnoozed(thread, { now: lifecycle.now })
  );
}

/** Settled as the list shows it: a queued send keeps a settled thread active. */
export function threadListV2Settled(
  thread: EnvironmentThreadShell,
  lifecycle: ThreadListV2Lifecycle,
): boolean {
  return (
    (lifecycle.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
    thread.settledOverride === "settled" &&
    lifecycle.queuedThreadKeys?.has(keyOf(thread)) !== true
  );
}

/**
 * Folds threads an agent launched under their launcher's row, with the web sidebar's rules. A
 * finished thread is unread when its own row would show it unread; settled ones count, as in
 * the web's Priority.
 */
/** A row's Priority rank, as the web sidebar ranks it: requests, running work, then unread. */
export function threadListV2PriorityRank(
  thread: EnvironmentThreadShell,
  lift: LaunchLift | undefined,
  lifecycle: ThreadListV2Lifecycle,
): ThreadPriorityRank | null {
  if (threadListV2Snoozed(thread, lifecycle)) return null;
  const rank = resolveThreadPriorityRank({
    thread,
    wokeAt: resolveThreadListV2WokeAt(thread, { now: lifecycle.now }),
    hasChildAttention: false,
  });
  return liftedPriorityRank(rank, lift);
}

export function foldThreadListV2(input: {
  readonly listed: readonly EnvironmentThreadShell[];
  /** Threads that may launch work without a row of their own; subagents, for the home list. */
  readonly owners: readonly LaunchSubagentRow[];
  readonly lifecycle: ThreadListV2Lifecycle;
}): LaunchFold<EnvironmentThreadShell> {
  const { lifecycle } = input;
  const delegated = new Map<string, "approval" | "input">();
  for (const thread of input.listed) {
    if (thread.pendingSubagentRequest === "approval") delegated.set(keyOf(thread), "approval");
    else if (thread.pendingSubagentRequest === "user_input") delegated.set(keyOf(thread), "input");
  }
  return foldLaunchedThreads({
    visible: input.listed,
    all: input.owners,
    now: lifecycle.now,
    delegatedAttentionByKey: delegated,
    unseen: (thread) =>
      !threadListV2Snoozed(thread, lifecycle) &&
      (threadHasUnseenCompletion(thread) ||
        resolveThreadListV2WokeAt(thread, { now: lifecycle.now }) !== null),
    settled: (thread) => threadListV2Settled(thread, lifecycle),
    snoozed: (thread) => threadListV2Snoozed(thread, lifecycle),
  });
}

/** Rows the ordered sections leave out: folded threads, and Priority rows placed by urgency. */
export function launchReorderExcludedKeys(
  fold: Pick<LaunchFold<EnvironmentThreadShell>, "folded" | "roots" | "liftByKey">,
  lifecycle: ThreadListV2Lifecycle,
): ReadonlySet<string> {
  const keys = new Set(fold.folded.map(keyOf));
  for (const root of fold.roots) {
    if (threadListV2PriorityRank(root, fold.liftByKey.get(keyOf(root)), lifecycle) !== null)
      keys.add(keyOf(root));
  }
  return keys;
}

let lastExcludedInput: readonly unknown[] = [];
let lastExcludedKeys: ReadonlySet<string> = new Set();

/**
 * The excluded keys for the whole list, without its project scope or search, so every reorder
 * path (menus, arrangement, pending order) agrees. Reused while its inputs are unchanged.
 */
export function threadListV2ReorderExcludedKeys(
  input: ThreadListV2Lifecycle & {
    readonly threads: readonly EnvironmentThreadShell[];
    /** Subagent rows when `threads` leaves them out. */
    readonly owners?: readonly LaunchSubagentRow[] | undefined;
    readonly hiddenBotThreadKeys?: ReadonlySet<string> | undefined;
  },
): ReadonlySet<string> {
  const args = [
    input.threads,
    input.owners,
    input.hiddenBotThreadKeys,
    input.now,
    input.settlementEnvironmentIds,
    input.snoozeEnvironmentIds,
    input.queuedThreadKeys,
  ];
  if (
    args.length === lastExcludedInput.length &&
    args.every((arg, i) => arg === lastExcludedInput[i])
  )
    return lastExcludedKeys;
  const listed = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      !isSideChatThread(thread) &&
      input.hiddenBotThreadKeys?.has(keyOf(thread)) !== true,
  );
  lastExcludedInput = args;
  lastExcludedKeys = launchReorderExcludedKeys(
    foldThreadListV2({ listed, owners: input.owners ?? input.threads, lifecycle: input }),
    input,
  );
  return lastExcludedKeys;
}

/** A row's status with a request waiting in work folded under it; its own requests come first. */
export function liftedThreadListV2Status<S extends string>(
  status: S,
  lift: LaunchLift | null | undefined,
): S | "approval" | "input" {
  if (status === "approval" || status === "input") return status;
  if (lift === "approval" || lift === "input") return lift;
  return status;
}

export interface ThreadListV2LaunchGroupEntry {
  readonly kind: "launch-group";
  readonly parentKey: string;
  readonly depth: number;
  readonly label: string;
  /** The first children's states, for the group's dots. */
  readonly states: readonly LaunchChildState[];
  readonly expanded: boolean;
}

export interface ThreadListV2LaunchMoreEntry {
  readonly kind: "launch-more";
  readonly parentKey: string;
  readonly depth: number;
  readonly hidden: number;
}

const MAX_DOTS = 8;

/** Expansion for the list's launch groups: stored per device, plus this session's overrides. */
export interface ThreadListV2LaunchGroupState {
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly showAll: ReadonlySet<string>;
  /** Groups on the selected thread's path the person collapsed while it stays selected. */
  readonly routeCollapsed: ReadonlySet<string>;
}

export interface LaunchTreeContext<Item> {
  readonly fold: LaunchFold<EnvironmentThreadShell>;
  readonly isExpanded: (parentKey: string) => boolean;
  readonly showAll: (parentKey: string) => boolean;
  /** The selected thread and its launchers; their row stays listed past the limit. */
  readonly routeKeys: ReadonlySet<string>;
  readonly childItem: (thread: EnvironmentThreadShell, depth: number) => Item;
}

/** A launch line placed after the row at `afterIndex` in the layout's rows. */
export interface ThreadListV2LaunchMarker {
  readonly afterIndex: number;
  readonly entry: ThreadListV2LaunchGroupEntry | ThreadListV2LaunchMoreEntry;
}

/** Appends a row, then its launch group and the children it lists, depth first. */
export function appendWithLaunchChildren<
  Item extends { readonly thread: EnvironmentThreadShell; readonly depth?: number | undefined },
>(
  items: Item[],
  markers: ThreadListV2LaunchMarker[],
  item: Item,
  context: LaunchTreeContext<Item>,
): void {
  items.push(item);
  const mark = (entry: ThreadListV2LaunchMarker["entry"]) =>
    markers.push({ afterIndex: items.length - 1, entry });
  const parentKey = keyOf(item.thread);
  const children = context.fold.childrenByParentKey.get(parentKey);
  if (children === undefined || children.length === 0) return;
  const expanded = context.isExpanded(parentKey);
  const summary = summarizeLaunchGroup(
    children.map((child) => context.fold.stateByKey.get(keyOf(child)) ?? "finished"),
  );
  mark({
    kind: "launch-group",
    parentKey,
    depth: item.depth ?? 0,
    label: launchGroupSummaryText(summary),
    states: summary.states.slice(0, MAX_DOTS),
    expanded,
  });
  const shown = shownLaunchChildren(children, {
    expanded,
    showAll: context.showAll(parentKey),
    routeKeys: context.routeKeys,
  });
  for (const child of shown) {
    appendWithLaunchChildren(
      items,
      markers,
      context.childItem(child, (item.depth ?? 0) + 1),
      context,
    );
  }
  const hidden = expanded ? children.length - shown.length : 0;
  if (hidden > 0) mark({ kind: "launch-more", parentKey, depth: item.depth ?? 0, hidden });
}
