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
import { selectSidebarMarkReadTargets } from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  markSidebarPriorityRead,
  selectSidebarPriorityClear,
  type SidebarPriorityReadPlan,
} from "./priorityRead";

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
}) {
  const { priorityThreads } = input;
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const operableEnvironments = useEnvironmentsWithScope(
    priorityThreads,
    AuthOrchestrationOperateScope,
  );
  const visitThread = useOrchestrationCommand(threadEnvironment.visit, { reportFailure: false });
  const rawWokeAtByKey = new Map(
    priorityThreads.map((thread) => [
      threadKey(thread),
      threadWokeAt(thread, { now: input.snoozeNow }),
    ]),
  );
  const markReadTargets = (operable: (thread: EnvironmentThreadShell) => boolean) =>
    selectSidebarMarkReadTargets({
      threads: priorityThreads,
      localLastVisitedAtByKey,
      wokeAtByKey: rawWokeAtByKey,
      canOperate: operable,
    });
  const clearPlan = (operable: (thread: EnvironmentThreadShell) => boolean) =>
    selectSidebarPriorityClear({
      threads: priorityThreads,
      localLastVisitedAtByKey,
      wokeAtByKey: input.wokeAtByThreadKey,
      attentionByOwnerKey: input.attentionByOwnerKey,
      canOperate: operable,
    });
  const isOperable = (thread: EnvironmentThreadShell) =>
    operableEnvironments.has(thread.environmentId);

  const run = (plan: SidebarPriorityReadPlan<EnvironmentThreadShell>) => {
    const visitedAt = new Date().toISOString();
    void markSidebarPriorityRead({
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
    canMarkAllRead: markReadTargets(isOperable).length > 0,
    markAllRead: () => {
      const targets = markReadTargets(canOperate);
      run({ markRead: targets, releaseKeys: targets.map(threadKey) });
    },
    canClearRead: clearPlan(isOperable).releaseKeys.length > 0,
    clearRead: () => run(clearPlan(canOperate)),
  };
}
