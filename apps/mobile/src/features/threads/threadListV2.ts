import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  pickSnoozePreset,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@goat/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@goat/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { resolveThreadProviderStack } from "@goat/client-runtime/state/models";
import {
  threadSearchMatchKey,
  threadSearchSubject,
} from "@goat/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@goat/shared/paletteSearch";
import {
  createInboxReturnTracker,
  isActiveThreadWork,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@goat/client-runtime/state/thread-inbox";
import {
  sortActiveThreadsByOrderKey,
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@goat/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId, SnoozePresetSetting } from "@goat/contracts";
import { isSideChatThread } from "@goat/contracts";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import type { ThreadMoveAvailability } from "./threadOrder";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";
import {
  appendWithLaunchChildren,
  foldThreadListV2,
  liftedThreadListV2Status,
  resolveThreadListV2WokeAt,
  sortLiftedThreads,
  threadHasUnseenCompletion,
  threadListV2Settled,
  threadListV2Snoozed,
  type LaunchLift,
  type LaunchSubagentRow,
  type ThreadListV2LaunchGroupEntry,
  type ThreadListV2LaunchGroupState,
  type ThreadListV2LaunchMarker,
} from "./threadListV2LaunchFold";
import { launchAncestorKeys, launchRootKey } from "@goat/client-runtime/state/launch-fold";

export { resolveThreadListV2WokeAt, snoozeWakeLabel, threadHasUnseenCompletion };

export const threadListInboxReturns = createInboxReturnTracker();

export function resolveThreadListV2ProviderDrivers(
  thread: Pick<EnvironmentThreadShell, "providerInstanceHistory" | "modelSelection" | "runtime">,
  providers: ReadonlyArray<ThreadListProvider> | undefined,
): ReadonlyArray<string> {
  if (providers === undefined) return [];
  const stack = resolveThreadProviderStack(thread);
  const drivers = stack.flatMap((instanceId) => {
    const driver = providers.find((provider) => provider.instanceId === instanceId)?.driver;
    return driver === undefined ? [] : [driver];
  });
  const currentDriver = providers.find(
    (provider) => provider.instanceId === stack[stack.length - 1],
  )?.driver;
  return currentDriver === undefined ? [] : drivers;
}

export type ThreadListV2Status =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";
export type ThreadListV2SnoozePresetSettings = ReadonlyArray<SnoozePresetSetting> | undefined;

/** The row's snooze menu, from its environment's presets (undefined before its config loads). */
export function resolveThreadListV2SnoozePresets(
  secondary: ThreadListV2SwipeAction | null,
  now: Date,
  presets: ThreadListV2SnoozePresetSettings,
): ReadonlyArray<SnoozePreset> {
  return secondary === "snooze" ? resolveSnoozePresets(now, presets ? { presets } : {}) : [];
}

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
  readonly presets: ThreadListV2SnoozePresetSettings;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };
  const preset = pickSnoozePreset({
    shown: input.displayedPresets,
    id: input.event.slice("snooze:".length),
    now: input.now,
    ...(input.presets ? { presets: input.presets } : {}),
  });
  return preset ? { _tag: "selected", preset } : { _tag: "expired" };
}

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  const primary = input.settlementSupported
    ? input.variant === "slim"
      ? "unsettle"
      : "settle"
    : "archive";
  return {
    primary,
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
  };
}

export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "latestRun"
    | "latestUserMessageAt"
    | "runtime"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return null;
  if (thread.pendingSubagentRequest != null) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

/** The earliest `snoozedUntil` strictly after `nowMs`, in epoch ms. */
export function nextSnoozeWakeAfter(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const thread of threads) {
    if (thread.snoozedUntil == null) continue;
    const wakeAtMs = Date.parse(thread.snoozedUntil);
    if (wakeAtMs > nowMs && (next === null || wakeAtMs < next)) next = wakeAtMs;
  }
  return next;
}

export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

/** The server marks unread only after a completed run, and only a recorded visit makes a thread read. */
export function canMarkThreadUnread(
  thread: Pick<
    EnvironmentThreadShell,
    "latestRun" | "lastVisitedAt" | "notificationCompletedAt" | "markedUnreadCompletionAt"
  >,
): boolean {
  return (
    Boolean(thread.lastVisitedAt) &&
    thread.latestRun?.completedAt != null &&
    !threadHasUnseenCompletion(thread)
  );
}

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
  >,
): ThreadListV2Status {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  return sortActiveThreadsByOrderKey(threads);
}

export function getThreadListV2OrderedSection(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** GOAT Bot's observation threads, by `environmentId:threadId`; they get no row. */
  readonly hiddenBotThreadKeys?: ReadonlySet<string>;
  /** Folded and lifted rows (threadListV2ReorderExcludedKeys); they are not ordered here. */
  readonly excludedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threads = input.threads.filter((thread) => {
    if (
      thread.archivedAt !== null ||
      thread.lineage.relationshipToParent === "subagent" ||
      isSideChatThread(thread) ||
      input.hiddenBotThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true ||
      input.excludedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true
    )
      return false;
    if (
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true
    ) {
      return false;
    }
    if (
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now })
    ) {
      return false;
    }
    return (thread.pinnedAt != null) === (input.section === "pinned");
  });
  const ordered =
    input.section === "pinned"
      ? sortPinnedThreadsByOrderKey(threads)
      : sortActiveThreadsByOrderKey(threads);
  const pending =
    input.pendingOrder?.section === input.section
      ? reconcilePendingThreadOrder(input.pendingOrder, ordered)
      : null;
  return applyPendingThreadOrder(ordered, input.section, pending);
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly snoozed: boolean;
  readonly pinned: boolean;
  readonly wokeAt: string | null;
  readonly isLast: boolean;
  /** Launch nesting: 0 for a top-level row. */
  readonly depth?: number;
  /** The most urgent state folded under this row, which its card carries. */
  readonly lift?: LaunchLift | null;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Launch group lines and "+N more", each after the row it follows, in order. */
  readonly launchMarkers?: readonly ThreadListV2LaunchMarker[];
  readonly hiddenSettledCount: number;
  /** The settled rows the shelf may list, before its visible limit. */
  readonly listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workingCount: number;
  readonly workingShelfHeaderIndex: number | null;
  readonly snoozedCount: number;
  readonly snoozedShelfHeaderIndex: number | null;
  readonly settledCount: number;
  readonly settledShelfHeaderIndex: number | null;
  /** Arm a timeout here to repartition at snooze expiry rather than the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
  /** Threads listed only because their messages match the search. */
  readonly contentOnlyThreadKeys: ReadonlySet<string>;
  /** Groups above the selected thread to expand and remember, as opening a folded thread does. */
  readonly launchRevealKeys: readonly string[];
  /** Groups above the selected thread, whose collapse lasts while it stays selected. */
  readonly launchRouteAncestorKeys: readonly string[];
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  readonly snoozeWakeLabelText: string | undefined;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string | undefined;
  readonly showTrailingDivider: boolean;
  /** Include queued state in item equality; outbox writes do not update thread shells. */
  readonly hasQueuedMessages: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2WorkingShelfListItem {
  readonly type: "v2-working-shelf";
  readonly key: "v2-working-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /** Include disabled state in item equality; recycled cells ignore render-closure updates. */
  readonly disabled: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2LaunchGroupListItem {
  readonly type: "v2-launch-group";
  readonly key: string;
  readonly parentKey: string;
  readonly depth: number;
  readonly label: string;
  readonly states: ThreadListV2LaunchGroupEntry["states"];
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2LaunchMoreListItem {
  readonly type: "v2-launch-more";
  readonly key: string;
  readonly parentKey: string;
  readonly depth: number;
  readonly hidden: number;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2WorkingShelfListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem
  | ThreadListV2LaunchGroupListItem
  | ThreadListV2LaunchMoreListItem;

export function isThreadListV2ListItem(value: {
  readonly type: string;
}): value is ThreadListV2ListItem {
  return (
    value.type === "v2-thread" ||
    value.type === "v2-pending" ||
    value.type === "v2-working-shelf" ||
    value.type === "v2-snoozed-shelf" ||
    value.type === "v2-settled-shelf" ||
    value.type === "v2-launch-group" ||
    value.type === "v2-launch-more"
  );
}

/** Compare rebuilt items by content so minute ticks and partition runs do not re-render every mounted row. */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        previous.item.thread === item.item.thread &&
        previous.item.variant === item.item.variant &&
        previous.item.snoozed === item.item.snoozed &&
        previous.item.pinned === item.item.pinned &&
        previous.item.wokeAt === item.item.wokeAt &&
        (previous.item.depth ?? 0) === (item.item.depth ?? 0) &&
        (previous.item.lift ?? null) === (item.item.lift ?? null) &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        previous.timeLabel === item.timeLabel &&
        previous.snoozePresetMinute === item.snoozePresetMinute &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        previous.hasQueuedMessages === item.hasQueuedMessages &&
        previous.canMoveUp === item.canMoveUp &&
        previous.canMoveDown === item.canMoveDown
      );
    case "v2-pending":
      return (
        previous.type === "v2-pending" &&
        previous.key === item.key &&
        previous.pendingTask === item.pendingTask &&
        previous.showPendingDivider === item.showPendingDivider &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-working-shelf":
      return (
        previous.type === "v2-working-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-snoozed-shelf":
      return (
        previous.type === "v2-snoozed-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-settled-shelf":
      return (
        previous.type === "v2-settled-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-launch-group":
      return (
        previous.type === "v2-launch-group" &&
        previous.key === item.key &&
        previous.depth === item.depth &&
        previous.label === item.label &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled &&
        previous.states.length === item.states.length &&
        previous.states.every((state, index) => state === item.states[index])
      );
    case "v2-launch-more":
      return (
        previous.type === "v2-launch-more" &&
        previous.key === item.key &&
        previous.depth === item.depth &&
        previous.hidden === item.hidden
      );
  }
}

function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  showSnoozeWakeLabel: boolean,
): string {
  const { thread, variant, snoozed } = item;
  if (showSnoozeWakeLabel) return "";
  if (
    variant === "card" &&
    (liftedThreadListV2Status(resolveThreadListV2Status(thread), item.lift) !== "ready" ||
      item.lift === "unseen" ||
      item.wokeAt !== null ||
      threadHasUnseenCompletion(thread))
  )
    return "";
  const settledTimestamp =
    variant === "slim" && !snoozed ? resolveSettledThreadTimestamp(thread) : null;
  return relativeTime(
    settledTimestamp ?? thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
}

export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly launchMarkers?: readonly ThreadListV2LaunchMarker[];
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly workingCount?: number;
  readonly workingShelfExpanded?: boolean;
  readonly workingShelfHeaderIndex?: number | null;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  readonly snoozeLabelNow?: string;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  readonly shelfPreferencesLoading?: boolean;
  /** Launch groups toggle once this device's preferences load. */
  readonly launchGroupsLoading?: boolean;
}): ThreadListV2ListItem[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const launchLine = ({ entry }: ThreadListV2LaunchMarker): ThreadListV2ListItem =>
    entry.kind === "launch-group"
      ? {
          type: "v2-launch-group",
          key: `v2-launch-group:${entry.parentKey}`,
          parentKey: entry.parentKey,
          depth: entry.depth,
          label: entry.label,
          states: entry.states,
          expanded: entry.expanded,
          disabled: input.launchGroupsLoading === true,
        }
      : {
          type: "v2-launch-more",
          key: `v2-launch-more:${entry.parentKey}`,
          parentKey: entry.parentKey,
          depth: entry.depth,
          hidden: entry.hidden,
        };
  const markersAfter = new Map<number, ThreadListV2ListItem[]>();
  for (const marker of input.launchMarkers ?? []) {
    const lines = markersAfter.get(marker.afterIndex);
    if (lines === undefined) markersAfter.set(marker.afterIndex, [launchLine(marker)]);
    else lines.push(launchLine(marker));
  }
  const threadRows = input.items.map((item): ThreadListV2ListItem => {
    const snoozeWakeLabelText =
      item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
        ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
        : undefined;
    // Put the clock on items so recycler equality limits ticks to rows displaying snooze preset times.
    const snoozePresetMinute =
      !item.snoozed &&
      input.snoozeLabelNow !== undefined &&
      (input.snoozeEnvironmentIds?.has(item.thread.environmentId) ?? true) &&
      canSnooze(item.thread, { now: input.snoozeLabelNow })
        ? input.snoozeLabelNow
        : undefined;
    const move =
      item.variant === "card"
        ? input.moveAvailability?.get(`${item.thread.environmentId}:${item.thread.id}`)
        : undefined;
    return {
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
      snoozeWakeLabelText,
      timeLabel: resolveThreadListV2ItemTimeLabel(item, snoozeWakeLabelText !== undefined),
      snoozePresetMinute,
      showTrailingDivider: false,
      hasQueuedMessages:
        queuedThreadKeys?.has(`${item.thread.environmentId}:${item.thread.id}`) === true,
      canMoveUp: move?.canMoveUp === true,
      canMoveDown: move?.canMoveDown === true,
    };
  });
  // Each row carries the launch lines after it, so shelf slices keep a group with its launcher.
  const threadItems = threadRows.map((row, index) => [row, ...(markersAfter.get(index) ?? [])]);
  const pendingItems = input.pendingTasks.map((pendingTask, index): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-${pendingTask.key}`,
    pendingTask,
    showPendingDivider: index === 0,
    showTrailingDivider: false,
  }));
  const workingCount = input.workingCount ?? 0;
  const workingShelfHeaderIndex = input.workingShelfHeaderIndex ?? null;
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const workingEnd = snoozedShelfHeaderIndex ?? snoozedEnd;
  const activeEnd = workingShelfHeaderIndex ?? workingEnd;
  const result: ThreadListV2ListItem[] = [
    ...pendingItems,
    ...threadItems.slice(0, activeEnd).flat(),
  ];
  const shelfDisabled = input.shelfPreferencesLoading === true;
  if (workingShelfHeaderIndex !== null && workingCount > 0) {
    result.push({
      type: "v2-working-shelf",
      key: "v2-working-shelf",
      count: workingCount,
      expanded: input.workingShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(workingShelfHeaderIndex, workingEnd).flat());
  }
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd).flat());
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex).flat());
  }
  return result.map((entry, index) => {
    if (entry.type !== "v2-thread" && entry.type !== "v2-pending") return entry;
    const next = result[index + 1];
    const showTrailingDivider =
      next?.type === "v2-thread" || (next?.type === "v2-pending" && !next.showPendingDivider);
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

// Immutable shells and field-only sorting make element-identical inputs produce identical output.
let lastSettledInput: ReadonlyArray<EnvironmentThreadShell> = [];
let lastSettledOutput: ReadonlyArray<EnvironmentThreadShell> = [];

function sortSettledThreadsReusingLast(
  settled: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  if (settled.length === lastSettledInput.length) {
    let same = true;
    for (let index = 0; index < settled.length; index += 1) {
      if (settled[index] !== lastSettledInput[index]) {
        same = false;
        break;
      }
    }
    if (same) return lastSettledOutput;
  }
  lastSettledInput = settled;
  lastSettledOutput = sortSettledThreads(settled);
  return lastSettledOutput;
}

export function buildThreadListV2Items(input: {
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly settledLimit?: number;
  readonly now: string;
  readonly workingShelfEnabled?: boolean;
  readonly workingShelfExpanded?: boolean;
  readonly isWorking?: (thread: EnvironmentThreadShell) => boolean;
  readonly inboxReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  readonly snoozedShelfExpanded?: boolean;
  readonly settledShelfExpanded?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** Whether the shelf may list a settled row yet; older settled rows load in pages. */
  readonly isListedSettled?: (thread: EnvironmentThreadShell) => boolean;
  /** Settled threads in scope that are not local (older settled threads not loaded). */
  readonly unloadedSettledCount?: number;
  /** GOAT Bot's observation threads, by `environmentId:threadId`; search still finds them. */
  readonly hiddenBotThreadKeys?: ReadonlySet<string>;
  /** Subagent rows, so work a subagent launched folds under the row that owns it. */
  readonly launchOwners?: ReadonlyArray<LaunchSubagentRow>;
  /** Expansion of launch groups; groups stay collapsed without it. */
  readonly launchGroups?: ThreadListV2LaunchGroupState;
  /** Rows every reorder path leaves out (threadListV2ReorderExcludedKeys). */
  readonly reorderExcludedKeys?: ReadonlySet<string>;
}): ThreadListV2Layout {
  const now = input.now;
  const lifecycle = {
    now,
    settlementEnvironmentIds: input.settlementEnvironmentIds,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
  };
  const pending =
    input.pendingOrder == null
      ? null
      : reconcilePendingThreadOrder(
          input.pendingOrder,
          getThreadListV2OrderedSection({
            ...input,
            section: input.pendingOrder.section,
            pendingOrder: null,
            excludedThreadKeys: input.reorderExcludedKeys,
          }),
        );
  const query = foldSearchQuery(input.searchQuery);
  const nowMs = Date.parse(now);
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const workingShelfEnabled = input.workingShelfEnabled === true;
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const hiddenBotThreadKeys = query.length > 0 ? undefined : input.hiddenBotThreadKeys;
  const listedThreads = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      !isSideChatThread(thread) &&
      hiddenBotThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (projectKeys === null ||
        projectKeys.has(`${thread.environmentId}:${thread.projectId}`) ||
        isActiveThreadWork(thread) ||
        queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true),
  );
  // The same matches as the command palette, typo fallback included. Only
  // listed threads are ranked: a hidden exact match must not turn typos off.
  const rankedMatches =
    query.length > 0
      ? rankSearchItems(listedThreads, (thread, options) =>
          scoreThreadSearch(query, threadSearchSubject(thread, null), nowMs, {
            ...options,
            picks: false,
          }),
        ).map(({ item }) => item)
      : null;
  const matchingThreads = rankedMatches === null ? null : new Set(rankedMatches);
  // Threads listed only because their messages match; only their rows show
  // the message and open at it.
  const contentOnlyThreadKeys = new Set<string>();
  // Searching lists matches flat; otherwise launched threads fold under their launcher's row.
  const fold =
    rankedMatches === null
      ? foldThreadListV2({ listed: listedThreads, owners: input.launchOwners ?? [], lifecycle })
      : null;
  const lifted: EnvironmentThreadShell[] = [];
  for (const thread of listedThreads) {
    if (thread.snoozedUntil == null || !threadListV2Snoozed(thread, lifecycle)) continue;
    if (
      nextSnoozeWakeAt === null ||
      parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt)
    ) {
      nextSnoozeWakeAt = thread.snoozedUntil;
    }
  }
  for (const thread of fold?.roots ?? listedThreads) {
    if (matchingThreads !== null && !matchingThreads.has(thread)) {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      if (input.matchedThreadKeys?.has(key) !== true) continue;
      contentOnlyThreadKeys.add(key);
    }
    if (threadListV2Snoozed(thread, lifecycle)) {
      snoozed.push(thread);
      continue;
    }
    // Work folded under a row carries it where the web's Priority would: never in a shelf.
    if (fold?.liftByKey.has(`${thread.environmentId}:${thread.id}`) === true) {
      (thread.pinnedAt != null ? pinned : lifted).push(thread);
    } else if (threadListV2Settled(thread, lifecycle)) {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (workingShelfEnabled && (input.isWorking ?? isThreadWorking)(thread)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  if (rankedMatches !== null) {
    // Searching lists every match by rank across shelves, as the palette and
    // the web sidebar do, then threads listed for their messages in the
    // server's order. Each row keeps its shelf's look.
    const slim = new Set([...snoozed, ...settled]);
    const snoozedThreads = new Set(snoozed);
    const pinnedThreads = new Set(pinned);
    const threadByKey = new Map(
      listedThreads.map((thread) => [
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        thread,
      ]),
    );
    const contentOnly = [...(input.matchedThreadKeys ?? [])].flatMap((key) => {
      const thread = contentOnlyThreadKeys.has(key) ? threadByKey.get(key) : undefined;
      return thread ? [thread] : [];
    });
    const results = [...rankedMatches, ...contentOnly];
    return {
      items: results.map((thread, index) => ({
        thread,
        variant: slim.has(thread) ? "slim" : "card",
        snoozed: snoozedThreads.has(thread),
        pinned: pinnedThreads.has(thread),
        wokeAt: slim.has(thread) ? null : resolveThreadListV2WokeAt(thread, { now }),
        isLast: index === results.length - 1,
      })),
      hiddenSettledCount: 0,
      listedSettledThreads: [],
      workingCount: 0,
      workingShelfHeaderIndex: null,
      snoozedCount: 0,
      snoozedShelfHeaderIndex: null,
      settledCount: 0,
      settledShelfHeaderIndex: null,
      nextSnoozeWakeAt,
      contentOnlyThreadKeys,
      launchRevealKeys: [],
      launchRouteAncestorKeys: [],
    };
  }

  const orderedActive = workingShelfEnabled
    ? sortInboxThreadsByReturn(active, input.inboxReturnAt)
    : applyPendingThreadOrder(sortThreadsForListV2(active), "active", pending);
  const orderedWorking = sortWorkingThreadsBySend(working);
  const orderedSnoozed = [...snoozed].sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
  );
  const selectedThreadKey = input.selectedThreadKey ?? null;
  // A selected folded thread shows through the top-level row that holds it.
  const selectedRowKey = fold === null ? selectedThreadKey : launchRootKey(fold, selectedThreadKey);
  const isSelectedRow = (thread: EnvironmentThreadShell) =>
    `${thread.environmentId}:${thread.id}` === selectedRowKey;
  const visibleWorking =
    input.workingShelfExpanded === true ? orderedWorking : orderedWorking.filter(isSelectedRow);
  const visibleSnoozed =
    input.snoozedShelfExpanded === true ? orderedSnoozed : orderedSnoozed.filter(isSelectedRow);
  const orderedSettled = sortSettledThreadsReusingLast(settled);
  const isListedSettled = input.isListedSettled;
  // A settled launcher is listed once it or anything folded under it has loaded.
  const listedWithFolded = (thread: EnvironmentThreadShell): boolean =>
    isListedSettled === undefined ||
    isListedSettled(thread) ||
    (fold?.childrenByParentKey.get(`${thread.environmentId}:${thread.id}`) ?? []).some(
      listedWithFolded,
    );
  const listedSettled =
    isListedSettled === undefined ? orderedSettled : orderedSettled.filter(listedWithFolded);
  const settledTotal = orderedSettled.length + (input.unloadedSettledCount ?? 0);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const limitedSettled =
    listedSettled.length > settledLimit ? listedSettled.slice(0, settledLimit) : listedSettled;
  const selectedSettled =
    selectedRowKey === null || limitedSettled.some(isSelectedRow)
      ? undefined
      : orderedSettled.find(isSelectedRow);
  const pagedSettled =
    selectedSettled === undefined ? limitedSettled : [...limitedSettled, selectedSettled];
  const visibleSettled =
    input.settledShelfExpanded !== false ? pagedSettled : pagedSettled.filter(isSelectedRow);

  const groups = input.launchGroups;
  const routeAncestorKeys =
    fold === null || selectedThreadKey === null ? [] : launchAncestorKeys(fold, selectedThreadKey);
  const isExpanded = (parentKey: string) =>
    routeAncestorKeys.includes(parentKey)
      ? groups?.routeCollapsed.has(parentKey) !== true
      : groups?.expanded[parentKey] === true;
  const childItem = (thread: EnvironmentThreadShell, depth: number): ThreadListV2Item => {
    const childSnoozed = threadListV2Snoozed(thread, lifecycle);
    const slim = childSnoozed || threadListV2Settled(thread, lifecycle);
    return {
      thread,
      variant: slim ? "slim" : "card",
      snoozed: childSnoozed,
      pinned: false,
      wokeAt: slim ? null : resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
      depth,
      lift: fold?.liftByKey.get(`${thread.environmentId}:${thread.id}`) ?? null,
    };
  };
  const items: ThreadListV2Item[] = [];
  const launchMarkers: ThreadListV2LaunchMarker[] = [];
  const push = (item: Omit<ThreadListV2Item, "isLast" | "depth" | "lift">) => {
    const lift = fold?.liftByKey.get(`${item.thread.environmentId}:${item.thread.id}`) ?? null;
    const entry: ThreadListV2Item = { ...item, isLast: false, depth: 0, lift };
    if (fold === null) items.push(entry);
    else
      appendWithLaunchChildren(items, launchMarkers, entry, {
        fold,
        isExpanded,
        showAll: (parentKey) => groups?.showAll.has(parentKey) === true,
        routeKeys: new Set(
          selectedThreadKey === null ? [] : [selectedThreadKey, ...routeAncestorKeys],
        ),
        childItem,
      });
  };
  const card = (thread: EnvironmentThreadShell, pinnedRow: boolean) =>
    push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: pinnedRow,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
    });
  for (const thread of applyPendingThreadOrder(
    sortPinnedThreadsByOrderKey(pinned),
    "pinned",
    pending,
  )) {
    card(thread, true);
  }
  for (const thread of fold === null
    ? []
    : sortLiftedThreads(sortThreadsForListV2(lifted), fold.liftByKey)) {
    card(thread, false);
  }
  for (const thread of orderedActive) card(thread, false);
  const workingShelfHeaderIndex = orderedWorking.length > 0 ? items.length : null;
  for (const thread of visibleWorking) card(thread, false);
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    push({ thread, variant: "slim", snoozed: true, pinned: false, wokeAt: null });
  }
  const settledShelfHeaderIndex = settledTotal > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    push({ thread, variant: "slim", snoozed: false, pinned: false, wokeAt: null });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    launchMarkers,
    hiddenSettledCount: Math.max(0, settledTotal - pagedSettled.length),
    listedSettledThreads: listedSettled,
    workingCount: orderedWorking.length,
    workingShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: settledTotal,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
    contentOnlyThreadKeys,
    launchRevealKeys: routeAncestorKeys.filter(
      (key) => groups?.expanded[key] !== true && groups?.routeCollapsed.has(key) !== true,
    ),
    launchRouteAncestorKeys: routeAncestorKeys,
  };
}
