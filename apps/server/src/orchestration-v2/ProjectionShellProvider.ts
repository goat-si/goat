import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

export function providerInstanceHistoryForShell(input: {
  readonly threadId: ThreadId;
  readonly providerThreads: ReadonlyArray<
    OrchestrationV2ThreadProjection["providerThreads"][number]
  >;
}): ReadonlyArray<ProviderInstanceId> {
  const history: Array<ProviderInstanceId> = [];
  for (const providerThread of input.providerThreads
    .filter((thread) => thread.appThreadId === input.threadId && thread.ownerNodeId === null)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )) {
    if (!history.includes(providerThread.providerInstanceId)) {
      history.push(providerThread.providerInstanceId);
    }
  }
  return history;
}

export function activeProviderGoalForShell(
  providerThreads: ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>,
  activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"],
): OrchestrationV2ThreadShell["goal"] {
  return providerThreads.find((thread) => thread.id === activeProviderThreadId)?.goal ?? null;
}
