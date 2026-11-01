import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { threadWokeAt } from "@goat/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@goat/contracts";

import { readEnvironmentSupportsVisitedTracking } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarPriorityRank, selectSidebarMarkReadTargets } from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  markPriorityRead,
  withFoldedUnseen,
  selectPriorityClear,
  type ThreadPriorityReadPlan,
} from "@goat/client-runtime/state/thread-list-priority";

const threadKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const canOperate = (thread: EnvironmentThreadShell) =>
  readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);

/** Priority's bulk read actions: Mark all as read, and Clear read threads. */
export function useSidebarPriorityRead(input: {
  readonly priorityThreads: readonly EnvironmentThreadShell[];
  /** Effective wakes Priority ranked its rows with. */
  readonly wokeAtByThreadKey: ReadonlyMap<string, string | null>;
  readonly attentionByOwnerKey: ReadonlyMap<string, unknown>;
  readonly snoozeNow: string;
  readonly releasePriorityThreads: (keys: readonly string[]) => void;
  readonly restorePriorityThread: (key: string) => void;
  /** Unread threads folded under a Priority row; they are read with it. */
  readonly unseenUnder: (key: string) => readonly EnvironmentThreadShell[];
}) {
  const { priorityThreads, unseenUnder } = input;
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const foldedUnseen = priorityThreads.flatMap((row) => unseenUnder(threadKey(row)));
  const operableEnvironments = useEnvironmentsWithScope(
    [...priorityThreads, ...foldedUnseen],
    AuthOrchestrationOperateScope,
  );
  const visitThread = useOrchestrationCommand(threadEnvironment.visit, { reportFailure: false });
  const rawWokeAtByKey = new Map(
    priorityThreads.map((thread) => [
      threadKey(thread),
      threadWokeAt(thread, { now: input.snoozeNow }),
    ]),
  );
  // A row in Priority only through unread work folded under it.
  const liftedOnly = (row: EnvironmentThreadShell) =>
    resolveSidebarPriorityRank({
      thread: row,
      localLastVisitedAt: localLastVisitedAtByKey[threadKey(row)],
      wokeAt: input.wokeAtByThreadKey.get(threadKey(row)) ?? null,
      hasChildAttention: input.attentionByOwnerKey.has(threadKey(row)),
    }) === null;
  const withFolded = (
    plan: ThreadPriorityReadPlan<EnvironmentThreadShell>,
    operable: (thread: EnvironmentThreadShell) => boolean,
  ) =>
    withFoldedUnseen(plan, {
      rows: priorityThreads,
      unseenUnder,
      canOperate: operable,
      liftedOnly,
    });
  const markAllPlan = (operable: (thread: EnvironmentThreadShell) => boolean) => {
    const targets = selectSidebarMarkReadTargets({
      threads: priorityThreads,
      localLastVisitedAtByKey,
      wokeAtByKey: rawWokeAtByKey,
      canOperate: operable,
    });
    return withFolded({ markRead: targets, releaseKeys: targets.map(threadKey) }, operable);
  };
  const clearPlan = (operable: (thread: EnvironmentThreadShell) => boolean) =>
    withFolded(
      selectPriorityClear({
        threads: priorityThreads,
        localLastVisitedAtByKey,
        wokeAtByKey: input.wokeAtByThreadKey,
        attentionByOwnerKey: input.attentionByOwnerKey,
        canOperate: operable,
      }),
      operable,
    );
  const isOperable = (thread: EnvironmentThreadShell) =>
    operableEnvironments.has(thread.environmentId);

  const run = (plan: ThreadPriorityReadPlan<EnvironmentThreadShell>) => {
    const visitedAt = new Date().toISOString();
    void markPriorityRead({
      plan,
      release: input.releasePriorityThreads,
      restore: input.restorePriorityThread,
      visit: async (thread) => {
        if (!canOperate(thread)) return "skipped";
        if (!readEnvironmentSupportsVisitedTracking(thread.environmentId)) {
          markThreadVisited(threadKey(thread), visitedAt);
          return "visited";
        }
        const result = await visitThread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, visitedAt },
        });
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return "visited";
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to mark thread as read",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return "failed";
      },
    });
  };

  return {
    canMarkAllRead: markAllPlan(isOperable).markRead.length > 0,
    markAllRead: () => run(markAllPlan(canOperate)),
    canClearRead: hasWork(clearPlan(isOperable)),
    clearRead: () => run(clearPlan(canOperate)),
  };
}

const hasWork = (plan: ThreadPriorityReadPlan<EnvironmentThreadShell>) =>
  plan.markRead.length > 0 || plan.releaseKeys.length > 0;
