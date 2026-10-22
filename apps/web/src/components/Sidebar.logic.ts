import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { backgroundWorkHoldsCompletion } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestSearchTerms } from "@goat/shared/threadPullRequests";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { threadSearchMatchKey } from "@goat/client-runtime/state/thread-search";
import type { ContextMenuItem, EnvironmentId, ThreadId } from "@goat/contracts";
import { isSideChatThread } from "@goat/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@goat/contracts/settings";
import type { AsyncResult } from "effect/reactivity";
import { planPinnedReorder } from "@goat/client-runtime/state/thread-sort";
import {
  effectiveSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "@goat/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { normalizeSearchText } from "../lib/utils";
import { isLatestRunSettled } from "../session-logic";

export function sidebarFolderName(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const last = segments.at(-1);
  return last === undefined || (segments.length === 1 && /^[a-z]:$/i.test(last)) ? null : last;
}

export function sidebarShortDeviceName(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  const token = trimmed.split(/[\s.\-_]/, 1)[0]?.replace(/['’]/g, "");
  return token || trimmed;
}

const SIDEBAR_HOST_HUE_CLASSES = [
  "text-orange-500",
  "text-emerald-500",
  "text-violet-500",
  "text-pink-500",
  "text-amber-500",
  "text-teal-500",
  "text-lime-600",
  "text-rose-500",
] as const;

function sidebarHostHueSlot(environmentId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash = Math.imul(hash ^ environmentId.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) % SIDEBAR_HOST_HUE_CLASSES.length;
}

/** Hash-only hue, for an environment outside the known set. */
export function sidebarHostHueClassName(environmentId: string): string {
  return SIDEBAR_HOST_HUE_CLASSES[sidebarHostHueSlot(environmentId)]!;
}

/**
 * Distinct globe hues for the known device environments. Each id keeps its hashed
 * hue unless an id that sorts earlier already took it, then moves to the next free
 * one, so colors only repeat past the palette size and never depend on list order.
 */
export function assignSidebarHostHues(
  environmentIds: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const taken = new Set<number>();
  const hues = new Map<string, string>();
  for (const environmentId of [...new Set(environmentIds)].toSorted()) {
    if (taken.size === SIDEBAR_HOST_HUE_CLASSES.length) taken.clear();
    let slot = sidebarHostHueSlot(environmentId);
    while (taken.has(slot)) slot = (slot + 1) % SIDEBAR_HOST_HUE_CLASSES.length;
    taken.add(slot);
    hues.set(environmentId, SIDEBAR_HOST_HUE_CLASSES[slot]!);
  }
  return hues;
}

export function shouldNavigateAfterThreadPark(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly action: "settle" | "snooze";
  readonly now: string;
  readonly thread: (ThreadSnoozeShell & Pick<SidebarThreadSummary, "settledOverride">) | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    (input.action === "settle"
      ? input.thread.settledOverride === "settled"
      : effectiveSnoozed(input.thread, { now: input.now }))
  );
}

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Each prewarmed thread holds a live, fully hydrated detail subscription (all
// messages and activities, growing as agents work) for as long as the row stays
// visible, so this limit is a direct renderer-heap and server-load multiplier —
// keep it small; cold opens still render instantly from the cached snapshot.
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
} {
  const [row, setRow] = React.useState<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);
  // The active row stays leased after it deactivates until the observer reports.
  if (isActive && !isNearViewport) setIsNearViewport(true);
  const canObserve = typeof IntersectionObserver !== "undefined";

  React.useEffect(() => {
    if (isActive || row === null || !canObserve) return;

    const scrollRoot = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry?.isIntersecting === true),
      {
        root: scrollRoot,
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [canObserve, isActive, row]);

  return {
    leaseLiveStatus: isActive || isNearViewport || !canObserve,
    rowRef: setRow,
  };
}

export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const [retained, setRetained] = React.useState<{
    readonly key: string;
    readonly value: T;
  } | null>(null);
  if (key !== null && value !== null && (retained?.key !== key || retained.value !== value)) {
    setRetained({ key, value });
  }
  if (value !== null) return value;
  return key !== null && retained?.key === key ? retained.value : null;
}

// Sidebar.motion handles ordinary section changes. Sortable transforms own
// dragging; replaying their committed DOM order would animate the drop twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Rows and section markers share one sortable list. The separators resolve
// the lifecycle action; Sidebar.drag previews the resulting layout. Pinned
// and active threads keep the dragged position; settled threads use time
// order. Snoozed rows can leave the shelf, but dropping into it is not
// supported because snoozing requires a wake time. Priority follows live
// attention, so it is neither a drag source nor a destination.

export type SidebarSection = "priority" | "pinned" | "active" | "snoozed" | "settled";

/** Snooze wins until its wake boundary. Priority overlays lifecycle;
 * otherwise settlement wins over a stale pin. */
export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
  readonly priority?: boolean;
}): SidebarSection {
  if (input.snoozed) return "snoozed";
  if (input.priority) return "priority";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  | "pinned-header"
  | "active-placeholder"
  | "settled-placeholder"
  | "pinned-divider"
  | "priority-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker };

export function sidebarListItemId(item: SidebarListItem): string {
  return item.kind === "thread" ? item.key : sidebarMarkerId(item.marker);
}

/** A status or lifecycle change must end a drag before it applies a stale action. */
export function shouldCancelSidebarThreadDrag(
  items: readonly SidebarListItem[],
  drag: { readonly activeKey: string; readonly activeSection: SidebarSection },
): boolean {
  return !items.some(
    (item) =>
      item.kind === "thread" && item.key === drag.activeKey && item.section === drag.activeSection,
  );
}

/** Section markers delimit Priority, Pinned, the inbox, and lifecycle shelves. */
function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "priority-header") section = "priority";
    else if (item.marker === "pinned-header") section = "pinned";
    else if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

/** Resolve the destination section and manual order from an arrayMove across
 * the separators. Priority and snoozed rows are never destinations. */
export type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  const source = items[activeIndex]!;
  const over = items[overIndex]!;
  if (
    (source.kind === "thread" && source.section === "priority") ||
    (over.kind === "thread" && over.section === "priority") ||
    (over.kind === "marker" && over.marker === "priority-header")
  )
    return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  // Pinned's top boundary belongs to Pinned even when Priority precedes it.
  const destinationIndex =
    over.kind === "marker" && over.marker === "pinned-header" ? overIndex + 1 : overIndex;
  moved.splice(destinationIndex, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, destinationIndex);
  if (section === "priority" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "priority-header") currentSection = "priority";
      else if (item.marker === "pinned-header") currentSection = "pinned";
      else if (item.marker === "pinned-divider") currentSection = "active";
      else if (item.marker === "snoozed-header" || item.marker === "settled-header") break;
    } else if (currentSection === "pinned") pinnedOrder.push(item.key);
    else if (currentSection === "active") activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

export type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

/** What dropping in `to` does to a thread lifted from `from`, for the badge
    on the lifted row. Null while reordering inside one section and for the
    Priority and snoozed rows, which cannot be drop targets. */
export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

/** How a pressed sidebar row may drag. "sort" moves it within the list and
    drags it out to a composer past the list edge; "context" only drags it
    out. Handing a thread to a composer reads it and writes nothing, so it
    never depends on the section, the server's ordering support, or operate
    permission. Only an inline rename blocks both. */
export type SidebarThreadDragMode = "sort" | "context" | "none";

export function resolveSidebarThreadDragMode(input: {
  readonly section: SidebarSection;
  readonly reorderable: boolean;
  readonly renaming: boolean;
  readonly dropPending: boolean;
  readonly canOperate: boolean;
}): SidebarThreadDragMode {
  if (input.renaming) return "none";
  // Priority ranks by attention, so its rows never take a manual order.
  if (input.section === "priority") return "context";
  // A drop still writing its order holds every row until the writes land.
  if (!input.reorderable || !input.canOperate || input.dropPending) return "context";
  return "sort";
}

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "priority" || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

export function resolveSidebarSweepKeys(
  orderedKeys: readonly string[],
  originKey: string,
  targetKey: string,
  canApply: (key: string) => boolean,
): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y;
  let key: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break;
    key = row.dataset.threadItem ?? null;
  }
  return key;
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (activeSection === "priority") return { kind: "none" };
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  const arrange = (
    order: readonly string[],
    keysById: ReadonlyMap<string, string | null | undefined>,
    writable: ReadonlySet<string> | undefined,
  ) => {
    if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
    if (!writable.has(activeKey)) return null;
    const assignments = planPinnedReorder({
      orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
      keysById,
      movedId: activeKey,
    });
    return assignments.every(({ id }) => writable.has(id)) ? assignments : null;
  };
  switch (target.section) {
    case "active": {
      const order = target.activeOrder;
      if (
        activeSection === "active" &&
        order.length === activeOrder.length &&
        order.every((key, index) => key === activeOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, activeKeysById, activeReorderableKeys);
      if (assignments === null) return { kind: "none" };
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled" ? { kind: "none" } : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, pinnedKeysById, reorderableKeys);
      if (assignments === null) return { kind: "none" };
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
  >,
>(thread: T, section: "pinned" | "active" | "settled", now: string, orderKey?: string): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined ? { activeOrderKey: orderKey } : {}),
  };
}

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

/**
 * Shared-worktree checks must exclude only successful deletions, never the
 * whole batch.
 */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

function isSidebarSubagentThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

type SidebarChildInput = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "source"
  | "latestRun"
  | "runtime"
  | "updatedAt"
  | "createdAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingBackgroundTasks"
>;

/**
 * Live subagent threads with a parent: delegate_task children (and their backing
 * threads) and provider-native subagents, on any environment.
 */
export function isSidebarSubagentChildThread(
  thread: Pick<SidebarThreadSummary, "lineage" | "archivedAt" | "deletedAt">,
): boolean {
  return (
    isSidebarSubagentThread(thread) &&
    thread.lineage.parentThreadId !== null &&
    thread.archivedAt === null &&
    thread.deletedAt === null
  );
}

/** GOAT-owned delegate_task children; provider-native subagents belong to their provider. */
export function isSidebarDelegatedChildThread(thread: SidebarChildInput): boolean {
  return isSidebarSubagentChildThread(thread) && thread.source.creationSource === "mcp";
}

export type SidebarDelegatedChildState = "attention" | "working" | "queued" | "finished";

/**
 * A delegated task's child thread can become a top-level thread when its server
 * understands thread.promote. Provider-native subagents belong to their provider.
 */
export function canPromoteThread(
  thread: Pick<SidebarThreadSummary, "lineage" | "source" | "deletedAt" | "forkedFrom">,
  capabilities: { readonly threadPromotion?: boolean } | undefined,
): boolean {
  return (
    capabilities?.threadPromotion === true &&
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId !== null &&
    thread.source.creationSource === "mcp" &&
    thread.forkedFrom?.type === "node"
  );
}

export function sidebarDelegatedChildState(
  thread: Pick<
    SidebarChildInput,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "pendingBackgroundTasks"
  >,
): SidebarDelegatedChildState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  const status = thread.runtime?.status;
  if (
    status === "preparing" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting" ||
    (status === "idle" && thread.pendingBackgroundTasks.length > 0)
  )
    return "working";
  return status === "queued" ? "queued" : "finished";
}

/** Stop interrupts active work; queued-only and background children have no active turn. */
export function canStopSidebarDelegatedChild(thread: SidebarChildInput): boolean {
  const state = sidebarDelegatedChildState(thread);
  return (
    isSidebarDelegatedChildThread(thread) &&
    thread.runtime?.activeRunId != null &&
    (state === "attention" || (state === "working" && thread.runtime.status !== "idle"))
  );
}

export type SidebarChildAttention = "approval" | "input";

/**
 * Subagents never get a sidebar row of their own. Each one belongs to its nearest
 * non-subagent ancestor (the owner row): the owner shows the subagent while it is the
 * open thread, and carries a delegated task's pending approval or question as the
 * owner's status. Provider-native subagents already ask through their parent.
 */
export interface SidebarSubagentIndex {
  readonly ownerKeyByChildKey: ReadonlyMap<string, string>;
  readonly attentionByOwnerKey: ReadonlyMap<string, SidebarChildAttention>;
}

const sameMap = <V>(left: ReadonlyMap<string, V>, right: ReadonlyMap<string, V>) =>
  left.size === right.size &&
  [...left].every(([key, value]) => right.has(key) && right.get(key) === value);

/** Index once per shell collection; unchanged maps keep their identity for memoized rows. */
export function buildSidebarSubagentIndex(
  threads: ReadonlyArray<
    Pick<
      SidebarThreadSummary,
      | "environmentId"
      | "id"
      | "lineage"
      | "archivedAt"
      | "deletedAt"
      | "source"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
    >
  >,
  previous?: SidebarSubagentIndex,
): SidebarSubagentIndex {
  // Archived or deleted subagents never own anything, but they still link their own
  // subagents to an ancestor.
  const parentKeyByChildKey = new Map<string, string>();
  const rowKeys = new Set<string>();
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (!isSidebarSubagentThread(thread)) rowKeys.add(key);
    else if (thread.lineage.parentThreadId !== null)
      parentKeyByChildKey.set(
        key,
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId)),
      );
  }
  const ownerKeyByChildKey = new Map<string, string>();
  const attentionByOwnerKey = new Map<string, SidebarChildAttention>();
  for (const thread of threads) {
    if (!isSidebarSubagentChildThread(thread)) continue;
    const childKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    let ownerKey = parentKeyByChildKey.get(childKey);
    if (ownerKey === undefined) continue;
    // A subagent of a subagent belongs to the first ancestor that has a row.
    const seen = new Set([childKey]);
    while (!seen.has(ownerKey)) {
      const next = parentKeyByChildKey.get(ownerKey);
      if (next === undefined) break;
      seen.add(ownerKey);
      ownerKey = next;
    }
    // A link missing from the shells (an archived subagent the client never loaded, or a
    // cycle) falls back to the lineage root when that thread has a row.
    if (!rowKeys.has(ownerKey)) {
      ownerKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.lineage.rootThreadId));
      if (!rowKeys.has(ownerKey)) continue;
    }
    ownerKeyByChildKey.set(childKey, ownerKey);
    if (thread.source.creationSource !== "mcp") continue;
    if (thread.hasPendingApprovals) attentionByOwnerKey.set(ownerKey, "approval");
    else if (thread.hasPendingUserInput && !attentionByOwnerKey.has(ownerKey))
      attentionByOwnerKey.set(ownerKey, "input");
  }
  const sameOwners =
    previous !== undefined && sameMap(previous.ownerKeyByChildKey, ownerKeyByChildKey);
  const sameAttention =
    previous !== undefined && sameMap(previous.attentionByOwnerKey, attentionByOwnerKey);
  if (previous !== undefined && sameOwners && sameAttention) return previous;
  return {
    ownerKeyByChildKey: sameOwners ? previous.ownerKeyByChildKey : ownerKeyByChildKey,
    attentionByOwnerKey: sameAttention ? previous.attentionByOwnerKey : attentionByOwnerKey,
  };
}

/**
 * Folds a subagent's pending request into its owner row, so status pills, Priority and
 * project indicators treat it like the owner's own approval or question.
 */
export function withSidebarChildRequest<
  T extends Pick<SidebarThreadSummary, "hasPendingApprovals" | "hasPendingUserInput">,
>(thread: T, childAttention: SidebarChildAttention | undefined): T {
  if (childAttention === undefined) return thread;
  return {
    ...thread,
    hasPendingApprovals: thread.hasPendingApprovals || childAttention === "approval",
    hasPendingUserInput: thread.hasPendingUserInput || childAttention === "input",
  };
}

export type SidebarSettingsHydration = "pending" | "ready" | "failed" | "retrying";

/**
 * Which sidebar to mount. `null` holds the tree unmounted until settings resolve,
 * so Projects does not mount and then swap. A synchronous last view paints immediately.
 * Failed hydration with no saved view uses Projects.
 */
export function resolveSidebarViewIsProjects(input: {
  readonly status: SidebarSettingsHydration;
  readonly value: boolean;
  readonly synchronousValue: boolean | null;
}): boolean | null {
  if (input.status === "ready") return input.value;
  if (input.synchronousValue !== null) return input.synchronousValue;
  if (input.status === "failed") return DEFAULT_CLIENT_SETTINGS.projectsSidebarEnabled;
  return null;
}

// Subagent threads have no sidebar row, so an open subagent is represented by
// its nearest non-subagent ancestor. A broken chain (missing parent, cycle,
// other environment) resolves to the thread itself, which then matches no row.
export function resolveSidebarRowThreadId(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  threads: readonly Pick<SidebarThreadSummary, "id" | "environmentId" | "lineage">[],
): ThreadId {
  const findThread = (id: ThreadId) =>
    threads.find((thread) => thread.id === id && thread.environmentId === environmentId);
  const visited = new Set<ThreadId>();
  let thread = findThread(threadId);
  while (thread !== undefined && isSidebarSubagentThread(thread)) {
    if (thread.lineage.parentThreadId === null || visited.has(thread.id)) return threadId;
    visited.add(thread.id);
    thread = findThread(thread.lineage.parentThreadId);
  }
  return thread?.id ?? threadId;
}

export function filterSidebarV2VisibleThreads<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "lineage" | "sideChatOf"> & {
    environmentId: string;
    projectId: string;
    id?: SidebarThreadSummary["id"];
    deletedAt?: SidebarThreadSummary["deletedAt"];
  },
>(
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  /** Archived owners kept so a child's request or the open subagent still has a row. */
  retainedArchivedKeys?: ReadonlySet<string>,
): T[] {
  return threads.filter((thread) => {
    if (thread.deletedAt != null || isSidebarSubagentThread(thread) || isSideChatThread(thread))
      return false;
    if (thread.archivedAt !== null) {
      if (retainedArchivedKeys === undefined || thread.id === undefined) return false;
      const key = scopedThreadKey(
        scopeThreadRef(thread.environmentId as SidebarThreadSummary["environmentId"], thread.id),
      );
      if (!retainedArchivedKeys.has(key)) return false;
    }
    return (
      scopedProjectKeys === null ||
      scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)
    );
  });
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

export function buildBulkUnpinContextMenuItem(input: {
  pinnedCount: number;
}): ContextMenuItem<"unpin"> | null {
  if (input.pinnedCount === 0) return null;
  return { id: "unpin", label: `Unpin (${input.pinnedCount})` };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Failed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Waiting"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Failed: 3.5,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
  blockedOnThreadWait?: boolean | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = (shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  };

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // When the server tracks visits it is authoritative — including explicit
  // rewinds from mark-unread, which a newer browser-local watermark must not
  // mask. The local value only carries servers without visited tracking.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Writable unread completions and woke-only rows are targets of Priority's bulk visit. */
export function selectSidebarMarkReadTargets<
  T extends ThreadStatusInput & Pick<SidebarThreadSummary, "environmentId" | "id">,
>(input: {
  readonly threads: readonly T[];
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly wokeAtByKey?: ReadonlyMap<string, string | null>;
  readonly canOperate: (thread: T) => boolean;
}): T[] {
  return input.threads.filter((thread) => {
    if (!input.canOperate(thread)) return false;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      input.localLastVisitedAtByKey[key],
    );
    return (
      hasUnseenCompletion({ ...thread, lastVisitedAt }) ||
      isSidebarThreadWoke(input.wokeAtByKey?.get(key) ?? null, lastVisitedAt)
    );
  });
}

/** A visit acknowledges a wake without changing the thread's lifecycle. */
export function isSidebarThreadWoke(
  wokeAt: string | null,
  lastVisitedAt: string | undefined,
): boolean {
  if (wokeAt === null || !Number.isFinite(Date.parse(wokeAt))) return false;
  const visited = lastVisitedAt === undefined ? NaN : Date.parse(lastVisitedAt);
  return !Number.isFinite(visited) || visited < Date.parse(wokeAt);
}

/** Priority is a display overlay; its rank never changes pinning or settlement. */
export function resolveSidebarPriorityRank(input: {
  readonly thread: ThreadStatusInput;
  readonly localLastVisitedAt?: string | undefined;
  readonly wokeAt: string | null;
  readonly hasChildAttention: boolean;
}): 0 | 1 | 2 | null {
  const status = resolveSidebarThreadStatus(input.thread);
  if (status === "approval" || status === "input" || input.hasChildAttention) return 0;
  if (status === "working" || status === "waiting") return 1;
  const lastVisitedAt = resolveThreadLastVisitedAt(
    input.thread.lastVisitedAt,
    input.localLastVisitedAt,
  );
  return hasUnseenCompletion({ ...input.thread, lastVisitedAt }) ||
    isSidebarThreadWoke(input.wokeAt, lastVisitedAt)
    ? 2
    : null;
}

/** Settled state each Priority row had when Activity last showed it, by scoped thread key. */
export type SidebarPriorityHolds = ReadonlyMap<string, SidebarThreadSummary["settledOverride"]>;

/**
 * Reading a thread does not pull its row out of Priority while Activity stays open; it leaves
 * when Activity is shown again. Settling or unsettling the row is the user's own move, so a
 * changed settled state ends the hold.
 */
export function holdSidebarPriorityRank(input: {
  readonly rank: 0 | 1 | 2 | null;
  readonly key: string;
  readonly settledOverride: SidebarThreadSummary["settledOverride"];
  readonly holds: SidebarPriorityHolds;
  /** Mark all as read drops the row once it no longer qualifies, instead of holding it. */
  readonly released?: boolean;
}): 0 | 1 | 2 | null {
  if (input.released) return input.rank;
  if (input.rank !== null || !input.holds.has(input.key)) return input.rank;
  return input.holds.get(input.key) === input.settledOverride ? 2 : null;
}

/**
 * Settling acknowledges a wake. The acknowledgement sticks until the shell stops
 * reporting one, so a later hold cannot put the Woke pill back. Un-settling restores it.
 */
export function resolveSidebarWokeAtForRow(input: {
  readonly key: string;
  readonly rawWokeAt: string | null;
  readonly settledOverride: SidebarThreadSummary["settledOverride"];
  readonly heldSettledOverride: SidebarThreadSummary["settledOverride"] | undefined;
  readonly acknowledged: Set<string>;
}): string | null {
  const settling =
    input.heldSettledOverride !== undefined &&
    input.heldSettledOverride !== input.settledOverride &&
    input.settledOverride === "settled";
  if (settling) input.acknowledged.add(input.key);
  if (input.settledOverride !== "settled" || input.rawWokeAt === null) {
    input.acknowledged.delete(input.key);
  }
  return input.acknowledged.has(input.key) ? null : input.rawWokeAt;
}

type SidebarPriorityMember = ThreadStatusInput &
  ThreadSnoozeShell &
  Pick<SidebarThreadSummary, "settledOverride" | "pinnedAt" | "deletedAt">;

/** Priority membership shared by the section and the activity bell. Holds are not included. */
export function isSidebarPriorityMember(input: {
  readonly thread: SidebarPriorityMember;
  readonly now: string;
  readonly localLastVisitedAt: string | undefined;
  readonly hasChildAttention: boolean;
  readonly supportsSnooze: boolean;
  readonly supportsSettlement: boolean;
}): boolean {
  if (input.thread.deletedAt != null) return false;
  const rank = resolveSidebarPriorityRank({
    thread: input.thread,
    localLastVisitedAt: input.localLastVisitedAt,
    wokeAt: threadWokeAt(input.thread, { now: input.now }),
    hasChildAttention: input.hasChildAttention,
  });
  return (
    resolveSidebarThreadSection({
      snoozed: input.supportsSnooze && effectiveSnoozed(input.thread, { now: input.now }),
      settled: input.supportsSettlement && input.thread.settledOverride === "settled",
      pinned: input.thread.pinnedAt != null,
      priority: rank !== null,
    }) === "priority"
  );
}

export function countVisibleSidebarPriorityThreads<
  T extends SidebarPriorityMember & Pick<SidebarThreadSummary, "environmentId" | "id">,
>(input: {
  readonly threads: readonly T[];
  readonly now: string;
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly attentionByOwnerKey: ReadonlyMap<string, SidebarChildAttention>;
  readonly supportsSnooze: (environmentId: SidebarThreadSummary["environmentId"]) => boolean;
  readonly supportsSettlement: (environmentId: SidebarThreadSummary["environmentId"]) => boolean;
}): number {
  let count = 0;
  for (const thread of input.threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (
      isSidebarPriorityMember({
        thread,
        now: input.now,
        localLastVisitedAt: input.localLastVisitedAtByKey[key],
        hasChildAttention: input.attentionByOwnerKey.has(key),
        supportsSnooze: input.supportsSnooze(thread.environmentId),
        supportsSettlement: input.supportsSettlement(thread.environmentId),
      })
    ) {
      count += 1;
    }
  }
  return count;
}

let publishedSidebarPriorityCount: number | null = null;
const sidebarPriorityCountListeners = new Set<() => void>();

/** Activity publishes the Priority row count so the bell shows the same number. */
export function publishSidebarPriorityCount(count: number | null): void {
  if (publishedSidebarPriorityCount === count) return;
  publishedSidebarPriorityCount = count;
  for (const listener of sidebarPriorityCountListeners) listener();
}

export function subscribeSidebarPriorityCount(listener: () => void): () => void {
  sidebarPriorityCountListeners.add(listener);
  return () => {
    sidebarPriorityCountListeners.delete(listener);
  };
}

export function getPublishedSidebarPriorityCount(): number | null {
  return publishedSidebarPriorityCount;
}

/**
 * Cache ranks before sorting. Within a rank, newer threads come first by
 * creation time: updatedAt moves on every streamed event of a running thread,
 * so ordering by it would swap working rows while they stream.
 */
export function sortPriorityThreadsForSidebar<
  T extends Pick<SidebarThreadSummary, "environmentId" | "id" | "createdAt">,
>(threads: readonly T[], ranks: ReadonlyMap<string, number>): T[] {
  const key = (thread: T) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  return threads.toSorted(
    (left, right) =>
      (ranks.get(key(left)) ?? 2) - (ranks.get(key(right)) ?? 2) ||
      firstValidTimestampMs(right.createdAt) - firstValidTimestampMs(left.createdAt) ||
      key(left).localeCompare(key(right)),
  );
}

/** Row controls follow lifecycle even inside Priority. */
export function resolveSidebarThreadPresentation(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
}) {
  return {
    action: input.snoozed
      ? ("unsnooze" as const)
      : input.settled
        ? ("unsettle" as const)
        : ("settle" as const),
  };
}

/**
 * A failed latest run the person hasn't looked at since it ended. Unlike a
 * completion, a thread nobody has opened yet (an automation's, say) counts:
 * its failure still needs someone.
 */
function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  projectGroupCount: number,
): boolean {
  return shiftKey || projectGroupCount <= 1;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (input.isActive || input.isSelected || input.status === "input") return false;
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
> & { blockedOnThreadWait?: boolean | undefined };

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
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

export type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "waiting"
  | "woke"
  | "working";

export function resolveSidebarV2TopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): SidebarV2TopStatusKind | null {
  if (input.status === "working") {
    return "working";
  }
  if (input.status === "waiting") {
    return "waiting";
  }
  if (input.status === "approval") {
    return "approval";
  }
  if (input.status === "input") {
    return "input";
  }
  if (input.status === "failed" || input.status === "limited") {
    return input.status;
  }
  if (input.isWoke) {
    return "woke";
  }
  return input.isUnread ? "done" : null;
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export { sortActiveThreadsByOrderKey as sortThreadsForSidebar } from "@goat/client-runtime/state/thread-sort";
// Pinned-reorder key math and the keyed sort live in client-runtime
// (state/thread-sort) so web and mobile compute identical pinned orders.
export { pinOrderKeyBetween } from "@goat/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@goat/client-runtime/state/thread-sort";

const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

export function searchSidebarThreads<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
  } & Parameters<typeof threadPullRequestSearchTerms>[0],
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  const titleMatches: T[] = [];
  const contentMatches: T[] = [];
  for (const thread of threads) {
    const matchesTitle = [thread.title, ...threadPullRequestSearchTerms(thread)].some((term) =>
      term.toLowerCase().includes(normalizedQuery),
    );
    if (matchesTitle) {
      titleMatches.push(thread);
    } else if (
      contentMatchKeys.size > 0 &&
      contentMatchKeys.has(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      )
    ) {
      contentMatches.push(thread);
    }
  }
  return [...titleMatches, ...contentMatches];
}

export function pullRequestMatchesSearchQuery(
  pullRequest: Parameters<typeof threadPullRequestSearchTerms>[0],
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return false;
  const haystack = normalizeSearchText(threadPullRequestSearchTerms(pullRequest).join(" "));
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

export interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

export type SidebarProjectScopeMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "Failed",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // Each project's timestamp walks all of its threads, so compute it once
  // per project instead of once per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread & Pick<SidebarThreadSummary, "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null),
    sortOrder,
  );
}

export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
