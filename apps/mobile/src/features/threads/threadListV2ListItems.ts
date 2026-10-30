import type { EnvironmentId } from "@goat/contracts";
import { resolveThreadListStatus } from "@goat/client-runtime/state/thread-list-priority";
import { canSnooze, snoozeWakeLabel } from "@goat/client-runtime/state/thread-settled";
import { resolveSettledThreadTimestamp } from "@goat/client-runtime/state/thread-sort";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { ThreadListV2FoldedUnseen, ThreadListV2Item } from "./threadListV2";
import {
  liftedThreadListV2Status,
  threadHasUnseenCompletion,
  type ThreadListV2LaunchGroupEntry,
  type ThreadListV2LaunchMarker,
} from "./threadListV2LaunchFold";
import type { ThreadMoveAvailability } from "./threadOrder";

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

export interface ThreadListV2PriorityHeaderListItem {
  readonly type: "v2-priority-header";
  readonly key: "v2-priority-header";
  /** Priority's own rows and the unread threads folded under them, which its read actions act on. */
  readonly rows: ReadonlyArray<ThreadListV2Item>;
  readonly foldedUnseen: ReadonlyArray<ThreadListV2FoldedUnseen>;
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
  | ThreadListV2PriorityHeaderListItem
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
    value.type === "v2-priority-header" ||
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
    case "v2-priority-header":
      return (
        previous.type === "v2-priority-header" &&
        previous.rows.length === item.rows.length &&
        previous.rows.every(
          (row, index) =>
            row.thread === item.rows[index]?.thread &&
            row.wokeAt === item.rows[index]?.wokeAt &&
            (row.lift ?? null) === (item.rows[index]?.lift ?? null),
        ) &&
        previous.foldedUnseen.length === item.foldedUnseen.length &&
        previous.foldedUnseen.every(
          (entry, index) =>
            entry.thread === item.foldedUnseen[index]?.thread &&
            entry.rowKey === item.foldedUnseen[index]?.rowKey,
        )
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
    (liftedThreadListV2Status(resolveThreadListStatus(thread), item.lift) !== "ready" ||
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
  readonly priorityCount?: number;
  readonly priorityFoldedUnseen?: ReadonlyArray<ThreadListV2FoldedUnseen>;
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
  const priorityCount = input.priorityCount ?? 0;
  const threadRows = input.items.map((item, index): ThreadListV2ListItem => {
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
      item.variant === "card" && index >= priorityCount
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
  const result: ThreadListV2ListItem[] = [];
  if (priorityCount > 0) {
    result.push({
      type: "v2-priority-header",
      key: "v2-priority-header",
      rows: input.items.slice(0, priorityCount).filter((item) => (item.depth ?? 0) === 0),
      foldedUnseen: input.priorityFoldedUnseen ?? [],
    });
    result.push(...threadItems.slice(0, priorityCount).flat());
  }
  result.push(...pendingItems, ...threadItems.slice(priorityCount, activeEnd).flat());
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
