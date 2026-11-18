import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope } from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import {
  buildPendingNewTasks,
  isQueuedCreationSending,
  type PendingNewTask,
  type ThreadOutboxSendGate,
} from "./pending-new-tasks-model";
import { pendingThreadCreationOutcomesAtom, withLaunchingThreads } from "./pending-thread-creation";
import { environmentSession, sessionHasScope } from "./session";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { newTaskComposerDraftsAtom } from "./use-composer-drafts";
import {
  retryingQueuedMessageIdsAtom,
  threadOutboxShellStatusesAtom,
  useThreadOutboxMessages,
} from "./use-thread-outbox";
import { workspaceConnections } from "./workspace";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

const threadOutboxSendGateAtom = Atom.make((get): ThreadOutboxSendGate => {
  const connected = get(workspaceConnections.environmentsAtom).flatMap((environment) =>
    environment.connectionState === "connected" ? [environment.environmentId] : [],
  );
  return {
    connectedEnvironmentIds: new Set(connected),
    operableEnvironmentIds: new Set(
      connected.filter((environmentId) =>
        sessionHasScope(
          get(environmentSession.sessionStateAtom(environmentId)),
          AuthOrchestrationOperateScope,
        ),
      ),
    ),
    shellStatuses: get(threadOutboxShellStatusesAtom),
    retryingMessageIds: get(retryingQueuedMessageIdsAtom),
  };
}).pipe(Atom.withLabel("mobile:pending-new-tasks:send-gate"));

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(newTaskComposerDraftsAtom);
  const sendGate = useAtomValue(threadOutboxSendGateAtom);
  return useMemo(
    () =>
      buildPendingNewTasks({
        queuedMessages: flattenQueuedThreadMessages(queuedMessagesByThreadKey),
        drafts,
        sendGate,
      }),
    [queuedMessagesByThreadKey, drafts, sendGate],
  );
}

/** The list's threads, with creations the outbox is sending placed as working. */
export function useLaunchingThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const outcomes = useAtomValue(pendingThreadCreationOutcomesAtom);
  const sendGate = useAtomValue(threadOutboxSendGateAtom);
  return useMemo(() => {
    const launches = [
      ...flattenQueuedThreadMessages(queuedMessagesByThreadKey).filter((message) =>
        isQueuedCreationSending(message, sendGate),
      ),
      ...Object.values(outcomes).flatMap((outcome) =>
        outcome.kind === "delivered" ? [outcome.message] : [],
      ),
    ];
    return withLaunchingThreads({ threads, launches });
  }, [threads, queuedMessagesByThreadKey, outcomes, sendGate]);
}
