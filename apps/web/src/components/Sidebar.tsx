import { type EnvironmentId, type ScopedProjectRef } from "@goat/contracts";
import type { EnvironmentServerConfig } from "@goat/client-runtime/connection";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import { threadContextDragListProps, useThreadContextDrag } from "./sidebar/useThreadContextDrag";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@goat/client-runtime/state/thread-settled";

import { sortSettledThreads } from "@goat/client-runtime/state/thread-sort";
import { threadSearchMatchKey } from "@goat/client-runtime/state/thread-search";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@goat/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@goat/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@goat/contracts";

import {
  EllipsisIcon,
  FolderIcon,
  ListFilterIcon,
  PlusIcon,
  SettingsIcon,
} from "~/components/solar";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKey,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { startNewThreadFromContext, startNewThreadFromLastWork } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  readThreadShell,
  readThreadShells,
  readEnvironmentSupportsVisitedTracking,
  useAllEnvironmentProjectSnapshotsReady,
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
} from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentProjects } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../state/session";
import { useGlobalAgentStore } from "../globalAgentStore";
import { excludeGlobalAgentThreads } from "../globalAgentRoute";
import { useAtomCommand } from "../state/use-atom-command";
import { SidebarOpenSubagent } from "./sidebar/SidebarOpenSubagent";
import { useSidebarOpenSubagent, useSidebarSubagentIndex } from "./sidebar/subagentIndex";
import { usePromoteThread } from "./promoteThread";
import { SortableSidebarMarker } from "./sidebar/SidebarListMarkers";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";

import { cn } from "~/lib/utils";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import {
  canPromoteThread,
  canStopSidebarDelegatedChild,
  isSidebarDelegatedChildThread,
  shouldCancelSidebarThreadDrag,
  type SidebarChildAttention,
  type SidebarPriorityHolds,
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  selectSidebarMarkReadTargets,
  isSidebarNestedLinkClick,
  holdSidebarPriorityRank,
  publishSidebarPriorityCount,
  resolveSidebarPriorityRank,
  resolveSidebarWokeAtForRow,
  resolveSidebarThreadPresentation,
  sidebarHostHueClassName,
  assignSidebarHostHues,
  sortPriorityThreadsForSidebar,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  resolveSidebarThreadSection,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarListItemId,
  sidebarThreadKeyAtY,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
  type SidebarListItem,
  type SidebarSection,
  resolveSidebarRowThreadId,
} from "./Sidebar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "./Sidebar.drag";
import {
  SIDEBAR_DRAG_DISTANCE,
  SidebarDragLifecycle,
  SidebarPointerSensor,
} from "./Sidebar.pointer";
import { createSidebarListMotion } from "./Sidebar.motion";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { useStableCallback } from "../hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { GoatBotSidebarRow } from "./goatBot/GoatBotSidebarRow";
import { DecisionInboxSidebarRow } from "./decisions/DecisionInboxSidebarRow";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { subscribeSidebarSearchFocus } from "./sidebar/sidebarSearchFocus";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { TooltipProvider } from "./ui/tooltip";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  SidebarSearchResultRow,
  SortableThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
} from "./sidebar/SidebarThreadRow";
import { SidebarDraftBlock } from "./sidebar/SidebarDraftBlock";
import {
  SidebarDragBoundary,
  SidebarSectionHeader,
  SidebarSectionPlaceholder,
} from "./sidebar/SidebarListMarkers";

function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.enabled !== entry.enabled ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}

// Threads on non-primary environments (T3 Connect, hosted) resolve their
// provider entry from their own environment's config: default instance ids
// are driver slugs, so a flat map would collide across environments.
const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
// Collapsed shelves share one empty list so a route change alone does not
// give the sidebar list a new identity.
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
const SETTLED_SHELF_EXPANDED_KEY = "goat:sidebar:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "goat:sidebar:snoozed-expanded";
type SidebarOptimisticDrop = {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};

interface SidebarThreadPartitionInput {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  // Snooze wakes and the queued-turn grace depend on the clock, so the minute
  // tick and the precise snooze-wake tick are inputs: a new key repartitions.
  readonly clockKey: string;
  readonly globalAgentRef: ReturnType<typeof useGlobalAgentStore.getState>["ref"];
  readonly goatBotRef: ReturnType<typeof useGlobalAgentStore.getState>["botRef"];
  readonly attentionByOwnerKey: ReadonlyMap<string, SidebarChildAttention>;
  readonly openSubagentOwnerKey: string | undefined;
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly priorityHolds: SidebarPriorityHolds;
  readonly acknowledgedWakes: ReadonlySet<string>;
  readonly priorityReleases: ReadonlySet<string>;
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

function sameHolds(left: SidebarPriorityHolds, right: SidebarPriorityHolds): boolean {
  if (left.size !== right.size) return false;
  for (const [key, settledOverride] of left) {
    if (!right.has(key) || right.get(key) !== settledOverride) return false;
  }
  return true;
}

function rawWokeAtByThreadKey(
  threads: readonly EnvironmentThreadShell[],
  now: string,
): ReadonlyMap<string, string | null> {
  return new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      threadWokeAt(thread, { now }),
    ]),
  );
}

function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

const NO_DRAGGED_ORDER: readonly string[] = [];
const NO_DRAGGED_ORDERS: {
  readonly settledOrder: readonly string[];
} = { settledOrder: NO_DRAGGED_ORDER };

// Preview the settled destination without changing the manually ordered inbox.
function resolveDraggedOrders(input: {
  readonly drag: { readonly activeKey: string; readonly occurredAt: string };
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly settledThreads: readonly EnvironmentThreadShell[];
}): typeof NO_DRAGGED_ORDERS {
  const { drag, threadByKey, settledThreads } = input;
  const thread = threadByKey.get(drag.activeKey);
  if (thread === undefined) return NO_DRAGGED_ORDERS;
  const others = (list: readonly EnvironmentThreadShell[]) =>
    list.filter((candidate) => threadShellKey(candidate) !== drag.activeKey);
  return {
    settledOrder: sortSettledThreads([
      ...others(settledThreads),
      applySidebarThreadDrop(thread, "settled", drag.occurredAt),
    ]).map(threadShellKey),
  };
}

function routeThreadOnly(
  threads: readonly EnvironmentThreadShell[],
  routeThreadKey: string | null,
): readonly EnvironmentThreadShell[] {
  if (routeThreadKey === null) return EMPTY_THREADS;
  const routeThread = threads.find((thread) => threadShellKey(thread) === routeThreadKey);
  return routeThread === undefined ? EMPTY_THREADS : [routeThread];
}

// Everything Sidebar derives from thread shells. Computed inside one hook so
// each value reaches the component frozen and cached on its real inputs: in
// the component body, later hook calls made the compiler treat these maps as
// possibly mutated and recompute them, and every dnd-kit input with them.
function useSidebarThreads(input: {
  readonly projectScopeKey: string | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly openSubagentOwnerKey: string | undefined;
  readonly attentionByOwnerKey: ReadonlyMap<string, SidebarChildAttention>;
  readonly routeThreadRef: ScopedThreadRef | null;
}) {
  const { projectScopeKey, scopedProjectKeys, serverConfigs, optimisticDrop, routeThreadRef } =
    input;
  const threads = useQuietThreadShells();
  const globalAgentRef = useGlobalAgentStore((state) => state.ref);
  const goatBotRef = useGlobalAgentStore((state) => state.botRef);
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  // Priority stickiness carried between renders: rows held in Priority (its rows as of the
  // last change), wakes acknowledged by settling, and rows Mark all as read lets go.
  const [priorityHolds, setPriorityHolds] = useState<SidebarPriorityHolds>(() => new Map());
  const [acknowledgedWakes, setAcknowledgedWakes] = useState<ReadonlySet<string>>(() => new Set());
  const [priorityReleases, setPriorityReleases] = useState<ReadonlySet<string>>(() => new Set());
  const routeRowThreadKey =
    input.openSubagentOwnerKey ??
    (routeThreadRef === null
      ? null
      : scopedThreadKey(
          scopeThreadRef(
            routeThreadRef.environmentId,
            resolveSidebarRowThreadId(
              routeThreadRef.threadId,
              routeThreadRef.environmentId,
              threads,
            ),
          ),
        ));
  const nowMinute = useNowMinute();
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const [nextSnoozeWakeAt, setNextSnoozeWakeAt] = useState<string | null>(null);
  useEffect(
    () => scheduleSnoozeWake(nextSnoozeWakeAt, () => bumpSnoozeWakeTick((tick) => tick + 1)),
    [nextSnoozeWakeAt],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  // The settled tail restarts whenever the project scope changes.
  const [settledTail, setSettledTail] = useState({
    scopeKey: projectScopeKey,
    count: SETTLED_TAIL_INITIAL_COUNT,
  });
  if (settledTail.scopeKey !== projectScopeKey) {
    setSettledTail({ scopeKey: projectScopeKey, count: SETTLED_TAIL_INITIAL_COUNT });
  }
  const settledVisibleCount =
    settledTail.scopeKey === projectScopeKey ? settledTail.count : SETTLED_TAIL_INITIAL_COUNT;

  const partition = partitionSidebarThreads({
    threads,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    globalAgentRef,
    goatBotRef,
    attentionByOwnerKey: input.attentionByOwnerKey,
    openSubagentOwnerKey: input.openSubagentOwnerKey,
    localLastVisitedAtByKey,
    priorityHolds,
    acknowledgedWakes,
    priorityReleases,
    clockKey: `${nowMinute}:${snoozeWakeTick}`,
  });
  const partitionNextWakeAt = partition.snoozedThreads[0]?.snoozedUntil ?? null;
  if (partitionNextWakeAt !== nextSnoozeWakeAt) setNextSnoozeWakeAt(partitionNextWakeAt);
  if (!sameKeys(partition.acknowledgedWakes, acknowledgedWakes)) {
    setAcknowledgedWakes(partition.acknowledgedWakes);
  }
  // The next pass holds what Priority shows now, and forgets releases for rows that left it.
  const nextPriorityHolds: SidebarPriorityHolds = new Map(
    partition.priorityThreads.map((thread) => [threadShellKey(thread), thread.settledOverride]),
  );
  if (!sameHolds(nextPriorityHolds, priorityHolds)) {
    setPriorityHolds(nextPriorityHolds);
    setPriorityReleases((current) =>
      [...current].every((key) => nextPriorityHolds.has(key))
        ? current
        : new Set([...current].filter((key) => nextPriorityHolds.has(key))),
    );
  }

  const { priorityThreads, pinnedThreads, activeThreads, snoozedThreads, settledThreads } =
    partition;
  const visibleSettledThreads = (() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    if (routeRowThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find((thread) => threadShellKey(thread) === routeRowThreadKey);
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  })();
  const renderedSettledThreads = settledShelfExpanded
    ? visibleSettledThreads
    : routeThreadOnly(visibleSettledThreads, routeRowThreadKey);
  const visibleSnoozedThreads = snoozedShelfExpanded
    ? snoozedThreads
    : routeThreadOnly(snoozedThreads, routeRowThreadKey);
  const orderedThreads = [
    ...priorityThreads,
    ...pinnedThreads,
    ...activeThreads,
    ...visibleSnoozedThreads,
    ...renderedSettledThreads,
  ];
  const sectionByThreadKey = new Map<string, SidebarSection>();
  for (const [list, section] of [
    [pinnedThreads, "pinned"],
    [activeThreads, "active"],
    [priorityThreads, "priority"],
    [snoozedThreads, "snoozed"],
    [settledThreads, "settled"],
  ] as const) {
    for (const thread of list) sectionByThreadKey.set(threadShellKey(thread), section);
  }
  useEffect(() => {
    publishSidebarPriorityCount(priorityThreads.length);
    return () => publishSidebarPriorityCount(null);
  }, [priorityThreads.length]);
  return {
    routeRowThreadKey,
    ...partition,
    releasePriorityThreads: (keys: readonly string[]) =>
      setPriorityReleases((current) => new Set([...current, ...keys])),
    restorePriorityThread: (key: string) =>
      setPriorityReleases((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      }),
    threads,
    searchableThreads: [
      ...priorityThreads,
      ...pinnedThreads,
      ...activeThreads,
      ...snoozedThreads,
      ...settledThreads,
    ],
    settledVisibleCount,
    hiddenSettledCount: settledThreads.length - visibleSettledThreads.length,
    showMoreSettled: () =>
      setSettledTail((current) => ({
        scopeKey: current.scopeKey,
        count: current.count + SETTLED_TAIL_PAGE_COUNT,
      })),
    settledShelfExpanded,
    toggleSettledShelf: () => setSettledShelfExpanded((value) => !value),
    snoozedShelfExpanded,
    toggleSnoozedShelf: () => setSnoozedShelfExpanded((value) => !value),
    renderedSettledThreads,
    visibleSnoozedThreads,
    orderedThreadKeys: orderedThreads.map(threadShellKey),
    threadByKey: new Map(orderedThreads.map((thread) => [threadShellKey(thread), thread] as const)),
    settledThreadKeys: new Set(settledThreads.map(threadShellKey)),
    snoozedThreadKeys: new Set(snoozedThreads.map(threadShellKey)),
    sectionByThreadKey,
    pinnedKeys: pinnedThreads.map(threadShellKey),
    activeKeys: activeThreads.map(threadShellKey),
    pinnedKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.pinOrderKey ?? null] as const),
    ),
    activeKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.activeOrderKey ?? null] as const),
    ),
  };
}

function partitionSidebarThreads(input: SidebarThreadPartitionInput) {
  const {
    threads,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    globalAgentRef,
    goatBotRef,
    attentionByOwnerKey,
    openSubagentOwnerKey,
    localLastVisitedAtByKey,
    priorityHolds,
    acknowledgedWakes,
    priorityReleases,
  } = input;
  const preciseNow = new Date().toISOString();
  // Subagent child threads live in the parent's Agents surface, not the
  // sidebar roster (v2 models them as real threads with lineage).
  const retainedArchivedKeys = new Set(attentionByOwnerKey.keys());
  if (openSubagentOwnerKey !== undefined) retainedArchivedKeys.add(openSubagentOwnerKey);
  const visible = excludeGlobalAgentThreads(
    filterSidebarV2VisibleThreads(threads, scopedProjectKeys, retainedArchivedKeys),
    globalAgentRef,
    goatBotRef,
  );
  const wokeAtByThreadKey = new Map<string, string | null>();
  // A copy: the acknowledgements this pass makes come back as output, never mutating input.
  const acknowledged = new Set(acknowledgedWakes);
  const priority: EnvironmentThreadShell[] = [];
  const priorityRanks = new Map<string, number>();
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const draggable = new Set<string>();
  const activeReorderable = new Set<string>();
  for (const thread of visible) {
    const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
    // Threads on servers without the settlement capability (old server,
    // or descriptor not loaded yet) never classify as settled: the user
    // could neither un-settle nor pin them, so auto-settling them would
    // strand rows in a tail with no working affordances.
    const supportsSettlement = capabilities?.threadSettlement === true;
    const supportsSnooze = capabilities?.threadSnooze === true;
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (capabilities?.threadActiveReorder === true) activeReorderable.add(threadKey);
    // Older servers retain their existing drag actions. Active placement
    // additionally requires its own ordering capability at the drop target.
    // This gates sorting only: every row can still drag out to a composer.
    if (capabilities?.threadPinning === true && capabilities.threadPinReorder === true) {
      draggable.add(threadKey);
    }
    if (optimisticDrop?.key === threadKey) {
      const projected = applySidebarThreadDrop(
        thread,
        optimisticDrop.section,
        optimisticDrop.occurredAt,
        optimisticDrop.assignedKeys.get(threadKey),
      );
      (optimisticDrop.section === "pinned"
        ? pinned
        : optimisticDrop.section === "settled"
          ? settled
          : active
      ).push(
        optimisticDrop.clearsSnooze
          ? projected
          : { ...projected, snoozedAt: thread.snoozedAt, snoozedUntil: thread.snoozedUntil },
      );
    } else {
      const rawWokeAt = threadWokeAt(thread, { now: preciseNow });
      const wokeAt = resolveSidebarWokeAtForRow({
        key: threadKey,
        rawWokeAt,
        settledOverride: thread.settledOverride,
        heldSettledOverride: priorityHolds.has(threadKey)
          ? priorityHolds.get(threadKey)
          : undefined,
        acknowledged,
      });
      wokeAtByThreadKey.set(threadKey, wokeAt);
      const rank = holdSidebarPriorityRank({
        rank: resolveSidebarPriorityRank({
          thread,
          localLastVisitedAt: localLastVisitedAtByKey[threadKey],
          wokeAt,
          hasChildAttention: attentionByOwnerKey.has(threadKey),
        }),
        key: threadKey,
        settledOverride: thread.settledOverride,
        holds: priorityHolds,
        released: priorityReleases.has(threadKey),
      });
      const section = resolveSidebarThreadSection({
        snoozed: supportsSnooze && effectiveSnoozed(thread, { now: preciseNow }),
        settled: supportsSettlement && thread.settledOverride === "settled",
        pinned: thread.pinnedAt != null,
        priority: rank !== null,
      });
      if (rank !== null) priorityRanks.set(threadKey, rank);
      if (section === "priority") draggable.delete(threadKey);
      (section === "priority"
        ? priority
        : section === "snoozed"
          ? snoozed
          : section === "settled"
            ? settled
            : section === "pinned"
              ? pinned
              : active
      ).push(thread);
    }
  }
  // One shared rule on every platform (see sortPinnedThreadsByOrderKey):
  // user-arranged keys first, keyless threads in creation order below.
  // Server capability only gates DRAGGING — it must not influence the
  // sort, or mixed-version fleets would render different pinned orders on
  // web and mobile from the same data.
  const sortedPinned = sortPinnedThreadsForSidebar(pinned);
  const sortedActive = sortThreadsForSidebar(active);
  return {
    pinnedThreads:
      optimisticDrop?.section !== "pinned" || optimisticDrop.order === null
        ? sortedPinned
        : orderItemsByPreferredIds({
            items: sortedPinned,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    draggableThreadKeys: draggable,
    activeReorderableThreadKeys: activeReorderable,
    activeThreads:
      optimisticDrop?.section !== "active" || optimisticDrop.order === null
        ? sortedActive
        : orderItemsByPreferredIds({
            items: sortedActive,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    priorityThreads: sortPriorityThreadsForSidebar(priority, priorityRanks),
    // Soonest wake first: "what comes back next" is the shelf's question.
    snoozedThreads: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settledThreads: sortSettledThreads(settled),
    snoozeNow: preciseNow,
    wokeAtByThreadKey,
    acknowledgedWakes: acknowledged,
  };
}

function isOptimisticDropReleased(input: {
  readonly optimisticDrop: SidebarOptimisticDrop;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly pinnedKeys: readonly string[];
  readonly activeKeys: readonly string[];
  readonly now: string;
}): boolean {
  const { optimisticDrop, threads, pinnedKeys, activeKeys, now } = input;
  const canonicalByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const thread = canonicalByKey.get(optimisticDrop.key);
  if (thread === undefined || thread.archivedAt !== null) {
    return true;
  }
  const canonicalSection = effectiveSnoozed(thread, { now })
    ? "snoozed"
    : thread.settledOverride === "settled"
      ? "settled"
      : thread.pinnedAt != null
        ? "pinned"
        : "active";
  if (
    canonicalSection !== optimisticDrop.sourceSection &&
    canonicalSection !== optimisticDrop.section
  ) {
    return true;
  }
  if (optimisticDrop.order === null) {
    // Settle also emits unpin/unsnooze events. Wait for the entire move
    // before releasing the projected fields and sort timestamps.
    if (
      canonicalSection === optimisticDrop.section &&
      thread.pinnedAt == null &&
      (!optimisticDrop.clearsSnooze || thread.snoozedUntil == null)
    ) {
      return true;
    }
    return false;
  }
  if (canonicalSection !== optimisticDrop.section) return false;
  if (optimisticDrop.clearsSnooze && thread.snoozedUntil != null) return false;
  const destinationKeys = optimisticDrop.section === "pinned" ? pinnedKeys : activeKeys;
  const canonicalDestination = destinationKeys.flatMap((key) => {
    const canonical = canonicalByKey.get(key);
    return canonical === undefined ? [] : [canonical];
  });
  const keyByThread = new Map(
    canonicalDestination.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      (optimisticDrop.section === "pinned" ? thread.pinOrderKey : thread.activeOrderKey) ?? null,
    ]),
  );
  const heldOrder = optimisticDrop.order;
  const heldKeys = new Set(heldOrder);
  const membershipChanged =
    destinationKeys.length !== heldOrder.length ||
    destinationKeys.some((key) => !heldKeys.has(key));
  const foreignKeyLanded = destinationKeys.some((threadKey) => {
    const currentKey = keyByThread.get(threadKey) ?? null;
    if (currentKey === (optimisticDrop.keysAtDrop.get(threadKey) ?? null)) return false;
    return currentKey !== optimisticDrop.assignedKeys.get(threadKey);
  });
  const allAssignmentsLanded = [...optimisticDrop.assignedKeys].every(
    ([threadKey, orderKey]) => keyByThread.get(threadKey) === orderKey,
  );
  return membershipChanged || foreignKeyLanded || allAssignmentsLanded;
}

// Sidebar() is large enough that the compiler cannot prove its local maps stay
// unmutated; built inside a hook they reach it frozen and cached.
function useSidebarLookups() {
  const projects = useProjects();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const projectGroups = useSidebarProjectGroups();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  const projectGroupByScopeKey = new Map(
    projectGroups.map((project) => [project.projectKey, project] as const),
  );
  const projectScopeItems = [
    { value: "all", label: "All projects" },
    ...projectGroups.map((project) => ({ value: project.projectKey, label: project.displayName })),
  ];
  return {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectScopeItems,
  };
}

function scheduleSnoozeWake(wakeAt: string | null, onWake: () => void): (() => void) | undefined {
  const wakeAtMs = wakeAt === null ? Number.NaN : Date.parse(wakeAt);
  if (Number.isNaN(wakeAtMs)) return undefined;
  // setTimeout delays are signed 32-bit: anything larger overflows and fires
  // immediately, turning a far-future wake (event-condition snoozes synced
  // from elsewhere) into a tight re-arm loop.
  const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
  const id = window.setTimeout(onWake, delayMs);
  return () => window.clearTimeout(id);
}

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

const SIDEBAR_DRAG_LABEL_HEIGHT = 24;

export default function Sidebar() {
  const {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectScopeItems,
  } = useSidebarLookups();
  const subagentIndex = useSidebarSubagentIndex();
  const promoteDelegatedChild = usePromoteThread();
  const interruptDelegatedTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const [stoppingDelegatedChildKey, setStoppingDelegatedChildKey] = useState<string | null>(null);
  const stoppingDelegatedChildKeyRef = useRef<string | null>(null);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const newThreadContext = useHandleNewThread();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const environments = useEnvironmentIdentities();
  const environmentHueById = assignSidebarHostHues(
    environments
      .map((environment) => environment.environmentId)
      .filter((environmentId) => environmentId !== primaryEnvironmentId),
  );
  const environmentMachineById = useEnvironmentMachines();
  const projectGroupsRef = useRef(projectGroups);
  const persistedProjectScopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setPersistedProjectScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const allProjectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  const headerSearchRef = useRef<HTMLDivElement | null>(null);
  // Safari can send a click after Ctrl+click opens settings. Ignore that one
  // selection, then clear the guard when the picker opens again.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  // Keep a dropped row at its destination while its server applies the
  // lifecycle command and any order-key writes. The next pickup waits for
  // this hold so a second drop cannot replace an unconfirmed placement.
  const [optimisticDrop, setOptimisticDrop] = useState<SidebarOptimisticDrop | null>(null);
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [searchHighlight, setSearchHighlight] = useState({ orderKey: "", index: 0 });
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const settlingThreadKeysRef = useRef(new Set<string>());
  const threadListRef = useRef<HTMLUListElement | null>(null);
  const dragLabelOffsetRef = useRef(0);
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const [dragState, setDragState] = useState<{
    readonly activeKey: string;
    readonly activeSection: SidebarSection;
    readonly occurredAt: string;
    readonly activationY: number | null;
    readonly targetSection: SidebarSection | null;
    readonly contextDrag: boolean;
  } | null>(null);
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const openAddProjectCommandPalette = () => openCommandPalette({ open: "add-project" });
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const openSubagentEntry = useSidebarOpenSubagent(routeThreadKey);
  const openSubagentOwnerKey = openSubagentEntry?.ownerKey;
  const openSubagent = openSubagentEntry?.thread ?? null;
  const routeThreadKeyRef = useRef(routeThreadKey);

  // A selection made under one scope can hold threads the next scope hides.
  const setProjectScopeKey = (key: string | null) => {
    clearSelection();
    setPersistedProjectScopeKey(key);
  };
  const projectScopeKey = resolveSidebarProjectScopeKey({
    groups: projectGroups,
    key: persistedProjectScopeKey,
    settings: projectGroupingSettings,
  });
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const selectedProjectScopeItem =
    projectScopeItems.find((item) => item.value === (projectScopeKey ?? "all")) ??
    projectScopeItems[0]!;
  const filteredProjectScopeItems = filterSidebarProjectScopeItems({
    items: projectScopeItems,
    query: projectScopeMenuState.query,
    matches: (item, query) =>
      projectScopeFilter.contains(item, query, (candidate) => candidate.label),
  });
  const scopedProjectGroup =
    projectScopeKey === null
      ? null
      : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null);
  const scopedProjectKeys =
    scopedProjectGroup === null
      ? null
      : new Set(
          scopedProjectGroup.memberProjectRefs.map(
            (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
          ),
        );
  useEffect(() => {
    const nextKey = resolveSidebarProjectScopeKey({
      groups: projectGroups,
      key: persistedProjectScopeKey,
      settings: projectGroupingSettings,
      canClearMissingScope: allProjectSnapshotsReady && allProjectConfigsReady,
    });
    if (nextKey !== persistedProjectScopeKey) {
      clearSelection();
      setPersistedProjectScopeKey(nextKey);
    }
  }, [
    allProjectConfigsReady,
    allProjectSnapshotsReady,
    clearSelection,
    persistedProjectScopeKey,
    projectGroups,
    projectGroupingSettings,
    setPersistedProjectScopeKey,
  ]);
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const globalAgentDraftId = useGlobalAgentStore((state) => state.ref?.draftId ?? null);
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (draftKey === globalAgentDraftId) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  });

  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: getSidebarProjectSettingsKey(
            projectGroup,
            projectGroupingSettings,
            projects,
            projectRef,
          ),
        },
      });
    },
  );
  const handleProjectSettings = useStableCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      openProjectSettings(projectGroup);
    },
  );

  const {
    threads,
    pinnedThreads,
    draggableThreadKeys,
    activeReorderableThreadKeys,
    activeThreads,
    priorityThreads,
    releasePriorityThreads,
    restorePriorityThread,
    wokeAtByThreadKey,
    snoozedThreads,
    settledThreads,
    snoozeNow,
    searchableThreads,
    settledVisibleCount,
    hiddenSettledCount,
    showMoreSettled,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
    renderedSettledThreads,
    visibleSnoozedThreads,
    orderedThreadKeys,
    threadByKey,
    settledThreadKeys,
    snoozedThreadKeys,
    sectionByThreadKey,
    pinnedKeys,
    activeKeys,
    pinnedKeysById,
    activeKeysById,
    routeRowThreadKey,
  } = useSidebarThreads({
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    openSubagentOwnerKey,
    attentionByOwnerKey: subagentIndex.attentionByOwnerKey,
    routeThreadRef,
  });

  useEffect(() => subscribeSidebarSearchFocus(() => threadSearchInputRef.current?.focus()), []);
  const operablePriorityEnvironments = useEnvironmentsWithScope(
    priorityThreads,
    AuthOrchestrationOperateScope,
  );
  const priorityWokeAtByKey = rawWokeAtByThreadKey(priorityThreads, snoozeNow);
  const priorityReadTargets = selectSidebarMarkReadTargets({
    threads: priorityThreads,
    localLastVisitedAtByKey,
    wokeAtByKey: priorityWokeAtByKey,
    canOperate: (thread) => operablePriorityEnvironments.has(thread.environmentId),
  });
  const visitPriorityThread = useOrchestrationCommand(threadEnvironment.visit, {
    reportFailure: false,
  });
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const markPriorityRead = () => {
    const targets = selectSidebarMarkReadTargets({
      threads: priorityThreads,
      localLastVisitedAtByKey,
      wokeAtByKey: priorityWokeAtByKey,
      canOperate: (thread) => canOperateThreads([thread]),
    });
    releasePriorityThreads(
      targets.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    const visitedAt = new Date().toISOString();
    void (async () => {
      for (const thread of targets) {
        if (!canOperateThreads([thread])) continue;
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        if (!readEnvironmentSupportsVisitedTracking(thread.environmentId)) {
          markThreadVisited(scopedThreadKey(threadRef), visitedAt);
          continue;
        }
        const result = await visitPriorityThread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, visitedAt },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          restorePriorityThread(scopedThreadKey(threadRef));
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to mark thread as read",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    })();
  };
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const threadSearchMatchByKey = new Map(
    threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const),
  );
  const threadSearchResults = searchSidebarThreads(
    searchableThreads,
    threadSearchQuery,
    new Set(threadSearchMatchByKey.keys()),
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  // The highlight belongs to one result list; a new list starts at the top.
  const activeSearchResultIndex =
    searchHighlight.orderKey === threadSearchResultOrderKey ? searchHighlight.index : 0;
  const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
    setSearchHighlight((current) => {
      const currentIndex = current.orderKey === threadSearchResultOrderKey ? current.index : 0;
      return {
        orderKey: threadSearchResultOrderKey,
        index: typeof index === "function" ? index(currentIndex) : index,
      };
    });
  const activeSearchResult = isSearchingThreads
    ? threadSearchResults[activeSearchResultIndex]
    : undefined;
  const activeSearchResultKey =
    activeSearchResult === undefined
      ? null
      : scopedThreadKey(scopeThreadRef(activeSearchResult.environmentId, activeSearchResult.id));
  useEffect(() => {
    if (activeSearchResultKey === null) return;
    document
      .querySelector(`[data-search-result-key="${globalThis.CSS.escape(activeSearchResultKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultKey]);

  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  const settledThreadKeysRef = useRef(settledThreadKeys);
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);

  const jumpLabelByKey = (() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  })();
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const landedBefore =
      router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname === router.state.location.pathname;
    if (landedBefore) return;

    try {
      await navigateToThread(threadRef);
      const landed =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (!landed) clearPendingFileDrop(dropId);
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const navigateToDraft = (draftId: DraftId) => {
    clearSelection();
    if (isMobile) {
      setOpenMobile(false);
    }
    void router.navigate({ to: "/draft/$draftId", params: { draftId } });
  };

  const clearThreadSearch = () => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  };
  const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
    clearThreadSearch();
    navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
  };
  const handleThreadSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearchingThreads) {
      event.preventDefault();
      event.stopPropagation();
      clearThreadSearch();
      return;
    }
    if (threadSearchResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSearchResultIndex(
        (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = threadSearchResults[activeSearchResultIndex];
      if (result) selectThreadSearchResult(result);
    }
  };

  const startThreadRename = (threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  };
  const cancelThreadRename = () => setRenamingThreadKey(null);
  const commitThreadRename = (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
    void (async () => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      const trimmed = title.trim();
      setRenamingThreadKey(null);
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (trimmed === originalTitle) return;
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, title: trimmed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    if (isSidebarNestedLinkClick(event.target)) return;
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const threadKey = scopedThreadKey(threadRef);
    if (isModClick) {
      event.preventDefault();
      toggleThreadSelection(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeysRef.current);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) {
      return;
    }
    navigateToThread(threadRef);
  };

  // Callers snapshot the plan BEFORE the command mutates the partition;
  // background parks never navigate (null plan).
  const planForwardNavigation = (
    threadKey: string,
    coParkingKeys?: ReadonlySet<string>,
  ): (() => void) | null => {
    if (routeThreadKeyRef.current !== threadKey) return null;
    const shell = threadByKeyRef.current.get(threadKey);
    const orderedKeys = orderedThreadKeysRef.current;
    const settledKeys = settledThreadKeysRef.current;
    const snoozedKeys = snoozedThreadKeysRef.current;
    const currentIndex = orderedKeys.indexOf(threadKey);
    const nextCardKey =
      currentIndex === -1
        ? null
        : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
            (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
          ) ?? null);
    const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
    return nextThread
      ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
      : shell
        ? () =>
            void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
        : () => void router.navigate({ to: "/" });
  };

  const attemptSettle = (
    threadRef: ScopedThreadRef,
    opts: { coSettlingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const threadKey = scopedThreadKey(threadRef);
      if (settlingThreadKeysRef.current.has(threadKey)) return;
      settlingThreadKeysRef.current.add(threadKey);
      const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
      const result = await settleThread(threadRef);
      settlingThreadKeysRef.current.delete(threadKey);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (
        shouldNavigateAfterThreadPark({
          threadKey,
          currentThreadKey: routeThreadKeyRef.current,
          action: "settle",
          now: new Date().toISOString(),
          thread: readThreadShell(threadRef),
        })
      ) {
        navigateAfterSettle?.();
      }
    })();
  };
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  const settleThreads = (threadKeys: readonly string[]) => {
    const coSettlingKeys = new Set(threadKeys);
    for (const threadKey of threadKeys) {
      const thread = threadByKeyRef.current.get(threadKey);
      if (!thread || thread.settledOverride === "settled") continue;
      attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
    }
  };
  const attemptUnsettle = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsettleThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnsnooze = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsnoozeThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const restrictBelowPins: Modifier = (args) =>
    restrictBelowSidebarLabel(args, dragLabelOffsetRef.current);
  // A new array re-renders DndContext and with it every sortable row.
  const dndModifiers = [
    restrictToVerticalAxis,
    restrictBelowPins,
    restrictToFirstScrollableAncestor,
  ];
  const attachListMotionRef = (node: HTMLUListElement | null) => {
    threadListRef.current = node;
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createSidebarListMotion(node);
    listMotionRef.current?.update(false);
  };

  // Working rows can supply chat context, but never preview sidebar movement.
  const isContextDrag = dragState?.contextDrag === true;
  const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
  const setContextDrag = (contextDrag: boolean) => {
    setDragState((current) =>
      current === null || current.contextDrag === contextDrag
        ? current
        : { ...current, contextDrag },
    );
  };
  const threadContextDrag = useThreadContextDrag({ onContextDragChange: setContextDrag });
  const finishThreadDrag = (started: boolean) => {
    dragSensorRef.current = null;
    threadContextDrag.end();
    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
    }
  };
  const attachDragSensor = (sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  };
  const cancelThreadDrag = () => {
    dragSensorRef.current?.cancel();
  };
  const pointerSensorOptions = {
    distance: SIDEBAR_DRAG_DISTANCE,
    onAttach: attachDragSensor,
    onFinish: finishThreadDrag,
    onMove: threadContextDrag.move,
    onDrop: threadContextDrag.drop,
  };
  const dndSensors = useSensors(useSensor(SidebarPointerSensor, pointerSensorOptions));
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  useLayoutEffect(() => {
    routeThreadKeyRef.current = routeThreadKey;
    projectGroupsRef.current = projectGroups;
    orderedThreadKeysRef.current = orderedThreadKeys;
    threadByKeyRef.current = threadByKey;
    handleNewThreadRef.current = newThreadContext.handleNewThread;
    settledThreadKeysRef.current = settledThreadKeys;
    snoozedThreadKeysRef.current = snoozedThreadKeys;
    sectionByThreadKeyRef.current = sectionByThreadKey;
  });
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        const capabilities =
          thread && serverConfigs.get(thread.environmentId)?.environment.capabilities;
        return (
          thread !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          resolveSidebarThreadPresentation({
            snoozed: originSection === "snoozed",
            settled: thread.settledOverride === "settled",
          }).action === action &&
          (action === "unsnooze"
            ? capabilities?.threadSnooze === true
            : capabilities?.threadSettlement === true)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      dragSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) =>
          sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  // Release the hold during render once the server state catches up, so the
  // canonical order shows in the same frame instead of after an effect pass.
  if (
    optimisticDrop !== null &&
    isOptimisticDropReleased({
      optimisticDrop,
      threads,
      pinnedKeys,
      activeKeys,
      now: snoozeNow,
    })
  ) {
    setOptimisticDrop(null);
  }
  const attemptPin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      // Fresh pins take the top of the arranged run: pinThread computes a
      // key before the smallest key across ALL pinned shells — including
      // snoozed pins hidden from this list, whose keys are still part of
      // the run — so the new pin can't land beneath a hidden head.
      const result = await pinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to pin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnpin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await confirmAndUnpinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unpin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadDragStart = (event: DragStartEvent) => {
    const activeKey = String(event.active.id);
    threadContextDrag.begin({
      key: activeKey,
      title: threadByKey.get(activeKey)?.title ?? "",
      list: threadListRef.current,
    });
    const activeSection = sectionByThreadKey.get(activeKey);
    if (activeSection === undefined || activeSection === "priority") return;
    listMotionRef.current?.suspend();
    const list = threadListRef.current;
    const header = list?.querySelector<HTMLElement>('[data-testid="sidebar-pinned-header"]');
    if (list && header) {
      const listRect = list.getBoundingClientRect();
      const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
      dragLabelOffsetRef.current =
        header.getBoundingClientRect().top - listRect.top + SIDEBAR_DRAG_LABEL_HEIGHT * scale;
    } else {
      dragLabelOffsetRef.current = 0;
    }
    setDragState({
      activeKey,
      activeSection,
      targetSection: activeSection,
      contextDrag: false,
      occurredAt: new Date().toISOString(),
      activationY:
        event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
    });
  };
  const sidebarListItemsFresh = ((): readonly SidebarListItem[] => {
    const rowsOf = (
      list: readonly EnvironmentThreadShell[],
      section: SidebarSection,
    ): SidebarListItem[] =>
      list.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return { kind: "thread", key, section };
      });
    if (
      pinnedThreads.length +
        activeThreads.length +
        priorityThreads.length +
        snoozedThreads.length +
        settledThreads.length ===
      0
    ) {
      return [];
    }
    const items: SidebarListItem[] = [];
    if (priorityThreads.length > 0) {
      items.push({ kind: "marker", marker: "priority-header" });
      items.push(...rowsOf(priorityThreads, "priority"));
    }
    items.push({ kind: "marker", marker: "pinned-header" });
    const pinnedRows = rowsOf(pinnedThreads, "pinned");
    items.push(...pinnedRows);
    items.push({ kind: "marker", marker: "pinned-divider" });
    const activeRows = rowsOf(activeThreads, "active");
    items.push({ kind: "marker", marker: "active-placeholder" });
    items.push(...activeRows);
    if (snoozedThreads.length > 0) {
      items.push({ kind: "marker", marker: "snoozed-header" });
      items.push(...rowsOf(visibleSnoozedThreads, "snoozed"));
    }
    items.push({ kind: "marker", marker: "settled-header" });
    const settledRows = rowsOf(renderedSettledThreads, "settled");
    items.push({ kind: "marker", marker: "settled-placeholder" });
    items.push(...settledRows);
    return items;
  })();
  // Thread shells update on every streamed event without moving rows. Keep the
  // list's identity until its order changes, so the sorting strategy, the
  // sortable context and every sortable row stay memoized meanwhile.
  const sidebarListItemsKey = sidebarListItemsFresh
    .map((item) => (item.kind === "thread" ? item.section + ":" + item.key : item.marker))
    .join("\n");
  const [sidebarListItemsState, setSidebarListItems] = useState(sidebarListItemsFresh);
  const [sidebarListItemsKeyState, setSidebarListItemsKeyState] = useState(sidebarListItemsKey);
  let sidebarListItems = sidebarListItemsState;
  if (sidebarListItemsKeyState !== sidebarListItemsKey) {
    setSidebarListItemsKeyState(sidebarListItemsKey);
    setSidebarListItems(sidebarListItemsFresh);
    // The rest of this render still runs before React applies the update, and
    // threadByKey already lacks rows that just left, such as a thread settled
    // into the collapsed Settled shelf.
    sidebarListItems = sidebarListItemsFresh;
  }
  useEffect(() => {
    if (dragState !== null && shouldCancelSidebarThreadDrag(sidebarListItems, dragState)) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, sidebarListItems]);
  // Rows only move when the rendered order, a row's section, or the draft block
  // changes. Running the motion pass on that alone keeps ordinary shell events
  // from forcing a layout read and animating rows that drifted for other reasons.
  const listMotionLayoutKey = [
    sidebarListItemsKey,
    visibleDraftSessionCount,
    routeDraftIdForRows ?? "",
  ].join("\0");
  const listMotionAnimate =
    dragState === null && sidebarListItems.length + visibleDraftSessionCount > 0;
  // The effect reads only `animate`; the pass object is cached on both fields,
  // so a new layout key alone also triggers it.
  const listMotionPass = { layoutKey: listMotionLayoutKey, animate: listMotionAnimate };
  useLayoutEffect(() => {
    listMotionRef.current?.update(listMotionPass.animate);
  }, [listMotionPass]);
  const handleThreadDragOver = (event: DragOverEvent) => {
    const target = event.over
      ? resolveSidebarDropTarget(sidebarListItems, String(event.active.id), String(event.over.id))
      : null;
    setDragState((current) =>
      current === null || current.activeKey !== String(event.active.id)
        ? current
        : { ...current, targetSection: target?.section ?? null },
    );
  };
  const sortableIds = sidebarListItems.map(sidebarListItemId);
  // Outside a drag the orders are constants, so the strategy, and with it
  // every sortable row, keeps its identity while thread shells stream in.
  const { settledOrder: draggedSettledOrder } =
    dragState === null
      ? NO_DRAGGED_ORDERS
      : resolveDraggedOrders({
          drag: dragState,
          threadByKey,
          settledThreads,
        });
  const nestedKeys = new Set<string>();
  if (
    openSubagent !== null &&
    openSubagentOwnerKey !== undefined &&
    sidebarListItems.some((item) => item.kind === "thread" && item.key === openSubagentOwnerKey)
  )
    nestedKeys.add(openSubagentOwnerKey);
  const sidebarSortingStrategy = createSidebarSortingStrategy({
    items: sidebarListItems,
    nestedKeys,
    enabled: !isContextDrag,
    boundaryLabelHeight: SIDEBAR_DRAG_LABEL_HEIGHT,
    settledOrder: draggedSettledOrder,
    settledExpanded: settledShelfExpanded,
    settledVisibleCount,
    routeThreadKey: routeRowThreadKey,
    snoozedThreadCount: snoozedThreads.length,
  });
  const draggedThreadKey = dragState?.activeKey;
  const draggedFromSection = dragState?.activeSection;
  const dragActivationY = dragState?.activationY;
  const dndCollisionDetection = (() => {
    if (draggedThreadKey === undefined || draggedFromSection === undefined)
      return createSidebarCollisionDetection(() => true);
    const source = threadByKey.get(draggedThreadKey);
    if (source === undefined) return createSidebarCollisionDetection(() => false);
    return createSidebarCollisionDetection(
      (id) => {
        const target = resolveSidebarDropTarget(sidebarListItems, draggedThreadKey, id);
        if (target === null) return false;
        return (
          planSidebarThreadDrop({
            activeKey: draggedThreadKey,
            activeSection: draggedFromSection,
            activePinned: source.pinnedAt != null,
            activeSettled: source.settledOverride === "settled",
            supportsSettlement:
              serverConfigs.get(source.environmentId)?.environment.capabilities.threadSettlement ===
              true,
            target,
            pinnedOrder: pinnedKeys,
            pinnedKeysById,
            reorderableKeys: draggableThreadKeys,
            activeOrder: activeKeys,
            activeKeysById,
            activeReorderableKeys: activeReorderableThreadKeys,
          }).kind !== "none"
        );
      },
      {
        items: sidebarListItems,
        activationY: dragActivationY ?? null,
      },
    );
  })();
  const handleThreadDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id);
    const activeSection = sectionByThreadKey.get(activeKey);
    const target =
      event.over === null
        ? null
        : resolveSidebarDropTarget(sidebarListItems, activeKey, String(event.over.id));
    const activeThread = threadByKey.get(activeKey);
    if (activeSection === undefined || target === null || activeThread === undefined) return;
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const plan = planSidebarThreadDrop({
      activeKey,
      activeSection,
      activePinned: activeThread.pinnedAt != null,
      activeSettled: activeThread.settledOverride === "settled",
      supportsSettlement:
        serverConfigs.get(activeThread.environmentId)?.environment.capabilities.threadSettlement ===
        true,
      target,
      pinnedOrder: pinnedKeys,
      pinnedKeysById,
      reorderableKeys: draggableThreadKeys,
      activeOrder: activeKeys,
      activeKeysById,
      activeReorderableKeys: activeReorderableThreadKeys,
    });
    if (plan.kind === "none") return;
    if (plan.kind === "settle" && settlingThreadKeysRef.current.has(activeKey)) return;
    const assignments =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.kind === "reorder-pinned" || plan.kind === "move-active"
          ? plan.assignments
          : [];
    if (
      !checkThreadOperations(
        [activeKey, ...assignments.map(({ id }) => id)].flatMap((key) => {
          const thread = threadByKey.get(key);
          return thread ? [thread] : [];
        }),
      )
    )
      return;
    const drop = {
      key: activeKey,
      sourceSection: activeSection,
      section: target.section,
      occurredAt: new Date().toISOString(),
      clearsSnooze:
        plan.kind === "pin" ||
        plan.kind === "settle" ||
        (plan.kind === "move-active" && plan.unsnooze),
      order: plan.kind === "settle" ? null : plan.order,
      keysAtDrop: target.section === "active" ? activeKeysById : pinnedKeysById,
      assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
    };
    setOptimisticDrop(drop);
    void (async () => {
      const run = async (
        operation: Promise<AtomCommandResult<unknown, unknown>>,
        title: string,
      ) => {
        const result = await operation;
        if (result._tag === "Success") return true;
        setOptimisticDrop((current) => (current === drop ? null : current));
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      };
      switch (plan.kind) {
        case "settle": {
          settlingThreadKeysRef.current.add(activeKey);
          const navigateAfterSettle = planForwardNavigation(activeKey);
          const settled = await run(settleThread(threadRef), "Failed to settle thread").finally(
            () => settlingThreadKeysRef.current.delete(activeKey),
          );
          if (
            settled &&
            shouldNavigateAfterThreadPark({
              threadKey: activeKey,
              currentThreadKey: routeThreadKeyRef.current,
              action: "settle",
              now: new Date().toISOString(),
              thread: readThreadShell(threadRef),
            })
          )
            navigateAfterSettle?.();
          return;
        }
        case "move-active":
          if (plan.unpin && !(await run(unpinThread(threadRef), "Failed to unpin thread"))) return;
          if (
            plan.unsettle &&
            !(await run(unsettleThread(threadRef), "Failed to un-settle thread"))
          )
            return;
          if (plan.unsnooze && !(await run(unsnoozeThread(threadRef), "Failed to wake thread")))
            return;
          break;
        case "pin":
          if (
            !(await run(
              pinThread(threadRef, plan.orderKey === undefined ? {} : { orderKey: plan.orderKey }),
              "Failed to pin thread",
            ))
          )
            return;
          break;
        case "reorder-pinned":
          break;
      }
      const keyWrites = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
      for (const assignment of keyWrites) {
        const thread = threadByKey.get(assignment.id);
        if (thread === undefined) continue;
        if (
          !(await run(
            (plan.kind === "move-active" ? reorderActiveThread : reorderPinnedThread)(
              scopeThreadRef(thread.environmentId, thread.id),
              assignment.orderKey,
            ),
            plan.kind === "move-active"
              ? "Failed to reorder active threads"
              : "Failed to reorder pinned threads",
          ))
        )
          return;
      }
    })();
  };
  const performSnooze = async (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    if (snoozingThreadKeysRef.current.has(threadKey)) {
      return { status: "skipped" } as const;
    }
    snoozingThreadKeysRef.current.add(threadKey);
    const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
    const result = await snoozeThread(threadRef, preset.snoozedUntil);
    snoozingThreadKeysRef.current.delete(threadKey);
    if (result._tag === "Failure") {
      return isAtomCommandInterrupted(result)
        ? ({ status: "interrupted" } as const)
        : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
    }
    if (
      shouldNavigateAfterThreadPark({
        threadKey,
        currentThreadKey: routeThreadKeyRef.current,
        action: "snooze",
        now: new Date().toISOString(),
        thread: readThreadShell(threadRef),
      })
    ) {
      navigateAfterSnooze?.();
    }
    return { status: "success" } as const;
  };
  const attemptSnooze = (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const outcome = await performSnooze(threadRef, preset, opts);
      if (outcome.status === "failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to snooze thread",
            description:
              outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
          }),
        );
        return;
      }
    })();
  };

  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning ===
            true && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(unpinMenuItem
              ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
              : []),
            {
              id: "settle",
              label: `Settle (${count})`,
              disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
            },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: true,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            {
              id: "delete",
              label: `Delete (${count})`,
              destructive: true,
              disabled: !canOperateThreads(selectedThreads),
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const actionTargets =
        clicked.value === "unpin"
          ? pinnedSelectedThreads
          : clicked.value === "regenerate-title"
            ? regeneratableTitleThreads
            : clicked.value === "settle"
              ? settlingThreads.flatMap((thread) => {
                  const current = threadByKeyRef.current.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                  );
                  return current && current.settledOverride !== "settled" ? [current] : [];
                })
              : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
        if (preset) {
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "unpin") {
        for (const thread of pinnedSelectedThreads) {
          attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const projectGroup = projectGroupsRef.current.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === session.environmentId && ref.projectId === session.projectId,
          ),
        );
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: projectGroup != null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "project-settings":
            if (projectGroup)
              openProjectSettings(projectGroup, {
                environmentId: session.environmentId,
                projectId: session.projectId,
              });
            return;
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu can stay open while the draft sends; discarding a
            // promoting draft would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  const attemptArchive = async (threadRef: ScopedThreadRef) => {
    const api = readLocalApi();
    const thread = readThreadShell(threadRef);
    if (
      !api ||
      !thread ||
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    if (confirmThreadArchive) {
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(`Archive thread "${thread.title}"?`),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    let didArchive = false;
    const result = await archiveThread(threadRef, {
      onArchived: () => {
        didArchive = true;
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  const onStopDelegatedChild = (threadRef: ScopedThreadRef) => {
    const thread = readThreadShell(threadRef);
    if (
      stoppingDelegatedChildKeyRef.current !== null ||
      !thread ||
      !canStopSidebarDelegatedChild(thread) ||
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const key = scopedThreadKey(threadRef);
    stoppingDelegatedChildKeyRef.current = key;
    setStoppingDelegatedChildKey(key);
    void interruptDelegatedTurn({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    })
      .then((result) => {
        if (result._tag === "Failure")
          toastManager.add({ type: "error", title: "Could not stop task" });
      })
      .catch(() => {
        toastManager.add({ type: "error", title: "Could not stop task" });
      })
      .finally(() => {
        stoppingDelegatedChildKeyRef.current = null;
        setStoppingDelegatedChildKey(null);
      });
  };

  const onDelegatedChildContextMenu = (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => {
    void (async () => {
      const api = readLocalApi();
      const thread = readThreadShell(threadRef);
      if (!api || !thread) return;
      const canOperate = readEnvironmentScope(
        threadRef.environmentId,
        AuthOrchestrationOperateScope,
      );
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "open", label: "Open" },
            ...(canOperate && canStopSidebarDelegatedChild(thread)
              ? [
                  {
                    id: "stop",
                    label: "Stop",
                    disabled: stoppingDelegatedChildKeyRef.current !== null,
                  },
                ]
              : []),
            // Provider-native subagents belong to their provider's session.
            ...(isSidebarDelegatedChildThread(thread)
              ? [
                  {
                    id: "archive",
                    label: "Archive",
                    disabled: !canOperate || !threadRuntimeCanArchive(thread.runtime),
                  },
                ]
              : []),
            ...(canOperate &&
            canPromoteThread(
              thread,
              serverConfigs.get(threadRef.environmentId)?.environment.capabilities,
            )
              ? [{ id: "promote", label: "Promote to thread" }]
              : []),
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      switch (clicked.value) {
        case "open":
          void navigateToThread(threadRef);
          return;
        case "stop":
          onStopDelegatedChild(threadRef);
          return;
        case "archive":
          await attemptArchive(threadRef);
          return;
        case "promote":
          await promoteDelegatedChild(threadRef);
          return;
      }
    })();
  };

  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const supportsAutoSettleOptOut =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadAutoSettleOptOut === true;
        const supportsTitleRegeneration =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = thread.pinnedAt != null;
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadActionMenuItems({
              canOperate: readEnvironmentScope(
                threadRef.environmentId,
                AuthOrchestrationOperateScope,
              ),
              branch: thread.branch ?? null,
              projectFilter: threadProjectGroup
                ? {
                    label: threadProjectGroup.displayName,
                    isActive: projectScopeKey === threadProjectGroup.projectKey,
                  }
                : null,
              isPinned,
              isSettled,
              autoSettleEnabled: thread.autoSettleDisabledAt == null,
              isSnoozed,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRegeneratingTitle,
              isRunning: !threadRuntimeCanArchive(thread.runtime),
              supports: {
                settlement: supportsSettlement,
                autoSettleOptOut: supportsAutoSettleOptOut,
                snooze: supportsSnooze,
                pinning: supportsPinning,
                titleRegeneration: supportsTitleRegeneration,
              },
              snoozePresets,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "filter-by-project":
            if (threadProjectGroup) {
              setProjectScopeKey(
                projectScopeKey === threadProjectGroup.projectKey
                  ? null
                  : threadProjectGroup.projectKey,
              );
            }
            return;
          case "project-settings":
            if (threadProjectGroup)
              openProjectSettings(threadProjectGroup, {
                environmentId: threadRef.environmentId,
                projectId: thread.projectId,
              });
            return;
          case "new-thread-on-branch": {
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "auto-settle:enabled":
          case "auto-settle:disabled": {
            const result = await setThreadAutoSettle(
              threadRef,
              clicked.value === "auto-settle:enabled",
            );
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to update auto-settle",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            await attemptArchive(threadRef);
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeRowThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeRowThreadKey,
    routeTerminalOpen,
    threadByKey,
  ]);

  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  // Plain compose opens a draft in the last project and workspace mode the
  // user wrote in. Shift+click keeps the current-project action.
  const handleNewThreadClick = (event?: ReactMouseEvent) => {
    if (isMobile) setOpenMobile(false);
    if (event?.shiftKey) {
      void startNewThreadFromContext({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        handleNewThread: newThreadContext.handleNewThread,
      });
      return;
    }
    void (async () => {
      if (
        await startNewThreadFromLastWork({
          threads: readThreadShells(),
          projects,
          handleNewThread: newThreadContext.handleNewThread,
        })
      ) {
        return;
      }
      if (shouldCreateNewThreadInCurrentProject(false, projectGroups.length)) {
        await startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
      } else {
        openCommandPalette({ open: "new-thread-in" });
      }
    })();
  };

  // The button mirrors chat.new. With no last work, multi-project setups
  // open the project picker; single-project setups create in context.
  // chat.newLocal remains the shortcut for the contextual action, even with
  // one project, where its workspace mode can differ from last work.
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new");
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <>
            {/* Lifted above the stage backdrop, whose fade bleeds below the
                header and would otherwise paint across the search row's outline. */}
            <SidebarGroup className="z-[1]">
              <SidebarThreadHeader
                searchFieldRef={headerSearchRef}
                hasProjects={projectGroups.length > 0}
                projectScope={
                  <Combobox
                    items={projectScopeItems}
                    filteredItems={filteredProjectScopeItems}
                    autoHighlight
                    itemToStringLabel={(item) => item.label}
                    isItemEqualToValue={(a, b) => a.value === b.value}
                    open={projectScopeMenuState.open}
                    onOpenChange={(open) => {
                      if (open) suppressNextScopeChangeRef.current = false;
                      dispatchProjectScopeMenu({ type: "open-changed", open });
                    }}
                    onItemHighlighted={(item) => {
                      highlightedProjectScopeKeyRef.current = item?.value ?? null;
                    }}
                    value={selectedProjectScopeItem}
                    onValueChange={(item) => {
                      if (suppressNextScopeChangeRef.current) {
                        suppressNextScopeChangeRef.current = false;
                        return;
                      }
                      if (!item) return;
                      setProjectScopeKey(item.value === "all" ? null : item.value);
                    }}
                  >
                    <ComboboxTrigger
                      render={
                        <SidebarHeaderIconButton
                          label={
                            scopedProjectGroup
                              ? `Filter threads by project: ${scopedProjectGroup.displayName}`
                              : "Filter threads by project"
                          }
                        />
                      }
                    >
                      {scopedProjectGroup ? (
                        // Wrapped so the button's direct-child svg color rule cannot override
                        // a project's own icon color.
                        <span className="flex shrink-0">
                          <ProjectFavicon project={scopedProjectGroup} className="size-4" />
                        </span>
                      ) : (
                        <ListFilterIcon className="size-4" />
                      )}
                    </ComboboxTrigger>
                    <ComboboxPopup
                      align="start"
                      // Anchored to the search field, not the 28px trigger: the
                      // popup opens under the field, is at least as wide as it,
                      // and grows to fit project names up to a cap, past which
                      // the rows truncate.
                      anchor={headerSearchRef}
                      className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
                    >
                      <ComboboxSearchInput
                        aria-label="Search projects"
                        placeholder="Search projects..."
                        value={projectScopeMenuState.query}
                        onKeyDown={(event) => {
                          if (
                            event.defaultPrevented ||
                            event.nativeEvent.isComposing ||
                            event.ctrlKey ||
                            event.altKey ||
                            event.metaKey ||
                            (event.key !== "ContextMenu" &&
                              !(event.shiftKey && event.key === "F10"))
                          ) {
                            return;
                          }
                          // Combobox items use virtual focus: keyboard events
                          // stay on this input, not on the highlighted option.
                          const scopeKey = highlightedProjectScopeKeyRef.current;
                          const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
                          if (project) handleProjectSettings(event, project);
                        }}
                        onChange={(event) =>
                          dispatchProjectScopeMenu({
                            type: "query-changed",
                            query: event.target.value,
                          })
                        }
                      />
                      <ComboboxEmpty>No matching projects.</ComboboxEmpty>
                      <ComboboxList>
                        {(item: (typeof projectScopeItems)[number]) => {
                          const project = projectGroupByScopeKey.get(item.value) ?? null;
                          return (
                            <ComboboxItem
                              key={item.value}
                              hideIndicator
                              value={item}
                              onContextMenu={(event) => {
                                if (project) handleProjectSettings(event, project);
                              }}
                            >
                              {project ? (
                                <ProjectFavicon project={project} className="size-4 shrink-0" />
                              ) : (
                                <FolderIcon className="size-4 shrink-0" />
                              )}
                              <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                              {project && showProjectEnvironments ? (
                                <ProjectEnvironmentBadge
                                  group={project}
                                  primaryEnvironmentId={primaryEnvironmentId}
                                  machineByEnvironmentId={environmentMachineById}
                                />
                              ) : null}
                              {project ? (
                                <Button
                                  size="icon-xs"
                                  variant="ghost-muted"
                                  tabIndex={-1}
                                  aria-hidden="true"
                                  title={`Project settings for ${project.displayName}`}
                                  className="ml-auto"
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={(event) => {
                                    void handleProjectSettings(event, project);
                                  }}
                                >
                                  <SettingsIcon className="size-3.5" />
                                </Button>
                              ) : null}
                            </ComboboxItem>
                          );
                        }}
                      </ComboboxList>
                    </ComboboxPopup>
                  </Combobox>
                }
                onNewProject={openAddProjectCommandPalette}
                onNewThread={handleNewThreadClick}
                newThreadDisabled={projects.length === 0}
                newThreadShortcutLabel={newThreadShortcutLabel}
                newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
                showNewThreadInProjectHint={projects.length > 0}
                searchInputRef={threadSearchInputRef}
                searchQuery={threadSearchQuery}
                onSearchQueryChange={(value) => {
                  setThreadSearchQuery(value);
                  setActiveSearchResultIndex(0);
                }}
                onSearchKeyDown={handleThreadSearchKeyDown}
                isSearching={isSearchingThreads}
                searchResultCount={threadSearchResults.length}
                activeSearchResultIndex={activeSearchResultIndex}
                onClearSearch={clearThreadSearch}
              />
            </SidebarGroup>
            <GoatBotSidebarRow />
          </>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul role="presentation">
                  <DecisionInboxSidebarRow />
                </ul>
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    const row = (
                      <SidebarSearchResultRow
                        isSettled={settledThreadKeys.has(threadKey)}
                        key={threadKey}
                        thread={thread}
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeRowThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                    return openSubagentEntry?.ownerKey === threadKey ? (
                      <Fragment key={threadKey}>
                        {row}
                        <li>
                          <SidebarOpenSubagent
                            thread={openSubagentEntry.thread}
                            onOpen={navigateToThread}
                            onStop={onStopDelegatedChild}
                            onContextMenu={onDelegatedChildContextMenu}
                            isStopping={stoppingDelegatedChildKey === routeThreadKey}
                          />
                        </li>
                      </Fragment>
                    ) : (
                      row
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <>
                <ul role="presentation">
                  <DecisionInboxSidebarRow />
                </ul>
                <p
                  role="status"
                  className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
                >
                  {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
                </p>
              </>
            )
          ) : null}
          {!isSearchingThreads ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <DndContext
                sensors={dndSensors}
                autoScroll={!isContextDrag}
                collisionDetection={dndCollisionDetection}
                modifiers={dndModifiers}
                onDragStart={handleThreadDragStart}
                onDragOver={handleThreadDragOver}
                onDragEnd={handleThreadDragEnd}
              >
                <SidebarDragLifecycle onUnmount={cancelThreadDrag} />
                <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                  <ul
                    ref={attachListMotionRef}
                    {...threadContextDragListProps()}
                    // VoiceOver treats an exposed list as an interaction boundary,
                    // which hides its rows from ordinary linear navigation. A
                    // presentational list also makes its implicit listitems
                    // presentational while preserving every descendant control.
                    role="presentation"
                    className={cn(
                      "relative flex flex-col gap-px",
                      sidebarListItems.length > 0 && "flex-1",
                      actionSweep !== null && "**:pointer-events-none",
                    )}
                  >
                    {(() => {
                      const renderThreadRow = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                      ) => {
                        const threadKey = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        const presentation = resolveSidebarThreadPresentation({
                          snoozed: section === "snoozed",
                          settled: thread.settledOverride === "settled",
                        });
                        const isCard =
                          section === "priority" || section === "pinned" || section === "active";
                        const rowVariant = isCard ? "card" : "slim";
                        return (
                          <SortableThreadRow
                            key={threadKey}
                            sortableId={threadKey}
                            contextDrag={isContextDrag}
                            sortableDisabled={
                              renamingThreadKey === threadKey ||
                              !draggableThreadKeys.has(threadKey) ||
                              optimisticDrop !== null
                            }
                            thread={thread}
                            section={section}
                            reorderable={draggableThreadKeys.has(threadKey)}
                            dropPending={optimisticDrop !== null}
                            openSubagent={threadKey === openSubagentOwnerKey ? openSubagent : null}
                            childAttention={subagentIndex.attentionByOwnerKey.get(threadKey)}
                            onOpenDelegatedChild={navigateToThread}
                            onStopDelegatedChild={onStopDelegatedChild}
                            onDelegatedChildContextMenu={onDelegatedChildContextMenu}
                            isStoppingOpenSubagent={
                              threadKey === openSubagentOwnerKey &&
                              stoppingDelegatedChildKey === routeThreadKey
                            }
                            variant={rowVariant}
                            variantAction={presentation.action}
                            settlementSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSettlement === true
                            }
                            snoozeSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSnooze === true
                            }
                            pinningSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadPinning === true
                            }
                            isPinned={thread.pinnedAt != null}
                            dropVerb={
                              dragState?.activeKey === threadKey
                                ? resolveSidebarDropVerb(dragState.activeSection, dragTargetSection)
                                : null
                            }
                            dragOverPinned={
                              dragState?.activeKey === threadKey && dragTargetSection === "pinned"
                            }
                            sweepAction={
                              actionSweep?.keys.has(threadKey) ? actionSweep.action : null
                            }
                            snoozeWakeLabelText={
                              section === "snoozed" && thread.snoozedUntil != null
                                ? snoozeWakeLabel(thread.snoozedUntil, {
                                    now: new Date().toISOString(),
                                  })
                                : null
                            }
                            // All sections: a woken thread can classify straight
                            // into the settled tail (PR merged while snoozed), and
                            // the wake signal must survive the trip. Still-snoozed
                            // rows resolve to null on their own.
                            wokeAt={
                              wokeAtByThreadKey.get(threadKey) ??
                              threadWokeAt(thread, { now: snoozeNow })
                            }
                            isActive={routeRowThreadKey === threadKey}
                            isRouteThread={routeThreadKey === threadKey}
                            openPullRequestsInRightPanel={routeThreadRef !== null}
                            jumpLabel={
                              showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null
                            }
                            currentEnvironmentId={primaryEnvironmentId}
                            environmentLabel={
                              environmentLabelById.get(thread.environmentId) ?? null
                            }
                            environmentHueClassName={
                              environmentHueById.get(thread.environmentId) ??
                              sidebarHostHueClassName(thread.environmentId)
                            }
                            environmentMachine={
                              environmentMachineById.get(thread.environmentId) ?? "server"
                            }
                            project={
                              projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                              null
                            }
                            projectDisplayName={
                              projectDisplayNameByKey.get(
                                `${thread.environmentId}:${thread.projectId}`,
                              ) ?? null
                            }
                            providerEntryByInstanceId={
                              providerEntriesByEnvironment.get(thread.environmentId) ??
                              EMPTY_PROVIDER_ENTRIES
                            }
                            timestampFormat={timestampFormat}
                            onThreadClick={handleThreadClick}
                            onThreadActivate={navigateToThread}
                            onStartRename={startThreadRename}
                            onRenameTitleChange={setRenamingTitle}
                            onCommitRename={commitThreadRename}
                            onCancelRename={cancelThreadRename}
                            isRenaming={renamingThreadKey === threadKey}
                            renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                            onContextMenu={handleThreadContextMenu}
                            onSettle={attemptSettle}
                            onActionSweepStart={startActionSweep}
                            onUnsettle={attemptUnsettle}
                            onSnooze={attemptSnooze}
                            onUnsnooze={attemptUnsnooze}
                            onUnpin={attemptUnpin}
                            onAcknowledgeWoke={acknowledgeWoke}
                            onFileDropThreads={handleThreadFileDrop}
                          />
                        );
                      };
                      const from = isContextDrag ? null : (dragState?.activeSection ?? null);
                      const draftBlock = (
                        <SidebarDraftBlock
                          key="draft-sessions"
                          projectByKey={projectByKey}
                          projectDisplayNameByKey={projectDisplayNameByKey}
                          scopedProjectKeys={scopedProjectKeys}
                          routeDraftId={routeDraftIdForRows}
                          onNavigateToDraft={navigateToDraft}
                          onDraftContextMenu={handleDraftContextMenu}
                        />
                      );
                      const items: ReactNode[] = [<DecisionInboxSidebarRow key="decision-inbox" />];
                      if (sidebarListItems.length === 0) items.push(draftBlock);
                      for (const item of sidebarListItems) {
                        if (item.kind === "thread") {
                          items.push(renderThreadRow(threadByKey.get(item.key)!, item.section));
                          continue;
                        }
                        switch (item.marker) {
                          case "pinned-header":
                            // With Priority above, label where the regular roster starts. It sits
                            // outside the sortable roster, inside the space drag projection keeps
                            // before the pinned header, like the draft rows below it.
                            if (priorityThreads.length > 0) {
                              items.push(
                                <li
                                  key="threads-header"
                                  data-thread-selection-safe
                                  data-testid="sidebar-threads-header"
                                  className="mx-0.5 mt-4 flex h-8 list-none items-center px-2"
                                >
                                  <span className="text-xs font-medium text-sidebar-foreground">
                                    Threads
                                  </span>
                                </li>,
                              );
                            }
                            items.push(draftBlock);
                            items.push(
                              <SidebarDragBoundary
                                key="pinned-header"
                                marker="pinned-header"
                                label="Pinned"
                                visible={from !== null}
                                isDropTarget={dragTargetSection === "pinned"}
                              />,
                            );
                            break;
                          case "pinned-divider":
                            items.push(
                              <SidebarDragBoundary
                                key="pinned-divider"
                                marker="pinned-divider"
                                label="Active"
                                visible={from !== null}
                                isDropTarget={dragTargetSection === "active"}
                              />,
                            );
                            break;
                          case "active-placeholder":
                            items.push(
                              <SidebarSectionPlaceholder
                                key="active-placeholder"
                                marker="active-placeholder"
                                label="Active"
                                showHint={
                                  from !== null &&
                                  (activeThreads.length === 0 ||
                                    (from === "active" &&
                                      activeThreads.length === 1 &&
                                      dragTargetSection !== null &&
                                      dragTargetSection !== "active"))
                                }
                                isDropTarget={dragTargetSection === "active"}
                              />,
                            );
                            break;
                          case "priority-header":
                            items.push(
                              <SortableSidebarMarker
                                key="priority-header"
                                marker="priority-header"
                                data-testid="sidebar-priority-header"
                                className="mx-0.5 flex h-8 items-center justify-between px-2"
                              >
                                <span className="text-xs font-medium text-sidebar-foreground">
                                  Priority ({priorityThreads.length})
                                </span>
                                <Menu>
                                  <MenuTrigger
                                    render={
                                      <Button
                                        variant="ghost-muted"
                                        size="icon-micro"
                                        aria-label="Priority actions"
                                      />
                                    }
                                  >
                                    <EllipsisIcon className="size-3" />
                                  </MenuTrigger>
                                  <MenuPopup side="bottom" align="end">
                                    <MenuItem
                                      disabled={priorityReadTargets.length === 0}
                                      onClick={markPriorityRead}
                                    >
                                      Mark all as read
                                    </MenuItem>
                                  </MenuPopup>
                                </Menu>
                              </SortableSidebarMarker>,
                            );
                            break;
                          case "snoozed-header":
                            items.push(
                              <SidebarSectionHeader
                                key="snoozed-shelf-header"
                                marker="snoozed-header"
                                className="mt-auto"
                                label={
                                  snoozedShelfExpanded
                                    ? "Snoozed"
                                    : `Snoozed (${snoozedThreads.length})`
                                }
                                toggle={{
                                  expanded: snoozedShelfExpanded,
                                  onToggle: toggleSnoozedShelf,
                                }}
                              />,
                            );
                            break;
                          case "settled-header":
                            items.push(
                              <SidebarSectionHeader
                                key="settled-shelf-header"
                                marker="settled-header"
                                className={cn(snoozedThreads.length === 0 && "mt-auto")}
                                label={
                                  settledShelfExpanded
                                    ? "Settled"
                                    : `Settled (${settledThreads.length})`
                                }
                                dragging={from !== null}
                                isDropTarget={dragTargetSection === "settled"}
                                toggle={{
                                  expanded: settledShelfExpanded,
                                  onToggle: toggleSettledShelf,
                                }}
                              />,
                            );
                            break;
                          case "settled-placeholder":
                            items.push(
                              <SidebarSectionPlaceholder
                                key="settled-placeholder"
                                marker="settled-placeholder"
                                label="Settled"
                                showHint={
                                  from !== null &&
                                  (renderedSettledThreads.length === 0 ||
                                    (from === "settled" &&
                                      renderedSettledThreads.length === 1 &&
                                      dragTargetSection !== null &&
                                      dragTargetSection !== "settled"))
                                }
                                isDropTarget={dragTargetSection === "settled"}
                              />,
                            );
                            break;
                        }
                      }
                      return items;
                    })()}
                    {settledShelfExpanded && hiddenSettledCount > 0 ? (
                      <li className="list-none">
                        <button
                          type="button"
                          onClick={showMoreSettled}
                          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                        >
                          <PlusIcon aria-hidden className="size-4 shrink-0" />
                          Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </SortableContext>
              </DndContext>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          visibleDraftSessionCount === 0 &&
          pinnedThreads.length +
            activeThreads.length +
            priorityThreads.length +
            snoozedThreads.length +
            settledThreads.length ===
            0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroup ? (
                `No threads in ${scopedProjectGroup.displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
