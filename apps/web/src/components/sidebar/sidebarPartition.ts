import type { EnvironmentServerConfig } from "@goat/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import { createInboxReturnTracker, isThreadWorking } from "@goat/client-runtime/state/thread-inbox";
import { effectiveSnoozed, threadWokeAt } from "@goat/client-runtime/state/thread-settled";
import { sortSettledThreads } from "@goat/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@goat/contracts";

import { excludeGlobalAgentThreads } from "../../globalAgentRoute";
import type { useGlobalAgentStore } from "../../globalAgentStore";
import {
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  firstValidTimestampMs,
  holdSidebarPriorityRank,
  orderItemsByPreferredIds,
  resolveSidebarPriorityRank,
  resolveSidebarThreadSection,
  resolveSidebarWokeAtForRow,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortPriorityThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  type SidebarChildAttention,
  type SidebarPriorityHolds,
  type SidebarSection,
} from "../Sidebar.logic";
import { foldedPriorityMember, wakesBeforeFold } from "./foldedPriority";
import { withoutBotThreads } from "./botVisibility";
import { foldLaunchedThreads, foldedSections, liftedPriorityRank } from "./launchFold";

export const inboxReturns = createInboxReturnTracker();
export type SidebarOptimisticDrop = {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};

export interface SidebarThreadPartitionInput {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  // Clock and inbox expiry revisions repartition second-precise wake and work states.
  readonly clockKey: string;
  readonly globalAgentRef: ReturnType<typeof useGlobalAgentStore.getState>["ref"];
  readonly goatBotRef: ReturnType<typeof useGlobalAgentStore.getState>["botRef"];
  readonly attentionByOwnerKey: ReadonlyMap<string, SidebarChildAttention>;
  readonly openSubagentOwnerKey: string | undefined;
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly priorityHolds: SidebarPriorityHolds;
  readonly acknowledgedWakes: ReadonlySet<string>;
  readonly priorityReleases: ReadonlySet<string>;
  /** GOAT Bot's observation threads the list leaves out. */
  readonly hiddenBotThreadKeys: ReadonlySet<string>;
}

export function partitionSidebarThreads(input: SidebarThreadPartitionInput) {
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
    workingShelfEnabled,
    hiddenBotThreadKeys,
  } = input;
  const preciseNow = new Date().toISOString();
  const retainedArchivedKeys = new Set(attentionByOwnerKey.keys());
  if (openSubagentOwnerKey !== undefined) retainedArchivedKeys.add(openSubagentOwnerKey);
  const visible = withoutBotThreads(
    excludeGlobalAgentThreads(
      filterSidebarV2VisibleThreads(threads, scopedProjectKeys, retainedArchivedKeys),
      globalAgentRef,
      goatBotRef,
    ),
    hiddenBotThreadKeys,
  );
  const acknowledged = new Set(acknowledgedWakes);
  const wakes = wakesBeforeFold({
    threads: visible,
    now: preciseNow,
    holds: priorityHolds,
    acknowledged,
    skipKey: optimisticDrop?.key ?? null,
  });
  const capabilitiesOf = (id: EnvironmentId) => serverConfigs.get(id)?.environment.capabilities;
  const launchFold = foldLaunchedThreads({
    visible,
    all: threads,
    now: preciseNow,
    delegatedAttentionByKey: attentionByOwnerKey,
    unseen: foldedPriorityMember({
      now: preciseNow,
      localLastVisitedAtByKey,
      capabilitiesOf,
      wakes,
    }),
  });
  const foldedSectionByKey = foldedSections(launchFold.folded, capabilitiesOf, preciseNow);
  const inboxObservation = inboxReturns.observe(workingShelfEnabled ? threads : null);
  const wokeAtByThreadKey = new Map<string, string | null>();
  const priority: EnvironmentThreadShell[] = [];
  const priorityRanks = new Map<string, number>();
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const inbox = (thread: EnvironmentThreadShell, manuallyMoved = false) =>
    workingShelfEnabled &&
    (manuallyMoved ? isThreadWorking(thread) : inboxObservation.isWorking(thread))
      ? working
      : active;
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const draggable = new Set<string>();
  const activeReorderable = new Set<string>();
  for (const thread of launchFold.roots) {
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
          : inbox(projected, true)
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
        rank: liftedPriorityRank(
          resolveSidebarPriorityRank({
            thread,
            localLastVisitedAt: localLastVisitedAtByKey[threadKey],
            wokeAt,
            hasChildAttention: attentionByOwnerKey.has(threadKey),
          }),
          launchFold.liftByKey.get(threadKey),
        ),
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
              : inbox(thread)
      ).push(thread);
    }
  }
  // Capability gates dragging only; mixed server versions must preserve the same pinned order across clients.
  const sortedPinned = sortPinnedThreadsForSidebar(pinned);
  const sortedActive = workingShelfEnabled
    ? sortInboxThreadsByReturn(active, inboxObservation.returnedAt)
    : sortThreadsForSidebar(active);
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
    workingThreads: sortWorkingThreadsBySend(working),
    // Soonest wake first: "what comes back next" is the shelf's question.
    snoozedThreads: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settledThreads: sortSettledThreads(settled),
    visibleThreads: visible,
    launchFold,
    foldedSectionByKey,
    snoozeNow: preciseNow,
    wokeAtByThreadKey,
    acknowledgedWakes: acknowledged,
  };
}
